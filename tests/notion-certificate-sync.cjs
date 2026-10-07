'use strict';
// Offline regression tests: no credentials, network requests or live student records.
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'shared/google-classroom.gs'), 'utf8');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3cAAAAASUVORK5CYII=';
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(condition, message) { assert(condition, message); checks++; }
function fixture() {
  const pages = new Map(), uploads = new Map(), calls = [], fail = new Set();
  const schemas = new Map(['students', 'works'].map(id => [id, { properties: Object.fromEntries(
    Object.entries(id === 'students' ? { '姓名':'title','學號':'rich_text','班級':'select','座號':'number','同步鍵':'rich_text' }
      : { '名稱':'title','學生':'relation','學期':'select','班級':'select','座號':'number','學號':'rich_text','類別':'select','任務鍵':'rich_text','任務名稱':'rich_text','Classroom 作業':'rich_text','教師狀態':'select','作品上傳時間':'date','教師核定時間':'date','作品連結':'url','作品附件':'files','同步鍵':'rich_text' })
      .map(([name, type]) => [name, type === 'select' ? { type, description: name + '原說明', select: { options: name === '班級'
        ? [{ id: id + '-701', name:'701', color:'yellow', description:'原班級說明' }] : [] } } : { type, [type]:{} }]))
  }]));
  let serial = 0, sends = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const rt = value => ({ rich_text: [{ plain_text: value }] });
  const text = property => (property?.rich_text || []).map(item => item.plain_text || item.text?.content || '').join('');
  const normalize = properties => Object.fromEntries(Object.entries(properties).map(([key, value]) => [key,
    value.rich_text ? { ...value, rich_text: value.rich_text.map(item => ({ ...item, plain_text: item.text?.content || item.plain_text || '' })) } : clone(value)]));
  const blocks = input => input.map(block => {
    if (block.type === 'image') assert.equal(block.image.type, 'file_upload', 'image creation keeps its file_upload type');
    return { ...clone(block), id: nextId() };
  });
  const context = vm.createContext({ console, Utilities: {
    base64Decode: value => [...Buffer.from(value, 'base64')],
    computeDigest: (_, bytes) => [...crypto.createHash('sha256').update(Buffer.from(bytes)).digest()],
    DigestAlgorithm: { SHA_256: 'sha256' }, newBlob: () => ({}), sleep() {}
  }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'mock' }) },
  UrlFetchApp: { fetch: () => { sends++; return { getResponseCode: () => 200, getContentText: () => '{"status":"uploaded"}' }; } } });
  vm.runInContext(source, context);
  context.notionConfig_ = () => ({ token: 'mock', studentsDataSourceId: 'students', worksDataSourceId: 'works' });
  const validateSelects = (dataSource, properties) => {
    for (const [name, value] of Object.entries(properties)) {
      if (value.select && !schemas.get(dataSource).properties[name].select.options.some(option => option.name === value.select.name))
        throw Error('select option "' + value.select.name + '" not found for property "' + name + '"');
    }
  };
  context.notionQuery_ = (_, dataSource, payload) => [...pages.values()].filter(page => page.parent === dataSource && !page.in_trash)
    .filter(page => !payload.filter || payload.filter.and.every(filter => {
      const property = page.properties[filter.property];
      return filter.select ? property?.select?.name === filter.select.equals : text(property) === filter.rich_text.equals;
    })).map(clone);
  context.notionCall_ = (_, method, url, data) => {
    calls.push({ method, url, data: data && clone(data) });
    const parts = url.split('?')[0].split('/');
    if (parts[0] === 'data_sources') {
      const schema = schemas.get(parts[1]); assert(schema, 'data source must exist');
      if (method === 'patch') {
        if (fail.has('schema-write')) { const error = Error('mock schema permission'); error.httpStatus = 403; throw error; }
        for (const [name, value] of Object.entries(data.properties)) {
          if (value.select) {
            const previous = schema.properties[name];
            const options = value.select.options.map(option => option.id
              ? clone(previous.select.options.find(old => old.id === option.id))
              : { id: nextId(), color:'default', ...clone(option) });
            schema.properties[name] = { ...previous, description:value.description, select:{ options } };
          } else {
            const type = Object.keys(value)[0]; schema.properties[name] = { type, ...clone(value) };
          }
        }
      }
      const result = clone(schema);
      if (method === 'get' && fail.has('schema-readback') && calls.some(call => call.method === 'patch' && call.url === url))
        result.properties['班級'].select.options = [];
      return result;
    }
    if (url === 'file_uploads') { const id = nextId(); uploads.set(id, { status: 'uploaded', in_trash: false, expiry_time: null }); return { id }; }
    if (parts[0] === 'file_uploads') {
      if (fail.has('upload-permission')) { const error = Error('mock permission'); error.httpStatus = 403; throw error; }
      if (!uploads.has(parts[1])) { const error = Error('mock missing upload'); error.httpStatus = 404; throw error; }
      return clone(uploads.get(parts[1]));
    }
    if (method === 'post' && url === 'pages') {
      validateSelects(data.parent.data_source_id, data.properties);
      const id = nextId(); const page = { id, parent: data.parent.data_source_id, properties: normalize(data.properties), cover: data.cover || null, blocks: blocks(data.children || []) };
      pages.set(id, page); return clone(page);
    }
    if (parts[0] === 'pages') {
      const page = pages.get(parts[1]); assert(page, 'page must exist');
      if (method === 'patch') {
        validateSelects(page.parent, data.properties);
        if (fail.has('page:' + text(page.properties['學號']))) throw Error('mock student page failure');
        page.properties = { ...page.properties, ...normalize(data.properties) };
        if ('cover' in data) page.cover = clone(data.cover);
      }
      const response = clone(page);
      if (method === 'get' && fail.has('verify:' + text(page.properties['學號']))) response.cover = null;
      return response;
    }
    if (parts[0] === 'blocks') {
      const parentPage = pages.get(parts[1]);
      if (parts[2] === 'children') {
        assert(parentPage);
        if (method === 'get') return { results: clone(parentPage.blocks.filter(block => !block.in_trash)), has_more: false };
        if (fail.has('append:' + text(parentPage.properties['學號']))) throw Error('mock image append failure');
        const position = data.position?.type === 'after_block' ? parentPage.blocks.findIndex(block => block.id === data.position.after_block.id) + 1 : parentPage.blocks.length;
        parentPage.blocks.splice(position, 0, ...blocks(data.children)); return {};
      }
      for (const page of pages.values()) {
        const block = page.blocks.find(item => item.id === parts[1]);
        if (block) {
          // Notion's update schema differs from its image creation schema.
          if (data.image && Object.hasOwn(data.image, 'type')) {
            const error = Error('body failed validation: body.image.type should be not present, instead was `"file_upload"`.');
            error.httpStatus = 400; throw error;
          }
          Object.assign(block, clone(data));
          if (data.image?.file_upload) block.image.type = 'file_upload'; // Response schema includes type.
          return clone(block);
        }
      }
    }
    throw Error('Unexpected mock call: ' + method + ' ' + url);
  };
  const student = (id = '1510101', completed = true) => ({ studentId: id, name: '測試同學', seatNo: Number(id.slice(-2)),
    status: completed ? '系統通關' : '尚未完成', completedAt: completed ? '2026-10-07T02:00:00.000Z' : '', attachments: [],
    certificate: completed ? { base64: png, completedAt: '2026-10-07T02:00:00.000Z', version: 'certificate-v1', unitId: '1-1', accuracy: 100 } : null });
  const payload = students => ({ term: '115-1', classRoom: '701', task: { key: 'info-1', category: 'info', title: '1-1 資訊科技與人類生活' }, students });
  const run = students => context.syncNotion_(payload(students));
  const work = id => [...pages.values()].find(page => page.parent === 'works' && text(page.properties['學號']) === id);
  const live = page => page.blocks.filter(block => !block.in_trash);
  const placeholder = block => block.type === 'paragraph' && context.notionBlockText_(block).startsWith('尚無本學期通關紀錄');
  return { context, pages, schemas, uploads, calls, fail, student, payload, run, work, live, placeholder, sends: () => sends, rt, text, nextId };
}

