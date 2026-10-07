// Display previously saved passes without changing quiz scoring or answer validation.
(() => {
    'use strict';
    const numeric = value => value !== null && value !== undefined && value !== ''
        && Number.isFinite(Number(value)) ? Number(value) : null;
    function date(value) {
        try {
            const raw = value?.toDate?.() || (typeof value?.toMillis === 'function' ? value.toMillis()
                : typeof value?.seconds === 'number' ? value.seconds * 1000 : value);
            const parsed = raw instanceof Date ? raw : raw != null ? new Date(raw) : null;
            return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
        } catch { return null; }
    }
    function describe(record, termId) {
        const accuracy = numeric(record?.accuracy) ?? (termId === '115-2' ? numeric(record?.score) : null);
        const duration = numeric(record?.durationSeconds);
        const awarded = date(record?.awardedAt || record?.issuedAt);
        return {
            accuracy: accuracy === null ? '未記錄' : `${accuracy}%`,
            duration: duration === null ? '未記錄' : `${Math.floor(duration / 60)} 分 ${Math.floor(duration % 60)} 秒`,
            time: awarded ? awarded.toLocaleString('zh-TW', {
                timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            }) : '日期未提供'
        };
    }
    function create({ termId, prefix, chapterKeys, read, startButton }) {
        const keys = new Set(chapterKeys);
        let owner = '', records = null, currentChapter = '', request = 0, loading = null, failed = false;
        let originalLabel = '';
        const currentOwner = () => String(window.LearningProfile?.get?.()?.studentId || '');
        function ensureOwner() {
            const next = currentOwner();
            if (next === owner) return;
            owner = next; records = null; failed = false; loading = null; request++;
            document.querySelectorAll('[data-quiz-pass-badge]').forEach(node => node.remove());
            ['quiz-previous-pass-study', 'quiz-previous-pass-active'].forEach(id => {
                const element = document.getElementById(id);
                if (element) { element.replaceChildren(); element.hidden = true; }
            });
            if (originalLabel && startButton()) startButton().textContent = originalLabel;
        }
        function previous(key) {
            const id = `${prefix}-${key}`;
            const last = records?.lastPasses?.[id];
            const certificate = records?.certificates?.[id];
            return last || certificate ? { record: last || certificate, last: Boolean(last) } : null;
        }
        function cardBadges() {
            document.querySelectorAll('#chapter-screen button[onclick]').forEach(button => {
                const key = button.getAttribute('onclick').match(/^showStudyNotes\(['"]([^'"]+)['"]\)/)?.[1];
                if (!keys.has(key)) return;
                button.querySelector('[data-quiz-pass-badge]')?.remove();
                if (!previous(key)) return;
                const badge = document.createElement('span');
                badge.dataset.quizPassBadge = key;
                badge.className = 'mt-3 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800';
                badge.textContent = '✓ 已通關・可再次挑戰';
                if (failed) badge.title = '暫時無法更新，顯示上次成功讀取的通關狀態';
                button.append(badge);
            });
        }
        function host(screen, id) {
            let element = document.getElementById(id);
            if (!element && document.getElementById(screen)) {
                element = document.createElement('aside');
                element.id = id;
                element.className = 'mb-5 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-slate-700';
                element.setAttribute('role', 'status');
                element.setAttribute('aria-live', 'polite');
                const anchor = screen === 'study-screen' ? document.getElementById('study-content')
                    : document.getElementById('question-container');
                document.getElementById(screen).insertBefore(element, anchor);
            }
            return element;
        }
        function paintHistory() {
            const previousPass = previous(currentChapter);
            for (const [screen, id] of [['study-screen', 'quiz-previous-pass-study'], ['quiz-screen', 'quiz-previous-pass-active']]) {
                const element = host(screen, id);
                if (!element) continue;
                element.replaceChildren();
                element.hidden = !keys.has(currentChapter) || Boolean(records && !previousPass);
                if (element.hidden) continue;
                if (!previousPass) {
                    element.textContent = failed ? '暫時無法讀取上次通關紀錄；不影響本次測驗。' : '正在讀取上次通關紀錄…';
                    continue;
                }
                const details = describe(previousPass.record, termId);
                const title = document.createElement('p');
                title.className = 'font-black text-emerald-800';
                title.textContent = previousPass.last ? '✓ 已通關｜上次通關紀錄' : '✓ 已通關｜既有通關紀錄';
                const summary = document.createElement('p');
                summary.className = 'mt-2 font-bold';
                summary.textContent = `正確率：${details.accuracy}　作答時間：${details.duration}`;
                const time = document.createElement('p');
                time.className = 'mt-1 text-xs text-slate-500';
                time.textContent = `通關時間：${details.time}（台灣時間）`;
                element.append(title, summary, time);
                if (failed) {
                    const warning = document.createElement('p');
                    warning.className = 'mt-2 text-xs font-bold text-amber-700';
                    warning.textContent = '暫時無法更新，以上為上次成功讀取的通關紀錄。';
                    element.append(warning);
                }
            }
            const button = startButton();
            if (button) {
                if (!originalLabel) originalLabel = button.textContent;
                button.textContent = keys.has(currentChapter) && previousPass ? '再次挑戰（已通關）' : originalLabel;
            }
        }
        function paint() { ensureOwner(); cardBadges(); paintHistory(); }
        async function refresh() {
            ensureOwner();
            if (!owner) { paint(); return; }
            const expectedOwner = owner, token = ++request;
            failed = false;
            const pending = (async () => {
                try {
                    const result = await read();
                    if (currentOwner() !== expectedOwner) { ensureOwner(); paint(); return; }
                    if (request !== token) return;
                    records = result || { certificates: {}, lastPasses: {} };
                    paint();
                } catch (error) {
                    if (currentOwner() !== expectedOwner) { ensureOwner(); paint(); return; }
                    if (request !== token) return;
                    console.warn('Unable to read previous quiz passes:', error);
                    failed = true;
                    // Keep known passes, but explicitly label the unsuccessful refresh.
                    paint();
                } finally { if (request === token) loading = null; }
            })();
            loading = pending;
            return pending;
        }
        window.addEventListener('focus', () => {
            if (currentOwner() === owner) return;
            ensureOwner(); paint(); void refresh();
        });
        return Object.freeze({
            refresh,
            show(key) {
                ensureOwner(); currentChapter = key; paint();
                if (!keys.has(key)) return;
                if (!loading) void refresh();
            }
        });
    }
    window.QuizPassStatus = Object.freeze({ create });
})();
