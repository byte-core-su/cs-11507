/**
 * 115 學年度資訊科技學習平台的共用 Google Classroom 唯讀連接程式。
 *
 * 透過 Classroom REST API 讀取資料，不依賴 Apps Script 的 Classroom 進階服務。
 * Web App 必須設定為「以存取網頁應用程式的使用者身分執行」，
 * 且只開放 jimwang@mail.qfm.kh.edu.tw 存取，避免將學生作業資料暴露在公開網址。
 */
const TEACHER_EMAIL = 'jimwang@mail.qfm.kh.edu.tw';
const CLASSROOM_API_ROOT = 'https://classroom.googleapis.com/v1/';
const DRIVE_API_ROOT = 'https://www.googleapis.com/drive/v3/';
const NOTION_API_ROOT = 'https://api.notion.com/v1/';
const NOTION_VERSION = '2026-03-11';
const LEARNING_SITE_ORIGIN = 'https://byte-core-su.github.io';

// 提供給 Apps Script 編輯器直接執行，用來觸發或確認 Classroom 權限。
function authorizeClassroom() {
  requireTeacher_();
  classroomGet_('courses', { teacherId: 'me', courseStates: 'ACTIVE', pageSize: 1 });
  authorizeDriveMetadata_();
}

function doGet(event) {
  const action = String((event && event.parameter && event.parameter.action) || '').trim();
  try {
    requireTeacher_();
    if (action === 'auth') {
      authorizeClassroom();
      return HtmlService.createHtmlOutput('<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>Classroom 授權完成</h2><p>可以關閉此分頁，回到教師後台按「更新資料」。</p></body></html>');
    }
    if (action === 'courses') return respond_(event, { status: 'success', courses: getCourses_() });
    if (action === 'assignments') return respond_(event, { status: 'success', assignments: getAssignments_(requiredParameter_(event, 'courseId')) });
    if (action === 'submissions') return respond_(event, {
      status: 'success',
      submissions: getSubmissions_(requiredParameter_(event, 'courseId'), requiredParameter_(event, 'courseWorkId'))
    });
    if (action === 'notion-status') return respond_(event, { status: 'success', notion: notionStatus_() });
    throw new Error('不支援的操作。');
  } catch (error) {
    return respond_(event, { status: 'error', message: error.message || 'Classroom 服務發生錯誤。' });
  }
}

// The teacher page sends a one-time, HTTPS form POST to this Web App.  The
// Notion personal access token is read only from Script Properties; it is
// never accepted from the browser or stored in Firebase.
function doPost(event) {
  const requestId = String((event && event.parameter && event.parameter.requestId) || '').slice(0, 100);
  let lock;
  try {
    requireTeacher_();
    const action = requiredParameter_(event, 'action');
    if (action !== 'notion-sync') throw new Error('不支援的寫入操作。');
    const payload = JSON.parse(requiredParameter_(event, 'payload'));
    lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) throw new Error('另一批 Notion 同步正在處理，請稍後重試。');
    return postResult_(Object.assign({ status: 'success', requestId: requestId }, syncNotion_(payload)));
  } catch (error) {
    return postResult_({ status: 'error', requestId: requestId, message: error.message || 'Notion 同步失敗。' });
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}

function postResult_(payload) {
  const body = JSON.stringify(payload).replace(/</g, '\\u003c');
  // Apps Script wraps HTML in its own sandbox iframe. Send the batch response
  // to the teacher site's top window, not to the intervening Google wrapper.
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><script>window.top.postMessage({kind:"learning-notion-sync",payload:' + body + '},' + JSON.stringify(LEARNING_SITE_ORIGIN) + ');</script><p>Notion 同步處理完成，可關閉此頁。</p>').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function notionStatus_() {
  const properties = PropertiesService.getScriptProperties();
  return {
    syncVersion: 'learning-archive-v3',
    configured: Boolean(properties.getProperty('NOTION_API_TOKEN') && properties.getProperty('NOTION_STUDENTS_DATA_SOURCE_ID') && properties.getProperty('NOTION_WORKS_DATA_SOURCE_ID')),
    hasToken: Boolean(properties.getProperty('NOTION_API_TOKEN')),
    hasStudentsDataSource: Boolean(properties.getProperty('NOTION_STUDENTS_DATA_SOURCE_ID')),
    hasWorksDataSource: Boolean(properties.getProperty('NOTION_WORKS_DATA_SOURCE_ID'))
  };
}

function notionConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    token: String(properties.getProperty('NOTION_API_TOKEN') || '').trim(),
    studentsDataSourceId: String(properties.getProperty('NOTION_STUDENTS_DATA_SOURCE_ID') || '').trim(),
    worksDataSourceId: String(properties.getProperty('NOTION_WORKS_DATA_SOURCE_ID') || '').trim()
  };
  if (!config.token || !config.studentsDataSourceId || !config.worksDataSourceId) {
    throw new Error('Notion 尚未完成設定。請在 Apps Script 指令碼屬性填入 NOTION_API_TOKEN、NOTION_STUDENTS_DATA_SOURCE_ID、NOTION_WORKS_DATA_SOURCE_ID。');
  }
  return config;
}

function syncNotion_(payload) {
  const job = validateNotionPayload_(payload);
  if (!job.students.length) return { message: '已略過學號結尾 00 的測試帳號，沒有需要同步的正式學生。', studentCreated: 0, studentUpdated: 0, workCreated: 0, workUpdated: 0, skippedTestAccounts: job.skippedTestAccounts };
  const config = notionConfig_();
  const studentsSchema = notionCall_(config, 'get', 'data_sources/' + encodeURIComponent(config.studentsDataSourceId));
  const worksSchema = notionCall_(config, 'get', 'data_sources/' + encodeURIComponent(config.worksDataSourceId));
  requireNotionProperties_(studentsSchema, { '姓名': 'title', '學號': 'rich_text', '班級': 'select', '座號': 'number', '同步鍵': 'rich_text' }, '學生名冊');
  requireNotionProperties_(worksSchema, { '名稱': 'title', '學生': 'relation', '學期': 'select', '班級': 'select', '座號': 'number', '學號': 'rich_text', '類別': 'select', '任務鍵': 'rich_text', '任務名稱': 'rich_text', 'Classroom 作業': 'rich_text', '教師狀態': 'select', '作品上傳時間': 'date', '教師核定時間': 'date', '作品連結': 'url', '作品附件': 'files', '同步鍵': 'rich_text' }, '學習作品');
  ensureNotionCertificateProperties_(config, worksSchema);

  const knownStudents = pageMapBySyncKey_(notionQuery_(config, config.studentsDataSourceId, {}));
  const workFilter = { and: [
    { property: '學期', select: { equals: job.term } },
    { property: '班級', select: { equals: job.classRoom } },
    { property: '任務鍵', rich_text: { equals: job.task.key } }
  ] };
  const knownWorks = pageMapBySyncKey_(notionQuery_(config, config.worksDataSourceId, { filter: workFilter }));
  let studentCreated = 0, studentUpdated = 0, workCreated = 0, workUpdated = 0;

  job.students.forEach(function(student) {
    const studentKey = 'student-' + student.studentId;
    const studentProperties = studentNotionProperties_(student, studentKey);
    let studentPage = knownStudents[studentKey];
    if (studentPage) {
      notionCall_(config, 'patch', 'pages/' + encodeURIComponent(studentPage.id), { properties: studentProperties });
      studentUpdated += 1;
    } else {
      studentPage = notionCall_(config, 'post', 'pages', { parent: { type: 'data_source_id', data_source_id: config.studentsDataSourceId }, properties: studentProperties });
      knownStudents[studentKey] = studentPage;
      studentCreated += 1;
    }

    const workKey = [job.term, job.classRoom, student.studentId, job.task.key].join(':');
    const workPage = knownWorks[workKey];
    if (job.task.system && student.certificate) {
      const previousBlocks = workPage ? notionBlockChildren_(config, workPage.id) : [];
      const index = notionRichTextValue_(workPage && workPage.properties && workPage.properties['證書索引']).match(/^([a-f0-9]{64}):([a-f0-9-]{36})$/);
      student.certificate.reused = Boolean(index && index[1] === student.certificate.hash);
      student.certificate.uploadId = student.certificate.reused ? index[2] : uploadNotionCertificate_(config, student.certificate);
      student.certificate.previousBlocks = previousBlocks;
    }
    const workProperties = workNotionProperties_(job, student, studentPage.id, workKey);
    const cover = job.task.system ? (student.certificate ? { type: 'file_upload', file_upload: { id: student.certificate.uploadId } } : null) : undefined;
    if (workPage) {
      if (job.task.system) syncNotionCertificateBlocks_(config, workPage, student.certificate);
      else syncNotionAttachmentBlocks_(config, workPage, student.attachments);
      notionCall_(config, 'patch', 'pages/' + encodeURIComponent(workPage.id), Object.assign({ properties: workProperties }, cover !== undefined ? { cover: cover } : {}));
      workUpdated += 1;
    } else {
      notionCall_(config, 'post', 'pages', Object.assign({ parent: { type: 'data_source_id', data_source_id: config.worksDataSourceId }, properties: workProperties, children: job.task.system ? notionCertificateBlocks_(student.certificate) : attachmentBlocks_(student.attachments) }, cover !== undefined ? { cover: cover } : {}));
      workCreated += 1;
    }
  });
  return { message: 'Notion 同步完成。', studentCreated: studentCreated, studentUpdated: studentUpdated, workCreated: workCreated, workUpdated: workUpdated, skippedTestAccounts: job.skippedTestAccounts };
}

