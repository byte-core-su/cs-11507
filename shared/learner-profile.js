/* Shared student identity helpers, with compatibility for first-term pages. */
(function (global) {
  'use strict';
  const app = global.SCHOOL_APP;
  if (!app) return;

  const sessionKey = `learning-platform.${app.currentTermId}.session.v1`;
  const profileSessionKey = `learning-platform.${app.currentTermId}.active-profile.v1`;
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
    const profile = saveLocalProfile(value);
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

  // This module runs on every learner page that already loads this shared file.
  // It records a short-lived presence signal without changing learning progress.
  if (app?.isFirebaseConfigured?.()) {
    const sourceUrl = global.document.currentScript?.src || global.location.href;
    import(new URL('presence.js', sourceUrl).href).catch(error => console.warn('Unable to start class presence:', error));
  }
})(window);
