/* Class-scoped Firestore reads. No credentials, writes, whole-grade listeners,
 * automatic retries or browser persistence. The teacher page owns visibility. */
(function (global) {
  'use strict';
  const cancelled = () => Object.assign(new Error('讀取已取消。'), { code: 'cancelled' });
  function rosterRows(snapshot) {
    return snapshot.docs.map(document => ({ ...document.data(), id: document.id,
      studentId: String(document.data().studentId || document.id) }));
  }
  function cohorts(rows, field = 'studentId') {
    const ids = [...new Set(rows.map(row => row.studentId).filter(id => /^15[12]\d{4}$/.test(id)))].sort();
    const result = [];
    for (let offset = 0; offset < ids.length; offset += 10) {
      result.push({ field, ids: ids.slice(offset, offset + 10) });
    }
    return result;
  }
  function errorText(error) {
    switch (String(error?.code || '').replace(/^firestore\//, '')) {
      case 'permission-denied': return '讀取權限不足，請確認教師帳號與 Firestore Rules；不會自動重試。';
      case 'unauthenticated': return '登入憑證失效，請重新登入。';
      case 'resource-exhausted': return '資料庫額度或資源已達限制，請確認 Firebase 用量後再手動重試。';
      case 'deadline-exceeded': return '讀取逾時，請確認網路後手動重試。';
      case 'failed-precondition': return '查詢設定不符，請確認 Firestore 索引或資料庫設定。';
      default: return '資料暫時無法讀取，請確認網路後手動重試；不會反覆重新載入。';
    }
  }
  function create({ db, onData = () => {}, onState = () => {}, timeoutMs = 20000,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    let epoch = 0, cohortEpoch = 0, fallbackEpoch = 0, watchdog = null, tick = 0;
    let state = { phase: 'paused', classRoom: '', reason: '尚未開始', rosterReady: false, progressReady: false };
    let rosters = [], signature = '', fallbackSignature = '', withProgress = true;
    const rosterStops = new Set(), userStops = new Set(), fallbackStops = new Set(), groups = new Map();
    const snapshotState = () => ({ ...state });
    const emit = () => onState(snapshotState());
    const stop = set => { for (const unsubscribe of set) unsubscribe(); set.clear(); };
    const clearWatchdog = () => { if (watchdog !== null) clearTimer(watchdog); watchdog = null; };
    const valid = token => token === epoch && !['paused', 'error'].includes(state.phase);
    function pause(reason = '已暫停') {
      epoch++; cohortEpoch++; fallbackEpoch++; clearWatchdog(); stop(rosterStops); stop(userStops); stop(fallbackStops); groups.clear();
      state = { ...state, phase: 'paused', reason, rosterReady: false, progressReady: false }; emit();
    }
    function fail(error, token) {
      if (!valid(token)) return;
      pause(); state = { ...state, phase: 'error', reason: errorText(error) }; emit();
    }
    function arm(token) {
      if (watchdog !== null) return;
      watchdog = setTimer(() => fail({code:'deadline-exceeded'}, token), timeoutMs);
    }
    function publish(token) {
      if (!valid(token)) return;
      const progress = new Map();
      for (const group of groups.values()) for (const [id, entry] of group.rows) {
        if (!progress.has(id) || progress.get(id).tick < entry.tick) progress.set(id, entry);
      }
      state.progressReady = !withProgress || (state.rosterReady && [...groups.values()].every(group => group.ready));
      state.phase = state.rosterReady && state.progressReady ? 'ready' : 'loading';
      if (state.phase === 'ready') clearWatchdog(); else arm(token);
      onData({ classRoom: state.classRoom, rosterRows: [...rosters], progressRows: [...progress.values()].map(entry => entry.row) });
      emit();
    }
    function attach(ref, stops, token, next) {
      try {
        const unsubscribe = ref.onSnapshot({includeMetadataChanges:true}, snapshot => {
          if (valid(token)) { try { next(snapshot); } catch (error) { fail(error,token); } }
        }, error => fail(error, token));
        if (valid(token)) stops.add(unsubscribe); else unsubscribe();
      } catch (error) { fail(error,token); }
    }
    function syncFallback(token, cohort) {
      const primary = [...groups.entries()].filter(([key]) => key.startsWith('primary:')).map(([,group]) => group);
      if (!primary.every(group => group.ready)) return;
      const found = new Set(primary.flatMap(group => [...group.rows.values()].map(entry => String(entry.row.data.studentId || ''))));
      const queries = cohorts(rosters.filter(row => !found.has(row.studentId)), 'profile.studentId');
      const nextSignature = JSON.stringify(queries);
      if (fallbackSignature === nextSignature) return;
      fallbackSignature = nextSignature; const generation = ++fallbackEpoch;
      stop(fallbackStops); for (const key of groups.keys()) if (key.startsWith('fallback:')) groups.delete(key);
      queries.forEach((query,index) => groups.set('fallback:'+index,{ready:false,rows:new Map()}));
      for (const [index,query] of queries.entries()) {
        if (!valid(token) || cohort !== cohortEpoch) break;
        attach(db.collection('users').where(query.field,'in',query.ids),fallbackStops,token,next => {
          if (generation !== fallbackEpoch || cohort !== cohortEpoch) return;
          groups.set('fallback:'+index,{ready:!next.metadata?.fromCache,rows:new Map(next.docs.map(document => [document.id,{row:{id:document.id,data:document.data()},tick:++tick}]))});
          publish(token);
        });
      }
    }
    function watchClass(classRoom, { progress = true } = {}) {
      if (!/^7\d{2}$/.test(classRoom)) throw new Error('班級格式不正確。');
      if (state.classRoom === classRoom && withProgress === progress && ['loading','ready'].includes(state.phase)) return;
      pause('正在切換班級'); const token = ++epoch;
      withProgress = progress; rosters = []; signature = ''; fallbackSignature = ''; groups.clear();
      state = {phase:'loading',classRoom,reason:'',rosterReady:false,progressReady:!progress};
      onData({classRoom,rosterRows:[],progressRows:[]}); emit(); arm(token);
      attach(db.collection('rosters').where('classRoom','==',classRoom), rosterStops, token, snapshot => {
        rosters = rosterRows(snapshot); state.rosterReady = !snapshot.metadata?.fromCache;
        if (state.rosterReady && withProgress) {
          const queries = cohorts(rosters), nextSignature = JSON.stringify(queries);
          if (signature !== nextSignature) {
            signature = nextSignature; const cohort = ++cohortEpoch; fallbackEpoch++; fallbackSignature = ''; stop(userStops); stop(fallbackStops); groups.clear();
            queries.forEach((query,index) => groups.set('primary:'+index,{ready:false,rows:new Map()}));
            for (const [index,query] of queries.entries()) {
              if (!valid(token)) break;
              attach(db.collection('users').where(query.field,'in',query.ids), userStops, token, next => {
                // An old cohort callback must not restore students after a roster edit.
                if (signature !== nextSignature || cohort !== cohortEpoch) return;
                groups.set('primary:'+index,{ready:!next.metadata?.fromCache,rows:new Map(next.docs.map(document => [document.id,{row:{id:document.id,data:document.data()},tick:++tick}]))});
                syncFallback(token,cohort);
                publish(token);
              });
            }
          }
        }
        publish(token);
      });
    }
    async function read(ref, shouldContinue) {
      if (!shouldContinue()) throw cancelled();
      let timer;
      try {
        const snapshot = await Promise.race([ref.get({source:'server'}),new Promise((_,reject) => {
          timer = setTimer(() => reject(Object.assign(new Error('讀取逾時。'),{code:'deadline-exceeded'})),timeoutMs);
        })]);
        if (!shouldContinue()) throw cancelled();
        return snapshot;
      } finally { if (timer !== undefined) clearTimer(timer); }
    }
    async function fetchClass(classRoom, shouldContinue = () => true) {
      if (!/^7\d{2}$/.test(classRoom)) throw new Error('班級格式不正確。');
      const rows = rosterRows(await read(db.collection('rosters').where('classRoom','==',classRoom),shouldContinue));
      const progress = new Map();
      for (const query of cohorts(rows)) {
        const result = await read(db.collection('users').where(query.field,'in',query.ids),shouldContinue);
        result.docs.forEach(document => progress.set(document.id,{id:document.id,data:document.data()}));
      }
      const found = new Set([...progress.values()].map(row => String(row.data.studentId || '')));
      for (const query of cohorts(rows.filter(row => !found.has(row.studentId)),'profile.studentId')) {
        const result = await read(db.collection('users').where(query.field,'in',query.ids),shouldContinue);
        result.docs.forEach(document => progress.set(document.id,{id:document.id,data:document.data()}));
      }
      return {classRoom,rosterRows:rows,progressRows:[...progress.values()]};
    }
    return Object.freeze({watchClass,pause,fetchClass,read,state:snapshotState,dispose:()=>pause('已離開教師端')});
  }
  global.TeacherData = Object.freeze({create,errorText});
})(typeof window === 'undefined' ? globalThis : window);