// Missing select choices must be created before filters/pages use them, without deleting old choices.
{
  const f = fixture(), job = f.payload([f.student('1510301')]); job.classRoom = '703';
  const query = f.context.notionQuery_;
  f.context.notionQuery_ = (...args) => {
    for (const filter of args[2].filter?.and || []) if (filter.select)
      assert(f.schemas.get(args[1]).properties[filter.property].select.options.some(option => option.name === filter.select.equals),
        'filter option must exist before query');
    return query(...args);
  };
  let result = f.context.syncNotion_(job);
  check(result.filesSynced === 1 && !result.failedStudents.length, '703 sync succeeds when schemas initially contain only 701');
  for (const id of ['students','works']) {
    const property = f.schemas.get(id).properties['班級'];
    check(property.select.options.some(option => option.name === '703'), id + ' receives 703 option');
    check(property.select.options.some(option => option.id === id + '-701' && option.color === 'yellow' && option.description === '原班級說明'), id + ' preserves 701 metadata');
    check(property.description === '班級原說明', id + ' preserves property description');
  }
  const before = f.calls.filter(call => call.method === 'patch' && call.url.startsWith('data_sources/')).length;
  result = f.context.syncNotion_(job);
  check(result.filesSynced === 1 && result.workCreated === 0 && !result.failedStudents.length, '703 repeat updates same card');
  check(f.calls.filter(call => call.method === 'patch' && call.url.startsWith('data_sources/')).length === before, 'no schema writes when options already exist');
  job.classRoom = '701'; job.students = [f.student('1510101')]; job.term = '115-2'; job.students[0].certificate.unitId = '4-1';
  result = f.context.syncNotion_(job);
  check(result.filesSynced === 1 && !result.failedStudents.length, 'second term option is prepared automatically');
}
{
  const f = fixture(); f.fail.add('schema-write');
  assert.throws(() => f.run([f.student()]), /mock schema permission/);
  check(f.pages.size === 0, 'schema permission error stops before any student page is changed');
}
{
  const f = fixture(); f.fail.add('schema-readback');
  const job = f.payload([f.student('1510301')]); job.classRoom = '703';
  assert.throws(() => f.context.syncNotion_(job), /選項尚未完整更新/);
  check(f.pages.size === 0, 'schema readback failure stops before page writes');
}
for (const category of ['flowchart', 'thinking', 'programming']) {
  const f = fixture(), student = f.student(), job = f.payload([student]);
  job.task = { key:category + '-1', category, title:'離線測試任務' };
  if (category === 'flowchart') { student.certificate.unitId = '1'; student.certificate.score = 90; }
  else {
    student.status = '已核定通關'; student.certificate = null;
    student.reviewedAt = student.completedAt; student.reviewedBy = 'jimwang@mail.qfm.kh.edu.tw';
    student.approvedAttachmentUrl = 'https://example.invalid/approved';
    student.attachments = [{ url:student.approvedAttachmentUrl, name:'教師採認附件' }];
  }
  const result = f.context.syncNotion_(job);
  check(result.filesSynced === 1 && !result.failedStudents.length, category + ' category and completion status options prepared');
  if (category !== 'flowchart') for (const status of ['需要補件', '尚未核定']) {
    student.status = status;
    const pending = f.context.syncNotion_(job);
    check(!pending.failedStudents.length && pending.filesSynced === 0, category + ' ' + status + ' option prepared without publishing attachment');
  }
}

