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
  try {
    requireTeacher_();
    const action = requiredParameter_(event, 'action');
    if (action !== 'notion-sync') throw new Error('不支援的寫入操作。');
    const payload = JSON.parse(requiredParameter_(event, 'payload'));
    return postResult_(Object.assign({ status: 'success' }, syncNotion_(payload)));
  } catch (error) {
    return postResult_({ status: 'error', message: error.message || 'Notion 同步失敗。' });
  }
}

function postResult_(payload) {
  const body = JSON.stringify(payload).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><script>window.parent.postMessage({kind:"learning-notion-sync",payload:' + body + '},"*");</script><p>Notion 同步處理完成，可關閉此頁。</p>');
}

function notionStatus_() {
  const properties = PropertiesService.getScriptProperties();
  return {
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
  const config = notionConfig_();
  const job = validateNotionPayload_(payload);
  const studentsSchema = notionCall_(config, 'get', 'data_sources/' + encodeURIComponent(config.studentsDataSourceId));
  const worksSchema = notionCall_(config, 'get', 'data_sources/' + encodeURIComponent(config.worksDataSourceId));
  requireNotionProperties_(studentsSchema, { '姓名': 'title', '學號': 'rich_text', '班級': 'select', '座號': 'number', '同步鍵': 'rich_text' }, '學生名冊');
  requireNotionProperties_(worksSchema, { '名稱': 'title', '學生': 'relation', '學期': 'select', '班級': 'select', '座號': 'number', '學號': 'rich_text', '類別': 'select', '任務鍵': 'rich_text', '任務名稱': 'rich_text', 'Classroom 作業': 'rich_text', '教師狀態': 'select', '作品上傳時間': 'date', '教師核定時間': 'date', '作品連結': 'url', '作品附件': 'files', '同步鍵': 'rich_text' }, '學習作品');

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
    const workProperties = workNotionProperties_(job, student, studentPage.id, workKey);
    const workPage = knownWorks[workKey];
    if (workPage) {
      notionCall_(config, 'patch', 'pages/' + encodeURIComponent(workPage.id), { properties: workProperties });
      workUpdated += 1;
    } else {
      notionCall_(config, 'post', 'pages', { parent: { type: 'data_source_id', data_source_id: config.worksDataSourceId }, properties: workProperties, children: attachmentBlocks_(student.attachments) });
      workCreated += 1;
    }
  });
  return { message: 'Notion 同步完成。', studentCreated: studentCreated, studentUpdated: studentUpdated, workCreated: workCreated, workUpdated: workUpdated };
}

function validateNotionPayload_(payload) {
  const value = payload || {};
  const term = String(value.term || '');
  const classRoom = String(value.classRoom || '');
  const task = value.task || {};
  const category = String(task.category || '');
  const students = Array.isArray(value.students) ? value.students : [];
  if (!/^115-[12]$/.test(term) || !/^7\d{2}$/.test(classRoom)) throw new Error('同步資料的學期或班級格式不正確。');
  if (!/^(thinking|programming)-[1-8]$/.test(String(task.key || '')) || !['thinking', 'programming'].includes(category)) throw new Error('同步資料的任務格式不正確。');
  if (!students.length || students.length > 60) throw new Error('同步學生人數必須介於 1 至 60 人。');
  return { term: term, classRoom: classRoom, task: { key: String(task.key), category: category, title: safeNotionText_(task.title, 180), assignmentTitle: safeNotionText_(task.assignmentTitle, 180) }, students: students.map(function(student) {
    const studentId = String(student.studentId || '');
    if (!/^15[12]\d{4}$/.test(studentId)) throw new Error('學生學號格式不正確。');
    const attachments = (Array.isArray(student.attachments) ? student.attachments : []).slice(0, 12).map(function(item) { return { name: safeNotionText_(item && item.name, 160) || '作品附件', url: safeHttpsUrl_(item && item.url), createdAt: safeDate_(item && item.createdAt) }; }).filter(function(item) { return item.url; });
    return { studentId: studentId, name: safeNotionText_(student.name, 120) || studentId, seatNo: Math.max(0, Number(student.seatNo) || 0), status: ['尚未核定', '需要補件', '已核定通關'].includes(student.status) ? student.status : '尚未核定', completedAt: safeDate_(student.completedAt), reviewedAt: safeDate_(student.reviewedAt), attachments: attachments };
  }) };
}

