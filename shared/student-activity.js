/* Pure clock plus an injectable presence coordinator; no Firebase dependency. */
(function(global){
  'use strict';
  const idleMs=300000,heartbeatMs=120000;
  function clock(initial=0){
    let last=initial,interaction=initial,eligible=false,pending=0;
    function sample(now){
      const elapsed=now-last;
      // Never credit suspended/throttled timers or clock jumps as study time.
      if(eligible&&elapsed>=0&&elapsed<=30000)pending+=Math.max(0,Math.min(now,interaction+idleMs)-last);
      last=now;
    }
    return {sample,activity(now){sample(now);interaction=now;},eligible(value,now){sample(now);eligible=value;},awake:now=>now-interaction<idleMs,take(){const seconds=Math.floor(pending/1000);pending-=seconds*1000;return seconds;}};
  }
  function create({env,identity,subscribe,write,warn=console.warn}){
    let user=null,epoch=0,held=false,requesting=false,release=null,unwatch=null,watchTimer=null;
    let verified=false,inflight=false,announced=false,blockedUntil=0,legacy=null;
    let timer=null,stopped=false,unsupportedWarned=false,meter=clock(env.clock());
    const canCount=!!env.locks;
    const key=()=>`learning-platform.${env.projectId}.${env.termId}.${user.uid}.active-v2`;
    const memory=new Map();
    const memo=suffix=>{const name=key()+suffix;try{return JSON.parse(env.storage.getItem(name)||'null')??memory.get(name)??null;}catch(_){return memory.get(name)??null;}};
    const remember=(suffix,value)=>{const name=key()+suffix;memory.set(name,value);try{env.storage.setItem(name,JSON.stringify(value));}catch(_){/* Memory preserves the heartbeat limit if storage is blocked. */}};
    const same=()=>{const next=identity();return !!user&&next?.uid===user.uid&&next.studentId===user.studentId&&next.remoteId===user.remoteId&&next.allowed;};
    const foreground=()=>env.visible()&&env.focused()&&env.online();
    function stopWatch(){if(unwatch)unwatch();unwatch=null;if(watchTimer!==null)env.clearTimeout(watchTimer);watchTimer=null;verified=false;}
    function carry(seconds){if(seconds>0)remember('.carry',Math.max(0,Number(memo('.carry'))||0)+seconds);}
    async function flush(closing=false){
      if(!canCount||!held||!verified||!same()||!env.online()||inflight)return;
      const last=Number(memo('.lastWrite'))||0;
      if(env.now()-last<heartbeatMs&&(!closing||!announced))return;
      const seconds=meter.take()+Math.max(0,Number(memo('.carry'))||0);remember('.carry',0);
      if(closing&&!announced&&!seconds)return;
      const owner={...user},generation=epoch;
      inflight=true;announced=!closing;remember('.lastWrite',env.now());
      // Never retry an ambiguous increment; it may already have reached Firestore.
      try{await write({owner,seconds,closing,legacy});}
      catch(error){warn('有效時間暫時無法保存；本批不自動重送，避免重複累計。',error);}
      finally{inflight=false;if(generation===epoch&&held&&same()&&(stopped||!foreground()||!meter.awake(env.clock())))deactivate();}
    }
    function deactivate(){
      meter.eligible(false,env.clock());
      if(!held){stopWatch();return;}
      // Hold the lock until an in-flight heartbeat settles.
      if(inflight)return;
      const closing=flush(true);
      if(inflight){closing.finally(()=>deactivate());return;}
      carry(meter.take());stopWatch();held=false;announced=false;
      if(release)release();release=null;
    }
    function watch(generation){
      watchTimer=env.setTimeout(()=>{
        if(generation!==epoch||verified)return;
        blockedUntil=env.now()+heartbeatMs;warn('登入識別確認逾時，暫停有效時間；稍後操作時再確認。');deactivate();
      },20000);
      unwatch=subscribe(user,(data,metadata={})=>{
        if(generation!==epoch||!held||!same()||metadata.fromCache||metadata.hasPendingWrites)return;
        if(data?.activeSession?.id&&data.activeSession.id!==user.remoteId){env.duplicate();stop();return;}
        if(data?.activeSession?.id!==user.remoteId)return;
        legacy=data?.terms?.[env.termId]?.usage||{};
        if(!verified){verified=true;if(watchTimer!==null)env.clearTimeout(watchTimer);watchTimer=null;meter.eligible(canCount&&foreground()&&meter.awake(env.clock()),env.clock());void flush();}
      },error=>{if(generation!==epoch)return;blockedUntil=env.now()+heartbeatMs;warn('無法確認登入識別，暫停有效時間。',error);deactivate();});
      if(!held||generation!==epoch)stopWatch();
    }
    function acquire(){
      if(held||requesting||inflight||env.now()<blockedUntil||!foreground()||!meter.awake(env.clock())||!same())return;
      if(!canCount){
        if(!unsupportedWarned){warn('此瀏覽器不支援跨分頁互斥；暫停有效時間，仍確認單一登入。');unsupportedWarned=true;}
        held=true;watch(epoch);return;
      }
      requesting=true;const generation=epoch;
      void env.locks.request(`learning-usage:${env.projectId}:${user.uid}`,{ifAvailable:true},async lock=>{
        requesting=false;if(!lock||generation!==epoch||stopped||!foreground()||!meter.awake(env.clock())||!same())return;
        held=true;const heldPromise=new Promise(resolve=>{release=resolve;});watch(generation);await heldPromise;
      }).catch(error=>{requesting=false;warn('無法取得有效時間的分頁鎖定。',error);blockedUntil=env.now()+heartbeatMs;});
    }
    function tick(){
      if(stopped)return;
      const next=identity();
      if(!next?.allowed||!next.uid||!next.remoteId||user?.uid!==next.uid||user?.studentId!==next.studentId||user?.remoteId!==next.remoteId){
        if(user){meter.eligible(false,env.clock());stopWatch();held=false;if(release)release();release=null;}
        epoch++;user=next?.allowed?next:null;meter=clock(env.clock());announced=false;blockedUntil=0;
      }
      if(!user)return;
      meter.sample(env.clock());
      if(!foreground()||!meter.awake(env.clock())){deactivate();return;}
      if(held&&verified){meter.eligible(canCount,env.clock());void flush();}else acquire();
    }
    function activity(){if(stopped)return;meter.activity(env.clock());tick();}
    function stop(){stopped=true;if(timer!==null)env.clearInterval(timer);deactivate();}
    timer=env.setInterval(tick,10000);tick();
    return Object.freeze({tick,activity,stop,state:()=>({held,verified,inflight,announced})});
  }
  global.StudentActivity=Object.freeze({clock,create,idleMs,heartbeatMs});
})(typeof window==='undefined'?globalThis:window);
