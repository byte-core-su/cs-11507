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
    throw new Error('不支援的操作。');
  } catch (error) {
    return respond_(event, { status: 'error', message: error.message || 'Classroom 服務發生錯誤。' });
  }
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
