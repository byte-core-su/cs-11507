// Shared, code-rendered certificates. No student image is stored publicly.
(function (global) {
  'use strict';
  const version = 'certificate-v1';
  const iso = value => {
    const date = value?.toDate?.() || (value ? new Date(value) : null);
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
  };
  const dateLabel = value => iso(value) ? new Date(iso(value)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—';
  function flowchart(record, term) {
    if (!record || !(term === '115-2' ? iso(record.exportedAt) : iso(record.completedAt))) return null;
    const result = Number(record.passedCoachResult?.score) >= 85 ? record.passedCoachResult : (Number(record.coachResult?.score) >= 85 ? record.coachResult : null);
    return { title: record.title || '', completedAt: iso(record.completedAt) || iso(record.exportedAt), score: result ? Number(result.score) : null, steps: record.steps || '', category: 'flowchart' };
  }
  function info(record) {
    const completedAt = iso(record?.awardedAt || record?.issuedAt);
    if (!record || !completedAt) return null;
    return { title: record.chapterTitle || record.title || '', course: record.course || '', completedAt, score: record.score != null && Number.isFinite(Number(record.score)) ? Number(record.score) : null, accuracy: record.accuracy != null ? Number(record.accuracy) : null, durationSeconds: record.durationSeconds != null ? Number(record.durationSeconds) : null, totalAttempted: record.totalAttempted != null ? Number(record.totalAttempted) : null, category: 'info' };
  }
  function wrap(ctx, text, x, y, maxWidth, lineHeight) {
    let line = '', lineNo = 0;
    for (const char of String(text || '')) {
      if (ctx.measureText(line + char).width > maxWidth && line) { ctx.fillText(line, x, y + lineNo++ * lineHeight); line = ''; }
      line += char;
    }
    ctx.fillText(line, x, y + lineNo * lineHeight);
    return (lineNo + 1) * lineHeight;
  }
  async function png(profile, term, certificate) {
    if (!certificate?.completedAt) throw new Error('沒有有效通關紀錄，無法產生證書。');
    await global.document.fonts?.ready;
    const canvas = global.document.createElement('canvas'); canvas.width = 1200; canvas.height = 900;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('此瀏覽器無法產生證書圖片。');
    const font = '"Microsoft JhengHei", "Noto Sans TC", sans-serif';
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, 1200, 900);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(28, 28, 1144, 844);
    ctx.strokeStyle = '#bfdbfe'; ctx.lineWidth = 4; ctx.strokeRect(28, 28, 1144, 844);
    const gradient = ctx.createLinearGradient(40, 0, 1160, 0); gradient.addColorStop(0, '#2563eb'); gradient.addColorStop(1, '#0891b2');
    ctx.fillStyle = gradient; ctx.fillRect(40, 40, 1120, 156);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'; ctx.font = `bold 44px ${font}`;
    ctx.fillText(certificate.category === 'flowchart' ? '演算流程 · 通關證書' : `${certificate.course || (term === '115-2' ? '資訊安全與數位著作' : '資訊生活')} · 測驗通關證書`, 600, 109);
    ctx.font = `bold 20px ${font}`; ctx.fillText(`${term} · ${term.endsWith('-1') ? '上學期' : '下學期'}  |  LEARNING PASS CERTIFICATE`, 600, 155);
    ctx.fillStyle = '#eff6ff'; ctx.fillRect(90, 226, 1020, 128);
    ctx.fillStyle = '#64748b'; ctx.font = `22px ${font}`; ctx.fillText('班級 / 座號 / 學號 / 姓名', 600, 262);
    ctx.fillStyle = '#1e293b'; ctx.font = `bold 32px ${font}`;
    wrap(ctx, `${profile.classRoom || ''} 班　${profile.seatNo || '0'} 號　${profile.studentId || ''}　${profile.name || '同學'}`, 600, 309, 940, 40);
    ctx.fillStyle = '#1e40af'; ctx.font = `bold 39px ${font}`;
    const titleHeight = wrap(ctx, certificate.title, 600, 421, 950, 53);
    const statusY = 456 + titleHeight;
    ctx.fillStyle = '#059669'; ctx.font = `bold 32px ${font}`; ctx.fillText('已完成本單元通關任務', 600, statusY);
    const details = certificate.category === 'flowchart'
      ? (certificate.score != null ? [`流程圖教練：${certificate.score} 分`, '完成流程決策與 Mermaid code 產生'] : ['流程圖步驟任務完成', '依既有完成紀錄核發'])
      : [certificate.accuracy != null ? `正確率：${certificate.accuracy}%` : (certificate.score != null ? `答對題數：${certificate.score}` : '測驗通關'), certificate.durationSeconds != null ? `作答時間：${certificate.durationSeconds} 秒` : '依既有集章紀錄核發'];
    ctx.fillStyle = '#475569'; ctx.font = `25px ${font}`;
    details.forEach((text, index) => ctx.fillText(text, 600, statusY + 62 + index * 44));
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(90, 679); ctx.lineTo(1110, 679); ctx.stroke();
    ctx.fillStyle = '#334155'; ctx.font = `23px ${font}`; ctx.fillText(`通關時間：${dateLabel(certificate.completedAt)}`, 600, 723);
    ctx.fillStyle = '#64748b'; ctx.font = `19px ${font}`; ctx.fillText('資訊科技學習平台 · 學習歷程展示紀錄', 600, 782);
    ctx.font = `17px ${font}`; ctx.fillText('本證書呈現系統學習紀錄，不作為正式評量成績證明。', 600, 817);
    const dataUrl = canvas.toDataURL('image/png');
    return { filename: `${term}-${profile.studentId}-${certificate.category}-certificate.png`, base64: dataUrl.split(',')[1], dataUrl, version };
  }
  function escape(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
  function modal(title, content) {
    const host = global.document.createElement('div'); host.dataset.learningCertificateModal = 'true'; host.className = 'fixed inset-0 z-[150] flex items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm';
    host.innerHTML = `<section role="dialog" aria-modal="true" aria-label="${escape(title)}" class="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-3xl bg-white p-6 shadow-2xl"><header class="mb-5 flex items-center justify-between gap-3"><h2 class="text-2xl font-black text-blue-700">${escape(title)}</h2><button type="button" data-close class="rounded-xl bg-slate-100 px-4 py-2 font-bold text-slate-600" aria-label="關閉">✕</button></header>${content}</section>`;
    const previousFocus = global.document.activeElement;
    const close = () => { host.remove(); global.document.removeEventListener('keydown', keydown); previousFocus?.focus?.(); };
    const keydown = event => {
      const modals = global.document.querySelectorAll('[data-learning-certificate-modal]');
      if (modals[modals.length - 1] !== host) return;
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const items = [...host.querySelectorAll('button:not(:disabled), a[href]')];
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && global.document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && global.document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    global.document.addEventListener('keydown', keydown);
    host.querySelector('[data-close]').onclick = close;
    host.onclick = event => { if (event.target === host) close(); };
    global.document.body.appendChild(host); host.querySelector('[data-close]').focus(); return host;
  }
  async function showCertificate(profile, term, certificate) {
    const image = await png(profile, term, certificate);
    modal('通關證書', `<img src="${image.dataUrl}" alt="${escape(certificate.title)}通關證書" class="h-auto w-full rounded-2xl border border-blue-100"><a download="${escape(image.filename)}" href="${image.dataUrl}" class="mt-4 block rounded-xl bg-blue-600 px-5 py-3 text-center font-black text-white">下載證書 PNG</a>`);
  }
  function showFlowchartWall(units, records, profile, term) {
    const slots = units.map(unit => ({ unit, certificate: flowchart(records?.[unit.id], term) }));
    const count = slots.filter(item => item.certificate).length;
    const host = modal('我的流程圖證書・集章牆', `<p class="mb-4 text-sm font-bold text-slate-500">${escape(profile.classRoom)} 班 ${escape(profile.seatNo)} 號・${escape(profile.name)}・${escape(term)}・已集 ${count} / ${slots.length} 章</p><div class="grid gap-3 sm:grid-cols-2">${slots.map(({ unit, certificate }) => certificate ? `<button type="button" data-unit="${escape(unit.id)}" class="rounded-2xl border-2 border-blue-500 bg-white p-4 text-left shadow-md transition hover:-translate-y-1 hover:shadow-xl"><p class="text-xs font-black tracking-widest text-blue-600">FLOWCHART PASS CARD</p><h3 class="mt-2 font-black text-slate-800">${escape(unit.title)}</h3><p class="mt-3 text-xs font-bold text-emerald-700">✓ 已通關${certificate.score != null ? `・${certificate.score} 分` : ''}</p><p class="mt-2 text-xs text-slate-500">${dateLabel(certificate.completedAt)}</p><p class="mt-3 text-center text-xs font-black text-blue-600">查看／下載證書 PNG</p></button>` : `<article class="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 p-4"><p class="text-xs font-black text-slate-400">CERTIFICATE SLOT</p><h3 class="mt-2 font-bold text-slate-500">${escape(unit.title)}</h3><p class="mt-3 text-xs text-slate-400">尚未完成</p></article>`).join('')}</div>`);
    host.querySelectorAll('[data-unit]').forEach(button => { button.onclick = async () => {
      const slot = slots.find(item => String(item.unit.id) === button.dataset.unit); button.disabled = true;
      try { await showCertificate(profile, term, { ...slot.certificate, title: slot.unit.title }); }
      catch (error) { global.alert(error.message); }
      finally { button.disabled = false; }
    }; });
  }
  global.LearningCertificates = Object.freeze({ version, iso, dateLabel, flowchart, info, png, showCertificate, showFlowchartWall });
})(window);
