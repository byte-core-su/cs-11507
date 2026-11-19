/* One foreground, verified learner tab records bounded active-use heartbeats. */
import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { deleteField, doc, getFirestore, increment, onSnapshot, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import './student-activity.js';

const settings=window.SCHOOL_APP;
if(settings?.isFirebaseConfigured?.()){
  const app=getApps().length?getApp():initializeApp(settings.firebaseConfig),auth=getAuth(app),db=getFirestore(app);
  let currentUser=null,duplicate=false;
  const sessionIds=new Map();
  const initialized=new Set(),started=new Set();
  function identity(){
    const studentId=String(currentUser?.email||'').split('@')[0],profile=window.LearnerProfile?.readLocalProfile?.();
    if(!currentUser||currentUser.isAnonymous||!settings.studentIdPattern.test(studentId)
      ||currentUser.email!==`${studentId}@${settings.studentEmailDomain}`||profile?.studentId!==studentId
      ||!window.LearnerProfile?.hasActiveSession?.())return null;
    return {uid:currentUser.uid,studentId,remoteId:window.LearnerProfile.getRemoteSessionId(),allowed:window.LearnerProfile.checkBrowserStudent(studentId).allowed};
  }
  function sessionId(owner){
    const key=`learning-platform.${settings.currentTermId}.${owner.uid}.usage-session.v2`;
    if(sessionIds.has(key))return sessionIds.get(key);
    let id='';try{id=sessionStorage.getItem(key)||'';}catch(_){}
    if(!/^session_[A-Za-z0-9_-]+$/.test(id)){id='session_'+(crypto.randomUUID?.()||`${Date.now()}_${Math.random().toString(36).slice(2)}`);try{sessionStorage.setItem(key,id);}catch(_){}}
    sessionIds.set(key,id);return id;
  }
  const presence=window.StudentActivity.create({
    env:{projectId:settings.firebaseConfig.projectId,termId:settings.currentTermId,now:()=>Date.now(),clock:()=>performance.now(),
      visible:()=>document.visibilityState==='visible',focused:()=>document.hasFocus(),online:()=>navigator.onLine!==false,
      storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},locks:navigator.locks,
      setTimeout,clearTimeout,setInterval,clearInterval,
      async duplicate(){if(duplicate)return;duplicate=true;window.LearnerProfile?.endSession?.();try{await signOut(auth);}catch(_){}window.location.replace(`${settings.rootPath||'./'}index.html?duplicateLogin=1`);}},
    identity,
    subscribe:(owner,next,error)=>onSnapshot(doc(db,'users',owner.uid),{includeMetadataChanges:true},snapshot=>next(snapshot.data(),snapshot.metadata),error),
    async write({owner,seconds,closing,legacy}){
      if(identity()?.uid!==owner.uid||identity()?.remoteId!==owner.remoteId)return;
      const id=sessionId(owner),first=legacy?.measurementVersion!=='active-v2'&&!initialized.has(owner.uid);
      await setDoc(doc(db,'users',owner.uid),{studentId:owner.studentId,terms:{[settings.currentTermId]:{
        presence:{lastSeenAt:serverTimestamp(),page:location.pathname,isActive:!closing},
        usage:{measurementVersion:'active-v2',totalActiveSeconds:increment(seconds),activeV2Seconds:increment(seconds),
          ...(first?{measuredSince:serverTimestamp(),legacyActiveSeconds:Math.max(0,Number(legacy?.totalActiveSeconds)||0)}:{}),
          sessions:{[id]:{...(!legacy?.sessions?.[id]?.startedAt&&!started.has(id)?{startedAt:serverTimestamp()}:{}),lastSeenAt:serverTimestamp(),activeSeconds:increment(seconds),page:location.pathname,status:closing?'closed':'active',endedAt:closing?serverTimestamp():deleteField()}}
        }
      }}},{merge:true});
      initialized.add(owner.uid);started.add(id);
    }
  });
  onAuthStateChanged(auth,user=>{currentUser=user;presence.tick();});
  window.addEventListener('portal:authenticated',()=>presence.activity());
  window.addEventListener('focus',()=>presence.activity());
  window.addEventListener('blur',()=>presence.tick());
  window.addEventListener('online',()=>presence.tick());
  window.addEventListener('offline',()=>presence.tick());
  document.addEventListener('visibilitychange',()=>presence.tick());
  window.addEventListener('pagehide',()=>presence.stop());
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  let lastInteraction=0;
  for(const type of ['pointerdown','keydown','wheel','touchstart','pointermove'])document.addEventListener(type,event=>{
    if(!event.isTrusted||performance.now()-lastInteraction<1000)return;lastInteraction=performance.now();presence.activity();
  },{passive:true});
}
