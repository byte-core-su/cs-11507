import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { addDoc, collection, getFirestore, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

/*
 * Public quiz pages contain only question text and choices.  The answer index
 * is held in Firestore and is checked by Security Rules when an attempt is
 * created.  This module intentionally never reads quizAnswerKeys.
 */
(function attachQuizSecurity(global) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();

  // Two independent FNV-1a passes give a compact, deterministic question ID.
  // Identical questions on a lesson page and the review page therefore share
  // one answer key and one set of statistics.
  function fnv1a(value, seed) {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function questionKey(termId, question, options) {
    const payload = [normalize(termId), normalize(question), ...(options || []).map(normalize)].join('\u241f');
    const first = fnv1a(payload, 0x811c9dc5).toString(36);
    const second = fnv1a(payload, 0x9e3779b9).toString(36);
    return `q_${normalize(termId).replace(/[^a-zA-Z0-9_-]/g, '_')}_${first}_${second}`;
  }

  function firebaseContext() {
    const config = global.SCHOOL_APP?.firebaseConfig || global.LEARNING_FIREBASE_CONFIG;
    if (!config?.projectId) throw new Error('尚未設定 Firebase，無法驗證測驗答案。');
    const app = getApps().length ? getApp() : initializeApp(config);
    return { auth: getAuth(app), db: getFirestore(app) };
  }

  async function saveAttempt({ termId, source, question, options, selectedIndex, elapsedSeconds = 0 }) {
    if (!Array.isArray(options) || !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= options.length) {
      throw new Error('作答資料格式不正確。');
    }

    const { auth, db } = firebaseContext();
    const user = auth.currentUser;
    if (!user || user.isAnonymous) throw new Error('請先由課程入口完成學生登入後再作答。');

    const questionId = questionKey(termId, question, options);
    const base = {
      termId: normalize(termId),
      questionId,
      source: normalize(source),
      questionText: normalize(question),
      optionCount: options.length,
      selectedIndex,
      elapsedSeconds: Math.max(0, Math.min(3600, Math.round(Number(elapsedSeconds) || 0))),
      createdAt: serverTimestamp()
    };
    const events = collection(db, 'quizAttempts', user.uid, 'events');

    // Rules allow exactly one of these writes.  A successful first write means
    // the selected choice matches the protected answer key.  For a wrong
    // choice the first write is rejected and the false record is accepted.
    try {
      await addDoc(events, { ...base, correct: true });
      return { correct: true, questionId };
    } catch (error) {
      if (error?.code !== 'permission-denied') throw error;
      try {
        await addDoc(events, { ...base, correct: false });
        return { correct: false, questionId };
      } catch (fallbackError) {
        if (fallbackError?.code === 'permission-denied') {
          throw new Error('題庫安全金鑰尚未完成設定，請通知教師完成初始化。');
        }
        throw fallbackError;
      }
    }
  }

  async function saveSequenceAttempt({ termId, source, question, options, selectedOrder, elapsedSeconds = 0 }) {
    if (!Array.isArray(options) || options.length < 2 || !Array.isArray(selectedOrder)
        || selectedOrder.length !== options.length || selectedOrder.some(value => typeof value !== 'string')) {
      throw new Error('流程排序資料格式不正確。');
    }

    const { auth, db } = firebaseContext();
    const user = auth.currentUser;
    if (!user || user.isAnonymous) throw new Error('請先由課程入口完成學生登入後再作答。');

    const questionId = questionKey(termId, question, options);
    const base = {
      termId: normalize(termId),
      questionId,
      source: normalize(source),
      questionText: normalize(question),
      optionCount: options.length,
      responseValue: selectedOrder.join('\u241f'),
      elapsedSeconds: Math.max(0, Math.min(3600, Math.round(Number(elapsedSeconds) || 0))),
      createdAt: serverTimestamp()
    };
    const events = collection(db, 'quizAttempts', user.uid, 'events');

    try {
      await addDoc(events, { ...base, correct: true });
      return { correct: true, questionId };
    } catch (error) {
      if (error?.code !== 'permission-denied') throw error;
      try {
        await addDoc(events, { ...base, correct: false });
        return { correct: false, questionId };
      } catch (fallbackError) {
        if (fallbackError?.code === 'permission-denied') {
          throw new Error('題庫安全金鑰尚未完成設定，請通知教師完成初始化。');
        }
        throw fallbackError;
      }
    }
  }

  global.QuizSecurity = Object.freeze({ questionKey, saveAttempt, saveSequenceAttempt });
})(window);
