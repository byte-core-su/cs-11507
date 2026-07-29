/* Shared entry guard for both terms. */
(function (global) {
  'use strict';
  const app = global.SCHOOL_APP;
  if (!app) return;
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isTeacherPage = page === 'teacher.html';
  const isTermPage = /\/terms\/\d{3}-[12](?:\/|$)/.test(location.pathname);

  // Students always enter the active term through the single root entry.
  if (isTermPage && !isTeacherPage && app.currentTermId !== app.automaticTermId) {
    location.replace(`${app.rootPath}index.html`);
    return;
  }

  function applyPortalSession() {
    if (isTeacherPage) return;
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
