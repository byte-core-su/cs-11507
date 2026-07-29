/* Shared entry guard for both terms. */
(function (global) {
  'use strict';
  const app = global.SCHOOL_APP;
  if (!app) return;
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isTeacherPage = page === 'teacher.html';
  const isTermPage = /\/terms\/\d{3}-[12](?:\/|$)/.test(location.pathname);
  const termLabel = app.currentTermId.endsWith('-1') ? '上學期' : '下學期';

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
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyPortalSession, { once: true });
  else applyPortalSession();
})(window);
