'use strict';
const assert=require('node:assert/strict');const{fakeFirestore}=require('./fake-firestore.cjs');
global.window=global;global.firebase={auth:()=>({currentUser:{uid:'u1',email:'1510101@students.jimwang-4b0ca.firebaseapp.com'}}),firestore:{FieldValue:{serverTimestamp:()=>({seconds:1})}}};
global.LearningProfile={get:()=>({studentId:'1510101'}),isComplete:()=>true};require('../shared/arena-store.js');
(async()=>{
 const f=fakeFirestore(),base='leaderboards/115-1/difficulties/easy';
 f.rows.set(base+'/archive/top20',{complete:true,rows:[{studentId:'1510101',score:900}]});
 for(let i=1;i<=28;i++)f.rows.set(base+'/bests/15101'+String(i).padStart(2,'0'),{studentId:'15101'+String(i).padStart(2,'0'),score:i*10});
 const api=ArenaStore.create(f.db,'115-1');const[first,second]=await Promise.all([api.leaderboard('easy'),api.leaderboard('easy',5)]);
 assert.equal(first.length,20);assert.equal(second.length,5);assert.equal(first[0].score,900);assert.equal(first[1].score,280);
 assert.equal(f.reads.length,2,'concurrent callers share one archive and one top query');assert.equal(f.reads[1].limit,20);assert.equal(f.reads[1].orders.length,2);await api.leaderboard('easy');assert.equal(f.reads.length,2,'60-second local cache');
 assert(!f.reads.some(row=>row.pathname===base+'/scores'),'no raw legacy board scan');
 await assert.rejects(()=>api.leaderboard('hard'),/尚未準備/);assert(!f.reads.some(row=>row.pathname.endsWith('/scores')),'missing archive never falls back to entire collection');
 f.rows.set('arenaActivity/1510101/runs/r',{status:'finished',score:30000});f.rows.set(base+'/scores/old',{studentId:'1510101',score:1000});
 assert.equal(await api.saveBest({uid:'u1',studentId:'1510101',difficulty:'easy',id:'r',ref:f.db.collection('arenaActivity').doc('1510101').collection('runs').doc('r')}),true);
 const legacy=f.reads.find(row=>row.pathname===base+'/scores');assert.equal(legacy.limit,1);assert.deepEqual(legacy.orders,[['score','desc']]);
 await api.leaderboard('easy');assert.equal(f.reads.filter(row=>row.pathname===base+'/archive/top20').length,2,'saving best invalidates cached rank');
 console.log('PASS arena store: top-20 server limit, stable tie order, legacy archive merge, missing-archive guard, pending/local cache, cache invalidation and bounded personal legacy lookup.');
})().catch(error=>{console.error(error);process.exitCode=1;});