// Blank card -> later pass, preserving teacher notes and one stable card.
{
  const f = fixture();
  check(f.context.notionStatus_().syncVersion === 'learning-archive-v4', 'new deployment marker');
  f.run([f.student('1510101', false)]);
  const page = f.work('1510101'), id = page.id;
  check(f.live(page).filter(f.placeholder).length === 1, 'initial blank card has one placeholder');
  page.blocks.push({ id: 'manual-note', type: 'paragraph', paragraph: { rich_text: [{ text: { content: '教師補充筆記' } }] } });
  page.blocks.push({ id: 'manual-image', type: 'image', image: { type: 'external', external: { url: 'https://example.invalid/manual.png' }, caption: [] } });
  const result = f.run([f.student()]);
  check(result.filesSynced === 1 && result.failedStudents.length === 0, 'successful image counts only after verification');
  check(f.work('1510101').id === id && result.workCreated === 0 && result.workUpdated === 1, 'updates same card');
  check(f.live(page).filter(f.placeholder).length === 0, 'stale no-pass message removed');
  check(f.live(page).some(block => block.id === 'manual-note') && f.live(page).some(block => block.id === 'manual-image'), 'teacher content preserved');
  check(f.live(page).filter(block => block.type === 'heading_2').length === 1, 'no duplicate system headings');
  const uploadId = page.cover.file_upload.id, sends = f.sends();
  const repeated = f.run([f.student()]);
  check(repeated.filesSynced === 1 && !repeated.failedStudents.length, 'existing image update satisfies strict Notion schema');
  const update = f.calls.find(call => call.method === 'patch' && call.data?.image);
  check(update && !Object.hasOwn(update.data.image, 'type') && update.data.image.file_upload.id === uploadId,
    'image update omits type and retains upload ID');
  check(update.data.image.caption[0].text.content === '通關證書｜115-1-1510101-info-1.png', 'image update retains certificate caption');
  check(page.cover.type === 'file_upload' && page.properties['作品附件'].files[0].type === 'file_upload',
    'cover and file property retain their required type');
  check(f.sends() === sends && page.cover.file_upload.id === uploadId, 'valid upload is checked and reused');
  check(f.calls.some(call => call.method === 'get' && call.url === 'file_uploads/' + uploadId), 'does not trust hash alone');
  const image = f.live(page).find(block => f.context.isNotionCertificateBlock_(block));
  image.image = { ...image.image, type: 'external', external: { url: 'https://example.invalid/broken.png' } };
  page.cover = null; page.properties['作品附件'] = { files: [] };
  f.run([f.student()]);
  check(image.image.type === 'file_upload' && page.cover && page.properties['作品附件'].files.length === 1, 'repairs body, cover and files even with matching old index');
  const duplicate = clone(image); duplicate.id = 'duplicate-image'; page.blocks.push(duplicate);
  f.run([f.student()]);
  check(f.live(page).filter(block => f.context.isNotionCertificateBlock_(block)).length === 1, 'deduplicates generated images');
  f.run([f.student('1510101', false)]); f.run([f.student('1510101', false)]);
  check(page.cover === null && !page.properties['作品附件'].files.length, 'removed pass clears cover and attachment');
  check(f.live(page).filter(f.placeholder).length === 1, 'one truthful placeholder when no source pass');
  check(f.live(page).some(block => block.id === 'manual-image'), 'manual images survive revoked pass');
}

