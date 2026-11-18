'use strict';
// No external services: strip scripts and supply an in-memory Firestore double.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'shared/teacher.html'),'utf8');
const script=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(([,attrs])=>!attrs.includes('src='))[2];
const markup=html.replace(/<script[^>]*>[\s\S]*?<\/script>/g,'');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.NOTION_TEST_BROWSER?{executablePath:process.env.NOTION_TEST_BROWSER}:{})});
 try{for(const term of ['115-1','115-2']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install({time:new Date('2026-11-18T01:00:00Z')});
  await page.route('**/*',route=>{const url=new URL(route.request().url()),callback=url.searchParams.get('callback');if(url.hostname!=='example.invalid'||!callback)throw Error('Unexpected network: '+url);return route.fulfill({contentType:'application/javascript',body:`${callback}({status:'success',notion:{configured:true,syncVersion:'learning-archive-v7'}})`});});
  await page.setContent(markup);
  for(const file of ['shared/learning-certificates.js','shared/teacher-data.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
  await page.evaluate(term=>{
   window.SCHOOL_APP={firebaseConfig:{},currentTermId:term,studentEmailDomain:'example.invalid'};window.LEARNING_CLASSROOM_CONFIG={endpoint:'https://example.invalid/exec'};
   window.testHidden=false;window.testOnline=true;window.holdSnapshots=false;window.deferEvents=false;
   Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.testHidden});Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>window.testOnline});
   window.testSubscriptions=[];window.testReads=[];window.pendingEvents=[];
   const documentFor=(id,data)=>({id,data:()=>data});
   const data={rosters:[documentFor('1510101',{studentId:'1510101',classRoom:'701',seatNo:'1',name:'甲'}),documentFor('1520102',{studentId:'1520102',classRoom:'701',seatNo:'2',name:'乙'}),documentFor('1510201',{studentId:'1510201',classRoom:'702',seatNo:'1',name:'丙'})],users:[documentFor('u1',{studentId:'1510101',profile:{studentId:'1510101'},terms:{[term]:{}}}),documentFor('u2',{profile:{studentId:'1520102'},terms:{[term]:{}}}),documentFor('u3',{studentId:'1510201',profile:{studentId:'1510201'},terms:{[term]:{}}})]};
   const filter=(rows,filters)=>rows.filter(document=>filters.every(([field,op,value])=>{const actual=field.split('.').reduce((item,key)=>item?.[key],document.data());return op==='in'?value.includes(actual):actual===value;}));
   const ref=(type,filters=[],pathname=type)=>({where(field,op,value){return ref(type,[...filters,[field,op,value]],pathname);},doc(id){return ref(type,filters,pathname+'/'+id);},collection(name){return ref(type,filters,pathname+'/'+name);},onSnapshot(options,ok,error){const sub={type,filters,pathname,ok,error,active:true};window.testSubscriptions.push(sub);if(!window.holdSnapshots)ok({docs:filter(data[type]||[],filters),metadata:{fromCache:false}});return()=>{sub.active=false;};},get(options){window.testReads.push({type,filters,pathname,options});const rows=type==='quizAttempts'?[documentFor('attempt',{termId:term,questionId:'synthetic-q',questionText:'假資料題目',source:'fixture',correct:true,selectedIndex:0,optionCount:3,elapsedSeconds:1,createdAt:'2026-11-18T01:00:00Z'})]:data[type]||[];const snapshot={docs:filter(rows,filters)};if(type==='quizAttempts'&&window.deferEvents)return new Promise(resolve=>window.pendingEvents.push(()=>resolve(snapshot)));return Promise.resolve(snapshot);}});
   const auth={setPersistence(){return Promise.resolve();},onAuthStateChanged(fn){fn({email:'jimwang@mail.qfm.kh.edu.tw'});}};
   window.firebase={initializeApp:()=>({}),auth:()=>auth,firestore:()=>({collection:ref})};window.firebase.auth.Auth={Persistence:{SESSION:'session'}};
  },term);
  await page.addScriptTag({content:script});
  const liveCount=()=>page.evaluate(()=>window.testSubscriptions.filter(s=>s.active).length);
  assert.equal(await liveCount(),3,'class roster and two identity queries, no analytics at login');
  assert.equal(await page.evaluate(()=>window.testReads.length),0,'zero background analytics get calls');
  assert.equal(await page.locator('#mission-cards article').count(),2,'legacy identity included in selected class');
  assert.equal(await page.evaluate(()=>window.testSubscriptions.every(s=>s.filters.length===1)),true,'no whole-collection listener');
  await page.locator('[data-tab="live"]').click();assert.equal(await liveCount(),3,'same class reuses listeners');
  await page.locator('#live-class-buttons [data-class="702"]').click();assert.equal(await page.locator('#mission-cards article').count(),1);assert.equal(await liveCount(),2);
  assert.equal(await page.evaluate(()=>window.testSubscriptions.filter(s=>s.active&&s.type==='users').every(s=>s.filters[0][2].every(id=>id==='1510201'))),true,'only roster IDs of current class');
  await page.locator('[data-tab="questions"]').click();assert.equal(await liveCount(),0,'entering analytics detaches live class');assert.equal(await page.evaluate(()=>window.testReads.length),0,'entering analytics alone does not fetch history');
  await page.locator('#questions-reload').click();await page.waitForFunction(()=>document.getElementById('questions-summary').textContent.includes('次作答'));
  assert.equal(await page.locator('#question-attempt-count').textContent(),'2','complete class history, no truncated sample');
  assert.equal(await liveCount(),0,'one-shot stats create no listeners');
  const first=await page.evaluate(()=>window.testReads.length);await page.clock.fastForward(60000);assert.equal(await page.evaluate(()=>window.testReads.length),first,'no polling after load');
  await page.locator('#questions-class-buttons [data-class="all"]').click();assert.equal(await page.evaluate(()=>window.testReads.length),first,'scope selection alone does not fetch');
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('#questions-reload').click();assert.equal(await page.evaluate(()=>window.testReads.length),first,'grade-wide warning can cancel without reads');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#questions-reload').click();await page.waitForFunction(()=>document.getElementById('questions-summary').textContent.includes('次作答'));
  assert.equal(await page.locator('#question-attempt-count').textContent(),'3','grade reads classes sequentially and retains accurate totals');
  assert.equal(await page.evaluate(()=>window.testReads.every(r=>r.filters.length===1)),true,'manual reads are scoped too');
  await page.locator('#questions-class-buttons [data-class="701"]').click();await page.evaluate(()=>{window.deferEvents=true;});await page.locator('#questions-reload').click();await page.waitForFunction(()=>window.pendingEvents.length===1);
  const pending=await page.evaluate(()=>window.testReads.length);await page.locator('[data-tab="notion"]').click();await page.evaluate(()=>{window.pendingEvents.shift()();window.deferEvents=false;});await page.waitForTimeout(10);
  assert.equal(await page.evaluate(()=>window.testReads.length),pending,'leaving analytics prevents later students from being fetched');
  assert.equal(await page.locator('#notion-sync-button').isDisabled(),false,'Notion resumes its own scoped class data');
  await page.evaluate(()=>{window.testHidden=true;document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await liveCount(),0);assert.equal(await page.locator('#notion-sync-button').isDisabled(),true,'hidden data cannot synchronize Notion');
  await page.evaluate(()=>{window.testHidden=false;document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await liveCount(),0,'visibility return never auto reloads');
  await page.locator('#teacher-data-resume').click();assert.equal(await liveCount(),3);
  await page.clock.fastForward(5*60000+1);assert.equal(await liveCount(),0);assert.match(await page.locator('#teacher-data-status').textContent(),/閒置 5 分鐘/);
  await page.locator('#teacher-lesson-mode').check();assert.equal(await liveCount(),3);await page.clock.fastForward(6*60000);assert.equal(await liveCount(),3,'explicit lesson mode survives ordinary idle deadline');
  await page.clock.fastForward(39*60000+1);assert.equal(await liveCount(),0);assert.match(await page.locator('#teacher-data-status').textContent(),/45 分鐘/);
  await page.locator('#teacher-data-resume').click();await page.evaluate(()=>{window.testOnline=false;window.dispatchEvent(new Event('offline'));});assert.equal(await liveCount(),0);
  await page.evaluate(()=>{window.testOnline=true;window.dispatchEvent(new Event('online'));});assert.equal(await liveCount(),0,'online recovery is manual');
  await page.locator('#teacher-data-resume').click();await page.evaluate(()=>window.testSubscriptions.find(s=>s.active).error({code:'permission-denied'}));assert.equal(await liveCount(),0);assert.match(await page.locator('#teacher-data-status').textContent(),/權限不足/);
  const failed=await page.evaluate(()=>window.testSubscriptions.length);await page.clock.fastForward(600000);assert.equal(await page.evaluate(()=>window.testSubscriptions.length),failed,'permission failures never spin retries');
  await page.evaluate(()=>{window.holdSnapshots=true;});await page.locator('#teacher-data-resume').click();await page.clock.fastForward(20001);assert.equal(await liveCount(),0);assert.match(await page.locator('#teacher-data-status').textContent(),/逾時/);
  await page.evaluate(()=>{window.holdSnapshots=false;});await page.locator('[data-tab="roster"]').click();assert.equal(await liveCount(),1,'roster tab does not read student progress');
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));assert.equal(await liveCount(),0);assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('PASS teacher UI in both terms: scoped reads, legacy students, manual class/grade statistics, cancellation, hidden/offline/idle/lesson deadlines, timeout/errors and Notion gating; all APIs mocked.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
