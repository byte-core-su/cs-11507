/* Shared Firebase and academic-term settings for the whole 115 school year. */
(function (global) {
  'use strict';

  const firebaseConfig = Object.freeze({
    apiKey: 'AIzaSyC_rudtM5PEC6dzWaLN71V3nryQIRCGowg',
    authDomain: 'jimwang-4b0ca.firebaseapp.com',
    projectId: 'jimwang-4b0ca',
    storageBucket: 'jimwang-4b0ca.firebasestorage.app',
    messagingSenderId: '47033675412',
    appId: '1:47033675412:web:7ca83b27ca6f4529f30e81',
    measurementId: 'G-YTWQRC0HZY'
  });

  const academicYearId = '115';

  function automaticTerm(date = new Date()) {
    const month = date.getMonth() + 1;
    // Taiwan school year: Aug–Jan is term 1, Feb–Jul is term 2.
    return `${academicYearId}-${month === 1 || month >= 8 ? '1' : '2'}`;
  }

  const pathMatch = global.location.pathname.match(/\/terms\/(\d{3}-[12])(?:\/|$)/);
  const requestedTerm = new URLSearchParams(global.location.search).get('term');
  const testTermStorageKey = 'learning-platform.test-term.v1';
  const requestedTestTerm = new URLSearchParams(global.location.search).get('testTerm');
  let testTermId = '';
  try {
    if (requestedTestTerm === 'auto') global.sessionStorage.removeItem(testTermStorageKey);
    else if (/^115-[12]$/.test(requestedTestTerm || '')) global.sessionStorage.setItem(testTermStorageKey, requestedTestTerm);
    testTermId = global.sessionStorage.getItem(testTermStorageKey) || '';
  } catch (_) { testTermId = /^115-[12]$/.test(requestedTestTerm || '') ? requestedTestTerm : ''; }
  const activeTermId = testTermId || automaticTerm();
  // The shared teacher template is outside /terms, so it carries its
  // selected term in ?term=115-1 or ?term=115-2.
  const currentTermId = /^115-[12]$/.test(requestedTerm || '') ? requestedTerm : (pathMatch ? pathMatch[1] : activeTermId);
  const rootPath = pathMatch ? '../../' : './';
  const storageKeys = Object.freeze({
    scratchUnits: `scratch-programming.${currentTermId}.unlocked-units.v1`,
    elevatorUnits: `5016b-project.${currentTermId}.opened-units.v1`,
    flowchartProgress: `flowchart-workshop.${currentTermId}.progress.v1`,
    learnerProfile: `learning-platform.${currentTermId}.profile.v1`
  });

  global.SCHOOL_APP = Object.freeze({
    currentTermId,
    automaticTerm,
    automaticTermId: automaticTerm(),
    activeTermId,
    testTermId,
    isTestMode: Boolean(testTermId),
    academicYearId,
    rootPath,
    firebaseProjectId: firebaseConfig.projectId,
    firebaseConfig,
    studentIdPattern: /^15[12]\d{4}$/,
    studentEmailDomain: 'students.jimwang-4b0ca.firebaseapp.com',
    storageKeys,
    isFirebaseConfigured() {
      return Boolean(firebaseConfig.apiKey && firebaseConfig.appId);
    }
  });

  // Compatibility aliases keep the first-term learning activities working
  // while both terms use the one shared configuration above.
  global.LEARNING_FIREBASE_CONFIG = firebaseConfig;
  global.LEARNING_CLASSROOM_CONFIG = Object.freeze({ endpoint: '' });
})(window);