// Expired, deleted, pending and failed historical file references reupload automatically.
for (const state of ['expired', 'missing', 'pending', 'failed', 'trash', 'past-expiry']) {
  const f = fixture(); f.run([f.student()]);
  const page = f.work('1510101'), oldId = page.cover.file_upload.id;
  if (state === 'missing') f.uploads.delete(oldId);
  else f.uploads.set(oldId, { status: ['trash', 'past-expiry'].includes(state) ? 'uploaded' : state,
    in_trash: state === 'trash', expiry_time: state === 'past-expiry' ? '2000-01-01T00:00:00Z' : null });
  const result = f.run([f.student()]);
  check(result.filesSynced === 1 && result.failedStudents.length === 0 && page.cover.file_upload.id !== oldId, state + ' upload repaired');
}

// Failed student must not block the rest of the batch; retry must fill the same card.
{
  const f = fixture(), students = ['1510101', '1510102', '1510103', '1510104'].map(id => f.student(id));
  f.run(students.map(item => f.student(item.studentId, false)));
  f.fail.add('append:1510101');
  let result = f.run(students);
  check(result.filesSynced === 3 && result.failedStudents.length === 1 && result.failedStudents[0].studentId === '1510101', 'lists failed student and continues later students');
  check(f.live(f.work('1510101')).filter(f.placeholder).length === 1, 'failed image write does not erase placeholder');
  check(f.work('1510104').cover !== null, 'last student still receives certificate');
  f.fail.clear(); result = f.run(students);
  check(result.filesSynced === 4 && !result.failedStudents.length && result.workCreated === 0, 'retry fills existing card without duplicates');
  f.fail.add('verify:1510102'); result = f.run(students);
  check(result.filesSynced === 3 && result.failedStudents.length === 1 && /尚未完整/.test(result.failedStudents[0].message), 'readback failure cannot count as a successful certificate');
  f.fail.clear(); f.fail.add('upload-permission'); result = f.run(students);
  check(result.filesSynced === 0 && result.failedStudents.length === 4, 'permission error reported rather than silently treated as missing file');
}

