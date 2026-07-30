import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { EmailAuthProvider, getAuth, linkWithCredential, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { getFirestore, doc, getDoc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const app = window.SCHOOL_APP;
const config = window.TERM_PORTAL_CONFIG;
const root = document.getElementById('portal-root');
const colors = ['#4f46e5','#0284c7','#db2777','#059669','#7c3aed','#ea580c','#0f766e','#e11d48'];
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const taipeiDay = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts().filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const courseList = config.courses.map(([title,description,href,icon,background]) => ({title,description,href,icon,background}));
const teacherTasks = (config.teacherTasks || []).map(([id,label,rule]) => ({id,label,rule:rule || {}}));
const total = teacherTasks.length;
let auth, db, user, profile, termProgress = {}, teacherProgress = {}, stop = () => {}, isFinishingInitialSetup = false;

function shell(content) { root.innerHTML = `<style>
  #portal-root{min-height:100vh;background:#f8fafc;color:#1e293b;font-family:system-ui,"Noto Sans TC","Microsoft JhengHei",sans-serif} .portal-wrap{max-width:1120px;margin:auto;padding:40px 16px 72px}.portal-card{border:1px solid #e2e8f0;border-radius:24px;background:#fff;box-shadow:0 10px 24px #0f172a0d}.portal-button{border:0;border-radius:14px;background:#4f46e5;padding:13px 18px;color:#fff;font:inherit;font-weight:800;cursor:pointer}.portal-button:hover{background:#4338ca}.portal-input{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:14px;padding:13px;font:inherit}.portal-input:focus{outline:3px solid #c7d2fe;border-color:#4f46e5}.portal-term{font-size:12px;font-weight:900;letter-spacing:.16em;color:#c7d2fe}.course-grid,.task-grid{display:grid;gap:18px}.course-grid{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.course-grid.course-grid--three{grid-template-columns:repeat(3,minmax(0,1fr))}.task-grid{grid-template-columns:repeat(auto-fit,minmax(245px,1fr))}.course-card{min-height:240px;border-radius:28px;padding:24px;color:#fff;text-decoration:none;box-shadow:0 12px 24px #0f172a26;transition:.2s}.course-card:hover{transform:translateY(-5px)}.easter-egg-card{align-self:stretch;min-height:240px;padding:24px;border:1px solid #eef2f7;border-radius:28px;background:#f8fafc;color:#cbd5e1;box-shadow:none;font-size:13px;font-weight:800;opacity:.78;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center}.easter-egg-card:hover{transform:translateY(-5px);border-color:#e2e8f0;background:#fff;color:#94a3b8;opacity:1}.easter-egg-icon{font-size:34px;transition:transform .2s}.easter-egg-name{max-height:0;opacity:0;overflow:hidden;transform:translateY(8px);transition:max-height .2s,opacity .2s,transform .2s}.easter-egg-card:hover .easter-egg-icon,.easter-egg-card:focus-visible .easter-egg-icon{transform:translateY(-3px)}.easter-egg-card:hover .easter-egg-name,.easter-egg-card:focus-visible .easter-egg-name{max-height:24px;opacity:1;transform:translateY(0)}.task-card{padding:20px}.task-item{display:flex;gap:10px;padding:9px 0;font-size:14px;line-height:1.45}.task-item input{margin-top:3px;accent-color:#4f46e5}.muted{color:#64748b}.error{color:#be123c}.progress{height:10px;overflow:hidden;border-radius:999px;background:#ffffff33}.progress>span{display:block;height:100%;border-radius:inherit;background:#67e8f9}@media(max-width:760px){.course-grid.course-grid--three{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.portal-wrap{padding-top:28px}.course-grid.course-grid--three{grid-template-columns:1fr}}
  </style>${content}`; }
async function signInOrCreateStudent(id, code) {
  const email = `${id}@${app.studentEmailDomain}`;
  if (!auth.currentUser?.isAnonymous) {
    try {
      await signInWithEmailAndPassword(auth, email, code);
      return;
    } catch (error) {
      if (error.code !== 'auth/user-not-found' && error.code !== 'auth/invalid-credential') throw error;
    }
  }
  if (!auth.currentUser?.isAnonymous) await signInAnonymously(auth);
  const roster = await getDoc(doc(db, 'rosters', id));
  const expectedCode = roster.data()?.verificationCode;
  if (!roster.exists()) {
    await signOut(auth);
    throw new Error('verification-code-mismatch');
  }
  if (!/^\d{6}$/.test(String(expectedCode || ''))) return { needsInitialSetup: true };
  if (String(expectedCode) !== code) {
    await signOut(auth);
    throw new Error('verification-code-mismatch');
  }
  try {
    // Linking keeps any older anonymous learning record under the same UID.
    await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, code));
  } catch (error) {
    if (error.code !== 'auth/email-already-in-use' && error.code !== 'auth/credential-already-in-use') throw error;
    await signInWithEmailAndPassword(auth, email, code);
  }
}
async function completeInitialSetup(id, code, confirmation) {
  if (!app.studentIdPattern.test(id) || !/^\d{6}$/.test(code) || code !== confirmation) throw new Error('invalid-initial-code');
  if (!auth.currentUser?.isAnonymous) await signInAnonymously(auth);
  const rosterRef = doc(db, 'rosters', id);
  const roster = await getDoc(rosterRef);
  if (!roster.exists()) throw new Error('roster-not-found');
  const email = `${id}@${app.studentEmailDomain}`;
  if (/^\d{6}$/.test(String(roster.data()?.verificationCode || ''))) {
    await signOut(auth);
    return { needsLogin: true, alreadySet: true };
  }
  isFinishingInitialSetup = true;
  try {
    try {
      await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, code));
    } catch (error) {
      if (error.code !== 'auth/email-already-in-use' && error.code !== 'auth/credential-already-in-use') throw error;
      await signInWithEmailAndPassword(auth, email, code);
    }
    await setDoc(rosterRef, { verificationCode: code, verificationCodeUpdatedAt: new Date() }, { merge: true });
  } catch (error) {
    await signOut(auth);
    throw error;
  } finally {
    isFinishingInitialSetup = false;
  }
  await signOut(auth);
  return { needsLogin: true };
}
function showInitialSetup(id, suggestedCode = '') {
  shell(`<main class="portal-wrap" style="max-width:480px;display:grid;min-height:calc(100vh - 80px);place-items:center"><section id="initial-code-setup" class="portal-card" style="width:100%;padding:32px;box-sizing:border-box"><p style="margin:0;color:#4f46e5;font-size:12px;font-weight:900;letter-spacing:.18em">${esc(config.termLabel)}</p><h1 style="margin:12px 0 4px;font-size:30px">設定登入驗證碼</h1><p style="margin:0 0 20px;font-weight:800;color:#475569">學號：${esc(id)}</p><p class="muted" style="margin:0 0 22px;font-size:14px;line-height:1.7">這是首次登入，請自行設定六位數驗證碼。完成後，教師可協助查看、重設或更改。</p><form id="initial-code-form" style="display:grid;gap:16px"><label style="font-weight:800">設定六位數驗證碼<input id="initial-code" class="portal-input" type="password" inputmode="numeric" maxlength="6" required value="${esc(suggestedCode)}"></label><label style="font-weight:800">再次確認驗證碼<input id="initial-code-confirmation" class="portal-input" type="password" inputmode="numeric" maxlength="6" required></label><button class="portal-button">設定並進入 ${esc(config.termLabel)}</button></form><p id="initial-code-message" class="muted" style="margin:16px 0 0;font-size:14px"></p></section></main>`);
  document.getElementById('initial-code-form').addEventListener('submit', async event => {
    event.preventDefault();
    const code = document.getElementById('initial-code').value.trim();
    const confirmation = document.getElementById('initial-code-confirmation').value.trim();
    const message = document.getElementById('initial-code-message');
    try {
      message.textContent = '正在設定登入帳號…';
      const result = await completeInitialSetup(id, code, confirmation);
      if (result?.needsLogin) showLogin(result.alreadySet ? '此帳號已完成設定，請使用原本的驗證碼登入。' : '驗證碼設定完成，請使用剛設定的驗證碼登入。');
    }
    catch (error) {
      console.error(error);
      const text = error.message === 'invalid-initial-code' ? '請輸入相同的六位數字驗證碼。' : error.message === 'verification-code-mismatch' ? '此帳號已完成設定，請輸入原本設定的六位數驗證碼。' : '設定失敗，請確認名冊資料後再試一次。';
      message.className = 'error'; message.textContent = text;
    }
  });
}
function showLogin(message = '', error = false) {
  shell(`<main class="portal-wrap" style="max-width:480px;display:grid;min-height:calc(100vh - 80px);place-items:center"><section class="portal-card" style="width:100%;padding:32px;box-sizing:border-box"><p style="margin:0;color:#4f46e5;font-size:12px;font-weight:900;letter-spacing:.18em">${esc(config.termLabel)}</p><h1 style="margin:12px 0 4px;font-size:30px">資訊科技學習平台</h1><p style="margin:0 0 28px;font-weight:800;color:#475569">學生登入</p><form id="portal-login" style="display:grid;gap:16px"><label style="font-weight:800">學號<input id="portal-id" class="portal-input" inputmode="numeric" maxlength="7" required placeholder="例如：1512026"></label><label style="font-weight:800">六位數驗證碼<input id="portal-code" class="portal-input" type="password" inputmode="numeric" maxlength="6" required></label><button class="portal-button">進入 ${esc(config.termLabel)}</button></form><p class="muted" style="margin:14px 0 0;font-size:13px">尚未設定驗證碼的同學，輸入欲設定的六位數字後即可開始設定。</p><p class="${error?'error':'muted'}" style="margin:12px 0 0;font-size:14px">${esc(message)}</p></section></main>`);
  document.getElementById('portal-login').addEventListener('submit', async event => {
    event.preventDefault();
    const id = document.getElementById('portal-id').value.trim();
    const code = document.getElementById('portal-code').value.trim();
    if (!app.studentIdPattern.test(id) || !/^\d{6}$/.test(code)) return showLogin('請輸入正確的 7 位學號與 6 位驗證碼。', true);
    try {
      const result = await signInOrCreateStudent(id, code);
      if (result?.needsInitialSetup) showInitialSetup(id, code);
    } catch (_) { showLogin('登入失敗，請確認學號、驗證碼與教師建立的名冊資料。', true); }
  });
}
function showPortal() {
  const certificateFor = unit => Object.values(termProgress.certificates || {}).some(item => item?.chapterKey === unit || item?.id === `infolife-${unit}` || item?.id === `security-${unit}`);
  const flowchartFor = unit => Boolean(termProgress.workflow?.flowcharts?.[unit]);
  const teacherCheckFor = task => teacherProgress.taskCompletions?.[task]?.status === 'approved'
    || Object.entries(teacherProgress.liveChecks || {}).some(([key, value]) => key.indexOf(`${task}_`) === 0 && value?.status === 'approved');
  const isCompleted = task => task.rule.source === 'certificate' ? certificateFor(task.rule.unit) : (task.rule.source === 'flowchart' ? flowchartFor(task.rule.unit) : teacherCheckFor(task.rule.task));
  const completed = teacherTasks.filter(isCompleted).length;
  const cards = courseList.map(course => `<a class="course-card" href="${esc(course.href)}" style="background:${course.background}"><div style="font-size:46px">${course.icon}</div><p style="margin:28px 0 5px;font-size:11px;font-weight:900;letter-spacing:.15em;color:#ffffffb3">LEARNING STUDIO</p><h2 style="margin:0;font-size:21px">${esc(course.title)}</h2><p style="margin:10px 0 0;line-height:1.55;color:#ffffffd9">${esc(course.description)}</p><b style="display:block;margin-top:22px">開始學習 →</b></a>`).join('');
  const egg = Array.isArray(config.easterEgg) ? config.easterEgg : null;
  const eggName = egg ? String(egg[1] || '課間小遊戲').replace(/^課間小遊戲[：:]\s*/, '') : '';
  const easterEggCard = egg && config.courseGridColumns ? `<a class="course-card easter-egg-card" href="${esc(egg[0])}" title="${esc(eggName)}" aria-label="${esc(eggName)}"><span class="easter-egg-icon" aria-hidden="true">${esc(egg[2] || '✨')}</span><span class="easter-egg-name">${esc(eggName)}</span></a>` : '';
  const easterEgg = egg && !config.courseGridColumns ? `<p style="margin:14px 2px 0;text-align:right"><a href="${esc(egg[0])}" style="color:#94a3b8;font-size:12px;font-weight:700;text-decoration:none" title="課程彩蛋">${esc(egg[2] || '✨')} ${esc(egg[1])} ↗</a></p>` : '';
  const cardsTasks = `<article class="portal-card task-card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:12px"><b style="color:#4f46e5">任務完成紀錄</b><span class="muted" style="font-size:12px;font-weight:800">已完成 ${completed} / ${total}</span></div>${teacherTasks.map(task => { const done = isCompleted(task); return `<div class="task-item" style="justify-content:space-between;align-items:center;border-bottom:1px solid #f1f5f9"><span>${esc(task.label)}</span><b style="white-space:nowrap;color:${done ? '#059669' : '#94a3b8'}">${done ? '已完成' : '尚未完成'}</b></div>`; }).join('')}<p class="muted" style="margin:14px 0 0;font-size:12px;line-height:1.6">資訊生活與演算流程由系統記錄；運算思維與程式設計須由教師檢核附件後標記完成。</p></article>`;
  const progressPercent = total ? Math.round(completed / total * 100) : 0;
  shell(`<main class="portal-wrap"><header style="margin-bottom:34px;border-radius:28px;background:linear-gradient(135deg,#4338ca,#7c3aed);padding:30px;color:#fff;box-shadow:0 18px 32px #4f46e533"><div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:24px;align-items:end"><div><p class="portal-term">${esc(config.termLabel)} · LEARNING PORTAL</p><h1 style="margin:10px 0 5px;font-size:30px">資訊科技學習平台</h1><p style="margin:0;color:#e0e7ff">${esc(profile.name || '同學')} · ${esc(profile.studentId)}</p></div><div style="min-width:220px"><div style="display:flex;justify-content:space-between;font-size:14px"><span>本學期任務</span><b>${completed} / ${total}</b></div><div class="progress" style="margin-top:12px"><span style="width:${progressPercent}%"></span></div></div></div></header><section><p style="margin:0;color:#4f46e5;font-size:12px;font-weight:900;letter-spacing:.16em">COURSE CENTER</p><h2 style="margin:6px 0 18px">選擇課程開始學習</h2><div class="course-grid${config.courseGridColumns === 3 ? ' course-grid--three' : ''}">${cards}${easterEggCard}</div>${easterEgg}</section><section style="margin-top:42px"><p style="margin:0;color:#4f46e5;font-size:12px;font-weight:900;letter-spacing:.16em">MY PROGRESS</p><h2 style="margin:6px 0 6px">本學期任務進度</h2><p class="muted" style="margin:0 0 18px;font-size:14px">系統與教師確認紀錄</p><div class="task-grid">${cardsTasks}</div></section></main>`);
}
async function loadStudent(currentUser) {
  user = currentUser;
  const id = currentUser.email?.split('@')[0] || '';
  if (!app.studentIdPattern.test(id)) return;
  const roster = await getDoc(doc(db,'rosters',id));
  const rosterData = roster.exists() ? roster.data() : {};
  profile = { ...(rosterData || {}), studentId:id };
  window.LearnerProfile?.startSession(profile);
  window.dispatchEvent(new Event('portal:authenticated'));
  const now = new Date();
  await setDoc(doc(db,'users',user.uid), {
    studentId:id,
    profile,
    identity:{provider:'student-email',studentId:id},
    updatedAt:now,
    terms:{[app.currentTermId]:{startedAt:now,updatedAt:now,attendance:{[taipeiDay()]:{loginAt:now}}}}
  }, {merge:true});
  stop();
  stop = onSnapshot(doc(db,'users',user.uid), snap => { const data = snap.data() || {}; termProgress=data.terms?.[app.currentTermId] || {}; teacherProgress=data.teacherProgress?.[app.currentTermId] || {}; showPortal(); });
}
const firebaseApp=initializeApp(app.firebaseConfig); auth=getAuth(firebaseApp); db=getFirestore(firebaseApp); onAuthStateChanged(auth,current=>{if(current?.email && !isFinishingInitialSetup) loadStudent(current).catch(()=>showLogin('資料載入失敗，請重新登入。',true)); else if (!current && !document.getElementById('initial-code-setup')) showLogin();});
