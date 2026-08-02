/* Lightweight, shared "currently in class" signal for the teacher dashboard. */
import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { deleteField, doc, getFirestore, increment, onSnapshot, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const appSettings = window.SCHOOL_APP;
const heartbeatIntervalMs = 2 * 60 * 1000;
const sessionKey = `learning-platform.${appSettings?.currentTermId || 'term'}.usage-session.v1`;
let currentUser = null;
let firestore = null;
let authInstance = null;
let sessionId = '';
let isNewSession = false;
let lastRecordedAt = 0;
let stopRemoteSessionWatch = () => {};
let duplicateLoginDetected = false;

function currentStudentId() {
  const emailId = String(currentUser?.email || '').split('@')[0];
  const savedId = window.LearnerProfile?.readLocalProfile?.()?.studentId;
  // Firebase Auth is authoritative.  The page-local profile is only a
  // fallback while the portal is finishing its initial load.
  const studentId = appSettings?.studentIdPattern?.test(emailId) ? emailId : savedId;
  return appSettings?.studentIdPattern?.test(studentId) ? studentId : '';
}

function getSessionId() {
  if (sessionId) return sessionId;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(sessionKey) || 'null');
    sessionId = typeof stored?.id === 'string' ? stored.id : '';
  } catch (_) { /* Session storage is optional. */ }
  if (!sessionId) {
    const randomPart = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionId = `session_${randomPart.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    isNewSession = true;
    try { window.sessionStorage.setItem(sessionKey, JSON.stringify({ id: sessionId })); } catch (_) { /* Keep the in-memory ID. */ }
  }
  return sessionId;
}

async function handleDuplicateLogin() {
  if (duplicateLoginDetected) return;
  duplicateLoginDetected = true;
  try {
    window.LearnerProfile?.endSession?.();
    if (authInstance) await signOut(authInstance);
  } catch (_) { /* The redirect still protects this page. */ }
  const root = appSettings?.rootPath || './';
  window.location.replace(`${root}index.html?duplicateLogin=1`);
}

function watchRemoteSession() {
  stopRemoteSessionWatch();
  if (!currentUser || !firestore || !window.LearnerProfile?.hasActiveSession?.()) return;
  stopRemoteSessionWatch = onSnapshot(doc(firestore, 'users', currentUser.uid), snapshot => {
    const remoteId = snapshot.data()?.activeSession?.id;
    const localId = window.LearnerProfile?.getRemoteSessionId?.();
    if (remoteId && localId && remoteId !== localId) handleDuplicateLogin();
  }, error => console.warn('Unable to verify single-login session:', error));
}

async function recordClassActivity({ closing = false } = {}) {
  if (!currentUser || (!closing && document.visibilityState !== 'visible')) return;
  const studentId = currentStudentId();
  if (!studentId || !firestore) return;
  if (window.LearnerProfile?.checkBrowserStudent && !window.LearnerProfile.checkBrowserStudent(studentId).allowed) return;
  const now = Date.now();
  const elapsedSeconds = lastRecordedAt ? Math.max(0, Math.round((now - lastRecordedAt) / 1000)) : 0;
  lastRecordedAt = now;
  const id = getSessionId();
  const sessionData = {
    lastSeenAt: serverTimestamp(),
    activeSeconds: increment(elapsedSeconds),
    page: window.location.pathname,
    status: closing ? 'closed' : 'active',
    endedAt: closing ? serverTimestamp() : deleteField(),
    ...(isNewSession ? { startedAt: serverTimestamp() } : {})
  };
  try {
    await setDoc(doc(firestore, 'users', currentUser.uid), {
      studentId,
      terms: {
        [appSettings.currentTermId]: {
          presence: {
            lastSeenAt: serverTimestamp(),
            page: window.location.pathname,
            isActive: !closing
          },
          usage: {
            totalActiveSeconds: increment(elapsedSeconds),
            sessions: {
              [id]: sessionData
            }
          }
        }
      }
    }, { merge: true });
    isNewSession = false;
  } catch (error) {
    console.warn('Unable to record class activity:', error);
  }
}

if (appSettings?.isFirebaseConfigured?.()) {
  const firebaseApp = getApps().length ? getApp() : initializeApp(appSettings.firebaseConfig);
  const auth = getAuth(firebaseApp);
  authInstance = auth;
  firestore = getFirestore(firebaseApp);
  onAuthStateChanged(auth, user => {
    currentUser = user;
    if (user) {
      recordClassActivity();
      watchRemoteSession();
    } else {
      stopRemoteSessionWatch();
      stopRemoteSessionWatch = () => {};
    }
  });
  window.addEventListener('portal:authenticated', () => { recordClassActivity(); watchRemoteSession(); });
  window.addEventListener('focus', () => recordClassActivity());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recordClassActivity();
    else recordClassActivity({ closing: true });
  });
  window.addEventListener('pagehide', () => recordClassActivity({ closing: true }));
  window.setInterval(() => recordClassActivity(), heartbeatIntervalMs);
}
