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
   window.fixtureServerTime=20000;window.firebase.firestore.FieldValue={serverTimestamp:()=>({seconds:window.fixtureServerTime,nanoseconds:0})};
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
  const refreshButton=page.getByRole('button',{name:'增量更新／接續全年級'});
  page.once('dialog',dialog=>dialog.accept());await refreshButton.click();
  await page.waitForFunction(()=>document.getElementById('question-attempt-count').textContent==='5006');
  assert.match(await page.locator('#questions-note').textContent(),/全年級更新基準已確認/);
  await page.evaluate(term=>{
    window.addAttempt('e',21000,true);window.fixtureServerTime=40000;
    for(let i=5002;i<=10002;i++)window.fixture.rows.set('quizAttempts/u702/events/a'+String(i).padStart(5,'0'),{
      termId:term,questionId:'q_fixture',questionText:'測試題',createdAt:{seconds:21000+i,nanoseconds:0},correct:true,elapsedSeconds:2,source:'fixture',optionCount:3,selectedIndex:0
    });
    window.fixture.reads.length=0;
  },term);
  page.once('dialog',dialog=>dialog.dismiss());await refreshButton.click();
  assert.equal(await page.evaluate(()=>window.fixture.reads.length),0,'no increment until the teacher confirms');
  page.once('dialog',dialog=>dialog.accept());await refreshButton.click();
  await page.waitForFunction(()=>document.getElementById('questions-note').textContent.includes('本次已掃描 5,000 筆作答。進度已保存'));
  assert.match(await page.locator('#questions-note').textContent(),/增量更新／接續全年級.*接續查詢新作答/);
  assert.equal(await page.locator('#question-attempt-count').textContent(),'—');
  await page.locator('#questions-class-buttons [data-class="701"]').click();
  assert.equal(await refreshButton.isVisible(),false,'only available under grade scope');
  await page.locator('#questions-class-buttons [data-class="all"]').click();
  await page.locator('#questions-reload').click();
  await page.waitForFunction(()=>document.getElementById('questions-note').textContent.includes('全年級增量更新尚未完成'));
  assert.equal(await page.locator('#question-attempt-count').textContent(),'—','manual reload must not expose mixed snapshots after changing scope');
  await page.evaluate(()=>{window.addAttempt('late',40001,true);window.fixtureServerTime=50000;window.fixture.reads.length=0;});
  page.once('dialog',dialog=>dialog.accept());await refreshButton.click();
  await page.waitForFunction(()=>document.getElementById('question-attempt-count').textContent==='10008');
  assert.match(await page.locator('#questions-note').textContent(),/全年級增量更新完成：已處理 2 個受影響的班級/);
  assert(!await page.evaluate(()=>window.fixture.reads.some(row=>row.pathname.startsWith('quizAttempts/'))),'normal fast path never reads individual raw histories');
  assert.deepEqual(await page.evaluate(()=>window.fixture.reads.filter(row=>row.kind==='collection'&&row.pathname==='rosters').map(row=>row.filters[0][2])),['701','702'],'only reload the affected class rosters');
  page.once('dialog',dialog=>dialog.accept());await refreshButton.click();
  await page.waitForFunction(()=>document.getElementById('question-attempt-count').textContent==='10009');
  await page.evaluate(()=>{window.fixture.reads.length=0;});
  page.once('dialog',dialog=>dialog.accept());await refreshButton.click();
  await page.waitForFunction(()=>document.getElementById('questions-note').textContent.includes('沒有新作答，已載入現有彙總'));
  assert.equal(await page.locator('#question-attempt-count').textContent(),'10009');
  assert.equal(await page.evaluate(()=>window.fixture.reads.filter(row=>row.kind==='group').length),1);
  assert(!await page.evaluate(()=>window.fixture.reads.some(row=>row.pathname.includes('/students/')||/^rosters|^users|^quizAttempts/.test(row.pathname))),'no student, roster or prior response reads when there are no new attempts');
  await page.locator('#questions-tab details summary').click();page.once('dialog',dialog=>dialog.accept());await page.locator('#leaderboard-archive').click();await page.waitForFunction(()=>document.getElementById('leaderboard-archive-status').textContent.includes('快照已完成'));
  assert.equal(await page.evaluate(term=>window.fixture.rows.get('leaderboards/'+term+'/difficulties/easy/archive/top20').rows.length,term),1);
  assert.equal(await page.evaluate(()=>window.fixture.writes.some(row=>row.pathname.startsWith('quizAttempts/')||row.pathname.includes('/scores/'))),false,'raw attempts and legacy scores never changed');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS teacher analytics UI, both terms: explicit initial and incremental grade actions, 5,000-row resume, blocked mixed reload, automatic full-grade display, cutoff isolation, archive and usage labels; all data local.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
