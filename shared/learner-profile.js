/* Shared student identity helpers, with compatibility for first-term pages. */
(function (global) {
  'use strict';
  const app = global.SCHOOL_APP;
  if (!app) return;

  const sessionKey = `learning-platform.${app.currentTermId}.session.v1`;
  const profileSessionKey = `learning-platform.${app.currentTermId}.active-profile.v1`;
  const browserSessionsKey = `learning-platform.${app.academicYearId || 'school'}.student-browser-sessions.v1`;
  const browserTabKey = 'learning-platform.student-browser-tab.v1';
  const remoteSessionKey = `learning-platform.${app.academicYearId || 'school'}.remote-session.v1`;
  const browserSessionMaxAgeMs = 4 * 60 * 1000;
  const legacyProfileKey = 'learning-platform.profile.v1';
  const normalizeStudentId = value => String(value || '').trim();
  const deriveFromStudentId = value => {
    const studentId = normalizeStudentId(value);
    if (!app.studentIdPattern.test(studentId)) return null;
    const suffix = studentId.slice(-4);
    const classRoom = `7${suffix.slice(0, 2)}`;
    if (classRoom < '701' || classRoom > '711') return null;
    return { studentId, classRoom, seatNo: String(Number(suffix.slice(2))), gender: studentId[2] === '1' ? '男' : '女' };
  };
  const normalize = value => ({
    studentId: normalizeStudentId(value?.studentId),
    classRoom: String(value?.classRoom || '').trim(),
    seatNo: String(value?.seatNo || '').trim(),
    name: String(value?.name || '').trim(),
    gender: String(value?.gender || '').trim(),
    updatedAt: value?.updatedAt || new Date().toISOString()
  });
  const isComplete = value => {
    const profile = normalize(value);
    const derived = deriveFromStudentId(profile.studentId);
    return Boolean(derived && profile.name && profile.classRoom === derived.classRoom && profile.seatNo === derived.seatNo);
  };
  function browserTabId() {
    try {
      let id = sessionStorage.getItem(browserTabKey);
      if (!id) {
        const randomPart = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        id = `tab_${randomPart.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        sessionStorage.setItem(browserTabKey, id);
      }
      return id;
    } catch (_) { return ''; }
  }
  function newRemoteSessionId() {
    const randomPart = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `remote_${randomPart.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  }
  function getRemoteSessionId() {
    try {
      const current = localStorage.getItem(remoteSessionKey);
      if (typeof current === 'string' && current.startsWith('remote_')) return current;
      const created = newRemoteSessionId();
      localStorage.setItem(remoteSessionKey, created);
      return created;
    } catch (_) { return newRemoteSessionId(); }
  }
  function rotateRemoteSessionId() {
    const next = newRemoteSessionId();
    try { localStorage.setItem(remoteSessionKey, next); } catch (_) { /* Keep the in-memory login ID. */ }
    return next;
  }
  function readBrowserSessions() {
    try {
      const now = Date.now();
      const sessions = JSON.parse(localStorage.getItem(browserSessionsKey) || '[]');
      return Array.isArray(sessions) ? sessions.filter(item => app.studentIdPattern.test(normalizeStudentId(item?.studentId)) && typeof item?.tabId === 'string' && now - Number(item?.lastSeenAt || 0) < browserSessionMaxAgeMs) : [];
    } catch (_) { return []; }
  }
  function writeBrowserSessions(sessions) {
    try { localStorage.setItem(browserSessionsKey, JSON.stringify(sessions)); } catch (_) { /* Browser storage is optional. */ }
  }
  function checkBrowserStudent(studentId) {
    const id = normalizeStudentId(studentId);
    if (!app.studentIdPattern.test(id)) return { allowed: false, activeStudentId: '' };
    const tabId = browserTabId();
    const foreign = readBrowserSessions().find(item => item.tabId !== tabId && item.studentId !== id);
    return foreign ? { allowed: false, activeStudentId: foreign.studentId } : { allowed: true, activeStudentId: id };
  }
  function claimBrowserStudent(studentId) {
    const result = checkBrowserStudent(studentId);
    if (!result.allowed) return result;
    const tabId = browserTabId();
    if (!tabId) return result;
    const sessions = readBrowserSessions().filter(item => item.tabId !== tabId);
    sessions.push({ tabId, studentId: result.activeStudentId, lastSeenAt: Date.now() });
    writeBrowserSessions(sessions);
    return result;
  }
  function refreshBrowserStudent() {
    const profile = readLocalProfile();
    return profile?.studentId ? claimBrowserStudent(profile.studentId) : { allowed: true, activeStudentId: '' };
  }
  function releaseBrowserStudent() {
    const tabId = browserTabId();
    if (!tabId) return;
    writeBrowserSessions(readBrowserSessions().filter(item => item.tabId !== tabId));
  }
  function readLocalProfile() {
    try {
      // localStorage is shared by every tab on this device.  The active learner
      // must therefore live in sessionStorage so two students can use separate
      // tabs without replacing each other's identity.
      const profile = normalize(JSON.parse(sessionStorage.getItem(profileSessionKey) || 'null'));
      return profile.studentId ? profile : null;
    } catch (_) { return null; }
  }
  function saveLocalProfile(value) {
    const profile = normalize(value);
    sessionStorage.setItem(profileSessionKey, JSON.stringify(profile));
    return profile;
  }
  function startSession(value) {
    const profile = normalize(value);
    const browserClaim = claimBrowserStudent(profile.studentId);
    if (!browserClaim.allowed) {
      const error = new Error('browser-student-lock');
      error.activeStudentId = browserClaim.activeStudentId;
      throw error;
    }
    saveLocalProfile(profile);
    sessionStorage.setItem(sessionKey, profile.studentId);
    // Remove the former shared profile cache so it cannot be mistaken for the
    // active student by an older cached page.
    localStorage.removeItem(app.storageKeys.learnerProfile);
    localStorage.removeItem(legacyProfileKey);
    return profile;
  }
  function hasActiveSession() {
    const profile = readLocalProfile();
    return Boolean(profile && app.studentIdPattern.test(profile.studentId) && sessionStorage.getItem(sessionKey) === profile.studentId);
  }
  function endSession() {
    releaseBrowserStudent();
    sessionStorage.removeItem(sessionKey);
    sessionStorage.removeItem(profileSessionKey);
    localStorage.removeItem(app.storageKeys.learnerProfile);
    localStorage.removeItem(legacyProfileKey);
  }
  function readTermStorage(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch (_) { return fallback; }
  }
  function writeTermStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  }
  function studentStorageKey(key, studentId) {
    const id = normalizeStudentId(studentId || readLocalProfile()?.studentId);
    return `${key}.student.${app.studentIdPattern.test(id) ? id : 'guest'}`;
  }
  function readStudentTermStorage(key, fallback, studentId) {
    return readTermStorage(studentStorageKey(key, studentId), fallback);
  }
  function writeStudentTermStorage(key, value, studentId) {
    return writeTermStorage(studentStorageKey(key, studentId), value);
  }

  global.LearnerProfile = Object.freeze({
    normalizeStudentId, isValidStudentId: value => app.studentIdPattern.test(normalizeStudentId(value)),
    studentEmail: studentId => `${normalizeStudentId(studentId)}@${app.studentEmailDomain}`,
    readLocalProfile, saveLocalProfile, startSession, hasActiveSession, endSession,
    checkBrowserStudent, claimBrowserStudent, refreshBrowserStudent, releaseBrowserStudent,
    getRemoteSessionId, rotateRemoteSessionId,
    termDocumentPath: uid => `users/${uid}/terms/${app.currentTermId}`,
    readTermStorage, writeTermStorage,
    studentStorageKey, readStudentTermStorage, writeStudentTermStorage
  });
  global.LearningProfile = Object.freeze({
    get: () => readLocalProfile() || normalize({}),
    save: value => startSession(value),
    clear: endSession,
    isComplete,
    normalize,
    deriveFromStudentId
  });

  global.addEventListener('pagehide', releaseBrowserStudent);
  global.addEventListener('focus', refreshBrowserStudent);
  global.setInterval(refreshBrowserStudent, 60 * 1000);

  // This module runs on every learner page that already loads this shared file.
  // It records a short-lived presence signal without changing learning progress.
  if (app?.isFirebaseConfigured?.()) {
    const sourceUrl = global.document.currentScript?.src || global.location.href;
    import(new URL('presence.js', sourceUrl).href).catch(error => console.warn('Unable to start class presence:', error));
  }
})(window);
