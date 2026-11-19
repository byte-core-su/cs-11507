'use strict';
const assert=require('node:assert/strict');require('../shared/student-activity.js');
const {clock,create}=global.StudentActivity;
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function fixture(shared={}){
 let time=1000000,visible=true,focused=true,online=true,current={uid:'u1',studentId:'1510101',remoteId:'r1',allowed:true};
 const storage=shared.storage||new Map(),locks=shared.locks||new Map(),timers=new Map(),subscriptions=[],writes=[],warnings=[];let nextTimer=0,deferred=null,fail=false,duplicates=0,storageFail=false;
 const env={projectId:'fake',termId:'115-1',now:()=>time,clock:()=>time,visible:()=>visible,focused:()=>focused,online:()=>online,
  storage:{getItem:key=>{if(storageFail)throw Error('blocked');return storage.get(key);},setItem:(key,value)=>{if(storageFail)throw Error('blocked');storage.set(key,value);}},
  locks:shared.noLocks?null:{async request(name,options,fn){if(locks.has(name))return fn(null);locks.set(name,true);try{return await fn({name});}finally{locks.delete(name);}}},
  setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,at:time+ms});return id;},clearTimeout:id=>timers.delete(id),setInterval(){return 1;},clearInterval(){},duplicate(){duplicates++;}};
 const api=create({env,identity:()=>current,subscribe(owner,next,error){const sub={owner,next,error,active:true};subscriptions.push(sub);return()=>{sub.active=false;};},async write(data){writes.push(data);if(deferred)await deferred;if(fail)throw Error('unavailable');},warn:(...args)=>warnings.push(args)});
 const verify=(data,metadata={fromCache:false,hasPendingWrites:false})=>subscriptions.filter(s=>s.active).forEach(s=>s.next(data||{activeSession:{id:current.remoteId},terms:{}},metadata));
 return {api,env,storage,locks,writes,warnings,subscriptions,verify,get duplicates(){return duplicates;},user(value){current=value;api.tick();},set(value){({visible=visible,focused=focused,online=online,fail=fail,storageFail=storageFail}=value);api.tick();},defer(promise){deferred=promise;},async step(ms,activity=false){time+=ms;if(activity)api.activity();else api.tick();for(const[id,timer]of timers)if(timer.at<=time){timers.delete(id);timer.fn();}await settle();},time:()=>time};
}
(async()=>{
 let meter=clock(0);meter.eligible(true,0);for(let n=10000;n<=300000;n+=10000)meter.sample(n);assert.equal(meter.take(),300);meter.sample(310000);assert.equal(meter.take(),0,'idle time is not counted');
 meter.activity(310000);meter.sample(320000);assert.equal(meter.take(),10);meter.eligible(false,320000);meter.sample(800000);assert.equal(meter.take(),0,'hidden time excluded');meter.eligible(true,800000);meter.activity(800000);meter.sample(860000);assert.equal(meter.take(),0,'sleep gap excluded');
 const a=fixture();assert.equal(a.writes.length,0,'no heartbeat before server verification');a.verify(null,{fromCache:true});assert.equal(a.writes.length,0,'cached identity not sufficient');a.verify();await settle();assert.equal(a.writes.length,1);
 for(let i=0;i<12;i++)await a.step(10000,true);assert.equal(a.writes.length,2);assert.equal(a.writes[1].seconds,120);
 const at=a.writes.length;for(let i=0;i<8;i++){a.set({focused:false});await settle();a.set({focused:true});a.api.activity();a.verify();await settle();await a.step(1000,true);}assert.equal(a.writes.length,at+1,'focus thrash sends one closing write, no per-focus write');
 a.set({visible:false});await settle();const hiddenWrites=a.writes.length,hiddenSubs=a.subscriptions.filter(s=>s.active).length;assert.equal(hiddenSubs,0);for(let i=0;i<360;i++)await a.step(10000);assert.equal(a.writes.length,hiddenWrites,'hidden for one hour creates no writes or listeners');
 a.set({visible:true,focused:true});a.api.activity();a.verify();await settle();assert(a.writes.at(-1).seconds<120,'return never credits hidden hour');
 const idle=fixture();idle.verify();await settle();for(let i=0;i<360;i++)await idle.step(10000);assert.equal(idle.writes.length,4,'initial, two heartbeats, one idle close only');assert.equal(idle.writes.reduce((sum,w)=>sum+w.seconds,0),300);assert.equal(idle.subscriptions.filter(s=>s.active).length,0);
 const b=fixture({storage:idle.storage,locks:idle.locks});b.verify();await settle();const c=fixture({storage:idle.storage,locks:idle.locks});c.verify();await settle();assert.equal(c.subscriptions.length,0,'only lock owner checks/records presence');assert.equal(c.writes.length,0);
 b.set({focused:false});await settle();await c.step(10000,true);c.verify();await settle();assert.equal(c.subscriptions.filter(s=>s.active).length,1,'lock handoff works');
 c.set({online:false});await settle();const offlineWrites=c.writes.length;for(let i=0;i<12;i++)await c.step(10000,true);assert.equal(c.writes.length,offlineWrites);assert.equal(c.subscriptions.filter(s=>s.active).length,0);
 const pending=fixture();let done;pending.defer(new Promise(resolve=>done=resolve));pending.verify();assert(pending.api.state().inflight);for(let i=0;i<24;i++)await pending.step(10000,true);assert.equal(pending.writes.length,1,'no overlapping writes');pending.api.stop();done();await settle();assert(!pending.api.state().held,'pagehide while write pending releases lock');
 const bad=fixture();bad.verify({activeSession:{id:'other'}});await settle();assert.equal(bad.duplicates,1);assert.equal(bad.writes.length,0,'duplicate remote session never writes');
 const timeout=fixture();await timeout.step(20001);assert.equal(timeout.subscriptions.filter(s=>s.active).length,0);const count=timeout.subscriptions.length;await timeout.step(10000,true);assert.equal(timeout.subscriptions.length,count,'verification failure has cooldown');
 const account=fixture();account.verify();await settle();await account.step(10000,true);account.user({uid:'u2',studentId:'1520102',remoteId:'r2',allowed:true});await settle();account.api.tick();account.verify();await settle();assert.equal(account.writes.at(-1).owner.uid,'u2');assert.equal(account.writes.at(-1).seconds,0,'previous student time does not leak');
 const failure=fixture();failure.set({fail:true,storageFail:true});failure.verify();await settle();for(let i=0;i<11;i++)await failure.step(10000,true);assert.equal(failure.writes.length,1,'storage unavailable still respects heartbeat interval');await failure.step(10000,true);assert.equal(failure.writes.length,2);assert.equal(failure.writes[1].seconds,120,'failed increment not re-added');
 const unsupported=fixture({noLocks:true});unsupported.verify();await settle();assert.equal(unsupported.writes.length,0,'unsupported browser does not double-count');unsupported.verify({activeSession:{id:'other'}});assert.equal(unsupported.duplicates,1,'single-login check remains even without Web Locks');
 for(const item of [a,idle,b,c,pending,bad,timeout,account,failure,unsupported])item.api.stop();await settle();
 console.log('PASS student activity: foreground/idle/sleep clocks, trusted-session gating, hourly idle cap, focus throttling, multi-tab lock/handoff, offline, pending writes, duplicate login, verification timeout, account isolation and storage/write failures.');
})().catch(error=>{console.error(error);process.exitCode=1;});
