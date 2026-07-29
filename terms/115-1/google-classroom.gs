/**
 * 11501 教師後台的 Google Classroom 唯讀連接程式。
 *
 * 部署方式請見 GOOGLE_CLASSROOM_SETUP.md。Web App 必須設定為「以存取網頁應用程式的使用者身分執行」，
 * 且只開放 jimwang@mail.qfm.kh.edu.tw 存取，避免將學生作業資料暴露在公開網址。
 */
const TEACHER_EMAIL = 'jimwang@mail.qfm.kh.edu.tw';

function doGet(event) {
  const action = String((event && event.parameter && event.parameter.action) || '').trim();
  try {
    requireTeacher_();
    if (action === 'auth') {
      // 呼叫一次 Classroom 服務，讓 Apps Script 顯示所需的 Google 授權畫面。
      Classroom.Courses.list({ teacherId: 'me', courseStates: 'ACTIVE', pageSize: 1 });
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

function getCourses_() {
  const response = Classroom.Courses.list({ teacherId: 'me', courseStates: 'ACTIVE', pageSize: 100 });
  return (response.courses || []).map(function(course) {
    return { id: course.id, name: course.name || '未命名課程', section: course.section || '' };
  }).sort(function(a, b) { return a.name.localeCompare(b.name, 'zh-Hant'); });
}

function getAssignments_(courseId) {
  const response = Classroom.Courses.CourseWork.list(courseId, { pageSize: 100, orderBy: 'updateTime desc' });
  return (response.courseWork || []).map(function(work) {
    return { id: work.id, title: work.title || '未命名作業', dueDate: work.dueDate || null, dueTime: work.dueTime || null };
  });
}

function getSubmissions_(courseId, courseWorkId) {
  const students = listStudents_(courseId);
  const studentsByUserId = {};
  students.forEach(function(student) { studentsByUserId[String(student.userId)] = student; });
  const response = Classroom.Courses.CourseWork.StudentSubmissions.list(courseId, courseWorkId, { pageSize: 100 });
  const submissionsByUserId = {};
  (response.studentSubmissions || []).forEach(function(submission) { submissionsByUserId[String(submission.userId)] = submission; });

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
      attachments: attachments_(submission.assignmentSubmission && submission.assignmentSubmission.attachments)
    };
  });
}

function listStudents_(courseId) {
  const response = Classroom.Courses.Students.list(courseId, { pageSize: 100 });
  return (response.students || []).map(function(student) {
    const profile = student.profile || {};
    const email = String(profile.emailAddress || '').toLowerCase();
    const studentId = studentIdFromEmail_(email);
    const derived = deriveStudentProfile_(studentId);
    return {
      userId: student.userId,
      email: email,
      studentId: studentId,
      classRoom: derived.classRoom,
      seatNo: derived.seatNo,
      name: (profile.name && profile.name.fullName) || '未提供姓名'
    };
  });
}

function studentIdFromEmail_(email) {
  const match = String(email || '').match(/^qfm(15[12]\d{4})@mail\.qfm\.kh\.edu\.tw$/i);
  return match ? match[1] : '';
}

function deriveStudentProfile_(studentId) {
  if (!/^15[12]\d{4}$/.test(studentId)) return { classRoom: '未對應', seatNo: '—' };
  const suffix = studentId.slice(-4);
  return { classRoom: '7' + suffix.slice(0, 2), seatNo: String(Number(suffix.slice(2))) };
}

function attachments_(attachments) {
  return (attachments || []).map(function(attachment) {
    if (attachment.driveFile && attachment.driveFile.driveFile) {
      const driveFile = attachment.driveFile.driveFile;
      return { name: driveFile.title || 'Google Drive 附件', url: driveFile.alternateLink || '' };
    }
    if (attachment.link) return { name: attachment.link.title || attachment.link.url || '連結附件', url: attachment.link.url || '' };
    if (attachment.youTubeVideo) return { name: attachment.youTubeVideo.title || 'YouTube 影片', url: attachment.youTubeVideo.alternateLink || '' };
    return { name: '附件', url: '' };
  });
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
