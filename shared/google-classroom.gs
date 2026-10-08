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
    return respond_(event, { status: 'error', message: error.message || 'Classroom 服務發生錯誤。', httpStatus: error.httpStatus, stage: error.stage, reason: error.reason });
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
    syncVersion: 'learning-archive-v6',
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
  if (!job.students.length) return { message: '已略過學號結尾 00 的測試帳號，沒有需要同步的正式學生。', studentCreated: 0, studentUpdated: 0, workCreated: 0, workUpdated: 0, filesSynced: 0, failedStudents: [], skippedTestAccounts: job.skippedTestAccounts };
  const config = notionConfig_();
  const studentsSchema = notionCall_(config, 'get', 'data_sources/' + encodeURIComponent(config.studentsDataSourceId));
  const worksSchema = notionCall_(config, 'get', 'data_sources/' + encodeURIComponent(config.worksDataSourceId));
  requireNotionProperties_(studentsSchema, { '姓名': 'title', '學號': 'rich_text', '班級': 'select', '座號': 'number', '同步鍵': 'rich_text' }, '學生名冊');
  requireNotionProperties_(worksSchema, { '名稱': 'title', '學生': 'relation', '學期': 'select', '班級': 'select', '座號': 'number', '學號': 'rich_text', '類別': 'select', '任務鍵': 'rich_text', '任務名稱': 'rich_text', 'Classroom 作業': 'rich_text', '教師狀態': 'select', '作品上傳時間': 'date', '教師核定時間': 'date', '作品連結': 'url', '作品附件': 'files', '同步鍵': 'rich_text' }, '學習作品');
  // Filters also require existing select options: prepare both schemas before querying.
  ensureNotionSelectOptions_(config, config.studentsDataSourceId, studentsSchema, { '班級': [job.classRoom] }, '學生名冊');
  ensureNotionSelectOptions_(config, config.worksDataSourceId, worksSchema, {
    '班級': [job.classRoom], '學期': [job.term],
    '類別': [{ info: '資訊生活', flowchart: '演算流程', thinking: '運算思維', programming: '程式設計' }[job.task.category]],
    '教師狀態': job.students.map(function(student) { return student.status; })
  }, '學習作品');
  ensureNotionCertificateProperties_(config, worksSchema);

  const knownStudents = pageMapBySyncKey_(notionQuery_(config, config.studentsDataSourceId, {}));
  const workFilter = { and: [
    { property: '學期', select: { equals: job.term } },
    { property: '班級', select: { equals: job.classRoom } },
    { property: '任務鍵', rich_text: { equals: job.task.key } }
  ] };
  const knownWorks = pageMapBySyncKey_(notionQuery_(config, config.worksDataSourceId, { filter: workFilter }));
  let studentCreated = 0, studentUpdated = 0, workCreated = 0, workUpdated = 0;
  let filesSynced = 0;
  const failedStudents = [];

  job.students.forEach(function(student) {
    try {
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
      if (job.task.category === 'thinking' && student.attachments.length) {
        student.workImage = !student.manualImage && !job.forceRefreshImages ? archivedNotionWorkImage_(config, job, student, workPage) : null;
        if (!student.workImage) {
          student.workImage = student.manualImage || readNotionWorkImage_(job, student);
          const index = notionRichTextValue_(workPage && workPage.properties && workPage.properties['作品圖片索引']).match(/^([a-f0-9]{64}):([a-f0-9-]{36})$/);
          student.workImage.uploadId = index && index[1] === student.workImage.hash && reusableNotionUpload_(config, index[2])
            ? index[2] : uploadNotionPng_(config, student.workImage);
          student.workImage.source = student.manualImage ? '教師手動補圖' : 'Google Drive';
          student.workImage.archivedAt = new Date().toISOString();
        }
      }
      if (job.task.system && student.certificate) {
        const previousBlocks = workPage ? notionBlockChildren_(config, workPage.id) : [];
        const index = notionRichTextValue_(workPage && workPage.properties && workPage.properties['證書索引']).match(/^([a-f0-9]{64}):([a-f0-9-]{36})$/);
        student.certificate.reused = Boolean(index && index[1] === student.certificate.hash && reusableNotionUpload_(config, index[2]));
        student.certificate.uploadId = student.certificate.reused ? index[2] : uploadNotionCertificate_(config, student.certificate);
        student.certificate.previousBlocks = previousBlocks;
      }
      const workProperties = workNotionProperties_(job, student, studentPage.id, workKey);
      const image = student.certificate || student.workImage;
      const cover = student.workImage && student.workImage.retained ? undefined : job.task.system || job.task.category === 'thinking' ? (image ? { type: 'file_upload', file_upload: { id: image.uploadId } } : null) : undefined;
      if (workPage) {
        if (job.task.system) syncNotionCertificateBlocks_(config, workPage, student.certificate);
        else {
          syncNotionAttachmentBlocks_(config, workPage, student.attachments);
          if (job.task.category === 'thinking' && !(student.workImage && student.workImage.retained)) syncNotionWorkImageBlock_(config, workPage, student.workImage);
        }
        notionCall_(config, 'patch', 'pages/' + encodeURIComponent(workPage.id), Object.assign({ properties: workProperties }, cover !== undefined ? { cover: cover } : {}));
        workUpdated += 1;
      } else {
        const children = job.task.system ? notionCertificateBlocks_(student.certificate) : attachmentBlocks_(student.attachments).concat(student.workImage ? [notionWorkImageBlock_(student.workImage)] : []);
        knownWorks[workKey] = notionCall_(config, 'post', 'pages', Object.assign({ parent: { type: 'data_source_id', data_source_id: config.worksDataSourceId }, properties: workProperties, children: children }, cover !== undefined ? { cover: cover } : {}));
        workCreated += 1;
      }
      if (student.certificate) verifyNotionCertificate_(config, (workPage || knownWorks[workKey]).id, student.certificate);
      if (student.workImage) verifyNotionWorkImage_(config, (workPage || knownWorks[workKey]).id, student);
      if (student.certificate || student.attachments.length) filesSynced += 1;
    } catch (error) {
      // A single broken card must not prevent later students from being repaired.
      const failure = { studentId: student.studentId, name: student.name, message: safeNotionText_(error.message || 'Notion 同步失敗。', 240) };
      if (Number.isInteger(error.httpStatus)) failure.httpStatus = error.httpStatus;
      // Keep diagnostics separate so the normal error limit cannot cut them off.
      if (error.authDiagnostic) failure.authDiagnostic = error.authDiagnostic;
      failedStudents.push(failure);
    }
  });
  return { message: failedStudents.length ? '部分學生尚未同步完成，請查看失敗名單後重試。' : 'Notion 同步完成。', studentCreated: studentCreated, studentUpdated: studentUpdated, workCreated: workCreated, workUpdated: workUpdated, filesSynced: filesSynced, failedStudents: failedStudents, skippedTestAccounts: job.skippedTestAccounts };
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
  if ((system || category === 'thinking') && students.length > 4) throw new Error('證書與作品圖片請分批同步，每批最多 4 位學生。');
  students.forEach(function(student) {
    const studentId = String(student && student.studentId || '');
    if (!/^15[12]\d{4}$/.test(studentId)) throw new Error('學生學號格式不正確。');
    if ('7' + studentId.slice(-4, -2) !== classRoom) throw new Error('同步學生不屬於所選班級。');
  });
  const eligibleStudents = students.filter(function(student) { return !String(student.studentId).endsWith('00'); });
  if (students.some(function(student) { return student.manualImage; }) && (category !== 'thinking' || students.length !== 1)) throw new Error('手動補圖僅限一位學生的運算思維採認作品。');
  return { term: term, classRoom: classRoom, forceRefreshImages: value.forceRefreshImages === true, task: { key: String(task.key), category: category, system: system, title: safeNotionText_(task.title, 180), assignmentTitle: safeNotionText_(task.assignmentTitle, 180) }, skippedTestAccounts: students.length - eligibleStudents.length, students: eligibleStudents.map(function(student) {
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
    if (student.manualImage && (!selected || safeHttpsUrl_(student.manualImage.approvedAttachmentUrl) !== approvedUrl || safeDate_(student.manualImage.reviewedAt) !== reviewedAt)) throw new Error('手動補圖與目前教師採認紀錄不一致，請重新同步此任務。');
    return { studentId: studentId, name: safeNotionText_(student.name, 120) || studentId, seatNo: Math.max(0, Number(student.seatNo) || 0), status: status === '已核定通關' && !selected ? '尚未核定' : status, completedAt: safeDate_(student.completedAt), reviewedAt: reviewedAt, assignmentTitle: safeNotionText_(student.assignmentTitle, 180), attachments: selected ? [selected] : [], manualImage: student.manualImage ? validateManualNotionImage_(student.manualImage, term, studentId, String(task.key)) : null };
  }) };
}