// Whole-class repeat: seven four-student batches, including formerly empty cards.
{
  const f = fixture(), students = Array.from({ length: 28 }, (_, index) => f.student('15101' + String(index + 1).padStart(2, '0')));
  for (let offset = 0; offset < 28; offset += 4) f.run(students.slice(offset, offset + 4).map((item, index) => f.student(item.studentId, index !== 0)));
  let count = 0;
  for (let offset = 0; offset < 28; offset += 4) {
    const result = f.run(students.slice(offset, offset + 4));
    check(result.failedStudents.length === 0, 'batch succeeds'); count += result.filesSynced;
  }
  check(count === 28 && [...f.pages.values()].filter(page => page.parent === 'works').length === 28, 'all 28 certificates repaired without extra cards');
  check(students.every(student => !f.live(f.work(student.studentId)).some(f.placeholder)), 'no stale no-pass messages for the completed class');
  const skipped = f.run([f.student('1510100')]);
  check(skipped.filesSynced === 0 && skipped.skippedTestAccounts === 1 && !f.work('1510100'), 'test accounts remain excluded');
}
// Correct positioning and exact, section-scoped cleanup must preserve teacher notes.
{
  const f = fixture(); f.run([f.student('1510101', false)]);
  const page = f.work('1510101');
  page.blocks.push({ id:'teacher-heading', type:'heading_2', heading_2:{ rich_text:[{ text:{ content:'教師筆記' } }] } });
  const teacherCopy = { ...clone(page.blocks[1]), id:'teacher-copy' }; page.blocks.push(teacherCopy);
  f.run([f.student()]);
  check(!page.blocks.find(block => block.id === 'teacher-copy').in_trash, 'same text in teacher section is not deleted');
  f.run([f.student('1510101', false)]); f.run([f.student('1510101', false)]);
  check(f.context.notionCertificatePlaceholders_(f.live(page)).length === 1, 'revoked pass placeholder stays inside its section');
  const result = f.run([f.student()]);
  check(result.filesSynced === 1 && !result.failedStudents.length && !page.blocks.find(block => block.id === 'teacher-copy').in_trash,
    'later pass removes only the system placeholder');
}

// Notion reads resolve file_upload references into signed file URLs.
{
  const f = fixture(), call = f.context.notionCall_;
  const resolveFiles = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(resolveFiles);
    if (value.type === 'file_upload') {
      const result = { ...value, type:'file', file:{ url:'https://example.invalid/private-signed-image.png', expiry_time:'2099-01-01T00:00:00Z' } };
      delete result.file_upload; return result;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveFiles(child)]));
  };
  f.context.notionCall_ = (...args) => { const response = call(...args); return args[1] === 'get' ? resolveFiles(response) : response; };
  const result = f.run([f.student()]);
  check(result.filesSynced === 1 && !result.failedStudents.length, 'accepts real file response shape without downloading URLs');
  check(!f.context.hasNotionCertificateFile_({ type:'file', file:{ url:'https://example.invalid/old.png', expiry_time:'2000-01-01T00:00:00Z' } }, 'any'), 'expired signed URL does not verify');
}
console.log(`PASS ${checks} offline Notion certificate repair checks; no network calls or live data changes.`);
