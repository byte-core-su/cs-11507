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
const groups = config.taskGroups.map(([title,tasks]) => ({title,tasks:tasks.map(([id,label])=>({id,label}))}));
const total = groups.flatMap(group=>group.tasks).length;
let auth, db, user, profile, tasks = {}, stop = () => {};

function shell(content) { root.innerHTML = `<style>
  #portal-root{min-height:100vh;background:#f8fafc;color:#1e293b;font-family:system-ui,"Noto Sans TC","Microsoft JhengHei",sans-serif} .portal-wrap{max-width:1120px;margin:auto;padding:40px 16px 72px}.portal-card{border:1px solid #e2e8f0;border-radius:24px;background:#fff;box-shadow:0 10px 24px #0f172a0d}.portal-button{border:0;border-radius:14px;background:#4f46e5;padding:13px 18px;color:#fff;font:inherit;font-weight:800;cursor:pointer}.portal-button:hover{background:#4338ca}.portal-input{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:14px;padding:13px;font:inherit}.portal-input:focus{outline:3px solid #c7d2fe;border-color:#4f46e5}.portal-term{font-size:12px;font-weight:900;letter-spacing:.16em;color:#c7d2fe}.course-grid,.task-grid{display:grid;gap:18px}.course-grid{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.task-grid{grid-template-columns:repeat(auto-fit,minmax(245px,1fr))}.course-card{min-height:240px;border-radius:28px;padding:24px;color:#fff;text-decoration:none;box-shadow:0 12px 24px #0f172a26;transition:.2s}.course-card:hover{transform:translateY(-5px)}.task-card{padding:20px}.task-item{display:flex;gap:10px;padding:9px 0;font-size:14px;line-height:1.45}.task-item input{margin-top:3px;accent-color:#4f46e5}.muted{color:#64748b}.error{color:#be123c}.progress{height:10px;overflow:hidden;border-radius:999px;background:#ffffff33}.progress>span{display:block;height:100%;border-radius:inherit;background:#67e8f9}@media(max-width:640px){.portal-wrap{padding-top:28px}}
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
  if (!roster.exists() || String(expectedCode || '') !== code) {
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
function showLogin(message = '', error = false) { shell(`<main class="portal-wrap" style="max-width:480px;display:grid;min-height:calc(100vh - 80px);place-items:center"><section class="portal-card" style="width:100%;padding:32px;box-sizing:border-box"><p style="margin:0;color:#4f46e5;font-size:12px;font-weight:900;letter-spacing:.18em">${esc(config.termLabel)}</p><h1 style="margin:12px 0 4px;font-size:30px">資訊科技學習平台</h1><p style="margin:0 0 28px;font-weight:800;color:#475569">學生登入</p><form id="portal-login" style="display:grid;gap:16px"><label style="font-weight:800">學號<input id="portal-id" class="portal-input" inputmode="numeric" maxlength="7" required placeholder="例如：1512026"></label><label style="font-weight:800">六位數驗證碼<input id="portal-code" class="portal-input" type="password" inputmode="numeric" maxlength="6" required></label><button class="portal-button">進入 ${esc(config.termLabel)}</button></form><p class="${error?'error':'muted'}" style="margin:16px 0 0;font-size:14px">${esc(message)}</p></section></main>`); document.getElementById('portal-login').addEventListener('submit', async event => { event.preventDefault(); const id=document.getElementById('portal-id').value.trim(); const code=document.getElementById('portal-code').value.trim(); if(!app.studentIdPattern.test(id)||!/^\d{6}$/.test(code)) return showLogin('請輸入正確的 7 位學號與 6 位驗證碼。',true); try { await signInOrCreateStudent(id, code); } catch (_) { showLogin('登入失敗，請確認學號、驗證碼與教師建立的名冊資料。',true); } }); }
function showPortal() { const completed=groups.flatMap(g=>g.tasks).filter(t=>tasks[t.id]).length; const cards=courseList.map(course=>`<a class="course-card" href="${esc(course.href)}" style="background:${course.background}"><div style="font-size:46px">${course.icon}</div><p style="margin:28px 0 5px;font-size:11px;font-weight:900;letter-spacing:.15em;color:#ffffffb3">LEARNING STUDIO</p><h2 style="margin:0;font-size:21px">${esc(course.title)}</h2><p style="margin:10px 0 0;line-height:1.55;color:#ffffffd9">${esc(course.description)}</p><b style="display:block;margin-top:22px">開始學習 →</b></a>`).join(''); const cardsTasks=groups.map((group,index)=>{const done=group.tasks.filter(t=>tasks[t.id]).length; return `<article class="portal-card task-card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:12px"><b style="color:${colors[index]}">${group.title}</b><span class="muted" style="font-size:12px;font-weight:800">${done} / ${group.tasks.length}</span></div>${group.tasks.map(task=>`<label class="task-item"><input data-task="${task.id}" type="checkbox" ${tasks[task.id]?'checked':''} ${config.automaticTaskIds.includes(task.id)?'disabled':''}><span style="${tasks[task.id]?'color:#94a3b8;text-decoration:line-through':''}">${esc(task.label)}${config.automaticTaskIds.includes(task.id)?'<small style="margin-left:6px;color:#059669;font-weight:800">系統登記</small>':''}</span></label>`).join('')}</article>`}).join(''); shell(`<main class="portal-wrap"><header style="margin-bottom:34px;border-radius:28px;background:linear-gradient(135deg,#4338ca,#7c3aed);padding:30px;color:#fff;box-shadow:0 18px 32px #4f46e533"><div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:24px;align-items:end"><div><p class="portal-term">${esc(config.termLabel)} · LEARNING PORTAL</p><h1 style="margin:10px 0 5px;font-size:30px">資訊科技學習平台</h1><p style="margin:0;color:#e0e7ff">${esc(profile.name || '同學')} · ${esc(profile.studentId)}</p></div><div style="min-width:220px"><div style="display:flex;justify-content:space-between;font-size:14px"><span>本學期任務</span><b>${completed} / ${total}</b></div><div class="progress" style="margin-top:12px"><span style="width:${Math.round(completed/total*100)}%"></span></div><button id="portal-logout" style="margin-top:14px;border:0;background:transparent;color:#e0e7ff;font:inherit;cursor:pointer">登出</button></div></div></header><section><p style="margin:0;color:#4f46e5;font-size:12px;font-weight:900;letter-spacing:.16em">COURSE CENTER</p><h2 style="margin:6px 0 18px">選擇課程開始學習</h2><div class="course-grid">${cards}</div></section><section style="margin-top:42px"><p style="margin:0;color:#4f46e5;font-size:12px;font-weight:900;letter-spacing:.16em">MY PROGRESS</p><h2 style="margin:6px 0 18px">本學期任務進度</h2><div class="task-grid">${cardsTasks}</div></section></main>`); document.getElementById('portal-logout').onclick=()=>signOut(auth); document.querySelectorAll('[data-task]').forEach(box=>box.onchange=async()=>{tasks[box.dataset.task]=box.checked?new Date().toISOString():false; await setDoc(doc(db,'users',user.uid),{terms:{[app.currentTermId]:{tasks,updatedAt:new Date()}}},{merge:true});}); }
async function loadStudent(currentUser) { user=currentUser; const id=currentUser.email?.split('@')[0]||''; if(!app.studentIdPattern.test(id)) return; const roster=await getDoc(doc(db,'rosters',id)); const rosterData=roster.exists()?roster.data():{}; profile={...(rosterData||{}),studentId:id}; window.LearnerProfile?.startSession(profile); window.dispatchEvent(new Event('portal:authenticated')); await setDoc(doc(db,'users',user.uid),{studentId:id,profile,identity:{provider:'student-email',studentId:id},terms:{[app.currentTermId]:{startedAt:new Date(),attendance:{[taipeiDay()]:{loginAt:new Date()}}}}},{merge:true}); stop(); stop=onSnapshot(doc(db,'users',user.uid),snap=>{tasks=snap.data()?.terms?.[app.currentTermId]?.tasks||{}; showPortal();}); }
const firebaseApp=initializeApp(app.firebaseConfig); auth=getAuth(firebaseApp); db=getFirestore(firebaseApp); onAuthStateChanged(auth,current=>{if(current?.email) loadStudent(current).catch(()=>showLogin('資料載入失敗，請重新登入。',true)); else showLogin();});