function validateNotionPayload_(payload) {
  const value = payload || {};
  const term = String(value.term || '');
  const classRoom = String(value.classRoom || '');
  const task = value.task || {};
  const category = String(task.category || '');
  const students = Array.isArray(value.students) ? value.students : [];
  if (!/^115-[12]$/.test(term) || !/^7\d{2}$/.test(classRoom)) throw new Error('同步資料的學期或班級格式不正確。');
  if (!/^(info|flowchart|thinking|programming)-[1-8]$/.test(String(task.key || '')) || String(task.key).split('-')[0] !== category) throw new Error('同步資料的任務格式不正確。');
  const system = category === 'info' || category === 'flowchart';
  if (!students.length || students.length > 60) throw new Error('同步學生人數必須介於 1 至 60 人。');
  if (system && students.length > 4) throw new Error('證書圖片請分批同步，每批最多 4 位學生。');
  students.forEach(function(student) {
    const studentId = String(student && student.studentId || '');
    if (!/^15[12]\d{4}$/.test(studentId)) throw new Error('學生學號格式不正確。');
    if ('7' + studentId.slice(-4, -2) !== classRoom) throw new Error('同步學生不屬於所選班級。');
  });
  const eligibleStudents = students.filter(function(student) { return !String(student.studentId).endsWith('00'); });
  return { term: term, classRoom: classRoom, task: { key: String(task.key), category: category, system: system, title: safeNotionText_(task.title, 180), assignmentTitle: safeNotionText_(task.assignmentTitle, 180) }, skippedTestAccounts: students.length - eligibleStudents.length, students: eligibleStudents.map(function(student) {
    const studentId = String(student.studentId);
    if (system) {
      const completedAt = safeDate_(student.completedAt);
      const certificate = student.status === '系統通關' && completedAt && student.certificate ? validateCertificateImage_(student.certificate, term, task, studentId, completedAt) : null;
      return { studentId: studentId, name: safeNotionText_(student.name, 120) || studentId, seatNo: Math.max(0, Number(student.seatNo) || 0), status: certificate ? '系統通關' : '尚未完成', completedAt: certificate ? completedAt : null, reviewedAt: null, attachments: [], certificate: certificate };
    }
    const candidates = (Array.isArray(student.attachments) ? student.attachments : []).slice(0, 12).map(function(item) { return { name: safeNotionText_(item && item.name, 160) || '作品附件', url: safeHttpsUrl_(item && item.url), createdAt: safeDate_(item && item.createdAt) }; }).filter(function(item) { return item.url; });
    const status = ['尚未核定', '需要補件', '已核定通關'].includes(student.status) ? student.status : '尚未核定';
    const reviewedAt = safeDate_(student.reviewedAt);
    const approvedUrl = safeHttpsUrl_(student.approvedAttachmentUrl);
    // Only the authenticated teacher's explicitly selected, reviewed attachment
    // may enter Notion. Never fall back to all submitted files or the first file.
    const selected = status === '已核定通關' && student.reviewedBy === TEACHER_EMAIL && reviewedAt && approvedUrl ? candidates.find(function(item) { return item.url === approvedUrl; }) : null;
    return { studentId: studentId, name: safeNotionText_(student.name, 120) || studentId, seatNo: Math.max(0, Number(student.seatNo) || 0), status: status === '已核定通關' && !selected ? '尚未核定' : status, completedAt: safeDate_(student.completedAt), reviewedAt: reviewedAt, assignmentTitle: safeNotionText_(student.assignmentTitle, 180), attachments: selected ? [selected] : [] };
  }) };
}

