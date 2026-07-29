/* Shared entry guard for both terms. */
(function (global) {
  'use strict';
  const app = global.SCHOOL_APP;
  if (!app) return;
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isTeacherPage = page === 'teacher.html';
  const isTermPage = /\/terms\/\d{3}-[12](?:\/|$)/.test(location.pathname);
  const termLabel = app.currentTermId.endsWith('-1') ? '上學期' : '下學期';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function showSystemContext() {
    if (document.querySelector('[data-system-context]')) return;
    const context = document.createElement('aside');
    context.dataset.systemContext = 'true';
    context.className = 'system-context';
    context.innerHTML = `<span>資訊科技學習平台</span><b>${app.currentTermId} · ${termLabel}</b><em>${isTeacherPage ? '教師管理' : '學生學習'}</em>`;
    const style = document.createElement('style');
    style.textContent = '.system-context{position:fixed;right:16px;bottom:16px;z-index:9998;display:flex;align-items:center;gap:7px;border:1px solid #c7d2fe;border-radius:999px;background:#fff;padding:8px 12px;box-shadow:0 10px 28px #312e8126;color:#312e81;font-family:system-ui,"Noto Sans TC","Microsoft JhengHei",sans-serif;font-size:12px;font-weight:800}.system-context span{color:#64748b;font-size:11px}.system-context b{border-radius:999px;background:#312e81;padding:3px 8px;color:#fff}.system-context em{color:#7c3aed;font-size:11px;font-style:normal}@media(max-width:640px){.system-context{right:10px;bottom:10px;padding:7px 10px}.system-context span{display:none}}';
    document.head.appendChild(style);
    document.body.appendChild(context);
  }

  function showStudentHeader(profile) {
    if (isTeacherPage || !profile?.studentId || document.querySelector('[data-student-header]')) return;
    const header = document.createElement('header');
    header.dataset.studentHeader = 'true';
    header.className = 'student-session-header';
    header.innerHTML = `<div class="student-session-info"><span>班級 ${escapeHtml(profile.classRoom || '—')}</span><span>座號 ${escapeHtml(profile.seatNo || '—')}</span><span>學號 ${escapeHtml(profile.studentId)}</span><strong>${escapeHtml(profile.name || '同學')}</strong></div><a class="student-home-link" href="index.html">返回首頁</a>`;
    const style = document.createElement('style');
    style.textContent = '.student-session-header{position:fixed;top:14px;left:16px;right:16px;z-index:9997;display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:system-ui,"Noto Sans TC","Microsoft JhengHei",sans-serif}.student-session-info,.student-home-link{border:1px solid #c7d2fe;background:#ffffffeb;box-shadow:0 8px 22px #312e8120;backdrop-filter:blur(10px)}.student-session-info{display:flex;flex-wrap:wrap;align-items:center;gap:8px;border-radius:999px;padding:8px 12px;color:#475569;font-size:12px;font-weight:700}.student-session-info span{padding-right:8px;border-right:1px solid #e2e8f0}.student-session-info strong{color:#312e81}.student-home-link{border-radius:999px;padding:8px 13px;color:#4338ca;font-size:12px;font-weight:900;text-decoration:none}.student-home-link:hover{background:#eef2ff}body.student-session-active{padding-top:68px!important}@media(max-width:640px){.student-session-header{top:8px;left:9px;right:9px}.student-session-info{gap:4px;padding:7px 9px;font-size:11px}.student-session-info span{padding-right:4px}.student-session-info span:nth-child(1),.student-session-info span:nth-child(2){display:none}.student-home-link{padding:7px 10px;font-size:11px}body.student-session-active{padding-top:58px!important}}';
    document.head.appendChild(style);
    document.body.classList.add('student-session-active');
    document.body.appendChild(header);
  }

  // Students always enter the active term through the single root entry.
  if (isTermPage && !isTeacherPage && app.currentTermId !== app.activeTermId) {
    location.replace(`${app.rootPath}index.html`);
    return;
  }

  function applyPortalSession() {
    showSystemContext();
    if (isTeacherPage) return;
    if (app.isTestMode && !document.querySelector('[data-test-mode]')) {
      const notice = document.createElement('aside');
      notice.dataset.testMode = 'true';
      notice.className = 'fixed bottom-4 left-4 z-[10000] rounded-xl bg-amber-400 px-4 py-3 text-sm font-black text-amber-950 shadow-lg';
      notice.innerHTML = `測試模式：${app.activeTermId}<a class="ml-3 underline" href="${app.rootPath}index.html?testTerm=auto">回到自動判定</a>`;
      document.body.appendChild(notice);
    }
    const isStudentPage = page !== 'index.html';
    const profile = global.LearnerProfile?.readLocalProfile();
    const hasSession = global.LearnerProfile?.hasActiveSession();
    if (isStudentPage && !hasSession) {
      location.replace(`index.html?next=${encodeURIComponent(page)}`);
      return;
    }
    if (page === 'index.html' && !hasSession) {
      global.addEventListener('portal:authenticated', applyPortalSession, { once: true });
      return;
    }
    global.PortalSession = Object.freeze({ studentId: profile?.studentId || '', name: profile?.name || '', termId: app.currentTermId });
    showStudentHeader(profile);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyPortalSession, { once: true });
  else applyPortalSession();
})(window);