function requireNotionProperties_(schema, expected, label) {
  Object.keys(expected).forEach(function(name) {
    const property = schema.properties && schema.properties[name];
    if (!property || property.type !== expected[name]) throw new Error('Notion「' + label + '」缺少欄位「' + name + '」或欄位類型不正確。');
  });
}

function ensureNotionSelectOptions_(config, dataSourceId, schema, required, label) {
  const properties = {};
  Object.keys(required).forEach(function(name) {
    const property = schema.properties && schema.properties[name];
    if (!property || property.type !== 'select' || !property.select || !Array.isArray(property.select.options)) {
      throw new Error('Notion「' + label + '」欄位「' + name + '」選項設定無法讀取，請確認為選取欄位。');
    }
    const existing = property.select.options;
    const missing = required[name].filter(function(value, index, values) {
      return values.indexOf(value) === index && !existing.some(function(option) { return option.name === value; });
    });
    if (!missing.length) return;
    // Notion replaces the full options list. Retain every existing option by ID
    // to preserve colors/descriptions and unrelated teacher-created options.
    properties[name] = { select: { options: existing.map(function(option) {
      return option.id ? { id: option.id } : { name: option.name };
    }).concat(missing.map(function(value) { return { name: value }; })) } };
    // Empty descriptions are returned as null/absent, but PATCH rejects "".
    // Preserve existing nonempty descriptions; otherwise omit the optional field.
    if (typeof property.description === 'string' && property.description.length) properties[name].description = property.description;
  });
  if (!Object.keys(properties).length) return;
  const path = 'data_sources/' + encodeURIComponent(dataSourceId);
  notionCall_(config, 'patch', path, { properties: properties });
  const updated = notionCall_(config, 'get', path);
  Object.keys(properties).forEach(function(name) {
    const property = updated.properties && updated.properties[name];
    const options = property && property.select && property.select.options;
    const retained = schema.properties[name].select.options.map(function(option) { return option.name; }).concat(required[name]);
    if (!Array.isArray(options) || retained.some(function(value) { return !options.some(function(option) { return option.name === value; }); })) {
      throw new Error('Notion「' + label + '」欄位「' + name + '」選項尚未完整更新，請重新同步。');
    }
  });
}

