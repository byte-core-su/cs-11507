/* Shared entry guard for both terms. */
(function (global) {
  'use strict';
  const app = global.SCHOOL_APP;
  if (!app) return;
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isTeacherPage = page === 'teacher.html';
  const isTermPage = /\/terms\/\d{3}-[12](?:\/|$)/.test(location.pathname);

  // Students always enter the active term through the single root entry.
  if (isTermPage && !isTeacherPage && app.currentTermId !== app.activeTermId) {
    location.replace(`${app.rootPath}index.html`);
    return;
  }

  function applyPortalSession() {
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
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyPortalSession, { once: true });
  else applyPortalSession();
})(window);
