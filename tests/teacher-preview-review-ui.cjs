'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {fakeFirestore}=require('./fake-firestore.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'shared/teacher.html'),'utf8');
const script=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(([,attrs])=>!attrs.includes('src='))[2];
const originalTime='2026-11-18T01:00:00Z';
const image=(id,modifiedAt=originalTime)=>({kind:'image',name:id+'.png',url:'https://drive.google.com/file/d/'+id+'/view',createdAt:originalTime,modifiedAt});
const video={kind:'video',name:'work.mp4',url:'https://drive.google.com/file/d/movie/view',createdAt:originalTime,modifiedAt:originalTime};
const reviewButton='[data-live-review="thinking"][data-live-status="approved"]';

(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.NOTION_TEST_BROWSER?{executablePath:process.env.NOTION_TEST_BROWSER}:{})});
 try{for(const term of ['115-1','115-2']){
  const page=await browser.newPage(),errors=[],calls=[];
  let records=[
   {studentId:'1510101',classroomUserId:'10001',classRoom:'701',state:'TURNED_IN',updateTime:originalTime,attachments:[image('a'),image('b'),video]},
   {studentId:'1510102',classroomUserId:'10002',classRoom:'701',state:'TURNED_IN',updateTime:originalTime,attachments:[image('other')]}
  ],fakeFailure='',misdirect=false,hold=false,deliver=null;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url()),callback=url.searchParams.get('callback'),action=url.searchParams.get('action');
   if(url.hostname!=='example.invalid'||!callback)throw Error('Unexpected request: '+url);
   calls.push(Object.fromEntries(url.searchParams));
   const data={
    'notion-status':{notion:{configured:false}},
    courses:{courses:[{id:'301',name:'701 資訊科技'}]},
    assignments:{assignments:[{id:'41',title:'測試作業'}]},
    submissions:{submissions:records}
   }[action];
   let out;
   if(action==='review-submission'){
    const actual=records.find(item=>item.classroomUserId===url.searchParams.get('classroomUserId'));
    out=fakeFailure?{status:'error',message:fakeFailure}:{status:'success',courseId:'301',courseWorkId:misdirect?'999':'41',submission:actual};
   }else if(data)out={status:'success',...data};
   else throw Error('Unexpected Classroom action: '+action);
   const response={contentType:'application/javascript',body:callback+'('+JSON.stringify(out)+');'};
   if(action==='review-submission'&&hold){
    await new Promise(resolve=>{deliver=resolve;});
    return route.fulfill(response).catch(()=>{}); // Browser may already have aborted this script.
   }
   return route.fulfill(response);
  });
  await page.setContent(html.replace(/<script[^>]*>[\s\S]*?<\/script>/g,''));
  await page.addScriptTag({content:'window.fakeFirestore='+fakeFirestore.toString()+';'});
  for(const file of ['learning-certificates.js','teacher-data.js','teacher-analytics.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'shared',file),'utf8')});
  await page.evaluate(term=>{
   const email='jimwang@mail.qfm.kh.edu.tw';
   window.SCHOOL_APP={firebaseConfig:{},currentTermId:term,studentEmailDomain:'example.invalid'};window.LEARNING_CLASSROOM_CONFIG={endpoint:'https://example.invalid/exec'};
   window.testHidden=false;
   Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.testHidden});
   window.changeVisibility=hidden=>{window.testHidden=hidden;document.dispatchEvent(new Event('visibilitychange'));};
   // Simulate the preview switching away without opening a real Google page.
   document.addEventListener('click',event=>{if(event.target.closest('[data-live-review-preview]'))event.preventDefault();});
   window.fixture=window.fakeFirestore({
    'rosters/1510101':{studentId:'1510101',classRoom:'701',seatNo:'1',name:'甲'},
    'rosters/1510102':{studentId:'1510102',classRoom:'701',seatNo:'2',name:'乙'},
    'users/u1':{studentId:'1510101',profile:{studentId:'1510101'}},
    'users/u2':{studentId:'1510102',profile:{studentId:'1510102'}}
   });
   const db=window.fixture.db,collection=db.collection;
   window.reviewWrites=[];
   db.collection=name=>{
    const reference=collection(name);
    if(name==='users'){
     const doc=reference.doc;
     reference.doc=id=>({
      ...doc(id),
      async update(fields){
       window.reviewWrites.push({id,fields});
       const old=window.fixture.rows.get('users/'+id);
       for(const [key,value] of Object.entries(fields)){
        const parts=key.split('.'),last=parts.pop(),destination=parts.reduce((object,name)=>object[name]||=(Object.create(null)),old);
        destination[last]=value;
       }
      }
     });
    }
    return reference;
   };
   const auth={currentUser:{email},setPersistence(){},onAuthStateChanged(call){call(this.currentUser);}};
   window.firebase={initializeApp:()=>({}),auth:()=>auth,firestore:()=>db};window.firebase.auth.Auth={Persistence:{SESSION:'session'}};
   window.firebase.firestore.FieldPath={documentId:()=> '__name__'};window.firebase.firestore.FieldValue={serverTimestamp:()=> '2026-11-18T08:00:00Z'};
  },term);
  await page.addScriptTag({content:script});
  await page.waitForFunction(()=>document.getElementById('teacher-data-status').textContent.includes('701 班資料更新中'));
  await page.locator('[data-tab="live"]').click();await page.locator('#live-classroom-load').click();
  await page.waitForFunction(()=>document.querySelector('#live-assignment-work option[value="41"]'));
  await page.locator('#live-assignment-work').selectOption('41');
  await page.locator('#live-flowchart-unit').selectOption('1');
  await page.waitForFunction(()=>document.getElementById('live-evidence-status').textContent.includes('成功更新'));
  await page.locator('[data-live-student="1510101"]').click();

  const b=page.locator('input[name="live-review-attachment-thinking"][value*="/b/"]');
  const note=page.locator('#live-revision-note-programming');
  await b.check();await page.locator('#live-revision-reason-programming').selectOption('其他');await note.fill('保留我的補件草稿');
  assert(!await page.locator(reviewButton).isDisabled());
  const title=await page.locator('#modal-title').textContent();
  const preview=async()=>{
   await page.locator('[data-live-review-preview][href*="/b/"]').click();
   await page.evaluate(()=>{window.fixture.reads.length=0;window.changeVisibility(true);});
  };
  const returnToReview=()=>page.evaluate(()=>window.changeVisibility(false));
  let start=calls.length;
  await preview();await page.waitForTimeout(30);
  assert(await page.locator(reviewButton).isDisabled());
  assert.equal(calls.length,start,'no Classroom requests while backgrounded');
  assert.equal(await page.evaluate(()=>window.fixture.reads.length),0,'no Firestore requests while backgrounded');
  await returnToReview();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('未變更，可直接核定'));
  assert.equal(await page.locator('#modal-title').textContent(),title);assert(await b.isChecked());assert.equal(await note.inputValue(),'保留我的補件草稿');
  assert.match(await page.locator('#teacher-data-status').textContent(),/資料已暫停/);
  const scopedCalls=calls.slice(start);
  assert.equal(scopedCalls.length,1);assert.deepEqual([scopedCalls[0].action,scopedCalls[0].courseId,scopedCalls[0].courseWorkId,scopedCalls[0].studentId,scopedCalls[0].classroomUserId],['review-submission','301','41','1510101','10001']);
  assert.deepEqual(await page.evaluate(()=>window.fixture.reads.map(({pathname,kind,filters,limit})=>({pathname,kind,filters,limit}))),[
   {pathname:'rosters/1510101',kind:'doc',filters:[],limit:null},
   {pathname:'users',kind:'collection',filters:[['__name__','==','u1']],limit:1}
  ],'only this student and no class listener');
  await page.locator(reviewButton).click();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('已核定'));
  const [write]=await page.evaluate(()=>window.reviewWrites);
  assert.equal(write.id,'u1');assert.equal(write.fields['teacherProgress.'+term+'.taskCompletions.thinking-1'].status,'approved');
  assert.equal(write.fields['teacherProgress.'+term+'.taskCompletions.thinking-1'].attachment.url,'https://drive.google.com/file/d/b/view');
  assert.equal(await note.inputValue(),'保留我的補件草稿');

  // Any changes detected after a preview must block the stale controls.
  await b.check();await preview();records[0].attachments[1]=image('b','2026-11-18T05:00:00Z');await returnToReview();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('附件或核定紀錄已變更'));
  assert(await page.locator(reviewButton).isDisabled());assert(await b.isChecked());assert.equal(await note.inputValue(),'保留我的補件草稿');
  assert.equal(await page.evaluate(()=>window.reviewWrites.length),1);
  await page.locator('#live-review-reload').click();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('重新確認並選擇採認作品'));
  assert(!await b.isChecked());assert(await page.locator(reviewButton).isDisabled());assert.equal(await note.inputValue(),'保留我的補件草稿');

  // A failure/mismatched assignment never falls back to the full roster.
  await b.check();await preview();misdirect=true;start=calls.length;await returnToReview();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('不是原先預覽'));
  assert(await page.locator(reviewButton).isDisabled());assert(await b.isChecked());assert.equal(await note.inputValue(),'保留我的補件草稿');assert.equal(calls.length-start,1);
  misdirect=false;fakeFailure='模擬讀取失敗';start=calls.length;await page.locator('#live-review-reload').click();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('模擬讀取失敗'));
  assert.equal(calls.length-start,1,'failed scoped request does not retry or fetch the full assignment');
  fakeFailure='';await page.locator('#live-review-reload').click();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('已核對這位學生'));
  assert(await b.isChecked());assert(!await page.locator(reviewButton).isDisabled());
  await preview();await page.evaluate(term=>{
   const record=window.fixture.rows.get('users/u1').teacherProgress[term].liveChecks.thinking_301_41;
   record.reviewedAt='2026-12-01T00:00:00Z';record.status='revision';
  },term);
  await returnToReview();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('核定紀錄已變更'));
  assert(await page.locator(reviewButton).isDisabled());assert.equal(await note.inputValue(),'保留我的補件草稿');
  await page.locator('#live-review-reload').click();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('已核對這位學生'));
  await preview();hold=true;
  await Promise.all([page.waitForRequest(request=>request.url().includes('action=review-submission')),returnToReview()]);
  await page.evaluate(()=>window.changeVisibility(true));hold=false;
  if(deliver){deliver();deliver=null;}
  await page.waitForTimeout(40);assert(await page.locator(reviewButton).isDisabled(),'late response cannot enable a paused review');
  await returnToReview();assert(await page.locator(reviewButton).isDisabled());
  await page.locator('#live-review-reload').click();
  await page.waitForFunction(()=>document.getElementById('live-review-message').textContent.includes('已核對這位學生'));
  start=calls.length;await page.evaluate(()=>{window.changeVisibility(true);window.changeVisibility(false);});
  assert.equal(calls.length,start,'plain tab switches are not treated as preview returns');assert(await page.locator(reviewButton).isDisabled());
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('PASS preview return, both terms: one student snapshot, selected attachment/draft intact, original review write, changed and failed scope blocked, and listeners remain paused.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
