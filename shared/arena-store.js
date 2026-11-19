/* Shared Firestore persistence for both knowledge arenas (Firebase compat). */
(() => {
    'use strict';
    const DAY_MS = 86400000;
    const dayNumber = () => Math.floor((Date.now() + 28800000) / DAY_MS);
    const exists = snapshot => typeof snapshot.exists === 'function' ? snapshot.exists() : snapshot.exists;
    const timestamp = () => firebase.firestore.FieldValue.serverTimestamp();
    function identity() {
        const user = firebase.auth().currentUser;
        const profile = window.LearningProfile?.get?.();
        const studentId = String(profile?.studentId || '');
        if (!user || user.isAnonymous || !window.LearningProfile?.isComplete?.(profile)
            || !/^15\d{5}$/.test(studentId)
            || user.email !== `${studentId}@students.jimwang-4b0ca.firebaseapp.com`) {
            throw new Error('找不到目前登入學生身分，請返回入口重新登入。');
        }
        return { uid: user.uid, studentId };
    }
    function create(db, termId) {
        const boards = new Map();
        const root = studentId => db.collection('arenaActivity').doc(studentId);
        const dailyRef = (studentId, day) => root(studentId).collection('days').doc(`${termId}_${day}`);
        const scores = difficulty => db.collection('leaderboards').doc(termId)
            .collection('difficulties').doc(difficulty);
        function assertOwner(run) {
            const owner = identity();
            if (owner.uid !== run.uid || owner.studentId !== run.studentId) {
                throw new Error('登入身分已變更，不能保存另一位學生的挑戰。');
            }
            return owner;
        }
        return Object.freeze({
            async remaining() {
                const owner = identity();
                const snapshot = await dailyRef(owner.studentId, dayNumber()).get({ source: 'server' });
                return Math.max(0, 2 - (exists(snapshot) ? snapshot.data().count : 0));
            },
            async start(difficulty, questionCount) {
                const owner = identity();
                const day = dayNumber();
                const daily = dailyRef(owner.studentId, day);
                const ref = root(owner.studentId).collection('runs').doc();
                const count = await db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(daily);
                    const used = exists(snapshot) ? snapshot.data().count : 0;
                    if (used >= 2) throw new Error('今天已挑戰兩次，請明天再來。');
                    assertOwner(owner);
                    transaction.set(daily, {
                        termId, day, studentId: owner.studentId, count: used + 1,
                        lastRunId: ref.id, updatedAt: timestamp()
                    });
                    transaction.set(ref, {
                        termId, day, studentId: owner.studentId, difficulty,
                        slot: used + 1, questionCount, status: 'active', startedAt: timestamp()
                    });
                    return used + 1;
                });
                return { ...owner, ref, id: ref.id, difficulty, remaining: 2 - count };
            },
            async finish(run, summary) {
                assertOwner(run);
                await db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(run.ref);
                    if (!exists(snapshot)) throw new Error('找不到本次挑戰紀錄。');
                    if (snapshot.data().status === 'finished') return;
                    transaction.update(run.ref, { ...summary, status: 'finished', finishedAt: timestamp() });
                });
            },
            async saveBest(run) {
                assertOwner(run);
                const legacy = await scores(run.difficulty).collection('scores')
                    .where('studentId', '==', run.studentId).orderBy('score','desc').limit(1).get({ source: 'server' });
                let legacyBest = 0;
                legacy.forEach(doc => { legacyBest = Math.max(legacyBest, Number(doc.data().score) || 0); });
                const ref = scores(run.difficulty).collection('bests').doc(run.studentId);
                const saved = await db.runTransaction(async transaction => {
                    const [savedRun, previous] = await Promise.all([
                        transaction.get(run.ref), transaction.get(ref)
                    ]);
                    assertOwner(run);
                    if (!exists(savedRun) || savedRun.data().status !== 'finished') {
                        throw new Error('請先保存本次挑戰結果。');
                    }
                    const score = savedRun.data().score;
                    const best = Math.max(legacyBest, exists(previous) ? previous.data().score : 0);
                    if (score <= best) return false;
                    transaction.set(ref, { studentId: run.studentId, score, runId: run.id, timestamp: timestamp() });
                    return true;
                });
                boards.delete(run.difficulty);
                return saved;
            },
            async leaderboard(difficulty, limit = 20) {
                if (!['easy','normal','hard'].includes(difficulty)) throw new Error('無效難度。');
                const count = Math.max(1,Math.min(20,Number(limit)||20));
                const previous = boards.get(difficulty);
                if (previous && (previous.pending || previous.until > Date.now())) return (await previous.promise).slice(0,count);
                const entry = {until:0,pending:true};
                entry.promise = (async () => {
                // Never fall back to downloading the legacy collection.
                const [archive,current] = await Promise.all([
                    scores(difficulty).collection('archive').doc('top20').get({source:'server'}),
                    scores(difficulty).collection('bests').orderBy('score','desc').orderBy('studentId','asc').limit(20).get({source:'server'})
                ]);
                if (!exists(archive) || archive.data().complete !== true) throw new Error('歷史英雄榜尚未準備完成，請教師先建立該學期與難度的快照。');
                const best = new Map();
                [...archive.data().rows,...current.docs.map(document=>document.data())].forEach(data => {
                    if (!/^15\d{5}$/.test(data.studentId) || data.studentId.endsWith('00')
                        || !Number.isInteger(data.score) || data.score < 0) throw new Error('英雄榜資料格式不符，請教師檢查；不顯示不完整排名。');
                    if (!best.has(data.studentId) || best.get(data.studentId).score < data.score) {
                        best.set(data.studentId, { studentId: data.studentId, score: data.score });
                    }
                });
                return [...best.values()].sort((a, b) => b.score - a.score
                    || a.studentId.localeCompare(b.studentId)).slice(0,20);
                })();
                boards.set(difficulty,entry);
                try { const rows = await entry.promise; entry.pending = false; entry.until = Date.now()+60000; return rows.slice(0,count); }
                catch(error) { if (boards.get(difficulty)===entry) boards.delete(difficulty); throw error; }
            }
        });
    }
    window.ArenaStore = Object.freeze({ create, identity, exists });
})();
