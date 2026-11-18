'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../shared/teacher-data.js'),'utf8');
let checks=0;
const check=(value,message)=>{assert(value,message);checks++;};
const doc=(id,data)=>({id,data:()=>data});
function fixture(){
 const context={setTimeout,clearTimeout};vm.runInNewContext(source,context);
 const subscriptions=[],reads=[],timers=new Map();let serial=0;
 const rosters=Array.from({length:28},(_,i)=>doc('15101'+String(i+1).padStart(2,'0'),{studentId:'15101'+String(i+1).padStart(2,'0'),classRoom:'701',name:'假資料'}));
 const users=rosters.map((r,i)=>doc('uid-'+i,i%2?{profile:{studentId:r.id}}:{studentId:r.id,profile:{studentId:r.id}}));
 const data={rosters,users};
 const filtered=(type,filters)=>(data[type]||[]).filter(document=>filters.every(([field,op,value])=>{const actual=field.split('.').reduce((a,k)=>a?.[k],document.data());return op==='in'?value.includes(actual):actual===value;}));
 let getHook=null;
 const ref=(type,filters=[])=>({where(field,op,value){return ref(type,[...filters,[field,op,value]]);},onSnapshot(options,ok,error){const sub={type,filters,options,ok,error,active:true};subscriptions.push(sub);return()=>{sub.active=false;};},get(options){reads.push({type,filters,options});return getHook?getHook(type,filters):Promise.resolve({docs:filtered(type,filters)});}});
 let state,lastData;
 const controller=context.TeacherData.create({db:{collection:ref},onState:s=>{state=s;},onData:value=>{lastData=value;},setTimer:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id)});
 const emit=(sub,metadata={fromCache:false})=>sub.ok({docs:filtered(sub.type,sub.filters),metadata});
 const finish=()=>{const seen=new Set();let sub;while((sub=subscriptions.find(item=>item.active&&!seen.has(item)))){seen.add(sub);emit(sub);}};
 return{controller,context,subscriptions,reads,timers,data,emit,finish,state:()=>state,lastData:()=>lastData,setGetHook:hook=>{getHook=hook;}};
}
(async()=>{
 {
  const f=fixture();f.controller.watchClass('701');check(f.subscriptions.length===1&&f.subscriptions[0].filters[0][0]==='classRoom','only class roster is read first');
  f.emit(f.subscriptions[0],{fromCache:true});check(f.subscriptions.length===1&&f.state().phase==='loading','cache roster does not authorize progress reads or actions');
  f.emit(f.subscriptions[0]);check(f.subscriptions.length===4,'28 students first use only three canonical queries plus one roster');
  check(f.subscriptions.slice(1).every(s=>s.filters.length===1&&s.filters[0][1]==='in'&&s.filters[0][2].length<=10),'never listen to whole users collection or rely on profile class field');
  f.finish();check(f.state().phase==='ready'&&f.lastData().progressRows.length===28&&f.subscriptions.length===6,'legacy fallback only queries 14 unmatched students, never duplicates canonical records');
  f.controller.watchClass('701');check(f.subscriptions.length===6,'same class does not re-register');
  for(let i=0;i<100;i++)f.emit(f.subscriptions[1]);check(f.subscriptions.length===6,'100 document updates do not attach more listeners');
  f.data.rosters[0]=doc(f.data.rosters[0].id,{...f.data.rosters[0].data(),verificationCode:'synthetic'});f.emit(f.subscriptions[0]);check(f.subscriptions.length===6,'verification-code changes do not reload progress cohorts');
  const old=[...f.subscriptions];f.controller.watchClass('702');check(old.every(s=>!s.active)&&f.lastData().rosterRows.length===0,'switch cancels old class and clears stale rows');
  f.emit(old[0]);check(f.lastData().classRoom==='702','late callbacks cannot restore another class');f.controller.dispose();check(f.subscriptions.every(s=>!s.active)&&f.timers.size===0,'dispose stops all listeners and timers');
 }
 {
  const f=fixture();f.controller.watchClass('701',{progress:false});f.finish();check(f.subscriptions.length===1&&f.state().phase==='ready','roster administration never queries users');f.controller.dispose();
 }
 {
  const f=fixture();f.controller.watchClass('702');f.finish();check(f.subscriptions.length===1&&f.state().phase==='ready'&&f.lastData().progressRows.length===0,'empty class does not query or monitor any users');f.controller.dispose();
 }
 {
  const f=fixture();f.data.users=f.data.rosters.map((r,i)=>doc('uid-'+i,{studentId:r.id,profile:{studentId:r.id}}));
  f.controller.watchClass('701');f.finish();check(f.subscriptions.length===4&&!f.subscriptions.some(s=>s.filters[0][0]==='profile.studentId'),'canonical students are never listened to through two fields');f.controller.dispose();
 }
 {
  const f=fixture();f.controller.watchClass('701');f.finish();const legacyId=f.data.rosters[1].id;
  f.data.users[1]=doc('uid-1',{studentId:legacyId,profile:{studentId:legacyId}});f.emit(f.subscriptions[1]);f.finish();
  check(f.lastData().progressRows.length===28&&f.subscriptions.filter(s=>s.active&&s.filters[0][0]==='profile.studentId').every(s=>!s.filters[0][2].includes(legacyId)),'new canonical identity removes its legacy fallback without dropping classmates');f.controller.dispose();
 }
 for(const code of ['permission-denied','resource-exhausted','unauthenticated','unavailable','failed-precondition']){
  const f=fixture();f.controller.watchClass('701');f.emit(f.subscriptions[0]);f.subscriptions[1].error({code});
  check(f.state().phase==='error'&&f.subscriptions.every(s=>!s.active)&&!f.timers.size,'source error stops all reads without retry: '+code);
  check(!f.state().rosterReady&&!f.state().progressReady,'error cannot be used as complete data: '+code);
 }
 {
  const f=fixture();f.controller.watchClass('701');[...f.timers.values()][0]();check(f.state().phase==='error'&&f.subscriptions.every(s=>!s.active)&&f.subscriptions.length===1,'timeout stops initial read, never retries');
 }
 {
  const f=fixture();f.controller.watchClass('701');f.finish();const old=f.subscriptions[1];
  const saved=f.data.rosters;f.data.rosters=[];f.emit(f.subscriptions[0]);f.data.rosters=saved;f.emit(f.subscriptions[0]);f.finish();
  old.ok({docs:[],metadata:{fromCache:false}});check(f.lastData().progressRows.length===28,'A-B-A roster edits reject stale same-signature cohort callbacks');f.controller.dispose();
 }
 {
  const f=fixture();const result=await f.controller.fetchClass('701');check(result.rosterRows.length===28&&result.progressRows.length===28&&f.reads.length===6,'manual class fetch preserves legacy users with only unmatched fallback queries');
  check(f.subscriptions.length===0&&f.reads.every(r=>r.options.source==='server'),'manual fetch does not create listeners or return offline cache as current');
 }
 {
  const f=fixture();let current=true;f.setGetHook(()=>{current=false;return Promise.resolve({docs:f.data.rosters});});
  await assert.rejects(()=>f.controller.fetchClass('701',()=>current),e=>e.code==='cancelled');check(f.reads.length===1,'leaving during manual roster fetch prevents subsequent user queries');
 }
 {
  const f=fixture();f.setGetHook(()=>Promise.reject(Object.assign(new Error('synthetic denied'),{code:'permission-denied'})));
  await assert.rejects(()=>f.controller.fetchClass('701'));check(f.reads.length===1&&f.timers.size===0,'manual failures have no retries or leaked deadline timers');
 }
 console.log('PASS '+checks+' offline class-scoped read/lifecycle checks; no network or writes.');
})().catch(error=>{console.error(error);process.exitCode=1;});
