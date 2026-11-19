'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{fakeFirestore}=require('./fake-firestore.cjs'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'shared/teacher.html'),'utf8'),script=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(([,attrs])=>!attrs.includes('src='))[2];
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.NOTION_TEST_BROWSER?{executablePath:process.env.NOTION_TEST_BROWSER}:{})});
 try{for(const term of ['115-1','115-2']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url()),callback=url.searchParams.get('callback');if(url.hostname!=='example.invalid'||!callback)throw Error('Unexpected request');return route.fulfill({contentType:'application/javascript',body:`${callback}({status:'success',notion:{configured:false}})`});});
  await page.setContent(html.replace(/<script[^>]*>[\s\S]*?<\/script>/g,''));
  await page.addScriptTag({content:'window.fakeFirestore='+fakeFirestore.toString()+';'});
  for(const file of ['learning-certificates.js','teacher-data.js','teacher-analytics.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'shared',file),'utf8')});
  await page.evaluate(term=>{
   window.SCHOOL_APP={firebaseConfig:{},currentTermId:term,studentEmailDomain:'example.invalid'};window.LEARNING_CLASSROOM_CONFIG={endpoint:'https://example.invalid/exec'};
   window.fixture=window.fakeFirestore({'rosters/1510101':{studentId:'1510101',classRoom:'701',seatNo:'1',name:'假資料甲'},'users/u1':{studentId:'1510101',profile:{studentId:'1510101'},terms:{[term]:{usage:{totalActiveSeconds:600,activeV2Seconds:120,measurementVersion:'active-v2',measuredSince:'2026-11-19T01:00:00Z'}}}}});
   window.addAttempt=(id,seconds,correct)=>window.fixture.rows.set('quizAttempts/u1/events/'+id,{termId:term,questionId:'q_fixture',questionText:'測試題',createdAt:{seconds,nanoseconds:0},correct,elapsedSeconds:2,source:'fixture',optionCount:3,selectedIndex:correct?0:1});
   window.addAttempt('a',1,false);window.addAttempt('b',2,true);
   window.fixture.rows.set('leaderboards/'+term+'/difficulties/easy/scores/old',{studentId:'1510101',score:100});
   const auth={setPersistence(){},onAuthStateChanged(fn){fn({email:'jimwang@mail.qfm.kh.edu.tw'});}};
   window.firebase={initializeApp:()=>({}),auth:()=>auth,firestore:()=>window.fixture.db};window.firebase.auth.Auth={Persistence:{SESSION:'session'}};window.firebase.firestore.FieldPath={documentId:()=> '__name__'};window.firebase.firestore.Timestamp=class{constructor(seconds,nanoseconds){Object.assign(this,{seconds,nanoseconds});}};
  },term);
  await page.addScriptTag({content:script});await page.waitForFunction(()=>document.querySelectorAll('#mission-cards article').length===1);
  await page.locator('[data-tab="progress"]').click();await page.waitForFunction(()=>document.getElementById('progress-note').textContent.includes('無法回溯校正'));assert.match(await page.locator('#progress-body').textContent(),/新版有效/);
  await page.locator('[data-tab="questions"]').click();await page.locator('#questions-reload').click();await page.waitForFunction(()=>document.getElementById('questions-note').textContent.includes('尚無完整彙總'));
  page.once('dialog',dialog=>dialog.accept());await page.locator('#questions-update').click();await page.waitForFunction(()=>document.getElementById('question-attempt-count').textContent==='2');
  assert.equal(await page.locator('#question-student-count').textContent(),'1');assert.match(await page.locator('#questions-body').textContent(),/0%/,'first wrong answer preserved');
  await page.evaluate(()=>window.addAttempt('c',3,true));await page.locator('#questions-reload').click();await page.waitForFunction(()=>document.getElementById('questions-summary').textContent.includes('次作答'));assert.equal(await page.locator('#question-attempt-count').textContent(),'2','reload never secretly scans new raw attempts');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#questions-update').click();await page.waitForFunction(()=>document.getElementById('question-attempt-count').textContent==='3');
  assert.equal(await page.locator('#questions-grade-update').isVisible(),false,'grade action is only shown in grade scope');
  await page.evaluate(term=>{
    for(const [classRoom,count] of [['702',5001],['703',1]]){
      const studentId='1510'+classRoom.slice(-1)+'01',uid='u'+classRoom;
      window.fixture.rows.set('rosters/'+studentId,{studentId,classRoom,seatNo:'1',name:'測試學生'});
      window.fixture.rows.set('users/'+uid,{studentId});
      for(let i=1;i<=count;i++)window.fixture.rows.set('quizAttempts/'+uid+'/events/a'+String(i).padStart(5,'0'),{
        termId:term,questionId:'q_fixture',questionText:'測試題',createdAt:{seconds:i,nanoseconds:0},correct:true,elapsedSeconds:2,source:'fixture',optionCount:3,selectedIndex:0
      });
    }
    window.addAttempt('d',4,true);
    window.fixture.reads.length=0;
  },term);
  await page.locator('#questions-class-buttons [data-class="all"]').click();
  const gradeButton=page.getByRole('button',{name:'整理／接續全年級'});
  assert.equal(await page.locator('#questions-update').isVisible(),false);
  page.once('dialog',dialog=>dialog.dismiss());await gradeButton.click();
  assert.equal(await page.evaluate(()=>window.fixture.reads.length),0,'cancelling confirmation does not query Firestore');
  page.once('dialog',dialog=>dialog.accept());await gradeButton.click();
  await page.waitForFunction(()=>document.getElementById('questions-note').textContent.includes('本次已掃描 5,000 筆作答。進度已保存'));
  assert.match(await page.locator('#questions-note').textContent(),/已完成 1／11 班.*702 班接續/);
  assert.equal(await page.locator('#question-attempt-count').textContent(),'—','never displays a partial grade total');
  assert.equal(await page.evaluate(()=>window.fixture.reads.filter(row=>row.pathname.startsWith('quizAttempts/')).every(row=>row.pathname==='quizAttempts/u702/events')),true,'701 skipped and 703 deferred');
  await page.locator('#questions-reload').click();
  await page.waitForFunction(()=>document.getElementById('questions-note').textContent.includes('702 班尚無完整彙總'));
  assert.equal(await page.locator('#question-attempt-count').textContent(),'—');
  page.once('dialog',dialog=>dialog.accept());await gradeButton.click();
  await page.waitForFunction(()=>document.getElementById('question-attempt-count').textContent==='5005');
  assert.equal(await page.locator('#question-student-count').textContent(),'3','automatically merges finished grade, keeping original 701 snapshot');
  assert.match(await page.locator('#questions-note').textContent(),/711：/,'all classes included, even those with zero attempts');
  await page.locator('#questions-tab details summary').click();page.once('dialog',dialog=>dialog.accept());await page.locator('#leaderboard-archive').click();await page.waitForFunction(()=>document.getElementById('leaderboard-archive-status').textContent.includes('快照已完成'));
  assert.equal(await page.evaluate(term=>window.fixture.rows.get('leaderboards/'+term+'/difficulties/easy/archive/top20').rows.length,term),1);
  assert.equal(await page.evaluate(()=>window.fixture.writes.some(row=>row.pathname.startsWith('quizAttempts/')||row.pathname.includes('/scores/'))),false,'raw attempts and legacy scores never changed');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS teacher analytics UI, both terms: class/grade scope actions, grade confirmation and 5,000-row resume, hides partial totals, automatic full-grade display, class-only increments, archive and usage labels; all data local.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