function requireNotionProperties_(schema, expected, label) {
  Object.keys(expected).forEach(function(name) {
    const property = schema.properties && schema.properties[name];
    if (!property || property.type !== expected[name]) throw new Error('Notion「' + label + '」缺少欄位「' + name + '」或欄位類型不正確。');
  });
}

function ensureNotionCertificateProperties_(config, schema) {
  const properties = {};
  const expected = { '證書索引': 'rich_text', '通關得分': 'number', '正確率': 'number', '作答秒數': 'number' };
  Object.keys(expected).forEach(function(name) {
    const existing = schema.properties && schema.properties[name];
    if (existing && existing.type !== expected[name]) throw new Error('Notion 欄位「' + name + '」類型應為 ' + expected[name] + '，請先調整。');
    if (!existing) properties[name] = expected[name] === 'number' ? { number: { format: 'number' } } : { rich_text: {} };
  });
  if (Object.keys(properties).length) notionCall_(config, 'patch', 'data_sources/' + encodeURIComponent(config.worksDataSourceId), { properties: properties });
}

function pageMapBySyncKey_(pages) {
  const map = {};
  (pages || []).forEach(function(page) {
    const key = notionRichTextValue_(page.properties && page.properties['同步鍵']);
    if (key) map[key] = page;
  });
  return map;
}

function studentNotionProperties_(student, syncKey) {
  return { '姓名': notionTitle_(student.name), '學號': notionText_(student.studentId), '班級': { select: { name: '7' + student.studentId.slice(-4, -2) } }, '座號': { number: student.seatNo }, '同步鍵': notionText_(syncKey) };
}

function workNotionProperties_(job, student, studentPageId, syncKey) {
  const firstUrl = student.attachments.length ? student.attachments[0].url : null;
  return {
    '名稱': notionTitle_([job.classRoom, String(student.seatNo).padStart(2, '0'), student.name, job.task.title].join('｜')),
    '學生': { relation: [{ id: studentPageId }] },
    '學期': { select: { name: job.term } }, '班級': { select: { name: job.classRoom } }, '座號': { number: student.seatNo }, '學號': notionText_(student.studentId),
    '類別': { select: { name: { info: '資訊生活', flowchart: '演算流程', thinking: '運算思維', programming: '程式設計' }[job.task.category] } }, '任務鍵': notionText_(job.task.key), '任務名稱': notionText_(job.task.title), 'Classroom 作業': notionText_(student.assignmentTitle || job.task.assignmentTitle),
    '教師狀態': { select: { name: student.status } }, '作品上傳時間': notionDate_(student.completedAt), '教師核定時間': notionDate_(student.reviewedAt), '作品連結': { url: firstUrl },
    '作品附件': { files: student.certificate ? [{ name: student.certificate.filename, type: 'file_upload', file_upload: { id: student.certificate.uploadId } }] : student.attachments.map(function(item) { return { name: item.name, type: 'external', external: { url: item.url } }; }) }, '同步鍵': notionText_(syncKey),
    '證書索引': notionText_(student.certificate ? student.certificate.hash + ':' + student.certificate.uploadId : ''),
    '通關得分': { number: student.certificate ? student.certificate.score : null }, '正確率': { number: student.certificate ? student.certificate.accuracy : null }, '作答秒數': { number: student.certificate ? student.certificate.durationSeconds : null }
  };
}

function validateCertificateImage_(value, term, task, studentId, completedAt) {
  const base64 = String(value.base64 || '');
  if (!base64 || base64.length > 1500000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) throw new Error('證書 PNG 格式或大小不正確。');
  if (safeDate_(value.completedAt) !== completedAt || value.version !== 'certificate-v1') throw new Error('證書與通關紀錄不一致。');
  const index = Number(String(task.key).split('-')[1]) - 1;
  const expectedUnit = task.category === 'info' ? (term === '115-1' ? ['1-1','1-2','CH1','2-1','2-2','2-3','2-4','CH2'] : ['4-1','4-2','4-3','5-1','5-2','6-1','6-2','6-3'])[index] : String(index + 1);
  if (String(value.unitId) !== expectedUnit) throw new Error('證書單元與任務不一致。');
  const bytes = Utilities.base64Decode(base64);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 32 || !signature.every(function(byte, i) { return (bytes[i] & 255) === byte; })) throw new Error('證書不是有效 PNG 檔案。');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
  const metric = key => value[key] != null && Number.isFinite(Number(value[key])) && Number(value[key]) >= 0 ? Number(value[key]) : null;
  if (task.category === 'flowchart' && metric('score') !== null && metric('score') < 85) throw new Error('流程圖證書得分未達通關標準。');
  return { filename: term + '-' + studentId + '-' + task.key + '.png', bytes: bytes, hash: hash, title: safeNotionText_(value.title || task.title, 180), completedAt: completedAt, score: metric('score'), accuracy: metric('accuracy'), durationSeconds: metric('durationSeconds') };
}

