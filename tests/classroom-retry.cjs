'use strict';
// Offline, synthetic read-only API responses. No Google credentials or live data.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'shared/google-classroom.gs'), 'utf8');
const teacher = fs.readFileSync(path.join(root, 'shared/teacher.html'), 'utf8');
const frontend = teacher.slice(teacher.indexOf('    async function classroomRequest('), teacher.indexOf('    function submissionState('));
let checks = 0;
function check(value, message) { assert(value, message); checks++; }
function api(responses) {
  const calls = [], sleeps = []; let tokens = 0;
  const context = vm.createContext({ ScriptApp:{ getOAuthToken:() => 'synthetic-token-' + (++tokens) },
    Utilities:{ sleep:ms => sleeps.push(ms) }, UrlFetchApp:{ fetch:(url, request) => {
      calls.push({ url, request }); assert.equal(request.method, 'get');
      const response = responses.shift(); assert(response, 'unexpected API request');
      return { getResponseCode:() => response.status, getContentText:() => typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
    } } });
  vm.runInContext(backend, context);
  context.requireTeacher_ = () => {};
  context.respond_ = (_, payload) => payload;
  return { context, calls, sleeps, tokens:() => tokens };
}
const unauthorized = { status:401, body:{ error:{ message:'Request had invalid authentication credentials.', errors:[{ reason:'authError' }] } } };
{
  const f = api([unauthorized, { status:200, body:{ courses:[{ id:'course' }] } }]);
  const result = f.context.classroomGet_('courses', { teacherId:'me', pageToken:'a & b', ignored:null });
  check(result.courses[0].id === 'course' && f.calls.length === 2 && f.tokens() === 2, '401 reacquires token once then succeeds');
  check(f.calls[0].request.headers.Authorization !== f.calls[1].request.headers.Authorization, 'token lookup is inside retry, not cached by request');
  check(f.calls[0].url === f.calls[1].url && f.calls[0].url.includes('pageToken=a%20%26%20b') && !f.calls[0].url.includes('ignored'), 'retry preserves URL, query and encoding');
  check(f.sleeps.length === 1 && f.sleeps[0] === 300, 'single bounded authentication backoff');
}
{
  const f = api([unauthorized, unauthorized]);
  const result = f.context.doGet({ parameter:{ action:'courses' } });
  check(result.status === 'error' && result.httpStatus === 401 && result.stage === '讀取課程' && result.reason === 'authError', 'doGet exposes status, stage and safe reason');
  check(/已重新取得憑證重試/.test(result.message) && /invalid authentication/.test(result.message) && !/synthetic-token/.test(JSON.stringify(result)), 'persistent 401 preserves cause without exposing token');
  check(f.calls.length === 2 && f.tokens() === 2, 'persistent 401 stops after two attempts');
}
for (const status of [400,403,404,429,500,503]) {
  const f = api([{ status, body:{ error:{ message:'synthetic cause', status:'PERMISSION_DENIED' } } }]);
  assert.throws(() => f.context.classroomGet_('courses/c/courseWork', {}), error => error.httpStatus === status && error.stage === '讀取作業' && /synthetic cause/.test(error.message));
  check(f.calls.length === 1 && f.sleeps.length === 0, status + ' is not treated as an auth retry');
}
for (const [endpoint, stage] of [['courses/c/students','讀取課程學生名冊'], ['courses/c/courseWork/w/studentSubmissions','讀取學生作業附件']]) {
  const f = api([{ status:403, body:{ error:{ message:'denied' } } }]);
  assert.throws(() => f.context.classroomGet_(endpoint, {}), error => error.stage === stage && error.httpStatus === 403);
  check(f.calls.length === 1, 'specific endpoint stage: ' + stage);
}
{
  const f = api([{ status:200, body:'<html>login</html>' }]);
  assert.throws(() => f.context.classroomGet_('courses', {}), /回應格式不正確/);
  check(f.calls.length === 1, 'non-JSON success is not silently an empty course list');
}
function browser(plan, endpoint = 'https://example.invalid/exec') {
  const scripts = [], timers = new Map(), notes = []; let timerId = 0, time = 0;
  const window = {};
  const context = vm.createContext({ URL, window, classroomEndpoint:endpoint,
    normalizedClassroomEndpoint:value => /^https:\/\//.test(value) ? value : '',
    setTimeout:(fn, ms) => { const id = ++timerId; timers.set(id, { fn, at:time + ms }); return id; }, clearTimeout:id => timers.delete(id),
    document:{ createElement:() => ({ remove() { this.removed = true; } }), head:{ appendChild:script => {
      const callback = new URL(script.src).searchParams.get('callback'); scripts.push({ script, callback });
      const next = plan.shift(); assert(next, 'unexpected frontend request');
      queueMicrotask(() => {
        if (next === 'error') script.onerror();
        else if (next === 'timeout') {} // Test clock advances to request deadline.
        else if (typeof next === 'function') next(window, callback, scripts);
        else window[callback](next);
      });
    } } }
  });
  vm.runInContext(frontend, context);
  const run = async (action = 'courses', parameters = {}) => {
    let done = false, result, failure;
    context.classroomRequest(action, parameters, note => notes.push(note)).then(value => { done = true; result = value; }, error => { done = true; failure = error; });
    for (let i = 0; i < 100 && !done; i++) {
      for (let tick = 0; tick < 10; tick++) await Promise.resolve();
      if (!done && timers.size) {
        const [id, task] = [...timers].sort((a,b) => a[1].at - b[1].at)[0]; timers.delete(id); time = task.at; task.fn();
      }
    }
    assert(done, 'request must settle');
    return { result, failure };
  };
  return { run, scripts, notes, timers, window };
}
const success = { status:'success', courses:[{ id:'real-result' }] };
(async () => {
  {
    const f = browser(['error', success]), outcome = await f.run('courses', { classRoom:'701' });
    check(outcome.result === success && !outcome.failure && f.scripts.length === 2, 'load error retries then succeeds');
    check(f.notes.length === 1 && /自動重試（1 \/ 2）/.test(f.notes[0]), 'retry progress is visible');
    check(f.scripts.every(({ script }) => script.removed) && f.timers.size === 0, 'successful load cleans scripts and timers');
    check(new Set(f.scripts.map(item => item.callback)).size === 2 && f.scripts.every(item => new URL(item.script.src).searchParams.get('classRoom') === '701'), 'each attempt has isolated callback and same parameters');
  }
  {
    const f = browser(['error','error','error']), outcome = await f.run();
    check(f.scripts.length === 3 && f.notes.length === 2 && /自動重試 2 次/.test(outcome.failure.message), 'load errors stop after three attempts');
    check(!outcome.failure.message.includes('請確認 Web App /exec 網址') && /讀取課程/.test(outcome.failure.message), 'network error does not assert URL is wrong');
  }
  {
    const f = browser(['timeout', (window, callback, scripts) => {
      window[scripts[0].callback]({ status:'success', courses:[{ id:'stale' }] });
      window[callback](success);
    }]);
    const outcome = await f.run();
    check(outcome.result === success && !outcome.failure && f.scripts.length === 2, 'late timed-out callback cannot replace retry result');
  }
  for (const payload of [{ status:'error', httpStatus:401, stage:'讀取課程', message:'讀取課程（HTTP 401）：authError' },
    { status:'error', httpStatus:403, message:'permission denied' }, { status:'error', message:'Classroom is not defined' }]) {
    const f = browser([payload]), outcome = await f.run();
    check(f.scripts.length === 1 && f.notes.length === 0 && outcome.failure, 'backend/API errors are not multiplied by frontend retries');
  }
  {
    const f = browser(['timeout','timeout','timeout']), outcome = await f.run('submissions', { courseId:'c', courseWorkId:'w' });
    check(f.scripts.length === 3 && /讀取學生作業附件.*回應逾時/.test(outcome.failure.message), 'timeouts are bounded and labeled');
  }
  {
    const f = browser([], ''); const outcome = await f.run();
    check(f.scripts.length === 0 && /網址尚未設定/.test(outcome.failure.message), 'invalid endpoint is not retried');
  }
  {
    const f = browser([]), outcome = await f.run('auth');
    check(f.scripts.length === 0 && /不支援/.test(outcome.failure.message), 'only read-only actions can enter frontend retry flow');
  }
  check(!backend.includes('ScriptApp.invalidateAuth('), 'retry does not revoke teacher grants');
  console.log(`PASS ${checks} offline Classroom credential/transport retry checks; no live API calls.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
