'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../shared/presence.js'),'utf8').replace(/^import .*;\r?$/gm,'');
let options,authChange,profile={studentId:'1510101'},serial=0;const writes=[],session=new Map(),events=[];
const app={firebaseConfig:{projectId:'fake'},currentTermId:'115-1',studentIdPattern:/^15[12]\d{4}$/,studentEmailDomain:'students.jimwang-4b0ca.firebaseapp.com',isFirebaseConfigured:()=>true};
const context={console,performance:{now:()=>1000},location:{pathname:'/terms/115-1/index.html'},navigator:{onLine:true,locks:{}},document:{visibilityState:'visible',hasFocus:()=>true,addEventListener:(name,fn)=>events.push(name)},localStorage:{},sessionStorage:{getItem:key=>session.get(key),setItem:(key,value)=>session.set(key,value)},crypto:{randomUUID:()=>String(++serial)},setTimeout,clearTimeout,setInterval,clearInterval,
 getApps:()=>[{}],getApp:()=>({}),getAuth:()=>({}),getFirestore:()=>({}),onAuthStateChanged:(auth,fn)=>{authChange=fn;},signOut:async()=>{},
 doc:(db,...parts)=>parts.join('/'),increment:seconds=>({increment:seconds}),serverTimestamp:()=>({server:true}),deleteField:()=>({delete:true}),setDoc:async(...args)=>writes.push(args),onSnapshot:(...args)=>{context.snapshotArgs=args;return()=>{};}};
context.window={SCHOOL_APP:app,StudentActivity:{create:settings=>{options=settings;return{tick(){},activity(){},stop(){}};}},LearnerProfile:{readLocalProfile:()=>profile,hasActiveSession:()=>true,getRemoteSessionId:()=> 'remote_1',checkBrowserStudent:()=>({allowed:true})},addEventListener:(name,fn)=>events.push(name)};
vm.runInNewContext(source,context);
(async()=>{
 assert.equal(options.identity(),null);authChange({uid:'teacher',email:'jimwang@mail.qfm.kh.edu.tw'});assert.equal(options.identity(),null,'teacher cannot be recorded under saved student profile');
 authChange({uid:'u1',email:'1510101@students.jimwang-4b0ca.firebaseapp.com'});const owner=options.identity();assert.equal(owner.studentId,'1510101');assert.equal(owner.uid,'u1');
 options.subscribe(owner,()=>{},()=>{});assert.equal(context.snapshotArgs[0],'users/u1');assert.equal(context.snapshotArgs[1].includeMetadataChanges,true);
 await options.write({owner,seconds:7,closing:false,legacy:{totalActiveSeconds:600}});const [pathname,payload,merge]=writes[0];assert.equal(pathname,'users/u1');assert.equal(merge.merge,true);
 const usage=payload.terms['115-1'].usage;assert.equal(usage.totalActiveSeconds.increment,7);assert.equal(usage.activeV2Seconds.increment,7);assert.equal(usage.legacyActiveSeconds,600);assert.equal(usage.measurementVersion,'active-v2');assert(usage.measuredSince.server);assert.equal(payload.terms['115-1'].presence.isActive,true);
 assert([...session.keys()].every(key=>key.includes('115-1.u1')),'session keys include term and UID');assert(Object.values(usage.sessions)[0].startedAt.server);
 await options.write({owner,seconds:2,closing:true,legacy:{totalActiveSeconds:600}});const second=writes[1][1].terms['115-1'];assert.equal(second.presence.isActive,false);assert(!('legacyActiveSeconds'in second.usage),'baseline not overwritten by a stale snapshot');assert(!('measuredSince'in second.usage));assert(!('startedAt'in Object.values(second.usage.sessions)[0]));
 profile={studentId:'1520102'};assert.equal(options.identity(),null,'mismatched local profile blocks writes');await options.write({owner,seconds:999,closing:false,legacy:{}});assert.equal(writes.length,2);
 authChange({uid:'u2',email:'1520102@students.jimwang-4b0ca.firebaseapp.com'});const next=options.identity();await options.write({owner:next,seconds:0,closing:false,legacy:{measurementVersion:'active-v2',totalActiveSeconds:12}});assert.equal(writes.at(-1)[0],'users/u2');assert([...session.keys()].some(key=>key.includes('115-1.u2')));assert(!('legacyActiveSeconds'in writes.at(-1)[1].terms['115-1'].usage));
 assert(events.includes('visibilitychange')&&events.includes('pagehide')&&events.includes('portal:authenticated'));
 console.log('PASS presence adapter: authoritative Auth/profile match, metadata verification, correct UID/term paths, increment-only usage, preserved baseline/start time, separate session IDs and stale-owner guard; Firebase imports mocked.');
})().catch(error=>{console.error(error);process.exitCode=1;});