function uploadNotionCertificate_(config, certificate) {
  const upload = notionCall_(config, 'post', 'file_uploads', { mode: 'single_part', filename: certificate.filename, content_type: 'image/png' });
  if (!upload.id) throw new Error('Notion 未回傳圖片上傳識別碼。');
  const request = { method: 'post', headers: { Authorization: 'Bearer ' + config.token, 'Notion-Version': NOTION_VERSION }, payload: { file: Utilities.newBlob(certificate.bytes, 'image/png', certificate.filename) }, muteHttpExceptions: true };
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = UrlFetchApp.fetch(NOTION_API_ROOT + 'file_uploads/' + encodeURIComponent(upload.id) + '/send', request);
    if (response.getResponseCode() !== 429) break;
    Utilities.sleep(400 * Math.pow(2, attempt));
  }
  let result = {}; try { result = JSON.parse(response.getContentText()); } catch (_) {}
  if (response.getResponseCode() >= 300 || result.status !== 'uploaded') throw new Error('Notion PNG 上傳失敗：' + (result.message || result.status || response.getResponseCode()));
  Utilities.sleep(340);
  return upload.id;
}

function isNotionCertificateBlock_(block) {
  const caption = ((block.image && block.image.caption) || []).map(function(item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
  return /^通關證書｜115-[12]-15[12]\d{4}-(info|flowchart)-[1-8]\.png$/.test(caption);
}
function notionCertificateBlocks_(certificate) {
  const heading = { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '系統通關證書' } }] } };
  return certificate ? [heading, { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: certificate.uploadId }, caption: [{ type: 'text', text: { content: '通關證書｜' + certificate.filename } }] } }] : [heading, { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '尚無本學期通關紀錄；完成後同步即可展示證書。' } }] } }];
}
function syncNotionCertificateBlocks_(config, page, certificate) {
  const blocks = certificate ? certificate.previousBlocks : notionBlockChildren_(config, page.id);
  const managed = blocks.filter(function(block) { return block.type === 'image' && isNotionCertificateBlock_(block); });
  if (!certificate) {
    managed.forEach(function(block) { notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { in_trash: true }); });
    return;
  }
  if (managed.length) {
    if (!certificate.reused) notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(managed[0].id), { image: notionCertificateBlocks_(certificate)[1].image });
    managed.slice(1).forEach(function(block) { notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { in_trash: true }); });
  } else notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(page.id) + '/children', { children: notionCertificateBlocks_(certificate) });
}

function notionBlockChildren_(config, pageId) {
  let blocks = [], cursor = '';
  do {
    const result = notionCall_(config, 'get', 'blocks/' + encodeURIComponent(pageId) + '/children?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''));
    blocks = blocks.concat(result.results || []); cursor = result.has_more ? result.next_cursor : '';
  } while (cursor);
  return blocks;
}

function attachmentBlocks_(attachments) {
  return [
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '教師核可作品附件' } }] } },
    { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: notionAttachmentRichText_(attachments[0]) } }
  ];
}

function notionAttachmentRichText_(attachment) {
  return [{ type: 'text', text: attachment ? { content: attachment.name, link: { url: attachment.url } } : { content: '尚無教師核可的採認附件。' } }];
}

