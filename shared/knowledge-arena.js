/* One game state machine for both terms. No answer keys are stored here. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const shuffle = items => {
        for (let i = items.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [items[i], items[j]] = [items[j], items[i]];
        }
        return items;
    };
    function mount({ termId, questions, requiredCertificates, requiredTasks }) {
        let db, store, unlocked = false, phase = 'idle', generation = 0, revision = 0;
        let run = null, queue = [], options = [], selected = null, lives = 0, maxLives = 0;
        let score = 0, correct = 0, wrong = 0, timeouts = 0, departures = 0, rounds = 0;
        let timer, transition, deadline = 0, submittedRemaining = 0, away = false;
        let savePromise = null, saved = false, bestBusy = false, boardRequest = 0, dailyRequest = 0;
        let screen = 'locked', sessionUid = null;
        const startButtons = [...document.querySelectorAll('[onclick^="startGame("]')];
        const here = () => !document.hidden && document.hasFocus() && !away;
        function show(name) {
            screen = name;
            ['locked', 'start', 'quiz', 'result', 'leaderboard'].forEach(key =>
                $(`screen-${key}`)?.classList.toggle('hidden-screen', key !== name));
        }
        function status(message) { $('arena-daily-status').textContent = message; }
        function errorMessage(error) {
            console.error('Knowledge arena:', error);
            return error?.code === 'permission-denied'
                ? '無法確認挑戰權限，請聯絡教師確認資料庫規則，並檢查裝置日期時間。'
                : error?.message || '連線失敗，請稍後再試。';
        }
        function buttons(disabled) { startButtons.forEach(button => { button.disabled = disabled; }); }
        async function refreshDaily() {
            const request = ++dailyRequest;
            buttons(true);
            if (!unlocked || !store || ['starting', 'question', 'submitting', 'feedback', 'waiting'].includes(phase)) return;
            status('正在確認今日挑戰次數…');
            try {
                const remaining = await store.remaining();
                if (request !== dailyRequest) return;
                status(`今日剩餘 ${remaining} / 2 次（台灣時間；各難度合計）`);
                $('arena-recheck').hidden = true;
                buttons(remaining === 0 || Boolean(run && !saved));
            } catch (error) {
                if (request === dailyRequest) {
                    status(errorMessage(error));
                    $('arena-recheck').hidden = false;
                }
            }
        }
        function stop() { clearInterval(timer); clearTimeout(transition); }
        function freezeOptions(frozen) {
            $('options-container').querySelectorAll('button').forEach(button => { button.disabled = frozen; });
        }
        function paint() {
            $('score-display').textContent = score.toLocaleString();
            $('lives-container').replaceChildren(...Array.from({ length: maxLives }, (_, i) => {
                const heart = document.createElement('span');
                heart.className = i < lives ? 'heart-icon' : 'heart-icon heart-lost';
                heart.textContent = '❤️';
                return heart;
            }));
        }
        function timerDisplay() {
            const remaining = Math.max(0, Math.min(10, (deadline - Date.now()) / 1000));
            $('time-text').textContent = Math.ceil(remaining);
            $('timer-bar').style.width = `${remaining * 10}%`;
            $('timer-bar').className = `h-full timer-bar ${remaining > 5 ? 'bg-green-400 timer-glow-green'
                : remaining > 2.5 ? 'bg-yellow-400 timer-glow-yellow' : 'bg-red-500 timer-glow-red'}`;
            return remaining;
        }
        function startTimer() {
            clearInterval(timer);
            timerDisplay();
            timer = setInterval(() => {
                if (phase !== 'question') return;
                if (timerDisplay() <= 0) settle('timeout');
            }, 50);
        }
        function overlay(title, detail, next) {
            $('feedback-overlay').classList.remove('hidden-screen');
            const content = $('feedback-content');
            content.className = 'text-center w-full px-6 transform scale-50 opacity-0 transition-all duration-300 ease-out';
            content.replaceChildren();
            const icon = document.createElement('div');
            const positive = title === '正解！';
            icon.className = `mx-auto mb-6 w-32 h-32 rounded-full border-4 border-white flex items-center justify-center text-6xl shadow-2xl ${positive
                ? 'bg-gradient-to-br from-green-400 to-green-600' : 'bg-gradient-to-br from-yellow-400 to-orange-600'}`;
            icon.textContent = positive ? '⭕' : title === '答錯了！' ? '❌' : title === '時間到！' ? '⏱️' : '⚠️';
            const heading = document.createElement('h3');
            heading.className = `text-4xl font-black mb-4 drop-shadow-lg ${positive ? 'text-green-300' : 'text-yellow-300'}`;
            heading.textContent = title;
            const message = document.createElement('p');
            message.className = 'text-lg font-bold text-slate-200 mb-5';
            message.textContent = detail;
            content.append(icon, heading, message);
            if (next) {
                const button = document.createElement('button');
                button.id = 'arena-continue';
                button.className = 'btn-3d bg-blue-600 text-white rounded-xl px-6 py-3 font-bold';
                button.textContent = lives <= 0 ? '查看結果' : '我知道了，開始下一題';
                button.onclick = () => { if (here() && phase === 'waiting') advance(); };
                content.append(button);
            }
            void content.offsetWidth;
            content.classList.replace('scale-50', 'scale-100');
            content.classList.replace('opacity-0', 'opacity-100');
        }
        function waitToContinue(focusPenalty = false) {
            phase = 'waiting';
            overlay(focusPenalty ? '離開作答畫面，視為答錯' : '準備繼續挑戰',
                focusPenalty ? '本題扣除一條生命；離開期間不會連續扣命。' : '確認後才開始下一題計時。', true);
        }
        function advance() {
            clearTimeout(transition);
            if (lives <= 0 || queue.length === 0) { endGame(queue.length === 0 && lives > 0); return; }
            loadQuestion();
        }
        function loadQuestion() {
            if (!here()) { waitToContinue(); return; }
            phase = 'question';
            revision++;
            rounds++;
            selected = null;
            $('arena-operation-status').textContent = '';
            $('submit-btn').disabled = true;
            $('feedback-overlay').classList.add('hidden-screen');
            $('main-container').classList.remove('screen-shake');
            $('question-counter').textContent = `第 ${rounds} 題（剩餘 ${queue.length} 題）`;
            $('question-text').textContent = queue[0].question;
            options = shuffle(queue[0].options.map((text, index) => ({ text, index })));
            $('options-container').replaceChildren(...options.map((option, i) => {
                const button = document.createElement('button');
                button.className = 'option-tv w-full text-left p-4 rounded-2xl font-bold text-lg tracking-wide flex items-center';
                const badge = document.createElement('span');
                badge.className = 'inline-block bg-slate-800 text-blue-400 w-8 h-8 rounded-full flex items-center justify-center mr-3 border border-blue-500/50 shrink-0';
                badge.textContent = String.fromCharCode(65 + i);
                const text = document.createElement('span');
                text.textContent = option.text;
                button.append(badge, text);
                button.onclick = () => {
                    if (phase !== 'question' || !here()) return;
                    if (timerDisplay() <= 0) { settle('timeout'); return; }
                    selected = i;
                    [...$('options-container').children].forEach((node, n) => node.classList.toggle('selected', n === i));
                    $('submit-btn').disabled = false;
                };
                return button;
            }));
            deadline = Date.now() + 10000;
            startTimer();
        }
        function settle(reason) {
            if (!['question', 'submitting'].includes(phase)) return;
            stop();
            phase = 'feedback';
            revision++;
            $('submit-btn').disabled = true;
            freezeOptions(true);
            const question = queue.shift();
            if (reason === 'correct') {
                const points = 1000 + Math.ceil(submittedRemaining) * 100;
                score += points;
                correct++;
                overlay('正解！', `+${points.toLocaleString()} 分`);
            } else {
                lives--;
                queue.push(question);
                if (reason === 'focus') departures++;
                else if (reason === 'timeout') timeouts++;
                else wrong++;
                $('main-container').classList.add('screen-shake');
                overlay(reason === 'timeout' ? '時間到！' : '答錯了！', '失去一命');
            }
            paint();
            // Save a final outcome immediately, even if its return/feedback screen is still open.
            if (lives <= 0 || queue.length === 0) void saveResult();
            if (reason === 'focus') { waitToContinue(true); return; }
            const token = generation;
            transition = setTimeout(() => {
                if (token !== generation || phase !== 'feedback') return;
                if (!here()) waitToContinue();
                else advance();
            }, 1800);
        }
        async function startGame(difficulty) {
            if (!unlocked || !['easy', 'normal', 'hard'].includes(difficulty)
                || ['starting', 'question', 'submitting', 'feedback', 'waiting'].includes(phase)
                || (run && !saved) || !here()) return;
            stop();
            phase = 'starting';
            buttons(true);
            ++dailyRequest;
            status('正在登記本次挑戰…');
            const token = ++generation;
            try {
                const reserved = await store.start(difficulty, questions.length);
                if (generation !== token) return;
                const activeOwner = window.ArenaStore.identity();
                if (activeOwner.uid !== reserved.uid) throw new Error('登入身分已變更，請返回入口重新登入。');
                run = reserved;
                saved = false;
                savePromise = null;
                bestBusy = false;
                queue = shuffle([...questions]);
                maxLives = { easy: 3, normal: 2, hard: 1 }[difficulty];
                lives = maxLives;
                score = correct = wrong = timeouts = departures = rounds = 0;
                $('record-submission-area').classList.add('hidden-screen');
                $('submission-success').classList.add('hidden-screen');
                $('submission-error').classList.add('hidden-screen');
                $('submit-score-btn').textContent = '登錄';
                $('submit-score-btn').disabled = false;
                $('student-id-input').value = run.studentId;
                status(`今日剩餘 ${run.remaining} / 2 次（台灣時間；各難度合計）`);
                paint();
                show('quiz');
                loadQuestion();
            } catch (error) {
                if (token !== generation) return;
                phase = 'idle';
                status(errorMessage(error));
                // Explicit retry rechecks the database. Never fall back to local counters.
                $('arena-recheck').hidden = false;
            }
        }
        async function submitAnswer() {
            if (phase !== 'question' || selected === null || !here()) return;
            submittedRemaining = timerDisplay();
            if (submittedRemaining <= 0) { settle('timeout'); return; }
            phase = 'submitting';
            clearInterval(timer);
            $('submit-btn').disabled = true;
            freezeOptions(true);
            const token = revision, game = generation, question = queue[0];
            try {
                window.ArenaStore.identity();
                const result = await window.QuizSecurity.saveAttempt({ termId, source: 'knowledge-arena',
                    question: question.question, options: question.options,
                    selectedIndex: options[selected].index,
                    elapsedSeconds: Math.max(0, Math.floor(10 - submittedRemaining)) });
                if (token !== revision || game !== generation || phase !== 'submitting') return;
                settle(result.correct ? 'correct' : 'wrong');
            } catch (error) {
                if (token !== revision || game !== generation || phase !== 'submitting') return;
                phase = 'question';
                $('arena-operation-status').textContent = errorMessage(error);
                if (timerDisplay() <= 0) settle('timeout');
                else { freezeOptions(false); $('submit-btn').disabled = false; startTimer(); }
            }
        }
        async function saveResult() {
            if (!run || saved) return;
            if (savePromise) return savePromise;
            const game = generation, finishedRun = run;
            $('arena-save-status').textContent = '正在保存挑戰紀錄…';
            $('arena-save-retry').hidden = true;
            savePromise = (async () => {
                try {
                    await store.finish(finishedRun, { score, correct, wrong, timeouts, departures,
                        rounds, won: queue.length === 0 && lives > 0 });
                    if (game !== generation) return;
                    saved = true;
                    $('arena-save-status').textContent = '本次挑戰紀錄已保存。';
                    if (score > 0) $('record-submission-area').classList.remove('hidden-screen');
                } catch (error) {
                    if (game !== generation) return;
                    $('arena-save-status').textContent = errorMessage(error);
                    $('arena-save-retry').hidden = false;
                } finally { if (game === generation) savePromise = null; }
            })();
            return savePromise;
        }
        function endGame(won) {
            if (phase === 'result') return;
            stop();
            phase = 'result';
            revision++;
            $('result-icon-container').textContent = won ? '🏆' : '💀';
            $('result-icon-container').style.fontSize = '5rem';
            $('result-title').textContent = won ? '全破通關！' : '挑戰結束';
            $('result-title').className = `text-5xl font-black mb-2 drop-shadow-lg tracking-widest ${won ? 'text-yellow-300' : 'text-red-400'}`;
            $('main-container').style.borderColor = won ? 'rgba(250,204,21,.6)' : 'rgba(239,68,68,.5)';
            $('final-score').textContent = score.toLocaleString();
            $('correct-count').textContent = correct;
            $('wrong-count').textContent = wrong;
            $('arena-timeout-count').textContent = timeouts;
            $('arena-focus-count').textContent = departures;
            show('result');
            void saveResult();
        }
        async function submitScoreToLeaderboard() {
            if (!saved || !run || score <= 0 || bestBusy) return;
            if (run.studentId.endsWith('00')) {
                $('submission-error').textContent = '測試帳號不列入正式英雄榜。';
                $('submission-error').classList.remove('hidden-screen');
                return;
            }
            bestBusy = true;
            $('submit-score-btn').disabled = true;
            const game = generation;
            try {
                const improved = await store.saveBest(run);
                if (game !== generation) return;
                $('submission-success').textContent = improved ? '✅ 已更新個人最佳成績！' : '已保留原有較高／相同的個人最佳成績。';
                $('submission-success').classList.remove('hidden-screen');
                $('submission-error').classList.add('hidden-screen');
                $('submit-score-btn').textContent = '已登錄';
            } catch (error) {
                if (game !== generation) return;
                $('submission-error').textContent = errorMessage(error);
                $('submission-error').classList.remove('hidden-screen');
                $('submit-score-btn').disabled = false;
                bestBusy = false;
            }
        }
        async function loadLeaderboardData(difficulty) {
            if (!unlocked || !store || !['easy', 'normal', 'hard'].includes(difficulty)) return;
            const request = ++boardRequest;
            ['easy', 'normal', 'hard'].forEach(key => {
                $(`tab-${key}`).className = `flex-1 py-2 text-sm font-bold rounded-md transition-colors ${key === difficulty
                    ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'}`;
            });
            $('leaderboard-body').replaceChildren();
            $('leaderboard-empty').classList.add('hidden-screen');
            $('leaderboard-loading').classList.remove('hidden-screen');
            try {
                const rows = await store.leaderboard(difficulty);
                if (request !== boardRequest) return;
                rows.forEach((data, i) => {
                    const tr = document.createElement('tr');
                    [(['🥇', '🥈', '🥉'][i] || i + 1), data.studentId, data.score.toLocaleString()].forEach(value => {
                        const td = document.createElement('td');
                        td.textContent = value;
                        tr.append(td);
                    });
                    $('leaderboard-body').append(tr);
                });
                $('leaderboard-empty').textContent = '尚無紀錄，成為第一位上榜者吧！';
                $('leaderboard-empty').classList.toggle('hidden-screen', rows.length > 0);
            } catch (error) {
                if (request !== boardRequest) return;
                $('leaderboard-empty').textContent = errorMessage(error);
                $('leaderboard-empty').classList.remove('hidden-screen');
            } finally {
                if (request === boardRequest) $('leaderboard-loading').classList.add('hidden-screen');
            }
        }
        function onLeave() {
            away = true;
            if (screen === 'quiz' && ['question', 'submitting'].includes(phase)) settle('focus');
        }
        function onReturn() {
            if (document.hidden || !document.hasFocus()) return;
            away = false;
            if (screen === 'start') void refreshDaily();
        }
        window.addEventListener('blur', onLeave);
        window.addEventListener('focus', onReturn);
        window.addEventListener('pagehide', onLeave);
        window.addEventListener('pageshow', onReturn);
        document.addEventListener('visibilitychange', () => document.hidden ? onLeave() : onReturn());
        ['copy', 'cut'].forEach(type => document.addEventListener(type, event => {
            if (screen !== 'quiz' || !['question', 'submitting', 'feedback', 'waiting'].includes(phase)) return;
            const selection = window.getSelection();
            const areas = [$('question-text'), $('options-container')];
            const selectedArea = areas.some(area => {
                if (area.contains(event.target)) return true;
                for (let i = 0; selection && i < selection.rangeCount; i++) {
                    if (selection.getRangeAt(i).intersectsNode(area)) return true;
                }
                return false;
            });
            if (!selectedArea) return;
            event.preventDefault();
            $('arena-operation-status').textContent = '題目與選項不提供複製／剪下，請在本頁閱讀並作答。';
        }));
        Object.assign(window, {
            startGame, submitAnswer, submitScoreToLeaderboard, loadLeaderboardData,
            showStartScreen() {
                if (['starting', 'question', 'submitting', 'feedback', 'waiting'].includes(phase)) return;
                if (run && !saved) { show('result'); return; }
                phase = 'idle'; show(unlocked ? 'start' : 'locked'); void refreshDaily();
            },
            showLeaderboardScreen() {
                if (!unlocked || ['starting', 'question', 'submitting', 'feedback', 'waiting'].includes(phase)) return;
                show('leaderboard'); void loadLeaderboardData('normal');
            },
            refreshQuizUnlock: initialize
        });
        $('arena-recheck').onclick = () => { $('arena-recheck').hidden = true; void refreshDaily(); };
        $('arena-save-retry').onclick = saveResult;
        function scheduleDayRefresh() {
            const now = Date.now();
            const nextMidnight = (Math.floor((now + 28800000) / 86400000) + 1) * 86400000 - 28800000;
            setTimeout(() => {
                if (screen === 'start') void refreshDaily();
                scheduleDayRefresh();
            }, Math.max(100, nextMidnight - now + 100));
        }
        scheduleDayRefresh();
        async function initialize() {
            if (['starting', 'question', 'submitting', 'feedback', 'waiting'].includes(phase)) return;
            const accessGeneration = generation;
            buttons(true);
            show('locked');
            $('unlock-status').textContent = '正在確認登入與集章進度…';
            try {
                if (!firebase.apps.length) firebase.initializeApp(window.LEARNING_FIREBASE_CONFIG);
                db = firebase.firestore();
                const user = await new Promise((resolve, reject) => {
                    let unsubscribe = () => {};
                    unsubscribe = firebase.auth().onAuthStateChanged(value => { unsubscribe(); resolve(value); }, reject);
                });
                if (!user) throw new Error('請先從入口網登入。');
                const owner = window.ArenaStore.identity();
                sessionUid = owner.uid;
                const snapshot = await db.collection('users').doc(owner.uid).get({ source: 'server' });
                if (accessGeneration !== generation) return;
                const data = window.ArenaStore.exists(snapshot) ? snapshot.data().terms?.[termId] || {} : {};
                const certificates = requiredCertificates ? window.QuizPassStatus.normalize(
                    { certificates: data.certificates }, 'infolife', requiredCertificates).certificates : null;
                unlocked = requiredCertificates
                    ? requiredCertificates.every(key => certificates[`infolife-${key}`])
                    : requiredTasks.every(key => Boolean(data.tasks?.[key]));
                if (!unlocked) { $('unlock-status').textContent = '請先完成本學期資訊生活的八枚印章，再挑戰知識大擂台。'; return; }
                store = window.ArenaStore.create(db, termId);
                show('start');
                void refreshDaily();
            } catch (error) { $('unlock-status').textContent = errorMessage(error); }
        }
        void initialize();
        // A changed authentication identity invalidates pending callbacks and the current game.
        try { firebase.auth().onAuthStateChanged(user => {
            if (!sessionUid || user?.uid === sessionUid) return;
            stop(); generation++; revision++; unlocked = false; phase = 'idle';
            buttons(true); show('locked');
            $('unlock-status').textContent = '登入身分已變更，請返回入口重新登入。';
        }); } catch (error) { $('unlock-status').textContent = errorMessage(error); }
    }
    window.KnowledgeArena = Object.freeze({ mount });
})();
