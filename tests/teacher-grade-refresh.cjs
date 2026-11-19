'use strict';
const assert=require('node:assert/strict');
require('../shared/teacher-analytics.js');
const {fakeFirestore}=require('./fake-firestore.cjs');

const {create,mergeQuestions}=global.TeacherAnalytics;
const classRooms=['701','702','703'],termId='115-1';
const root='quizAnalytics/'+termId,jobPath=root+'/maintenance/grade-refresh';
const f=fakeFirestore(),fetched=[],updates=[];
const attemptPath=(classRoom,number)=>`quizAttempts/u${classRoom}/events/a${String(number).padStart(5,'0')}`;
for(const classRoom of classRooms){
 const studentId='1510'+classRoom.slice(-1)+'01';
 f.rows.set('users/u'+classRoom,{studentId});
 f.rows.set('rosters/'+studentId,{studentId,classRoom});
}
function add(classRoom,number,nanoseconds=0){
 f.rows.set(attemptPath(classRoom,number),{termId,questionId:'q_fixture',questionText:'測試題',source:'unit',createdAt:{seconds:number,nanoseconds},correct:true,selectedIndex:0,optionCount:2});
}
let serverTime={seconds:7000,nanoseconds:500};
const params={
 db:f.db,termId,documentId:'__name__',timestampFrom:time=>({seconds:time.seconds,nanoseconds:time.nanoseconds}),
 serverTimestamp:()=>serverTime,
 async fetchClass(classRoom){
  fetched.push(classRoom);
  const studentId='1510'+classRoom.slice(-1)+'01';
  return{rosterRows:[{studentId}],progressRows:[{id:'u'+classRoom,data:{studentId}}]};
 },
 async read(ref,current){
  if(!current())throw new Error('整理已停止');
  const snapshot=await ref.get();
  if(!current())throw new Error('整理已停止');
  return snapshot;
 }
};
const active=()=>true,created=classRoom=>f.rows.get(root+'/classes/'+classRoom);
const aggregate=async api=>mergeQuestions((await api.loadGrade(classRooms,active)).map(summary=>summary.entries))[0].attemptCount;