// Refresh only the integration-generated section, leaving teacher-written notes
// untouched. Replace link text rather than deleting blocks, including legacy
// sections which could contain more than one unreviewed attachment.
function syncNotionAttachmentBlocks_(config, page, attachments) {
  let blocks = [], cursor = '';
  do {
    const result = notionCall_(config, 'get', 'blocks/' + encodeURIComponent(page.id) + '/children?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''));
    blocks = blocks.concat(result.results || []); cursor = result.has_more ? result.next_cursor : '';
  } while (cursor);
  let managedSection = false, refreshed = false;
  blocks.forEach(function(block) {
    const heading = ((block.heading_2 && block.heading_2.rich_text) || []).map(function(item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
    if (block.type === 'heading_2') { managedSection = heading === '教師核可作品附件' || heading === '學生作品附件'; return; }
    if (!managedSection) return;
    const text = block.bulleted_list_item && block.bulleted_list_item.rich_text;
    const url = text && text[0] && text[0].text && text[0].text.link && text[0].text.link.url;
    const content = text && text[0] && (text[0].plain_text || (text[0].text && text[0].text.content));
    const generated = !block.has_children && text && text.length === 1 && (safeHttpsUrl_(url) || content === '尚無教師核可的採認附件。' || content === '未採認的附件不予匯入。');
    if (!generated) { managedSection = false; return; }
    const replacement = refreshed ? [{ type: 'text', text: { content: '未採認的附件不予匯入。' } }] : notionAttachmentRichText_(attachments[0]);
    notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { bulleted_list_item: { rich_text: replacement } });
    refreshed = true;
  });
  if (!refreshed) notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(page.id) + '/children', { children: attachmentBlocks_(attachments) });
}

function notionTitle_(text) { return { title: [{ type: 'text', text: { content: safeNotionText_(text, 180) || '未命名' } }] }; }
function notionText_(text) { const value = safeNotionText_(text, 1800); return { rich_text: value ? [{ type: 'text', text: { content: value } }] : [] }; }
function notionDate_(value) { return { date: value ? { start: value } : null }; }
function notionRichTextValue_(property) { return ((property && property.rich_text) || []).map(function(item) { return item.plain_text || ''; }).join(''); }
function safeNotionText_(value, max) { return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 1800); }
function safeHttpsUrl_(value) { const text = String(value || '').trim(); return /^https:\/\//i.test(text) ? text : ''; }
function safeDate_(value) { const text = String(value || '').trim(); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && !isNaN(new Date(text).getTime()) ? new Date(text).toISOString() : null; }

function notionQuery_(config, dataSourceId, payload) {
  let results = [], cursor = '';
  do {
    const response = notionCall_(config, 'post', 'data_sources/' + encodeURIComponent(dataSourceId) + '/query', Object.assign({ page_size: 100 }, payload || {}, cursor ? { start_cursor: cursor } : {}));
    results = results.concat(response.results || []); cursor = response.has_more ? response.next_cursor : '';
  } while (cursor);
  return results;
}

function notionCall_(config, method, path, payload) {
  const request = { method: method, headers: { Authorization: 'Bearer ' + config.token, 'Notion-Version': NOTION_VERSION }, muteHttpExceptions: true };
  if (payload !== undefined) { request.contentType = 'application/json'; request.payload = JSON.stringify(payload); }
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = UrlFetchApp.fetch(NOTION_API_ROOT + path, request);
    if (response.getResponseCode() !== 429) break;
    Utilities.sleep(400 * Math.pow(2, attempt));
  }
  const body = response.getContentText(); let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch (_) {}
  if (response.getResponseCode() >= 300) throw new Error('Notion API 失敗（HTTP ' + response.getResponseCode() + '）：' + ((data && data.message) || body || '未知錯誤').slice(0, 220));
  // Stay below Notion's average request limit during a whole-class sync.
  Utilities.sleep(340);
  return data;
}

function requireTeacher_() {
  const activeEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!activeEmail) throw new Error('無法辨識登入帳號。請確認 Web App 設為「以存取網頁應用程式的使用者身分執行」，並限制校內帳號使用。');
  if (activeEmail !== TEACHER_EMAIL) throw new Error('這個 Google 帳號沒有 Classroom 看板權限。請使用 ' + TEACHER_EMAIL + '。');
}

function requiredParameter_(event, name) {
  const value = String((event && event.parameter && event.parameter[name]) || '').trim();
  if (!value) throw new Error('缺少必要資料：' + name);
  return value;
}