function ensureNotionCertificateProperties_(config, schema) {
  const properties = {};
  const expected = { '證書索引': 'rich_text', '作品圖片索引': 'rich_text', '圖片採認索引': 'rich_text', '圖片封存來源': 'rich_text', '圖片封存時間': 'date', '通關得分': 'number', '正確率': 'number', '作答秒數': 'number' };
  Object.keys(expected).forEach(function(name) {
    const existing = schema.properties && schema.properties[name];
    if (existing && existing.type !== expected[name]) throw new Error('Notion 欄位「' + name + '」類型應為 ' + expected[name] + '，請先調整。');
    if (!existing) properties[name] = expected[name] === 'number' ? { number: { format: 'number' } } : { [expected[name]]: {} };
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
  const image = student.certificate || student.workImage;
  const properties = {
    '名稱': notionTitle_([job.classRoom, String(student.seatNo).padStart(2, '0'), student.name, job.task.title].join('｜')),
    '學生': { relation: [{ id: studentPageId }] },
    '學期': { select: { name: job.term } }, '班級': { select: { name: job.classRoom } }, '座號': { number: student.seatNo }, '學號': notionText_(student.studentId),
    '類別': { select: { name: { info: '資訊生活', flowchart: '演算流程', thinking: '運算思維', programming: '程式設計' }[job.task.category] } }, '任務鍵': notionText_(job.task.key), '任務名稱': notionText_(job.task.title), 'Classroom 作業': notionText_(student.assignmentTitle || job.task.assignmentTitle),
    '教師狀態': { select: { name: student.status } }, '作品上傳時間': notionDate_(student.completedAt), '教師核定時間': notionDate_(student.reviewedAt), '作品連結': { url: firstUrl },
    '作品附件': { files: image ? [{ name: image.filename, type: 'file_upload', file_upload: { id: image.uploadId } }] : student.attachments.map(function(item) { return { name: item.name, type: 'external', external: { url: item.url } }; }) }, '同步鍵': notionText_(syncKey),
    '作品圖片索引': notionText_(student.workImage ? student.workImage.hash + ':' + student.workImage.uploadId : ''),
    '圖片採認索引': notionText_(student.workImage ? notionImageApprovalKey_(job, student) : ''),
    '圖片封存來源': notionText_(student.workImage ? student.workImage.source : ''), '圖片封存時間': notionDate_(student.workImage ? student.workImage.archivedAt : null),
    '證書索引': notionText_(student.certificate ? student.certificate.hash + ':' + student.certificate.uploadId : ''),
    '通關得分': { number: student.certificate ? student.certificate.score : null }, '正確率': { number: student.certificate ? student.certificate.accuracy : null }, '作答秒數': { number: student.certificate ? student.certificate.durationSeconds : null }
  };
  if (student.workImage && student.workImage.retained) delete properties['作品附件'];
  return properties;
}

function notionImageApprovalKey_(job, student) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify([job.term, job.task.key, student.studentId, student.attachments[0].url, student.reviewedAt])).map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
}
function validateManualNotionImage_(value, term, studentId, taskKey) {
  const base64 = String(value.base64 || ''), limit = 10 * 1024 * 1024;
  if (!base64 || base64.length > Math.ceil(limit / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('手動補圖必須為 10 MB 以下的 PNG。');
  const bytes = Utilities.base64Decode(base64);
  if (bytes.length > limit || bytes.length < 32 || ![137,80,78,71,13,10,26,10].every(function(byte, i) { return (bytes[i] & 255) === byte; })) throw new Error('手動補圖不是有效 PNG 或超過 10 MB。');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
  return { filename: term + '-' + studentId + '-' + taskKey + '.png', bytes: bytes, hash: hash };
}
function archivedNotionWorkImage_(config, job, student, page) {
  if (!page) return null;
  const properties = page.properties || {}, index = notionRichTextValue_(properties['作品圖片索引']).match(/^([a-f0-9]{64}):([a-f0-9-]{36})$/);
  if (!index || ((properties['教師狀態'] || {}).select || {}).name !== '已核定通關'
    || (properties['作品連結'] || {}).url !== student.attachments[0].url
    || safeDate_(((properties['教師核定時間'] || {}).date || {}).start) !== student.reviewedAt) return null;
  const approvalKey = notionRichTextValue_(properties['圖片採認索引']);
  if (approvalKey && approvalKey !== notionImageApprovalKey_(job, student)) return null;
  const image = { hash: index[1], uploadId: index[2], filename: job.term + '-' + student.studentId + '-' + job.task.key + '.png',
    source: notionRichTextValue_(properties['圖片封存來源']) || '既有圖片封存', archivedAt: safeDate_(((properties['圖片封存時間'] || {}).date || {}).start) || new Date().toISOString() };
  if (notionWorkImageComplete_(config, page.id, Object.assign({}, student, { workImage: image }))) { image.retained = true; return image; }
  return reusableNotionUpload_(config, index[2]) ? image : null;
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

// Fetch only the teacher-selected Drive file, never an arbitrary external URL.
function readNotionWorkImage_(job, student) {
  const url = student.attachments[0].url;
  const allowed = /^https:\/\/(drive|docs)\.google\.com\//.test(url);
  const pathId = allowed && url.match(/\/d\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
  const queryId = allowed && url.match(/[?&]id=([A-Za-z0-9_-]+)(?:[&#]|$)/);
  const fileId = pathId ? pathId[1] : queryId ? queryId[1] : '';
  if (!fileId) throw new Error('採認附件不是可讀取的 Google Drive／Google 繪圖連結，請回作業檢核確認採認檔案。');
  const root = DRIVE_API_ROOT + 'files/' + encodeURIComponent(fileId);
  const fetch = function(endpoint, stage) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Acquire separately for metadata, content and the single 401 retry.
      // Never replay a Notion write or forward this token to a redirect target.
      const response = UrlFetchApp.fetch(endpoint, {
        method: 'get', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true, followRedirects: false
      });
      const status = response.getResponseCode();
      if (status >= 200 && status < 300) return response;
      if (status === 401 && attempt === 0) { Utilities.sleep(300); continue; }
      let googleError = {};
      try { googleError = JSON.parse(response.getContentText()).error || {}; } catch (_) {}
      const detail = String(googleError.message || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
      const reason = String((googleError.errors && googleError.errors[0] && googleError.errors[0].reason) || googleError.status || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
      const scopesMissing = reason === 'insufficientPermissions' || /insufficient authentication scopes/i.test(detail);
      const guidance = status === 401 ? '已重新取得憑證重試 1 次，Google 仍拒絕驗證；請確認部署執行帳號與 Drive 唯讀授權。'
        : status === 403 ? (scopesMissing ? 'Drive 授權範圍不足；請確認 appsscript.json 包含 drive.readonly，並以部署帳號執行 authorizeClassroom。' : 'Google 拒絕存取；請確認部署執行帳號的檔案下載權限或管理員限制。')
        : status === 404 ? '採認圖片不存在或執行帳號無法存取，請確認 Classroom 原始附件及採認紀錄。'
        : 'Google Drive 讀取失敗，原作品卡保留，請稍後重試。';
      const error = new Error('無法讀取採認圖片：' + stage + '（HTTP ' + status + '）。' + guidance + (detail ? ' Google 原因：' + detail : '') + (reason ? ' [' + reason + ']' : ''));
      error.httpStatus = status; error.stage = stage; error.reason = reason;
      if (status === 401) error.authDiagnostic = driveAuthDiagnostic_(stage);
      throw error;
    }
  };
  const metadataResponse = fetch(root + '?fields=id,mimeType,size,trashed,capabilities(canDownload)&supportsAllDrives=true', '檔案資訊讀取');
  let metadata;
  try { metadata = JSON.parse(metadataResponse.getContentText()); }
  catch (_) { throw new Error('無法讀取採認圖片：檔案資訊讀取未取得有效 JSON 回應，原作品卡保留，請稍後重試。'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('無法讀取採認圖片：檔案資訊讀取的回應格式不正確，原作品卡保留。');
  if (metadata.trashed || !metadata.capabilities || metadata.capabilities.canDownload !== true) throw new Error('教師無法下載此採認圖片，請確認檔案未刪除且允許下載。');
  const drawing = metadata.mimeType === 'application/vnd.google-apps.drawing';
  if (!drawing && metadata.mimeType !== 'image/png') throw new Error('運算思維圖片同步目前支援 PNG 與 Google 繪圖；此採認附件不是上述格式。');
  const limit = 10 * 1024 * 1024;
  if (Number(metadata.size) > limit) throw new Error('採認圖片超過 10 MB，請縮小圖片後重新採認。');
  const endpoint = drawing ? root + '/export?mimeType=image%2Fpng' : root + '?alt=media&supportsAllDrives=true';
  const bytes = fetch(endpoint, drawing ? 'Google 繪圖轉檔' : 'PNG 下載').getBlob().getBytes();
  if (bytes.length > limit) throw new Error('採認圖片超過 10 MB，請縮小圖片後重新採認。');
  if (bytes.length < 32 || ![137,80,78,71,13,10,26,10].every(function(byte, i) { return (bytes[i] & 255) === byte; })) throw new Error('採認附件未取得有效 PNG，未將錯誤頁面匯入 Notion，請確認檔案內容。');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
  return { filename: job.term + '-' + student.studentId + '-' + job.task.key + '.png', bytes: bytes, hash: hash };
}

// Read-only, same-execution checks after a persistent 401. No tokens, raw
// exceptions, authorization URLs, file IDs or script properties are returned.
function driveAuthDiagnostic_(stage) {
  const diagnostic = { version: 'drive-auth-diagnostic-v1', checkedAt: new Date().toISOString(), stage: stage,
    activeUser: '', effectiveUser: '', scopeStatus: 'UNKNOWN', advancedStatus: 'UNAVAILABLE', advancedUser: '', advancedReason: '' };
  const email = function(value) { const text = String(value || '').trim().toLowerCase(); return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) ? text.slice(0, 254) : ''; };
  try { diagnostic.activeUser = email(Session.getActiveUser().getEmail()); } catch (_) {}
  try { diagnostic.effectiveUser = email(Session.getEffectiveUser().getEmail()); } catch (_) {}
  try {
    const status = String(ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, ['https://www.googleapis.com/auth/drive.readonly']).getAuthorizationStatus());
    if (status === 'REQUIRED' || status === 'NOT_REQUIRED') diagnostic.scopeStatus = status;
  } catch (_) {}
  try {
    if (typeof Drive !== 'undefined' && Drive.About && typeof Drive.About.get === 'function') {
      diagnostic.advancedStatus = 'FAILED';
      const about = Drive.About.get({ fields: 'user(emailAddress)' });
      diagnostic.advancedUser = email(about && about.user && about.user.emailAddress);
      diagnostic.advancedStatus = diagnostic.advancedUser ? 'SUCCESS' : 'INVALID_RESPONSE';
    }
  } catch (error) {
    // Classify locally; never echo an exception that may contain credentials.
    const message = String(error && error.message || '');
    diagnostic.advancedReason = /\b401\b|invalid credentials|invalid authentication|unauthenticated/i.test(message) ? 'AUTHENTICATION_FAILED'
      : /not enabled|disabled|accessNotConfigured/i.test(message) ? 'SERVICE_DISABLED'
      : /\b403\b|insufficient|permission|forbidden/i.test(message) ? 'ACCESS_DENIED' : 'UNKNOWN';
  }
  return diagnostic;
}

function isNotionWorkImageBlock_(block, filename) {
  const caption = ((block.image && block.image.caption) || []).map(function(item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
  return block.type === 'image' && /^採認作品｜115-[12]-15[12]\d{4}-thinking-[1-8]\.png$/.test(caption)
    && (!filename || caption === '採認作品｜' + filename);
}
function notionWorkImageBlock_(image) {
  return { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: image.uploadId }, caption: [{ type: 'text', text: { content: '採認作品｜' + image.filename } }] } };
}
function syncNotionWorkImageBlock_(config, page, image) {
  const blocks = notionBlockChildren_(config, page.id);
  const managed = blocks.filter(function(block) { return isNotionWorkImageBlock_(block); });
  if (!image) {
    managed.forEach(function(block) { notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { in_trash: true }); });
    return;
  }
  if (managed.length) {
    const value = notionWorkImageBlock_(image).image;
    // PATCH image bodies must not include the creation-only nested type field.
    notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(managed[0].id), { image: { file_upload: value.file_upload, caption: value.caption } });
    managed.slice(1).forEach(function(block) { notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { in_trash: true }); });
  } else {
    const heading = blocks.find(function(block) { return block.type === 'heading_2' && ['教師核可作品附件', '學生作品附件'].includes(notionBlockText_(block)); });
    const payload = { children: [notionWorkImageBlock_(image)] };
    if (heading) payload.position = { type: 'after_block', after_block: { id: heading.id } };
    notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(page.id) + '/children', payload);
  }
}
function verifyNotionWorkImage_(config, pageId, student) {
  if (!notionWorkImageComplete_(config, pageId, student)) throw new Error('採認圖片尚未完整掛入 Notion（封面、作品附件或正文），請重新同步此任務補齊。');
}
function notionWorkImageComplete_(config, pageId, student) {
  const image = student.workImage;
  const page = notionCall_(config, 'get', 'pages/' + encodeURIComponent(pageId));
  const properties = page.properties || {};
  const files = (properties['作品附件'] || {}).files || [];
  const blocks = notionBlockChildren_(config, pageId);
  return !(page.in_trash || page.archived || !hasNotionCertificateFile_(page.cover, image.uploadId)
    || blocks.filter(function(block) { return isNotionWorkImageBlock_(block, image.filename); }).length !== 1
    || !files.some(function(file) { return file.name === image.filename && hasNotionCertificateFile_(file, image.uploadId); })
    || !blocks.some(function(block) { return isNotionWorkImageBlock_(block, image.filename) && hasNotionCertificateFile_(block.image, image.uploadId); })
    || ((properties['教師狀態'] || {}).select || {}).name !== '已核定通關'
    || (properties['作品連結'] || {}).url !== student.attachments[0].url
    || notionRichTextValue_(properties['作品圖片索引']) !== image.hash + ':' + image.uploadId);
}

function uploadNotionCertificate_(config, certificate) {
  return uploadNotionPng_(config, certificate);
}
function uploadNotionPng_(config, image) {
  const upload = notionCall_(config, 'post', 'file_uploads', { mode: 'single_part', filename: image.filename, content_type: 'image/png' });
  if (!upload.id) throw new Error('Notion 未回傳圖片上傳識別碼。');
  const request = { method: 'post', headers: { Authorization: 'Bearer ' + config.token, 'Notion-Version': NOTION_VERSION }, payload: { file: Utilities.newBlob(image.bytes, 'image/png', image.filename) }, muteHttpExceptions: true };
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

function reusableNotionUpload_(config, uploadId) {
  try {
    const upload = notionCall_(config, 'get', 'file_uploads/' + encodeURIComponent(uploadId));
    return upload.status === 'uploaded' && !upload.in_trash
      && (!upload.expiry_time || new Date(upload.expiry_time).getTime() > Date.now());
  } catch (error) {
    // A missing upload is repairable; permission/network errors are not proof it is missing.
    if (error.httpStatus === 404) return false;
    throw error;
  }
}

function notionBlockText_(block) {
  return (((block[block.type] || {}).rich_text) || []).map(function(item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
}
function notionCertificatePlaceholders_(blocks) {
  let section = false;
  return blocks.filter(function(block) {
    if (/^heading_[123]$/.test(block.type)) { section = block.type === 'heading_2' && notionBlockText_(block) === '系統通關證書'; return false; }
    return section && block.type === 'paragraph' && !block.has_children
      && notionBlockText_(block) === '尚無本學期通關紀錄；完成後同步即可展示證書。';
  });
}
function hasNotionCertificateFile_(file, uploadId) {
  return Boolean(file && (file.type === 'file_upload' ? file.file_upload && file.file_upload.id === uploadId
    : file.type === 'file' && file.file && safeHttpsUrl_(file.file.url)
      && (!file.file.expiry_time || new Date(file.file.expiry_time).getTime() > Date.now())));
}
function verifyNotionCertificate_(config, pageId, certificate) {
  const page = notionCall_(config, 'get', 'pages/' + encodeURIComponent(pageId));
  const properties = page.properties || {};
  const files = (properties['作品附件'] || {}).files || [];
  const blocks = notionBlockChildren_(config, pageId);
  const imagePresent = blocks.some(function(block) {
    return !block.in_trash && !block.archived && isNotionCertificateBlock_(block, certificate.filename)
      && hasNotionCertificateFile_(block.image, certificate.uploadId);
  });
  if (page.in_trash || page.archived || !hasNotionCertificateFile_(page.cover, certificate.uploadId)
    || !files.some(function(file) { return file.name === certificate.filename && hasNotionCertificateFile_(file, certificate.uploadId); })
    || !imagePresent || notionCertificatePlaceholders_(blocks).length
    || ((properties['教師狀態'] || {}).select || {}).name !== '系統通關'
    || notionRichTextValue_(properties['證書索引']) !== certificate.hash + ':' + certificate.uploadId) {
    throw new Error('證書尚未完整掛入 Notion（封面、作品附件或正文），請重新同步此任務補齊。');
  }
}

function isNotionCertificateBlock_(block, filename) {
  const caption = ((block.image && block.image.caption) || []).map(function(item) { return item.plain_text || (item.text && item.text.content) || ''; }).join('');
  return /^通關證書｜115-[12]-15[12]\d{4}-(info|flowchart)-[1-8]\.png$/.test(caption)
    && (!filename || caption === '通關證書｜' + filename);
}
function notionCertificateBlocks_(certificate) {
  const heading = { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '系統通關證書' } }] } };
  return certificate ? [heading, { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: certificate.uploadId }, caption: [{ type: 'text', text: { content: '通關證書｜' + certificate.filename } }] } }] : [heading, { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '尚無本學期通關紀錄；完成後同步即可展示證書。' } }] } }];
}
function syncNotionCertificateBlocks_(config, page, certificate) {
  const blocks = certificate ? certificate.previousBlocks : notionBlockChildren_(config, page.id);
  const managed = blocks.filter(function(block) { return block.type === 'image' && isNotionCertificateBlock_(block); });
  const placeholders = notionCertificatePlaceholders_(blocks);
  const heading = blocks.find(function(block) { return block.type === 'heading_2' && notionBlockText_(block) === '系統通關證書'; });
  const append = function(value) {
    const payload = { children: notionCertificateBlocks_(value).slice(heading ? 1 : 0) };
    // Keep generated content inside its section, even if teacher notes follow it.
    if (heading) payload.position = { type: 'after_block', after_block: { id: heading.id } };
    notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(page.id) + '/children', payload);
  };
  if (!certificate) {
    managed.forEach(function(block) { notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { in_trash: true }); });
    if (!placeholders.length) append(null);
    placeholders.slice(1).forEach(function(block) { notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { in_trash: true }); });
    return;
  }
  if (managed.length) {
    // Refresh the image reference even when reusing the same valid upload.
    // Unlike image creation, the block update API rejects image.type.
    const image = notionCertificateBlocks_(certificate)[1].image;
    notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(managed[0].id), { image: { file_upload: image.file_upload, caption: image.caption } });
    managed.slice(1).forEach(function(block) { notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { in_trash: true }); });
  } else append(certificate);
  // Only remove the integration's exact placeholder, and only after the image write succeeds.
  placeholders.forEach(function(block) { notionCall_(config, 'patch', 'blocks/' + encodeURIComponent(block.id), { in_trash: true }); });
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
    if (isNotionWorkImageBlock_(block)) return; // The generated image may precede the original link.
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
  if (response.getResponseCode() >= 300) {
    const error = new Error('Notion API 失敗（HTTP ' + response.getResponseCode() + '）：' + ((data && data.message) || body || '未知錯誤').slice(0, 220));
    error.httpStatus = response.getResponseCode();
    throw error;
  }
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
  const stage = path.indexOf('studentSubmissions') !== -1 ? '讀取學生作業附件'
    : /\/students(?:\/|$)/.test(path) ? '讀取課程學生名冊'
    : path.indexOf('courseWork') !== -1 ? '讀取作業' : '讀取課程';
  for (let attempt = 0; attempt < 2; attempt++) {
    // Reacquire for each attempt. Do not invalidate the teacher's authorization.
    const response = UrlFetchApp.fetch(CLASSROOM_API_ROOT + path + (query ? '?' + query : ''), {
      method: 'get', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    let payload = null;
    try { payload = JSON.parse(response.getContentText() || '{}'); } catch (_) {}
    if (status >= 200 && status < 300 && payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
    if (status === 401 && attempt === 0) { Utilities.sleep(300); continue; }
    const googleError = payload && payload.error || {};
    const detail = String(googleError.message || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 400);
    const reason = String((googleError.errors && googleError.errors[0] && googleError.errors[0].reason) || googleError.status || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
    const guidance = status === 401 ? '已重新取得憑證重試，Google 仍拒絕驗證。請確認教師登入帳號及部署授權。'
      : status === 403 ? 'Google 拒絕存取，請確認該課程權限或授權範圍。'
      : status >= 200 && status < 300 ? 'Google 回應格式不正確，請稍後重試。' : 'Google API 讀取失敗。';
    const error = new Error(stage + '（HTTP ' + status + '）：' + guidance + (detail ? ' Google 原因：' + detail : '') + (reason ? ' [' + reason + ']' : ''));
    error.httpStatus = status; error.stage = stage; error.reason = reason;
    throw error;
  }
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