(async()=>{
 const api=create(params);
 await assert.rejects(()=>api.refreshGrade(classRooms,active),/701 班尚無完整彙總/);
 assert(!f.rows.has(jobPath),'incremental update cannot silently build missing classes');
 assert.deepEqual(fetched,[],'no raw reads until all classes are prepared');
 for(const classRoom of classRooms)add(classRoom,1);
 await api.updateGrade(classRooms,active);
 assert.equal(await aggregate(api),3);
 for(let i=2;i<=2901;i++)add('701',i);
 for(let i=2;i<=2301;i++)add('702',i);
 const before=f.reads.length;
 assert.equal(await aggregate(api),3,'reload does not see unprocessed raw data');
 assert(f.reads.slice(before).every(row=>row.pathname.startsWith(root+'/')),'viewing statistics does not scan raw history');
 fetched.length=0;f.reads.length=0;
 const unchanged=structuredClone(created('703'));
 const partial=await api.refreshGrade(classRooms,active,status=>updates.push(status),99999);
 assert.deepEqual(partial,{complete:false,scanned:5000,completed:1,total:3,classRoom:'702'});
 assert.deepEqual(fetched,['701','702']);
 assert.equal(f.rows.get(jobPath).nextClass,1,'persist the next class beyond the completed prefix');
 assert.deepEqual(f.rows.get(jobPath).cutoff,serverTime);
 assert(updates.some(status=>status.classRoom==='701'&&status.scanned===2900));
 assert(updates.some(status=>status.classRoom==='702'&&status.scanned===5000));
 const originalJob=structuredClone(f.rows.get(jobPath));
 const raw=f.reads.filter(row=>row.pathname.startsWith('quizAttempts/'));
 assert.equal(raw.at(-1).limit,100,'the last query only uses the remaining budget');
 assert(raw.every(row=>row.limit<=200&&row.after&&row.filters.some(([field,op])=>field==='createdAt'&&op==='<=')),'reuse stored cursor and bound by the server cutoff');
 const resumed=create(params);
 await assert.rejects(()=>resumed.loadGrade(classRooms,active),/全年級增量更新尚未完成/);
 await assert.rejects(()=>resumed.updateGrade(classRooms,active),/增量更新尚未完成/);
 await assert.rejects(()=>resumed.updateClass('701',active),/增量更新尚未完成/);
 assert.equal((await resumed.loadClass('703',active)).entries[0].attemptCount,1,'single class completed snapshots remain viewable');
 assert.deepEqual(f.rows.get(jobPath),originalJob);
 // New attempts in both a completed and an unfinished class stay out of this run.
 add('701',7001);add('702',7000,501);
 serverTime={seconds:8000,nanoseconds:0};
 fetched.length=0;f.reads.length=0;
 assert.deepEqual(await resumed.refreshGrade(classRooms,active),{complete:true,scanned:200,completed:3,total:3});
 assert.deepEqual(fetched,['702','703'],'new instance resumes at the saved class');
 assert(f.reads.filter(row=>row.pathname==='quizAttempts/u702/events').every(row=>row.filters.find(([field])=>field==='createdAt')[2].seconds===7000));
 assert.equal(f.reads.find(row=>row.pathname==='quizAttempts/u702/events').after[0].seconds,2101,'resume at saved student cursor');
 assert.deepEqual(created('703'),unchanged,'no-op class does not rewrite its snapshot');
 assert.equal(await aggregate(resumed),5203);
 assert.deepEqual(await resumed.refreshGrade(classRooms,active),{complete:true,scanned:2,changedClasses:2,completed:2,total:2,phase:'done'});
 assert.equal(await aggregate(resumed),5205,'the next round includes late attempts exactly once');
 const writeStart=f.writes.length;
 fetched.length=0;f.reads.length=0;
 assert.deepEqual(await resumed.refreshGrade(classRooms,active),{complete:true,scanned:0,changedClasses:0,completed:0,total:0,phase:'done'});
 assert.deepEqual(fetched,[],'an empty query must not load any class rosters');
 assert.equal(f.reads.filter(row=>row.kind==='group').length,1);
 assert(!f.reads.some(row=>row.pathname.startsWith('users')||row.pathname.startsWith('rosters')||row.pathname.includes('/classes/')||row.pathname.includes('/students/')||row.pathname.startsWith('quizAttempts/')),'no class/roster/student access in empty fast path before rendering');
 assert(f.writes.slice(writeStart).every(row=>row.pathname.startsWith(root+'/maintenance/')),'no new attempts only persist the run metadata, not summaries');
 // A cancel after the fast-path job starts leaves its fixed window resumable.
 let current=true;
 await assert.rejects(()=>resumed.refreshGrade(classRooms,()=>current,status=>{
  if(status.phase==='scan')current=false;
 }),/已停止/);
 assert.equal(f.rows.get(jobPath).phase,'scan');
 await assert.rejects(()=>resumed.loadGrade(classRooms,active),/增量更新尚未完成/);
 assert.equal((await create(params).refreshGrade(classRooms,active)).scanned,0);
 // An update that completes across a concurrent read cannot mix publications.
 await assert.rejects(()=>resumed.loadGrade(classRooms,active,classRoom=>{
  if(classRoom==='702')f.rows.set(jobPath,{...f.rows.get(jobPath),id:'concurrent-finished-job'});
 }),/讀取期間有人完成/);
 assert(!f.writes.some(row=>row.pathname.startsWith('quizAttempts/')),'raw data is never written');
 console.log('PASS grade increment: published baseline, shared 5,000 limit, class/student resume, immutable cutoff, blocked mixed totals, no-op writes, cancellation and concurrency.');
})().catch(error=>{console.error(error);process.exitCode=1;});