function classroomGet_(path, parameters) {
  const query = Object.keys(parameters || {}).filter(function(key) {
    return parameters[key] !== undefined && parameters[key] !== null && parameters[key] !== '';
  }).map(function(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(parameters[key]);
  }).join('&');
  const response = UrlFetchApp.fetch(CLASSROOM_API_ROOT + path + (query ? '?' + query : ''), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  const body = response.getContentText();
  let payload = {};
  try { payload = body ? JSON.parse(body) : {}; } catch (_) { payload = {}; }
  if (response.getResponseCode() >= 300) {
    throw new Error((payload.error && payload.error.message) || 'Classroom API 讀取失敗（HTTP ' + response.getResponseCode() + '）。');
  }
  return payload;
}

function authorizeDriveMetadata_() {
  const response = UrlFetchApp.fetch(DRIVE_API_ROOT + 'about?fields=user', {
    method: 'get', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 300) {
    throw new Error('Google Drive 附件中繼資料授權失敗（HTTP ' + response.getResponseCode() + '）：' + response.getContentText().slice(0, 240));
  }
}

function getCourses_() {
  const response = classroomGet_('courses', { teacherId: 'me', courseStates: 'ACTIVE', pageSize: 100 });
  return (response.courses || []).map(function(course) {
    return { id: course.id, name: course.name || '未命名課程', section: course.section || '' };
  }).sort(function(a, b) { return a.name.localeCompare(b.name, 'zh-Hant'); });
}

function getAssignments_(courseId) {
  const response = classroomGet_('courses/' + encodeURIComponent(courseId) + '/courseWork', { pageSize: 100, orderBy: 'updateTime desc' });
  return (response.courseWork || []).map(function(work) {
    return { id: work.id, title: work.title || '未命名作業', dueDate: work.dueDate || null, dueTime: work.dueTime || null };
  });
}

function getSubmissions_(courseId, courseWorkId) {
  const students = listStudents_(courseId);
  const studentsByUserId = {};
  students.forEach(function(student) { studentsByUserId[String(student.userId)] = student; });
  const response = classroomGet_('courses/' + encodeURIComponent(courseId) + '/courseWork/' + encodeURIComponent(courseWorkId) + '/studentSubmissions', { pageSize: 100 });
  const submissionsByUserId = {};
  (response.studentSubmissions || []).forEach(function(submission) { submissionsByUserId[String(submission.userId)] = submission; });
  const allAttachments = [];
  (response.studentSubmissions || []).forEach(function(submission) {
    const attachments = submission.assignmentSubmission && submission.assignmentSubmission.attachments;
    (attachments || []).forEach(function(attachment) { allAttachments.push(attachment); });
  });
  const driveFiles = driveFileMetadataMap_(allAttachments);

  // 以課程名冊為主，確保「未交」的學生也會列出。
  return students.map(function(student) {
    const submission = submissionsByUserId[String(student.userId)] || {};
    return {
      studentId: student.studentId,
      classRoom: student.classRoom,
      seatNo: student.seatNo,
      name: student.name,
      email: student.email,
      state: submission.state || 'CREATED',
      late: submission.late === true,
      updateTime: submission.updateTime || null,
      attachments: attachments_(submission.assignmentSubmission && submission.assignmentSubmission.attachments, driveFiles)
    };
  });
}

function listStudents_(courseId) {
  const response = classroomGet_('courses/' + encodeURIComponent(courseId) + '/students', { pageSize: 100 });
  return (response.students || []).map(function(student) {
    const profile = student.profile || {};
    const email = String(profile.emailAddress || '').toLowerCase();
    const fullName = (profile.name && profile.name.fullName) || '';
    // 部分 Classroom 帳號的信箱沒有學號，但學校顯示名稱如「00 1510100」。
    const studentId = studentIdFromEmail_(email) || studentIdFromDisplayName_(fullName);
    const derived = deriveStudentProfile_(studentId);
    return {
      userId: student.userId,
      email: email,
      studentId: studentId,
      classRoom: derived.classRoom,
      seatNo: derived.seatNo,
      name: fullName || '未提供姓名'
    };
  });
}

function studentIdFromEmail_(email) {
  // Classroom 可能使用校務信箱 qfm1510101@…，也可能使用平台登入帳號
  // 1510101@students.jimwang-4b0ca.firebaseapp.com；兩者皆以學號對應名冊。
  const match = String(email || '').match(/(15[12]\d{4})/);
  return match ? match[1] : '';
}

function studentIdFromDisplayName_(name) {
  const match = String(name || '').match(/(15[12]\d{4})/);
  return match ? match[1] : '';
}

function deriveStudentProfile_(studentId) {
  if (!/^15[12]\d{4}$/.test(studentId)) return { classRoom: '未對應', seatNo: '—' };
  const suffix = studentId.slice(-4);
  return { classRoom: '7' + suffix.slice(0, 2), seatNo: String(Number(suffix.slice(2))) };
}

function driveFileMetadataMap_(attachments) {
  const ids = [];
  const seen = {};
  (attachments || []).forEach(function(attachment) {
    const id = driveFileIdFromAttachment_(attachment);
    if (id && !seen[id]) { seen[id] = true; ids.push(id); }
  });
  if (!ids.length) return {};
  const token = ScriptApp.getOAuthToken();
  const requests = ids.map(function(id) {
    return {
      url: DRIVE_API_ROOT + 'files/' + encodeURIComponent(id) + '?fields=id,name,mimeType,webViewLink,createdTime,modifiedTime&supportsAllDrives=true',
      method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    };
  });
  const files = {};
  try {
    UrlFetchApp.fetchAll(requests).forEach(function(response, index) {
      if (response.getResponseCode() >= 300) return;
      try { files[ids[index]] = JSON.parse(response.getContentText() || '{}'); } catch (_) {}
    });
  } catch (_) {}
  return files;
}

function driveFileIdFromAttachment_(attachment) {
  const driveId = attachment && attachment.driveFile && attachment.driveFile.id;
  if (driveId) return driveId;
  const url = attachment && attachment.link && attachment.link.url;
  const value = String(url || '');
  const pathMatch = value.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  const queryMatch = value.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return queryMatch ? queryMatch[1] : '';
}

function attachments_(attachments, driveFiles) {
  return (attachments || []).map(function(attachment) {
    if (attachment.driveFile) {
      const driveFile = attachment.driveFile;
      const metadata = (driveFiles && driveFiles[driveFile.id]) || {};
      const name = metadata.name || driveFile.title || 'Google Drive 附件';
      // alternateLink 偶爾未回傳，仍可用 Drive 檔案 ID 建立教師可開啟的連結。
      const url = metadata.webViewLink || driveFile.alternateLink || (driveFile.id ? 'https://drive.google.com/open?id=' + encodeURIComponent(driveFile.id) : '');
      return { name: name, url: url, kind: attachmentKind_(name, metadata.mimeType || '', url), mimeType: metadata.mimeType || '', createdAt: metadata.createdTime || null, modifiedAt: metadata.modifiedTime || null, source: 'driveFile' };
    }
    if (attachment.link) {
      const driveId = driveFileIdFromAttachment_(attachment);
      const metadata = (driveFiles && driveFiles[driveId]) || {};
      const name = metadata.name || attachment.link.title || attachment.link.url || '連結附件';
      const url = metadata.webViewLink || attachment.link.url || '';
      return { name: name, url: url, kind: attachmentKind_(name, metadata.mimeType || '', attachment.link.url || url), mimeType: metadata.mimeType || '', createdAt: metadata.createdTime || null, modifiedAt: metadata.modifiedTime || null, source: 'link' };
    }
    if (attachment.youTubeVideo) return { name: attachment.youTubeVideo.title || 'YouTube 影片', url: attachment.youTubeVideo.alternateLink || '', kind: 'video', mimeType: 'video/youtube', source: 'youtube' };
    return { name: '附件', url: '', kind: '', mimeType: '', source: 'unknown' };
  });
}

function attachmentKind_(name, mimeType, url) {
  const value = String(name || '').toLowerCase();
  if (mimeType === 'image/png' || mimeType.indexOf('image/') === 0) return 'image';
  if (mimeType === 'application/vnd.google-apps.drawing') return 'image';
  if (mimeType === 'video/mp4' || mimeType.indexOf('video/') === 0) return 'video';
  if (/^https:\/\/docs\.google\.com\/drawings\/d\/[A-Za-z0-9_-]+(?:\/|[?#]|$)/.test(String(url || ''))) return 'image';
  if (/\.png(?:$|[?#])/.test(value)) return 'image';
  if (/\.mp4(?:$|[?#])/.test(value)) return 'video';
  return '';
}

function respond_(event, payload) {
  const body = JSON.stringify(payload);
  const callback = String((event && event.parameter && event.parameter.callback) || '');
  if (callback) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callback)) throw new Error('不合法的 callback 名稱。');
    return ContentService.createTextOutput(callback + '(' + body + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}
