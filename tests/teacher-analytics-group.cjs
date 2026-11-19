'use strict';
const assert=require('node:assert/strict');
require('../shared/teacher-analytics.js');
require('../shared/teacher-data.js');
const {fakeFirestore}=require('./fake-firestore.cjs');
const {create,mergeQuestions}=TeacherAnalytics;
const classes=['701','702','703'];
const active=()=>true;

(async()=>{
 for(const termId of ['115-1','115-2']){
  const root='quizAnalytics/'+termId,jobPath=root+'/maintenance/grade-refresh',f=fakeFirestore();
  const teacher=TeacherData.create({db:f.db}),fetched=[],returned=[],reports=[];
  let seconds=10,groupError='';
  const make=()=>create({db:f.db,termId,documentId:'__name__',timestampFrom:value=>value,serverTimestamp:()=>({seconds,nanoseconds:0}),
   fetchClass:(name,current)=>{fetched.push(name);return teacher.fetchClass(name,current);},
   read:async(ref,current)=>{
    if(ref.path==='events'&&groupError)throw Object.assign(new Error('fixture deployment not ready'),{code:groupError});
    const snapshot=await teacher.read(ref,current);
    if(ref.path==='events')returned.push(...snapshot.docs.map(document=>document.ref.path));
    return snapshot;
   }
  });
  const member=(uid,studentId,classRoom)=>{
   f.rows.set('users/'+uid,{studentId});
   f.rows.set('rosters/'+studentId,{studentId,classRoom});
  };
  const add=(uid,id,createdAt,term=termId,correct=true)=>{
   const name=`quizAttempts/${uid}/events/${id}`;
   f.rows.set(name,{termId:term,questionId:'q_fixture',questionText:'測試題',source:'unit',createdAt:{seconds:createdAt,nanoseconds:0},correct,selectedIndex:correct?0:1,optionCount:2,elapsedSeconds:3});
   return name;
  };
  const s1='1510101',s2='1510201',s3='1510301';
  member('u1',s1,'701');member('u2',s2,'702');member('u3',s3,'703');
  for(const uid of ['u1','u2','u3'])add(uid,'old',1,termId,uid!=='u1');
  const api=make(),classMeta=name=>f.rows.get(root+'/classes/'+name);
  const total=async(value=api)=>mergeQuestions((await value.loadGrade(classes,active)).map(item=>item.entries))[0];
  await api.updateGrade(classes,active);
  assert((await api.refreshGrade(classes,active)).complete,'one legacy pass establishes a server cutoff when none exists');
  assert.equal(f.rows.get(jobPath).schema,'quiz-grade-refresh-v1');
  assert.equal((await total()).attemptCount,3);
  const baseline=structuredClone(f.rows.get(jobPath));
  for(const code of ['permission-denied','failed-precondition']){
   groupError=code;
   await assert.rejects(()=>api.refreshGrade(classes,active),{code});
   assert.deepEqual(f.rows.get(jobPath),baseline,'failed first query keeps existing statistics readable');
   assert.equal((await total()).attemptCount,3);
  }
  groupError='';
  fetched.length=0;f.reads.length=0;
  seconds=11;
  assert.equal((await api.refreshGrade(classes,active)).scanned,0);
  assert.deepEqual(fetched,[]);
  assert.equal(f.reads.filter(row=>row.kind==='group').length,1);
  assert(f.reads.every(row=>row.kind==='group'||row.pathname.startsWith(root+'/maintenance/')));
  assert.equal(f.rows.get(jobPath).schema,'quiz-grade-refresh-v2');
  const untouched=structuredClone(classMeta('703'));
  // Same timestamps and identical local IDs across different students exercise
  // the full document-path tie breaker, including at the budget boundary.
  for(let i=0;i<2504;i++)for(const uid of ['u1','u2'])add(uid,'x'+String(i).padStart(4,'0'),12);
  add('u3','different-term',12,termId==='115-1'?'115-2':'115-1');
  member('test','1510100','701');
  add('test','test-only',12);
  add('orphan','no-longer-enrolled',12);
  f.rows.set('unrelated/x/events/not-a-quiz',{termId,createdAt:{seconds:12,nanoseconds:0}});
  seconds=20;fetched.length=0;f.reads.length=0;
  const part=await api.refreshGrade(classes,active,status=>reports.push(status),99999);
  assert.deepEqual(part,{complete:false,scanned:5000,phase:'scan',classRoom:'',completed:0,total:2});
  assert.deepEqual(fetched,[],'no class rebuilding before scan is complete');
  assert(f.reads.filter(row=>row.kind==='group').every(row=>row.limit<=200));
  assert(!f.reads.some(row=>row.pathname.startsWith('quizAttempts/')),'normal group scans do not fetch individual raw histories');
  assert(reports.some(status=>status.scanned===5000));
  const checkpoint=structuredClone(f.rows.get(jobPath));
  assert.equal(checkpoint.cursor.seconds,12);
  assert.match(checkpoint.cursor.path,/^quizAttempts\/u2\/events\//);
  assert.equal(returned.length,5000);
  await assert.rejects(()=>api.loadGrade(classes,active),/尚未完成/);
  add('u3','while-paused',21);
  const fresh=make();
  seconds=30;
  const result=await fresh.refreshGrade(classes,active);
  assert.deepEqual(result,{complete:true,scanned:11,changedClasses:2,completed:2,total:2,phase:'done'});
  assert.deepEqual(fetched,['701','702'],'only rebuild classes with new attempts, even across resumed clicks');
  assert.equal(returned.length,new Set(returned).size,'normal continuation never rereads a raw event');
  assert.deepEqual(classMeta('703'),untouched);
  const stats=await total(fresh);
  assert.equal(stats.attemptCount,5011);
  assert.equal(stats.firstCorrectCount,2);
  assert.equal((await fresh.refreshGrade(classes,active)).changedClasses,1);
  assert.equal((await total()).attemptCount,5012,'events after cutoff belong to next round');
  // A student linked for the first time can have older uncounted events.
  member('joined','1510202','702');add('joined','old-unlinked',5);add('joined','new',31);
  seconds=32;
  let joinResult=await fresh.refreshGrade(classes,active,()=>{},1);
  assert(!joinResult.complete&&joinResult.scanned===1);
  assert.equal(f.rows.get(jobPath).bootstrap.uid,'joined');
  for(let tries=0;!joinResult.complete&&tries<5;tries++){
   joinResult=await make().refreshGrade(classes,active,()=>{},1);
   assert(joinResult.scanned<=1,'older one-student catch-up shares the same budget');
  }
  assert(joinResult.complete);
  assert.equal((await total()).attemptCount,5014,'older uncounted and new attempts included once for joined student');
  // A new attempt following a transfer refreshes both current and old class, once.
  f.rows.set('rosters/'+s2,{studentId:s2,classRoom:'703'});
  add('u2','after-transfer',33);seconds=34;fetched.length=0;
  let current=true;
  await assert.rejects(()=>fresh.refreshGrade(classes,()=>current,status=>{
   if(status.phase==='publish'&&status.completed===1)current=false;
  }),/已停止|讀取已取消/);
  assert.equal(f.rows.get(jobPath).nextClass,1);
  assert.deepEqual(fetched,['702']);
  await assert.rejects(()=>fresh.loadGrade(classes,active),/尚未完成/);
  assert.equal((await make().refreshGrade(classes,active)).scanned,0,'resume publishing from saved class without any further raw reads');
  assert.deepEqual(fetched,['702','703']);
  assert.equal((await total()).attemptCount,5015,'transfer retains one copy of the student history');
  assert(!f.writes.some(row=>row.pathname.startsWith('quizAttempts/')),'student attempts remain immutable');
 }
 console.log('PASS targeted grade updates, both terms: no-op read path, 5,000 shared cap, same-time path cursor, no rescan, stable cutoff, transfer, new membership bootstrap, interrupted publication and immutable raw data.');
})().catch(error=>{console.error(error);process.exitCode=1;});
