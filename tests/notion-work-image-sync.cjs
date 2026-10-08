'use strict';
// Synthetic fixtures only: no live Drive/Notion credentials, files or students.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, png, clone } = require('./notion-certificate-sync.cjs');
let checks = 0;
function check(value, message) { assert(value, message); checks++; }
function job(f, { term = '115-1', unit = 1, id = '1510101', url = 'https://drive.google.com/file/d/approved/view' } = {}) {
  const student = { ...f.student(id, false), status:'已核定通關', completedAt:'2026-10-08T02:00:00Z',
    reviewedAt:'2026-10-08T03:00:00Z', reviewedBy:'jimwang@mail.qfm.kh.edu.tw', approvedAttachmentUrl:url,
    attachments:[{ name:'教師採認圖片', url }, { name:'未採認圖片', url:'https://drive.google.com/file/d/unselected/view' }] };
  return { term, classRoom:'701', task:{ key:'thinking-' + unit, category:'thinking', title:'運算思維單元 ' + unit }, students:[student] };
}
function file(f, id, options = {}) {
  f.driveFiles.set(id, { ...clone(f.driveFiles.get('approved')), ...options });
}
for (const term of ['115-1', '115-2']) for (let unit = 1; unit <= 8; unit++) {
  const f = fixture(), payload = job(f, { term, unit }), result = f.context.syncNotion_(payload), page = f.work('1510101');
  const images = f.live(page).filter(block => f.context.isNotionWorkImageBlock_(block));
  check(result.filesSynced === 1 && !result.failedStudents.length && images.length === 1, `${term} thinking-${unit} uploads one approved image`);
  check(page.cover.file_upload.id === images[0].image.file_upload.id && page.properties['作品附件'].files.length === 1
    && page.properties['作品附件'].files[0].type === 'file_upload', 'cover, body and single file use same upload');
  check(f.driveCalls.length === 2 && f.driveCalls[1].url.includes('alt=media') && !f.driveCalls.some(call => call.url.includes('unselected')),
    'fetches selected PNG only, metadata then binary');
  check(page.properties['作品連結'].url === payload.students[0].approvedAttachmentUrl, 'original Classroom/Drive source link retained');
}
{
  const f = fixture(); file(f, 'drawing', { mimeType:'application/vnd.google-apps.drawing' });
  const payload = job(f, { url:'https://docs.google.com/drawings/d/drawing/edit' });
  let result = f.context.syncNotion_(payload), page = f.work('1510101');
  check(result.filesSynced === 1 && !result.failedStudents.length && f.driveCalls[1].url.endsWith('/export?mimeType=image%2Fpng'), 'Google drawing exported as PNG');
  const pageId = page.id, uploadId = page.cover.file_upload.id, sends = f.sends();
  page.blocks.push({ id:'manual-note', type:'paragraph', paragraph:{ rich_text:[{ text:{ content:'教師筆記' } }] } });
  page.blocks.push({ id:'manual-image', type:'image', image:{ type:'external', external:{ url:'https://example.invalid/manual.png' }, caption:[] } });
  result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && !result.failedStudents.length && f.sends() === sends && page.id === pageId, 'unchanged drawing reuses checked upload and same card');
  check(f.calls.filter(call => call.data?.image).every(call => !Object.hasOwn(call.data.image, 'type')), 'existing image PATCH omits nested type');
  const image = f.live(page).find(block => f.context.isNotionWorkImageBlock_(block));
  image.image = { ...image.image, type:'external', external:{ url:'https://example.invalid/broken.png' } };
  page.cover = null; page.properties['作品附件'] = { files:[] };
  result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && !result.failedStudents.length && page.cover && image.image.type === 'file_upload'
    && page.properties['作品附件'].files.length === 1 && f.sends() === sends, 'matching index still repairs cover, file and body without unnecessary upload');
  f.driveFiles.get('drawing').bytes.push(0);
  result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && page.cover.file_upload.id !== uploadId && f.live(page).filter(block => f.context.isNotionWorkImageBlock_(block)).length === 1,
    'changed drawing gets refreshed without duplicate image');
  const duplicate = clone(f.live(page).find(block => f.context.isNotionWorkImageBlock_(block))); duplicate.id = 'duplicate'; page.blocks.push(duplicate);
  result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && f.live(page).filter(block => f.context.isNotionWorkImageBlock_(block)).length === 1, 'duplicate generated images cleaned up');
  payload.students[0].status = '需要補件';
  const reads = f.driveCalls.length;
  result = f.context.syncNotion_(payload);
  check(result.filesSynced === 0 && !result.failedStudents.length && f.driveCalls.length === reads, 'revoked review does not fetch file');
  check(page.cover === null && page.properties['作品附件'].files.length === 0 && !f.text(page.properties['作品圖片索引'])
    && !f.live(page).some(block => f.context.isNotionWorkImageBlock_(block)), 'revoked review clears generated body, cover, file and index');
  check(f.live(page).some(block => block.id === 'manual-note') && f.live(page).some(block => block.id === 'manual-image'), 'teacher notes and manual image preserved');
}
{
  const f = fixture(), payload = job(f); payload.students[0].status = '尚未核定';
  f.context.syncNotion_(payload);
  const page = f.work('1510101'), id = page.id;
  // Reproduce a historical link-only card and a manual note following the auto section.
  page.blocks[1].bulleted_list_item.rich_text = f.context.notionAttachmentRichText_(payload.students[0].attachments[0]);
  page.properties['作品附件'] = { files:[{ type:'external', external:{ url:payload.students[0].approvedAttachmentUrl } }] };
  page.blocks.push({ id:'teacher-heading', type:'heading_2', heading_2:{ rich_text:[{ text:{ content:'教師筆記' } }] } });
  page.blocks.push({ id:'note', type:'paragraph', paragraph:{ rich_text:[{ text:{ content:'請保留' } }] } });
  payload.students[0].status = '已核定通關';
  let result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && !result.failedStudents.length && page.id === id && result.workCreated === 0, 'legacy link card upgraded in place');
  check(f.live(page).findIndex(block => f.context.isNotionWorkImageBlock_(block)) < f.live(page).findIndex(block => block.id === 'teacher-heading'),
    'image inserted inside managed section before teacher notes');
  file(f, 'replacement', { bytes:[...Buffer.from(png, 'base64'), 0] });
  payload.students[0].approvedAttachmentUrl = 'https://drive.google.com/open?id=replacement';
  payload.students[0].attachments = [{ name:'重新採認', url:payload.students[0].approvedAttachmentUrl }];
  result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && !result.failedStudents.length && page.properties['作品連結'].url.endsWith('replacement'), 'reselected image replaces source');
  check(f.live(page).some(block => block.bulleted_list_item?.rich_text?.[0]?.text?.link?.url?.endsWith('replacement')),
    'original link refreshes even when generated image precedes link');
  f.uploads.get(page.cover.file_upload.id).status = 'expired';
  const sends = f.sends(); result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && !result.failedStudents.length && f.sends() === sends + 1, 'expired upload automatically replaced');
  f.fail.add('verify:1510101'); result = f.context.syncNotion_(payload);
  check(result.filesSynced === 0 && result.failedStudents.length === 1 && /尚未完整/.test(result.failedStudents[0].message), 'missing image on readback cannot count success');
}
for (const status of ['尚未核定', '需要補件']) {
  const f = fixture(), payload = job(f); payload.students[0].status = status;
  const result = f.context.syncNotion_(payload);
  check(result.filesSynced === 0 && !result.failedStudents.length && f.driveCalls.length === 0, status + ' never fetches/uploads attachment');
}
for (const missing of ['reviewedBy', 'reviewedAt', 'approvedAttachmentUrl']) {
  const f = fixture(), payload = job(f); delete payload.students[0][missing];
  const result = f.context.syncNotion_(payload);
  check(result.filesSynced === 0 && f.driveCalls.length === 0, 'incomplete approval never imports: ' + missing);
}
for (const [label, options, expected] of [
  ['permission', { httpStatus:403 }, /檔案下載權限/], ['missing', { httpStatus:404 }, /不存在/],
  ['download disabled', { capabilities:{ canDownload:false } }, /無法下載/], ['trashed', { trashed:true }, /無法下載/],
  ['wrong type', { mimeType:'video/mp4' }, /不是上述格式/], ['too large', { size:11 * 1024 * 1024 }, /超過 10 MB/],
  ['invalid content', { bytes:[...Buffer.from('<html>not an image</html>xxxxxxxxxx')] }, /有效 PNG/]
]) {
  const f = fixture(), payload = job(f); file(f, 'approved', options);
  const result = f.context.syncNotion_(payload);
  check(result.filesSynced === 0 && result.failedStudents.length === 1 && expected.test(result.failedStudents[0].message) && f.sends() === 0,
    label + ' failure is explicit, no fake successful image');
}
for (const url of ['https://evil.invalid/d/approved', 'https://drive.google.com.evil.invalid/file/d/approved/view', 'https://drive.google.com@evil.invalid/d/approved', 'http://drive.google.com/file/d/approved/view']) {
  const f = fixture(), result = f.context.syncNotion_(job(f, { url }));
  check(result.filesSynced === 0 && f.driveCalls.length === 0 && f.sends() === 0, 'does not fetch arbitrary URL or leak Google token');
}
{
  const f = fixture(), payload = job(f); file(f, 'denied', { httpStatus:403 });
  payload.students.unshift(job(f, { id:'1510102', url:'https://drive.google.com/file/d/denied/view' }).students[0]);
  const result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && result.failedStudents.length === 1 && result.failedStudents[0].studentId === '1510102', 'one inaccessible file does not block other students');
}
{
  const f = fixture(); f.fail.add('upload-send');
  const result = f.context.syncNotion_(job(f));
  check(result.filesSynced === 0 && result.failedStudents.length === 1 && /上傳失敗/.test(result.failedStudents[0].message), 'failed Notion upload cannot count success');
}
{
  const f = fixture(), payload = job(f), call = f.context.notionCall_;
  const resolve = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(resolve);
    if (value.type === 'file_upload') {
      const result = { ...value, type:'file', file:{ url:'https://example.invalid/signed.png', expiry_time:'2099-01-01T00:00:00Z' } };
      delete result.file_upload; return result;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
  };
  f.context.notionCall_ = (...args) => { const result = call(...args); return args[1] === 'get' ? resolve(result) : result; };
  const result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && !result.failedStudents.length, 'accepts actual Notion readback file URL shape without fetching private URL');
}
{
  const f = fixture(), payload = job(f);
  payload.students = Array.from({ length:5 }, (_, i) => job(f, { id:'151010' + (i + 1) }).students[0]);
  assert.throws(() => f.context.syncNotion_(payload), /每批最多 4 位/);
  check(f.driveCalls.length === 0 && f.pages.size === 0, 'oversized thinking batch rejected before network or writes');
}
{
  const f = fixture(), payload = job(f); payload.task = { ...payload.task, key:'programming-1', category:'programming' };
  const result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && !result.failedStudents.length && f.driveCalls.length === 0 && f.work('1510101').cover === null, 'programming remains link-only, no image conversion');
  const skipped = f.context.syncNotion_(job(f, { id:'1510100' }));
  check(skipped.skippedTestAccounts === 1 && skipped.filesSynced === 0 && f.driveCalls.length === 0, '00 test account never downloads/uploads images');
}
// Credential failures must be retried at the failing Drive GET, not by replaying sync.
const unauthorized = { status:401, body:{ error:{ message:'Invalid Credentials', errors:[{reason:'authError'}] } } };
for (const [stage, label] of [['metadata','檔案資訊讀取'], ['media','PNG 下載'], ['export','Google 繪圖轉檔']]) {
  const f = fixture(), payload = job(f);
  if (stage === 'export') file(f, 'approved', { mimeType:'application/vnd.google-apps.drawing' });
  f.driveResponses.set('approved:' + stage, [unauthorized]);
  const result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && !result.failedStudents.length && f.driveCalls.length === 3, label + ' recovers one 401');
  check(f.tokens() === 3 && new Set(f.driveCalls.map(call => call.request.headers.Authorization)).size === 3, 'each metadata/content/retry request reacquires its token');
  check(f.sleeps.filter(ms => ms === 300).length === 1 && f.driveCalls.every(call => call.request.method === 'get' && call.request.followRedirects === false), 'single bounded retry keeps token on Google API only');
  check(f.sends() === 1 && f.calls.filter(call => call.method === 'post' && call.url === 'pages' && call.data.parent.data_source_id === 'works').length === 1, 'Drive retry never duplicates Notion image upload/card');
  const persistent = fixture(), persistentJob = job(persistent);
  if (stage === 'export') file(persistent, 'approved', { mimeType:'application/vnd.google-apps.drawing' });
  persistent.driveResponses.set('approved:' + stage, [unauthorized, unauthorized]);
  const failure = persistent.context.syncNotion_(persistentJob);
  check(failure.filesSynced === 0 && failure.failedStudents.length === 1 && failure.failedStudents[0].message.includes(label)
    && /HTTP 401/.test(failure.failedStudents[0].message) && /Invalid Credentials/.test(failure.failedStudents[0].message), label + ' persistent failure preserves stage and Google cause');
  check(persistent.driveCalls.length === (stage === 'metadata' ? 2 : 3) && persistent.sleeps.length === 1 && persistent.sends() === 0 && !persistent.work('1510101'), 'persistent 401 stops before Notion work writes');
  check(!JSON.stringify(failure).includes('mock-google-token'), 'failure does not expose OAuth token');
}
{
  const f = fixture();
  f.driveResponses.set('approved:metadata', [unauthorized]); f.driveResponses.set('approved:media', [unauthorized]);
  const result = f.context.syncNotion_(job(f));
  check(result.filesSynced === 1 && f.driveCalls.length === 4 && f.sleeps.filter(ms => ms === 300).length === 2 && f.sends() === 1, 'metadata and content each have a separate bounded retry');
}
for (const [status, reason, detail, expected] of [
  [403,'insufficientPermissions','Request had insufficient authentication scopes.',/drive.readonly/],
  [403,'forbidden','Access denied',/檔案下載權限/], [404,'notFound','File not found',/不存在/],
  [429,'rateLimitExceeded','Too many requests',/Google Drive 讀取失敗/], [503,'backendError','Unavailable',/Google Drive 讀取失敗/],
  [302,'','','Google Drive 讀取失敗']
]) {
  const f = fixture(); f.driveResponses.set('approved:media', [{status,body:{error:{message:detail,errors:[{reason}]}}}]);
  const result = f.context.syncNotion_(job(f)), message = result.failedStudents[0]?.message || '';
  check(result.filesSynced === 0 && f.driveCalls.length === 2 && f.sleeps.length === 0 && f.sends() === 0, status + ' does not trigger authentication retry or Notion upload');
  check(message.includes('PNG 下載') && message.includes('HTTP ' + status) && (expected instanceof RegExp ? expected.test(message) : message.includes(expected)), 'non-401 has accurate stage-specific guidance');
}
{
  const f = fixture(), payload = job(f); f.context.syncNotion_(payload);
  const before = JSON.stringify(f.work('1510101')), sends = f.sends();
  f.driveResponses.set('approved:media', [unauthorized, unauthorized]);
  file(f, 'other'); payload.students.push(job(f, {id:'1510102',url:'https://drive.google.com/file/d/other/view'}).students[0]);
  const result = f.context.syncNotion_(payload);
  check(result.filesSynced === 1 && result.failedStudents.length === 1 && result.failedStudents[0].studentId === '1510101', 'persistent auth failure is isolated; next student still synchronizes');
  check(JSON.stringify(f.work('1510101')) === before && f.sends() === sends + 1, 'existing card/image is preserved when source download fails');
}
{
  const f = fixture(); f.driveResponses.set('approved:metadata', [{status:200,body:'<html>not JSON</html>'}]);
  const result = f.context.syncNotion_(job(f));
  check(result.filesSynced === 0 && /檔案資訊讀取.*JSON/.test(result.failedStudents[0].message) && f.sends() === 0, 'malformed metadata is not reported as PNG format/auth problem');
}
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared/google-classroom-appsscript.json'), 'utf8'));
check(manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive.readonly') && !manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive'), 'Drive content access is read-only, no write scope');
const teacher = fs.readFileSync(path.join(root, 'shared/teacher.html'), 'utf8');
check(teacher.includes("syncVersion === 'learning-archive-v5'") && teacher.includes("syncVersion !== 'learning-archive-v5'"), 'teacher UI requires new image-capable deployment');
console.log(`PASS ${checks} offline approved work-image checks; no network calls or live data changes.`);
