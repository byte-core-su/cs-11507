/* Teacher-owned materialized statistics. Raw attempts and scores are immutable.
 * Reads/writes run only after a teacher clicks a button; no background jobs. */
(function(global){
  'use strict';
  const schema='quiz-summary-v1',pageSize=200,shardSize=100,maxAttempts=5000;
  const scanBudget=value=>Math.max(1,Math.min(maxAttempts,Math.floor(Number(value))||maxAttempts));
  const exists=snapshot=>typeof snapshot.exists==='function'?snapshot.exists():snapshot.exists;
  const cancelled=()=>Object.assign(new Error('整理已停止；已完成的進度保留。'),{code:'cancelled'});
  const stamp=value=>({seconds:Number(value?.seconds)||0,nanoseconds:Number(value?.nanoseconds)||0});
  const compare=(a,b)=>a.seconds-b.seconds||a.nanoseconds-b.nanoseconds||(String(a.id||'')===String(b.id||'')?0:String(a.id||'')<String(b.id||'')?-1:1);
  const validStudent=id=>/^15[12]\d{4}$/.test(id)&&!id.endsWith('00');
  const top20=rows=>{
    const best=new Map();
    for(const row of rows)if(validStudent(String(row.studentId||''))&&Number.isInteger(row.score)&&row.score>=0&&(!best.has(row.studentId)||best.get(row.studentId).score<row.score))best.set(row.studentId,{studentId:row.studentId,score:row.score});
    return [...best.values()].sort((a,b)=>b.score-a.score||a.studentId.localeCompare(b.studentId)).slice(0,20);
  };
  function mergeQuestions(summaries){
    const result=new Map();
    for(const entries of summaries)for(const entry of entries){
      let target=result.get(entry.questionId);
      if(!target){target={questionId:entry.questionId,questionText:entry.questionText,sources:[],attemptCount:0,correctCount:0,studentCount:0,firstCorrectCount:0,secondsTotal:0,optionCounts:[]};result.set(entry.questionId,target);}
      for(const key of ['attemptCount','correctCount','studentCount','firstCorrectCount','secondsTotal'])target[key]+=Number(entry[key])||0;
      target.sources=[...new Set([...target.sources,...entry.sources])];
      entry.optionCounts.forEach((count,index)=>{target.optionCounts[index]=(target.optionCounts[index]||0)+count;});
    }
    return [...result.values()].sort((a,b)=>a.questionId.localeCompare(b.questionId));
  }
  function addAttempts(previous,documents){
    const result=new Map(previous.map(entry=>[entry.questionId,JSON.parse(JSON.stringify(entry))]));
    for(const document of documents){
      const item=document.data();
      if(!item.questionId||typeof item.correct!=='boolean')throw new Error('原始作答格式不完整，停止整理，不發布部分統計。');
      const time={...stamp(item.createdAt),id:document.id};
      let entry=result.get(item.questionId);
      if(!entry){entry={questionId:item.questionId,questionText:String(item.questionText||'題目文字未記錄'),sources:[],attemptCount:0,correctCount:0,studentCount:1,firstCorrectCount:0,firstAt:time,secondsTotal:0,optionCounts:[]};result.set(item.questionId,entry);}
      if(!entry.attemptCount||compare(time,entry.firstAt)<0){entry.firstAt=time;entry.firstCorrectCount=item.correct?1:0;}
      entry.attemptCount++;entry.correctCount+=item.correct?1:0;entry.secondsTotal+=Math.max(0,Number(item.elapsedSeconds)||0);
      entry.sources=[...new Set([...entry.sources,String(item.source||'未分類')])];
      const count=Math.max(0,Math.min(10,Number(item.optionCount)||0));while(entry.optionCounts.length<count)entry.optionCounts.push(0);
      if(Number.isInteger(item.selectedIndex)&&item.selectedIndex>=0&&item.selectedIndex<entry.optionCounts.length)entry.optionCounts[item.selectedIndex]++;
    }
    return [...result.values()];
  }
  function create({db,termId,read,fetchClass,documentId,timestampFrom,now=()=>Date.now()}){
    if(!/^115-[12]$/.test(termId))throw new Error('學期格式不正確。');
    const root=db.collection('quizAnalytics').doc(termId);
    const classRef=classRoom=>root.collection('classes').doc(classRoom);
    const guard=current=>{if(!current())throw cancelled();};
    async function loadMeta(ref,current){
      const snapshot=await read(ref,current);if(!exists(snapshot))return null;
      const meta=snapshot.data();if(meta.schema!==schema||!Number.isInteger(meta.pageCount)||meta.pageCount<0||meta.pageCount>400)throw new Error('彙總格式不符，請由教師重新整理。');
      return meta;
    }
    async function load(ref,current){
      const meta=await loadMeta(ref,current);if(!meta)return null;
      const entries=[];
      for(let index=0;index<meta.pageCount;index++){
        const page=await read(ref.collection('pages').doc(String(index).padStart(4,'0')),current);
        if(!exists(page)||page.data().generation!==meta.generation)throw new Error('彙總正在更新或尚未完整，請稍後手動重讀。');
        entries.push(...page.data().entries);
      }
      return{...meta,entries};
    }
    async function save(ref,meta,entries,current){
      guard(current);if(leaseOwner)await renew();guard(current);const generation='g_'+now()+'_'+Math.random().toString(36).slice(2);
      const pages=[];for(let offset=0;offset<entries.length;offset+=shardSize)pages.push(entries.slice(offset,offset+shardSize));
      if(pages.length>400)throw new Error('題目彙總超過單次安全容量，原彙總保留，請聯絡管理者。');
      const sizes=pages.map(items=>new TextEncoder().encode(JSON.stringify(items)).length);
      if(sizes.some(size=>size>700000)||sizes.reduce((sum,size)=>sum+size,0)>7000000)throw new Error('彙總超過安全容量，未覆蓋原資料。');
      const writes=pages.map((items,index)=>[ref.collection('pages').doc(String(index).padStart(4,'0')),{generation,entries:items}]);
      writes.push([ref,{...meta,schema,generation,pageCount:pages.length,updatedAt:new Date(now()).toISOString()}]);
      await commit(writes,current);
    }
    async function loadClass(classRoom,current){
      const value=await load(classRef(classRoom),current);
      if(value?.complete!==true)throw new Error(classRoom+' 班尚無完整彙總。可按「整理／接續全年級」，或選該班按「整理／增量更新」。');
      return value;
    }
    async function updateClassImpl(classRoom,current,onProgress=()=>{},budget=maxAttempts){
      guard(current);if(!/^7\d{2}$/.test(classRoom))throw new Error('請逐班整理，不會自動掃描全年級歷史。');
      budget=scanBudget(budget);
      const data=await fetchClass(classRoom,current),byStudent=new Map();
      data.progressRows.forEach(row=>byStudent.set(String(row.data.profile?.studentId||row.data.studentId||''),row.id));
      const members=data.rosterRows.filter(row=>validStudent(row.studentId)).map(row=>({studentId:row.studentId,uid:byStudent.get(row.studentId)||''}));
      const all=[],seen=new Set();let scanned=0,studentsWithAttempts=0;
      for(const member of members){
        if(!member.uid||seen.has(member.uid))continue;seen.add(member.uid);guard(current);
        const ref=root.collection('students').doc(member.uid),stored=await load(ref,current);
        let entries=stored?.entries||[],cursor=stored?.cursor||null,complete=false,savedComplete=stored?.complete;
        // A bounded range query resumes after the immutable server timestamp.
        // No full historical scan is performed when a checkpoint already exists.
        while(!complete){
          guard(current);if(scanned>=budget)return{complete:false,scanned,studentId:member.studentId};
          const limit=Math.min(pageSize,budget-scanned);
          let query=db.collection('quizAttempts').doc(member.uid).collection('events').where('termId','==',termId).orderBy('createdAt','asc').orderBy(documentId,'asc');
          if(cursor)query=query.startAfter(timestampFrom(cursor),cursor.id);
          const snapshot=await read(query.limit(limit),current);scanned+=snapshot.docs.length;
          entries=addAttempts(entries,snapshot.docs);
          const last=snapshot.docs.at(-1);if(last)cursor={...stamp(last.data().createdAt),id:last.id};
          complete=snapshot.docs.length<limit;
          if(snapshot.docs.length||savedComplete!==complete){await save(ref,{uid:member.uid,studentId:member.studentId,termId,cursor,complete},entries,current);savedComplete=complete;}
          onProgress({studentId:member.studentId,scanned,complete});
        }
        if(entries.length)studentsWithAttempts++;all.push(entries);
      }
      await save(classRef(classRoom),{termId,classRoom,complete:true,members,studentCount:studentsWithAttempts},mergeQuestions(all),current);
      return{complete:true,scanned};
    }
    async function updateGradeImpl(classRooms,current,onProgress=()=>{},budget=maxAttempts){
      guard(current);
      const selected=[...new Set(classRooms)];
      if(!selected.length||selected.some(classRoom=>!/^7\d{2}$/.test(classRoom)))throw new Error('全年級班級設定不正確。');
      budget=scanBudget(budget);
      const pending=[];let completed=0,scanned=0;
      for(const classRoom of selected){
        const meta=await loadMeta(classRef(classRoom),current);
        if(meta?.complete===true)completed++;
        else pending.push(classRoom);
      }
      const total=selected.length;
      const report=(classRoom='',studentId='',count=scanned)=>{
        guard(current);
        onProgress({classRoom,studentId,scanned:count,completed,total});
      };
      report();
      for(const classRoom of pending){
        if(scanned>=budget)return{complete:false,scanned,completed,total,classRoom};
        report(classRoom);
        // One lease and one remaining budget for the entire click, not one per class.
        const result=await updateClassImpl(classRoom,current,status=>report(classRoom,status.studentId,scanned+status.scanned),budget-scanned);
        scanned+=result.scanned;
        if(!result.complete)return{complete:false,scanned,completed,total,classRoom};
        completed++;
        report();
      }
      return{complete:true,scanned,completed,total};
    }
    async function archiveLeaderboardImpl(difficulty,current,onProgress=()=>{},budget=5000){
      if(!['easy','normal','hard'].includes(difficulty))throw new Error('難度格式不正確。');
      const base=db.collection('leaderboards').doc(termId).collection('difficulties').doc(difficulty);
      const checkpoint=base.collection('maintenance').doc('legacy-top20'),snapshot=await read(checkpoint,current);
      let state=exists(snapshot)?snapshot.data():{cursor:'',rows:[],complete:false,scanned:0};
      if(state.complete)return{complete:true,scanned:0};
      let scanned=0;budget=Math.max(1,Math.min(5000,Number(budget)||5000));
      while(scanned<budget){
        guard(current);const limit=Math.min(pageSize,budget-scanned);let query=base.collection('scores').orderBy(documentId,'asc');
        if(state.cursor)query=query.startAfter(state.cursor);
        const batch=await read(query.limit(limit),current);scanned+=batch.docs.length;
        state={schema:'legacy-top20-v1',cursor:batch.docs.at(-1)?.id||state.cursor,rows:top20([...state.rows,...batch.docs.map(document=>document.data())]),complete:batch.docs.length<limit,scanned:state.scanned+batch.docs.length,updatedAt:new Date(now()).toISOString()};
        const writes=[[checkpoint,state]];
        if(state.complete)writes.push([base.collection('archive').doc('top20'),{schema:'legacy-top20-v1',complete:true,rows:state.rows,updatedAt:state.updatedAt}]);
        await commit(writes,current);onProgress({scanned,complete:state.complete});if(state.complete)break;
      }
      return{complete:state.complete,scanned};
    }
    // A term-wide lease prevents two teacher tabs/devices overwriting checkpoints.
    // Renew before each read; expired jobs must not commit after a takeover.
    let busy=false,leaseOwner='',leaseRenewedAt=0;
    const lock=root.collection('maintenance').doc('lease');
    async function renew(){
      if(leaseRenewedAt&&now()-leaseRenewedAt<30000)return;
      await db.runTransaction(async transaction=>{
        const snapshot=await transaction.get(lock),previous=exists(snapshot)?snapshot.data():{};
        if(previous.owner!==leaseOwner&&Number(previous.until)>now())throw new Error('已有另一個教師視窗正在整理，請稍後再試。');
        transaction.set(lock,{owner:leaseOwner,until:now()+120000});
      },{maxAttempts:1});
      leaseRenewedAt=now();
    }
    async function commit(writes,current){
      guard(current);await renew();guard(current);
      await db.runTransaction(async transaction=>{
        const snapshot=await transaction.get(lock),state=exists(snapshot)?snapshot.data():{};
        if(state.owner!==leaseOwner||Number(state.until)<=now())throw new Error('整理鎖定已失效，已停止保存；請手動接續。');
        guard(current);for(const [ref,data]of writes)transaction.set(ref,data);
      },{maxAttempts:1});
      guard(current);
    }
    const originalRead=read;
    read=async(ref,current)=>{if(leaseOwner){guard(current);await renew();}return originalRead(ref,current);};
    async function exclusive(job){
      if(busy)throw new Error('目前已有整理工作，請等待完成。');
      busy=true;leaseRenewedAt=0;leaseOwner='job_'+now()+'_'+Math.random().toString(36).slice(2);
      try{await renew();return await job();}
      finally{
        const owner=leaseOwner;leaseOwner='';busy=false;
        try{await db.runTransaction(async transaction=>{const snapshot=await transaction.get(lock);if(exists(snapshot)&&snapshot.data().owner===owner)transaction.set(lock,{owner:'',until:0});},{maxAttempts:1});}catch(_){/* Lease expires without a background retry. */}
      }
    }
    return Object.freeze({loadClass,updateClass:(...args)=>exclusive(()=>updateClassImpl(...args)),updateGrade:(...args)=>exclusive(()=>updateGradeImpl(...args)),archiveLeaderboard:(...args)=>exclusive(()=>archiveLeaderboardImpl(...args))});
  }
  global.TeacherAnalytics=Object.freeze({create,mergeQuestions,addAttempts,top20});
})(typeof window==='undefined'?globalThis:window);
