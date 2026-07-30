/* Lightweight, shared "currently in class" signal for the teacher dashboard. */
import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { doc, getFirestore, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const appSettings = window.SCHOOL_APP;
const heartbeatIntervalMs = 2 * 60 * 1000;
let currentUser = null;
let firestore = null;

function currentStudentId() {
  const savedId = window.LearnerProfile?.readLocalProfile?.()?.studentId;
  const emailId = String(currentUser?.email || '').split('@')[0];
  const studentId = savedId || emailId;
  return appSettings?.studentIdPattern?.test(studentId) ? studentId : '';
}

async function updatePresence() {
  if (!currentUser || document.visibilityState !== 'visible') return;
  const studentId = currentStudentId();
  if (!studentId || !firestore) return;
  try {
    await setDoc(doc(firestore, 'users', currentUser.uid), {
      studentId,
      terms: {
        [appSettings.currentTermId]: {
          presence: {
            lastSeenAt: serverTimestamp(),
            page: window.location.pathname
          }
        }
      }
    }, { merge: true });
  } catch (error) {
    console.warn('Unable to update class presence:', error);
  }
}

if (appSettings?.isFirebaseConfigured?.()) {
  const firebaseApp = getApps().length ? getApp() : initializeApp(appSettings.firebaseConfig);
  const auth = getAuth(firebaseApp);
  firestore = getFirestore(firebaseApp);
  onAuthStateChanged(auth, user => {
    currentUser = user;
    if (user) updatePresence();
  });
  window.addEventListener('portal:authenticated', updatePresence);
  window.addEventListener('focus', updatePresence);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updatePresence();
  });
  window.setInterval(updatePresence, heartbeatIntervalMs);
}