function requireNotionProperties_(schema, expected, label) {
  Object.keys(expected).forEach(function(name) {
    const property = schema.properties && schema.properties[name];
    if (!property || property.type !== expected[name]) throw new Error('Notion「' + label + '」缺少欄位「' + name + '」或欄位類型不正確。');
  });
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
    '類別': { select: { name: job.task.category === 'thinking' ? '運算思維' : '程式設計' } }, '任務鍵': notionText_(job.task.key), '任務名稱': notionText_(job.task.title), 'Classroom 作業': notionText_(job.task.assignmentTitle),
    '教師狀態': { select: { name: student.status } }, '作品上傳時間': notionDate_(student.completedAt), '教師核定時間': notionDate_(student.reviewedAt), '作品連結': { url: firstUrl },
    '作品附件': { files: student.attachments.map(function(item) { return { name: item.name, type: 'external', external: { url: item.url } }; }) }, '同步鍵': notionText_(syncKey)
  };
}

function attachmentBlocks_(attachments) {
  if (!attachments.length) return [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '尚未讀到符合此任務格式的附件。' } }] } }];
  return [{ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '學生作品附件' } }] } }].concat(attachments.map(function(item) {
    return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: item.name, link: { url: item.url } } }] } };
  }));
}

function notionTitle_(text) { return { title: [{ type: 'text', text: { content: safeNotionText_(text, 180) || '未命名' } }] }; }
function notionText_(text) { const value = safeNotionText_(text, 1800); return { rich_text: value ? [{ type: 'text', text: { content: value } }] : [] }; }
function notionDate_(value) { return { date: value ? { start: value } : null }; }
function notionRichTextValue_(property) { return ((property && property.rich_text) || []).map(function(item) { return item.plain_text || ''; }).join(''); }
function safeNotionText_(value, max) { return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 1800); }
function safeHttpsUrl_(value) { const text = String(value || '').trim(); return /^https:\/\//i.test(text) ? text : ''; }
function safeDate_(value) { const text = String(value || '').trim(); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && !isNaN(new Date(text).getTime()) ? new Date(text).toISOString() : null; }

function notionQuery_(config, dataSourceId, payload) {
  const response = notionCall_(config, 'post', 'data_sources/' + encodeURIComponent(dataSourceId) + '/query', Object.assign({ page_size: 100 }, payload || {}));
  return response.results || [];
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
      url: DRIVE_API_ROOT + 'files/' + encodeURIComponent(id) + '?fields=id,name,mimeType,webViewLink,createdTime&supportsAllDrives=true',
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
      return { name: name, url: url, kind: attachmentKind_(name, metadata.mimeType || ''), mimeType: metadata.mimeType || '', createdAt: metadata.createdTime || null, source: 'driveFile' };
    }
    if (attachment.link) {
      const driveId = driveFileIdFromAttachment_(attachment);
      const metadata = (driveFiles && driveFiles[driveId]) || {};
      const name = metadata.name || attachment.link.title || attachment.link.url || '連結附件';
      const url = metadata.webViewLink || attachment.link.url || '';
      return { name: name, url: url, kind: attachmentKind_(name, metadata.mimeType || ''), mimeType: metadata.mimeType || '', createdAt: metadata.createdTime || null, source: 'link' };
    }
    if (attachment.youTubeVideo) return { name: attachment.youTubeVideo.title || 'YouTube 影片', url: attachment.youTubeVideo.alternateLink || '', kind: 'video', mimeType: 'video/youtube', source: 'youtube' };
    return { name: '附件', url: '', kind: '', mimeType: '', source: 'unknown' };
  });
}

function attachmentKind_(name, mimeType) {
  const value = String(name || '').toLowerCase();
  if (mimeType === 'image/png' || mimeType.indexOf('image/') === 0) return 'image';
  if (mimeType === 'video/mp4' || mimeType.indexOf('video/') === 0) return 'video';
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
