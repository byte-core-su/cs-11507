'use strict';
// All Firebase imports replaced by local doubles; real browser Web Locks only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'shared/presence.js'),'utf8').replace(/^import .*;\r?$/gm,'');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.NOTION_TEST_BROWSER?{executablePath:process.env.NOTION_TEST_BROWSER}:{})});
 try{for(const term of ['115-1','115-2']){
  const context=await browser.newContext(),errors=[];
  await context.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='example.invalid')throw Error('Unexpected network request');return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Offline presence test</title><main>假資料</main>'});});
  async function setup(){
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
   await page.clock.install({time:new Date('2026-11-19T01:00:00Z')});await page.goto('https://example.invalid/terms/'+term+'/index.html');
   await page.clock.pauseAt(new Date('2026-11-19T01:01:00Z'));
   await page.addScriptTag({content:fs.readFileSync(path.join(root,'shared/student-activity.js'),'utf8')});
   await page.evaluate(term=>{
    window.testFocused=true;window.testHidden=false;window.testWrites=[];window.testSubs=[];
    Object.defineProperty(document,'hasFocus',{value:()=>window.testFocused});Object.defineProperty(document,'visibilityState',{get:()=>window.testHidden?'hidden':'visible'});
    window.SCHOOL_APP={firebaseConfig:{projectId:'fake'},currentTermId:term,studentIdPattern:/^15[12]\d{4}$/,studentEmailDomain:'students.jimwang-4b0ca.firebaseapp.com',isFirebaseConfigured:()=>true,rootPath:'/'};
    window.LearnerProfile={readLocalProfile:()=>({studentId:'1510101'}),hasActiveSession:()=>true,getRemoteSessionId:()=> 'r1',checkBrowserStudent:()=>({allowed:true}),endSession(){}};
    Object.assign(window,{getApps:()=>[{}],getApp:()=>({}),getAuth:()=>({}),getFirestore:()=>({}),onAuthStateChanged:(auth,fn)=>fn({uid:'u1',email:'1510101@students.jimwang-4b0ca.firebaseapp.com'}),signOut:async()=>{},doc:(db,...parts)=>parts.join('/'),increment:seconds=>({increment:seconds}),serverTimestamp:()=>({server:true}),deleteField:()=>({delete:true}),setDoc:async(ref,data)=>{window.testWrites.push({ref,data});},onSnapshot:(ref,options,next,error)=>{const sub={ref,next,error,active:true};window.testSubs.push(sub);next({data:()=>({activeSession:{id:'r1'},terms:{}}),metadata:{fromCache:false,hasPendingWrites:false}});return()=>{sub.active=false;};}});
   },term);
   await page.addScriptTag({content:source});return page;
  }
  const first=await setup();await first.waitForFunction(()=>window.testWrites.length===1);
  await first.clock.runFor(120000);await first.waitForFunction(()=>window.testWrites.length===2);
  assert.equal(await first.evaluate(term=>window.testWrites[1].data.terms[term].usage.activeV2Seconds.increment,term),120);
  const second=await setup();await second.waitForTimeout(30);
  assert.equal(await second.evaluate(()=>window.testSubs.length),0,'actual Web Lock prevents a second learner tab subscribing/counting');
  await first.evaluate(()=>{window.testHidden=true;document.dispatchEvent(new Event('visibilitychange'));});
  await first.waitForFunction(()=>window.testSubs.every(sub=>!sub.active));const before=await first.evaluate(()=>window.testWrites.length);
  await first.clock.runFor(3600000);assert.equal(await first.evaluate(()=>window.testWrites.length),before,'background hour has zero extra writes');
  await second.evaluate(()=>window.dispatchEvent(new Event('focus')));await second.waitForFunction(()=>window.testSubs.some(sub=>sub.active));
  await second.evaluate(()=>window.testSubs.find(sub=>sub.active).next({data:()=>({activeSession:{id:'another'}}),metadata:{fromCache:false,hasPendingWrites:false}}));
  await second.waitForURL('**/index.html?duplicateLogin=1');assert.deepEqual(errors,[]);
  await context.close();
 }
 console.log('PASS real browser presence, both terms: bounded heartbeat increments, actual same-origin multi-tab Web Lock, background hour pause, handoff and duplicate-login redirect; all Firebase calls mocked.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
