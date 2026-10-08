'use strict';
// Offline diagnostics only. No live accounts, credentials or Google/Notion calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./notion-certificate-sync.cjs');
let checks = 0;
function check(value, message) { assert(value, message); checks++; }
const unauthorized = { status:401, body:{ error:{message:'Invalid Credentials',errors:[{reason:'authError'}]} } };
function job(f, id = '1510101') {
  const url = 'https://drive.google.com/file/d/approved/view';
  return {term:'115-1',classRoom:'701',task:{key:'thinking-1',category:'thinking',title:'運算思維'},students:[{
    ...f.student(id,false),status:'已核定通關',completedAt:'2026-10-08T02:00:00Z',reviewedAt:'2026-10-08T03:00:00Z',
    reviewedBy:'jimwang@mail.qfm.kh.edu.tw',approvedAttachmentUrl:url,attachments:[{name:'採認附件',url}]
  }]};
}
function diagnostics(f, options = {}) {
  const calls = { scope:0, advanced:0 };
  f.context.Session = {
    getActiveUser:() => ({getEmail:() => options.activeUser ?? 'jimwang@mail.qfm.kh.edu.tw'}),
    getEffectiveUser:() => ({getEmail:() => options.effectiveUser ?? 'jimwang@mail.qfm.kh.edu.tw'})
  };
  f.context.ScriptApp.AuthMode = {FULL:'FULL'};
  f.context.ScriptApp.getAuthorizationInfo = (mode, scopes) => {
    calls.scope++;
    assert.equal(mode,'FULL'); assert.deepEqual([...scopes],['https://www.googleapis.com/auth/drive.readonly']);
    if (options.scopeError) throw Error('scope error: synthetic-secret-token');
    return {getAuthorizationStatus:() => options.scopeStatus ?? 'NOT_REQUIRED'};
  };
  if (!options.noService) f.context.Drive = {About:{get:parameters => {
    calls.advanced++; assert.equal(parameters.fields,'user(emailAddress)');
    if (options.advancedError) throw Error(options.advancedError);
    return {user:{emailAddress:options.advancedUser ?? 'jimwang@mail.qfm.kh.edu.tw'}};
  }}};
  return calls;
}
for (const [stage,label] of [['metadata','檔案資訊讀取'],['media','PNG 下載'],['export','Google 繪圖轉檔']]) {
  const f = fixture(), calls = diagnostics(f);
  if (stage==='export') f.driveFiles.get('approved').mimeType='application/vnd.google-apps.drawing';
  f.driveResponses.set('approved:'+stage,[unauthorized,unauthorized]);
  const result=f.context.syncNotion_(job(f)), failure=result.failedStudents[0], d=failure.authDiagnostic;
  check(d?.version==='drive-auth-diagnostic-v1' && d.stage===label && Number.isFinite(Date.parse(d.checkedAt)), label+' has same-execution timestamp/stage');
  check(d.effectiveUser==='jimwang@mail.qfm.kh.edu.tw' && d.activeUser===d.effectiveUser && d.advancedUser===d.effectiveUser, 'effective, active and advanced account checks retained');
  check(d.scopeStatus==='NOT_REQUIRED' && d.advancedStatus==='SUCCESS' && calls.scope===1 && calls.advanced===1, 'exactly one diagnostic probe after persistent 401');
  check(result.filesSynced===0 && f.sends()===0 && !f.work('1510101') && /HTTP 401/.test(failure.message), 'successful diagnostic never counts failed source as successful sync');
  check(!JSON.stringify(result).includes('mock-google-token'), 'diagnostic never outputs OAuth credential');
}
for (const recover of [true,false]) {
  const f=fixture(), calls=diagnostics(f,{advancedError:'must not be called'});
  f.driveResponses.set('approved:metadata',recover?[unauthorized]:[{status:403,body:{error:{message:'Forbidden'}}}]);
  const result=f.context.syncNotion_(job(f));
  check(calls.scope===0 && calls.advanced===0, recover?'recovered 401 needs no probe':'403 needs no 401 probe');
  check(recover?result.filesSynced===1:!result.failedStudents[0].authDiagnostic, 'diagnostic is only attached to persistent 401');
}
{
  const f=fixture(), calls=diagnostics(f);
  const result=f.context.syncNotion_(job(f));
  check(result.filesSynced===1 && calls.scope===0 && calls.advanced===0, 'successful sync incurs no extra diagnostic calls');
}
for (const [options,status,reason] of [
  [{advancedError:'401 Invalid Credentials Bearer synthetic-secret-token'},'FAILED','AUTHENTICATION_FAILED'],
  [{advancedError:'403 insufficient permissions synthetic-secret-token'},'FAILED','ACCESS_DENIED'],
  [{advancedError:'403 Drive API not enabled synthetic-secret-token'},'FAILED','SERVICE_DISABLED'],
  [{advancedError:'<img src=x onerror=alert(1)> synthetic-secret-token'},'FAILED','UNKNOWN'],
  [{noService:true},'UNAVAILABLE',''], [{advancedUser:''},'INVALID_RESPONSE','']
]) {
  const f=fixture(); diagnostics(f,options); f.driveResponses.set('approved:metadata',[unauthorized,unauthorized]);
  const result=f.context.syncNotion_(job(f)), d=result.failedStudents[0].authDiagnostic;
  check(d.advancedStatus===status && d.advancedReason===reason && /HTTP 401/.test(result.failedStudents[0].message), 'probe failure does not replace original error: '+reason);
  check(!JSON.stringify(result).includes('synthetic-secret-token') && !JSON.stringify(d).includes('<img'), 'raw probe exceptions/secrets are not returned');
}
{
  const f=fixture(); diagnostics(f,{scopeStatus:'REQUIRED',effectiveUser:'other@example.invalid'});
  f.driveResponses.set('approved:metadata',[unauthorized,unauthorized]);
  const d=f.context.syncNotion_(job(f)).failedStudents[0].authDiagnostic;
  check(d.scopeStatus==='REQUIRED' && d.effectiveUser==='other@example.invalid', 'actual runtime identity and missing consent are not hidden');
}
{
  const f=fixture(); diagnostics(f,{scopeError:true,noService:true});
  f.context.Session.getActiveUser=()=>{throw Error('synthetic-secret-token');};
  f.context.Session.getEffectiveUser=()=>{throw Error('synthetic-secret-token');};
  f.driveResponses.set('approved:metadata',[unauthorized,unauthorized]);
  const payload=job(f); payload.students.push({...payload.students[0],studentId:'1510102'});
  const result=f.context.syncNotion_(payload), d=result.failedStudents[0].authDiagnostic;
  check(d.scopeStatus==='UNKNOWN' && !d.activeUser && !d.effectiveUser && d.advancedStatus==='UNAVAILABLE', 'unavailable checks remain unknown, not missing-consent claims');
  check(result.filesSynced===1 && result.failedStudents.length===1 && f.work('1510102'), 'diagnostic failures never block next student');
}
// Exercise the real HTML rendering helper without a browser or live backend.
const root=path.resolve(__dirname,'..'), teacher=fs.readFileSync(path.join(root,'shared/teacher.html'),'utf8');
const helper=teacher.slice(teacher.indexOf('    function notionAuthDiagnosticHtml('),teacher.indexOf('    async function syncNotionTask('));
const context=vm.createContext({escapeHtml:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),formatDate:value=>value});
vm.runInContext(helper,context);
const render=value=>context.notionAuthDiagnosticHtml(value);
check(render(null)==='' && render({version:'unknown'})==='', 'old/missing diagnostics remain compatible');
const output=render({version:'drive-auth-diagnostic-v1',checkedAt:'<img src=x>',stage:'<script>alert(1)</script>',effectiveUser:'<svg onload=alert(1)>',scopeStatus:'NOT_REQUIRED',advancedStatus:'SUCCESS',advancedUser:'<img src=x>'});
check(!output.includes('<script>') && !output.includes('<svg ') && !output.includes('<img ') && output.includes('&lt;script&gt;'), 'all diagnostic values are HTML escaped');
check(output.includes('同步當下診斷') && output.includes('已具備授權') && output.includes('不代表原附件已確認可下載'), 'UI displays facts without claiming source download success');
check(render({version:'drive-auth-diagnostic-v1',scopeStatus:'REQUIRED',advancedStatus:'FAILED',advancedReason:'AUTHENTICATION_FAILED'}).includes('驗證失敗'), 'UI explains classified advanced-service failure');
console.log(`PASS ${checks} offline same-execution Drive authentication diagnostic checks; no live API calls.`);
