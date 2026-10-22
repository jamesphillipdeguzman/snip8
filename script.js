        import { Snip8Theme } from './utils/theme.js';
        import { Snip8Validation } from './utils/validation.js';

        const TARGET_DAILY_SEC = 8 * 3600;
        let countdownInterval = null;
        let deadlineTimeout = null;
        let periodicSyncInterval = null;
        let neonSaveTimeout = null;
        let alarmInterval = null;
        let targetTimestamp = null;
        let alarmDismissed = false;
        let alarmActive = false;
        let alarmNotification = null;
        let titleFlashInterval = null;
        const BASE_TITLE = document.title;
        const ALARM_TITLE = '⏰ STOP TIMER — 8h reached!';
        // On reload after the target already passed, only re-ring if we're still inside the 5m grace window
        const ALARM_RESTORE_GRACE_MS = 5 * 60 * 1000;

        // Dynamic days model (populated directly via OCR)
        let detectedDays = [];
        let selectedDayIndex = 0;
        let totalTrackedSec = 0;

        // Live progress tracking baseline state
        let timerStartTime = null;
        let timerCompleted = false;
        let completedElapsedSec = 0;
        let baseTodaySec = 0;
        let baseTotalTrackedSec = 0;
        const STORAGE_KEY_LIVE_INCREMENT = 'snip8_live_increment';

        // Session persistence keys (localStorage, JSON-serialized)
        const SESSION_KEYS = {
            detectedDays: 'snip8_detectedDays',
            selectedDayIndex: 'snip8_selectedDayIndex',
            targetTimestamp: 'snip8_targetTimestamp',
            lastUpdated: 'snip8_lastUpdated',
            totalTrackedSec: 'snip8_totalTrackedSec',
            alarmAck: 'snip8_alarmAckTarget'
        };

        // Elements
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const statusContainer = document.getElementById('statusContainer');
        const dashboard = document.getElementById('dashboard');
        const dispTotalTracked = document.getElementById('dispTotalTracked');
        const dispTodayLogged = document.getElementById('dispTodayLogged');
        const dispTodayLabel = document.getElementById('dispTodayLabel');
        const dispStopTime = document.getElementById('dispStopTime');
        const dispRemaining = document.getElementById('dispRemaining');
        const countdown = document.getElementById('countdown');
        const weeklyTableBody = document.getElementById('weeklyTableBody');
        const alarmBanner = document.getElementById('alarmBanner');
        const rawOcrText = document.getElementById('rawOcrText');
        const liveIncrementToggle = document.getElementById('liveIncrementToggle');
        const dismissBtn = document.getElementById('dismissBtn');
        const sessionMeta = document.getElementById('sessionMeta');
        const syncMobileBtn = document.getElementById('syncMobileBtn');
        const syncModal = document.getElementById('syncModal');
        const syncModalClose = document.getElementById('syncModalClose');
        const syncModalSummary = document.getElementById('syncModalSummary');
        const syncQrCanvas = document.getElementById('syncQrCanvas');
        const syncQrFallback = document.getElementById('syncQrFallback');
        const syncLocalWarning = document.getElementById('syncLocalWarning');
        const syncLinkInput = document.getElementById('syncLinkInput');
        const copySyncLinkBtn = document.getElementById('copySyncLinkBtn');

        // Neon & AI Vision Elements
        const neonSyncBadge = document.getElementById('neonSyncBadge');
        const neonSyncDot = document.getElementById('neonSyncDot');
        const neonSyncLabel = document.getElementById('neonSyncLabel');
        const aiValidationNotice = document.getElementById('aiValidationNotice');
        const aiValidationDetail = document.getElementById('aiValidationDetail');
        const aiValidationModel = document.getElementById('aiValidationModel');
        const parseSourceBadge = document.getElementById('parseSourceBadge');
        const forceAiBtn = document.getElementById('forceAiBtn');

        function updateParseSourceBadge(type, detail = '') {
            if (!parseSourceBadge) return;
            if (type === 'ocr') {
                parseSourceBadge.textContent = '⚡ Local OCR';
                parseSourceBadge.className = 'text-xs px-2 py-0.5 rounded bg-slate-800 text-emerald-400 border border-emerald-500/30 font-mono font-medium';
            } else if (type === 'ai') {
                const confText = detail ? ` (Confidence: ${detail})` : '';
                parseSourceBadge.textContent = `✨ Gemini AI Validated${confText}`;
                parseSourceBadge.className = 'text-xs px-2 py-0.5 rounded bg-indigo-950/90 text-indigo-300 border border-indigo-500/50 font-mono font-medium shadow-sm';
            } else if (type === 'parsing') {
                parseSourceBadge.textContent = '🤖 Validating with Gemini AI...';
                parseSourceBadge.className = 'text-xs px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-500/40 font-mono animate-pulse';
            } else {
                parseSourceBadge.textContent = 'Awaiting scan';
                parseSourceBadge.className = 'text-xs px-2 py-1 rounded bg-slate-800 text-slate-300';
            }
        }

        // PIN Authentication State & Elements
        const STORAGE_KEY_PIN = 'snip8_user_pin';
        const pinIndicator = document.getElementById('pinIndicator');
        const pinDisplay = document.getElementById('pinDisplay');
        const switchPinBtn = document.getElementById('switchPinBtn');
        const pinModal = document.getElementById('pinModal');
        const pinForm = document.getElementById('pinForm');
        const pinInput = document.getElementById('pinInput');
        const pinErrorMsg = document.getElementById('pinErrorMsg');

        function getUserPin() {
            try {
                return (localStorage.getItem(STORAGE_KEY_PIN) || '').trim();
            } catch (e) {
                return '';
            }
        }

        function maskPin(pin) {
            return pin ? '•'.repeat(Math.min(pin.length, 8)) : '••••';
        }

        function updatePinUI() {
            const pin = getUserPin();
            if (pinIndicator && pinDisplay) {
                if (pin) {
                    pinDisplay.textContent = maskPin(pin);
                    pinIndicator.classList.remove('hidden');
                } else {
                    pinIndicator.classList.add('hidden');
                }
            }
        }

        function openPinModal() {
            if (!pinModal) return;
            if (pinErrorMsg) pinErrorMsg.classList.add('hidden');
            if (pinInput) pinInput.value = '';
            if (typeof pinModal.showModal === 'function') {
                if (!pinModal.open) pinModal.showModal();
            } else {
                pinModal.setAttribute('open', '');
            }
            if (pinInput) {
                setTimeout(() => pinInput.focus(), 60);
            }
        }

        function closePinModal() {
            if (!pinModal || !pinModal.open) return;
            if (typeof pinModal.close === 'function') {
                pinModal.close();
            } else {
                pinModal.removeAttribute('open');
            }
        }

        function clearUserPin() {
            try {
                localStorage.removeItem(STORAGE_KEY_PIN);
            } catch (e) { }
            updatePinUI();
        }

        // ===== Web Audio (single shared, lazily-created context) =====
        // Browsers start AudioContexts "suspended" until a user gesture, so we create one context
        // and resume it on every gesture/alarm instead of spawning a new (blocked) context per beep.
        let audioCtx = null;

        function getAudioContext() {
            if (!audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                audioCtx = new AC();
            }
            return audioCtx;
        }

        async function ensureAudioRunning() {
            const ctx = getAudioContext();
            if (!ctx) return null;
            if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
                try { await ctx.resume(); } catch (e) { /* still locked until a user gesture */ }
            }
            return ctx;
        }

        // Web Audio Chime (Triple Bell Pattern)
        async function playBeep() {
            try {
                const ctx = await ensureAudioRunning();
                if (!ctx || ctx.state !== 'running') {
                    console.warn('snip8: audio is locked until you click or press a key on the page.');
                    return false;
                }

                const start = ctx.currentTime + 0.05;
                const notes = [587.33, 739.99, 880]; // D5, F#5, A5
                notes.forEach((freq, idx) => {
                    const t = start + idx * 0.15;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();

                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(freq, t);

                    gain.gain.setValueAtTime(0, t);
                    gain.gain.linearRampToValueAtTime(0.3, t + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

                    osc.connect(gain);
                    gain.connect(ctx.destination);

                    osc.start(t);
                    osc.stop(t + 0.4);
                    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
                });
                return true;
            } catch (e) {
                console.error("Audio error", e);
                return false;
            }
        }

        // Unlock audio on any user gesture so the alarm can sound later without interaction
        ['pointerdown', 'keydown', 'touchstart'].forEach(evt =>
            window.addEventListener(evt, () => { ensureAudioRunning(); }, { passive: true })
        );

        // ===== Desktop Notifications =====
        let notificationPermissionAsked = false;

        function requestNotificationPermission() {
            if (!('Notification' in window) || Notification.permission !== 'default' || notificationPermissionAsked) return;
            notificationPermissionAsked = true;
            try {
                const p = Notification.requestPermission();
                if (p && typeof p.catch === 'function') p.catch(() => { });
            } catch (e) { /* unsupported */ }
        }

        function showAlarmNotification() {
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            try {
                alarmNotification = new Notification('⏰ snip8 — 8 hours reached', {
                    body: 'Stop your timer in Springboard / Clockify now. The 5-minute grace period has started.',
                    tag: 'snip8-alarm',
                    requireInteraction: true,
                    icon: 'images/favicon.ico'
                });
                alarmNotification.onclick = () => {
                    window.focus();
                    alarmNotification && alarmNotification.close();
                };
            } catch (e) {
                // e.g. Android Chrome requires a Service Worker for notifications
                console.warn('snip8: notification failed', e);
            }
        }

        document.getElementById('testAudioBtn').addEventListener('click', () => {
            requestNotificationPermission();
            playBeep();
        });

        dropZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) processFile(e.target.files[0]);
        });

        window.addEventListener('paste', (e) => {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            for (const item of items) {
                if (item.type.indexOf('image') !== -1) {
                    processFile(item.getAsFile());
                    break;
                }
            }
        });

        async function processFile(file) {
            // Store the last uploaded image file/blob in memory as window.lastUploadedTimesheet
            window.lastUploadedTimesheet = file;

            // Called from a paste/upload gesture: good moment to unlock audio + ask for notifications
            ensureAudioRunning();
            requestNotificationPermission();

            statusContainer.classList.remove('hidden');
            statusContainer.textContent = "Enhancing contrast and running OCR on timesheet...";

            let base64Image = null;
            try {
                base64Image = await Snip8Validation.toBase64(file);
            } catch (b64Err) {
                console.warn('snip8: Could not encode image to base64', b64Err);
            }

            const img = new Image();
            img.src = URL.createObjectURL(file);
            await img.decode();

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            let sx = 0, sy = 0, sw = img.width, sh = img.height;

            // Check aspect ratio: only crop the header band if this is a wide desktop screenshot.
            // Tight/narrow crops (e.g. single day column with width <= 900 or aspect ratio < 1.2) are kept 100% intact.
            const aspectRatio = img.width / img.height;
            const isFullDesktopView = img.width > 900 && img.height > 600 && aspectRatio >= 1.2;

            if (isFullDesktopView) {
                sy = Math.floor(img.height * 0.08);
                sh = Math.floor(img.height * 0.20);
            }

            canvas.width = sw * 2;
            canvas.height = sh * 2;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

            // Contrast enhancement: convert faint gray font to pure dark pixels.
            // Use safe cutoff (200 for tight crops) to preserve thin or faint text in single-column snips.
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imgData.data;
            const threshold = isFullDesktopView ? 185 : 200;
            for (let i = 0; i < data.length; i += 4) {
                const brightness = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                if (brightness < threshold) {
                    data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
                } else {
                    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
                }
            }
            ctx.putImageData(imgData, 0, 0);

            if (!base64Image) {
                try {
                    base64Image = canvas.toDataURL('image/png');
                } catch (cErr) {
                    console.warn('snip8: Could not encode canvas to base64', cErr);
                }
            }
            if (base64Image) {
                window.lastUploadedTimesheetBase64 = base64Image;
            }

            try {
                const result = await Tesseract.recognize(canvas, 'eng');
                statusContainer.classList.add('hidden');
                rawOcrText.textContent = result.data.text || "(No readable text detected)";
                await parseText(result.data.text, base64Image);
            } catch (err) {
                console.warn('snip8: Tesseract OCR error, evaluating AI fallback:', err);
                if (base64Image) {
                    const fallbackHandled = await triggerAiValidationFallback(base64Image, 'Tesseract OCR failure');
                    if (fallbackHandled) return;
                }
                statusContainer.classList.remove('hidden');
                statusContainer.textContent = "OCR scan failed. Use manual entry below.";
            }
        }

        async function triggerAiValidationFallback(base64Image, reason) {
            if (!base64Image) return false;
            try {
                statusContainer.classList.remove('hidden');
                statusContainer.innerHTML = `<span>🤖 <strong>Triggering AI Vision:</strong> ${escapeHtml(reason)}<br>Validating timesheet with Gemini Vision...</span>`;

                const result = await Snip8Validation.validateWithAi(base64Image, {
                    dailyCapSeconds: TARGET_DAILY_SEC
                });

                if (result && result.success) {
                    const rawConf = result.confidence || 'High';
                    const conf = rawConf.charAt(0).toUpperCase() + rawConf.slice(1).toLowerCase();
                    updateParseSourceBadge('ai', conf);

                    statusContainer.textContent = `✨ Timesheet validated via Gemini Vision AI (${result.confidence} confidence)`;
                    setTimeout(() => { statusContainer.classList.add('hidden'); }, 3500);

                    if (aiValidationNotice && aiValidationDetail && aiValidationModel) {
                        aiValidationDetail.textContent = `Confidence: ${(result.confidence || 'high').toUpperCase()} (${formatHms(result.loggedSeconds)} logged)`;
                        aiValidationModel.textContent = result.modelUsed || 'Gemini Vision';
                        aiValidationNotice.classList.remove('hidden');
                    }

                    if (Array.isArray(result.timesheetData) && result.timesheetData.length > 0) {
                        detectedDays = result.timesheetData;
                    } else {
                        const now = new Date();
                        const todayLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
                        const h = Math.floor(result.loggedSeconds / 3600);
                        const m = Math.floor((result.loggedSeconds % 3600) / 60);
                        const s = result.loggedSeconds % 60;
                        detectedDays = [{
                            label: `${todayLabel} (AI)`,
                            dayName: todayLabel.split(' ')[0],
                            h, m, s,
                            sec: result.loggedSeconds,
                            shifts: result.shifts || []
                        }];
                    }

                    selectedDayIndex = 0;
                    totalTrackedSec = result.loggedSeconds;

                    rawOcrText.textContent = `=== VALIDATED VIA AI VISION (Gemini) ===\nModel: ${result.modelUsed}\nConfidence: ${result.confidence}\nLogged: ${formatHms(result.loggedSeconds)}\nRemaining for 8h: ${formatHms(result.remainingSeconds)}\n\nShifts:\n${JSON.stringify(result.shifts, null, 2)}`;

                    renderAll();
                    debouncedSaveSession();
                    saveToNeon();
                    return true;
                }
            } catch (err) {
                console.warn('snip8: AI Vision validation failed:', err);
                statusContainer.classList.remove('hidden');
                statusContainer.textContent = `AI fallback unavailable (${err.message}). Using manual entry.`;
                setTimeout(() => { statusContainer.classList.add('hidden'); }, 4000);
            }
            return false;
        }

        async function parseText(rawText, base64Image = null) {
            if (!rawText) return;

            // 1. Normalization
            let cleaned = rawText
                .replace(/[oOQ]([0-9])/g, '0$1')
                .replace(/([0-9])[oOQ]/g, '$10')
                .replace(/\b(?:racked|racksd|tracksd)\b/gi, 'tracked')
                .replace(/\btine\b/gi, 'time')
                .replace(/\bThr\s*,/gi, '1 hr,')
                .replace(/\bThr\b/gi, '1 hr')
                // Normalize any OCR misreads of 00 hr (G0, GO, g0, go, 60, CO, C0, OO, O0)
                .replace(/\b[Gg6COo0][0oOQ]\s*(?:hr|h)/gi, '00 hr')
                .replace(/\b[Gg]\s*(?:hr|h)/gi, '00 hr')
                .replace(/\bG0\b/gi, '00')
                .replace(/rnin|min|mln/gi, 'min')
                .replace(/ser|see|soc|soe|sec/gi, 'sec')
                // Fix Tesseract common misread: "00 hr 20 min 00 sec" for empty columns
                .replace(/\b0{1,2}\s*(?:hr|h)\s*,?\s*20\s*(?:min|m)\s*,?\s*0{1,2}\s*(?:sec|s)?/gi, '00 hr 00 min 00 sec')
                .replace(/\b0{1,2}\s*(?:hr|h)\s*,?\s*20\s*(?:min|m)\s*,?\s*0\b/gi, '00 hr 00 min 00 sec');

            // 2. Total time tracked extraction (top summary)
            const totalRegex = /(?:Total\s*(?:time|tire|tine|tracked)?)[\s\S]{0,35}?(\d{1,2})\s*(?:hr|h|br|hrs?)\s*,?\s*(\d{1,2})\s*(?:min|m|mins?)(?:\s*,?\s*(\d{1,2})\s*(?:sec|s|secs?))?/i;
            const totalMatch = cleaned.match(totalRegex);
            totalTrackedSec = 0;
            if (totalMatch) {
                const totH = parseInt(totalMatch[1], 10);
                const totM = parseInt(totalMatch[2], 10);
                const totS = totalMatch[3] !== undefined ? parseInt(totalMatch[3], 10) : 0;
                totalTrackedSec = totH * 3600 + totM * 60 + totS;
            }

            // Extract shift intervals (e.g. 5:05-8:22, 9:37-12:08, 12:32-2:45)
            const { shifts: extractedShifts, totalShiftSec } = Snip8Validation.extractShiftIntervals((rawText || '') + '\n' + cleaned);

            // 3. Remove all lines containing "total" so it doesn't get captured in columns
            const lines = cleaned.split('\n').filter(line => !/total/i.test(line)).join('\n');

            // 4. Sanitize timezone markers, time ranges, and lone axis digits/offsets before day durations
            // Note: Never strip duration units (hr/min/sec) or digits preceding "min/sec"
            let textForColumns = lines
                .replace(/\bGMT\b/gi, ' ')
                .replace(/\b\d{1,2}\s*(?:AM|PM)\b/gi, ' ') // e.g. 10 AM, 12 AM
                .replace(/(?:^|\s)[+-]?\d{1,2}(?:\s+[a-gi-ln-rt-z]\b)?(?=\s+(?:00|\d{1,2})\s*(?:hr|h)\b)/gim, ' ')
                .replace(/(?:^|\s)[+-]?\d{1,2}(?=\s+[+-]?\d{1,2}\s+(?:00|\d{1,2})\s*(?:hr|h)\b)/gim, ' ')
                .replace(/(?:^|\s)[+-]?\d{1,2}(?=\s+(?:00|\d{1,2})\s*(?:hr|h)\b)/gim, ' ');

            // 5. Extract Date Headers (e.g. Thu 10/1, Fri 10/2)
            const dayHeaderRegex = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Man)\b[\s\S]{0,4}?(\d{1,2}[\/\w]+)/gi;
            const daysFound = [];
            let hm;
            while ((hm = dayHeaderRegex.exec(textForColumns)) !== null) {
                let dayName = hm[1];
                if (/^man$/i.test(dayName)) dayName = 'Mon';
                const datePart = hm[2].replace(/([0-9])[A|Il\\]([0-9])/g, '$1/$2');
                daysFound.push({ label: `${dayName} ${datePart}`.trim(), dayName });
            }

            // Fallback if dates were not read
            if (daysFound.length === 0) {
                const standaloneHeaderRegex = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/gi;
                let shm;
                while ((shm = standaloneHeaderRegex.exec(textForColumns)) !== null) {
                    daysFound.push({ label: shm[1], dayName: shm[1] });
                }
            }

            // 6. Extract Column Durations (HH hr MM min SS sec or headless hr)
            // Ensures "08 hr 00 min 05 sec" parses as 8h 0m 5s (28,805 sec), "08 hr 00 min" as 8h 0m 0s (28,800 sec), etc.
            const durRegex = /(?:(\d{1,2})\s*(?:hr|h|hrs?)\b\s*,?\s*(?:(\d{1,2})\s*(?:min|m|mins?)\b\s*,?\s*)?(?:(\d{1,2})\s*(?:sec|s|secs?)\b)?)|(?:(\d{1,2})\s*(?:min|m|mins?)\b\s*,?\s*(?:(\d{1,2})\s*(?:sec|s|secs?)\b)?)|(?:(\d{1,2})\s*(?:sec|s|secs?)\b)/gi;
            const parsedDurations = [];
            let dm;
            while ((dm = durRegex.exec(textForColumns)) !== null) {
                let h = 0;
                let m = 0;
                let s = 0;

                if (dm[1] !== undefined) {
                    h = parseInt(dm[1], 10);
                    m = dm[2] !== undefined ? parseInt(dm[2], 10) : 0;
                    s = dm[3] !== undefined ? parseInt(dm[3], 10) : 0;
                } else if (dm[4] !== undefined) {
                    m = parseInt(dm[4], 10);
                    s = dm[5] !== undefined ? parseInt(dm[5], 10) : 0;
                } else if (dm[6] !== undefined) {
                    s = parseInt(dm[6], 10);
                }

                // If hour was headless (e.g. "hr 41 min 36 sec"), inspect preceding token
                if (dm[1] === undefined) {
                    const preText = textForColumns.substring(Math.max(0, dm.index - 8), dm.index);
                    if (/\bhr\s*,?\s*$/i.test(preText)) {
                        h = totalTrackedSec > 0 ? Math.max(1, Math.floor(totalTrackedSec / 3600)) : 1;
                    }
                }

                // Fix Tesseract common misread: "00 hr 20 min 00 sec" for "00 hr 00 min 00 sec"
                if (h === 0 && m === 20 && s === 0) {
                    m = 0;
                }

                if (h <= 24 && m < 60 && s < 60) {
                    parsedDurations.push({
                        h,
                        m,
                        s,
                        sec: h * 3600 + m * 60 + s
                    });
                }
            }

            if (daysFound.length === 0 && parsedDurations.length === 0) {
                if (base64Image) {
                    const handled = await triggerAiValidationFallback(base64Image, 'No timesheet columns detected by OCR');
                    if (handled) return;
                }
                alert("Could not detect timesheet columns. Please use manual entry.");
                return;
            }

            // 7. Map parsed columns
            const count = Math.max(daysFound.length, parsedDurations.length);
            detectedDays = [];
            for (let i = 0; i < count; i++) {
                const label = daysFound[i] ? daysFound[i].label : `Day ${i + 1}`;
                const dur = parsedDurations[i] || { h: 0, m: 0, s: 0, sec: 0 };
                detectedDays.push({
                    label,
                    dayName: daysFound[i] ? daysFound[i].dayName : '',
                    h: dur.h,
                    m: dur.m,
                    s: dur.s,
                    sec: dur.sec
                });
            }

            // 8. Smart Active Day Selection:
            // First priority: Match today's day of week (e.g. "Fri")
            const now = new Date();
            const todayName = now.toLocaleDateString('en-US', { weekday: 'short' }); // "Fri"
            let matchedIndex = detectedDays.findIndex(d => d.label.toLowerCase().includes(todayName.toLowerCase()));

            // Fallback: If not matched by day name, pick the latest day with sec > 0
            if (matchedIndex === -1) {
                for (let i = detectedDays.length - 1; i >= 0; i--) {
                    if (detectedDays[i].sec > 0) {
                        matchedIndex = i;
                        break;
                    }
                }
            }

            selectedDayIndex = matchedIndex >= 0 ? matchedIndex : 0;

            // 9. Reconcile Active Day with Total Tracked Time
            // When totalTrackedSec is read from the pay period summary (e.g. 2 hr, 54 min, 10 sec):
            // If today is the active day and all other columns are 0, reconcile the active day's duration
            // with the pay period total (correcting OCR misreads like '04 min' for '54 min' or '0h 0m 0s')
            if (totalTrackedSec > 0 && detectedDays[selectedDayIndex]) {
                const otherDaysSec = detectedDays.reduce((acc, d, idx) => idx === selectedDayIndex ? acc : acc + d.sec, 0);
                if (otherDaysSec === 0) {
                    const totH = Math.floor(totalTrackedSec / 3600);
                    const totM = Math.floor((totalTrackedSec % 3600) / 60);
                    const totS = totalTrackedSec % 60;
                    detectedDays[selectedDayIndex].h = totH;
                    detectedDays[selectedDayIndex].m = totM;
                    detectedDays[selectedDayIndex].s = totS;
                    detectedDays[selectedDayIndex].sec = totalTrackedSec;
                }
            }

            if (totalTrackedSec === 0) {
                totalTrackedSec = detectedDays.reduce((acc, d) => acc + d.sec, 0);
            }

            // Attach extracted shifts if active day doesn't already have them
            if (detectedDays[selectedDayIndex] && (!detectedDays[selectedDayIndex].shifts || detectedDays[selectedDayIndex].shifts.length === 0)) {
                detectedDays[selectedDayIndex].shifts = extractedShifts;
            }

            // 10. Shift Total & Duration Sanity Check:
            // Auto-trigger AI fallback if:
            // 1) total parsed time < 1 hour but 2+ shifts were detected
            // 2) duration string contains "08 hr" but total is under 1 minute (e.g. parsed as 5 seconds)
            // 3) shift sum is ~8 hours but parsed header total is < 1 hour
            const activeDaySec = detectedDays[selectedDayIndex] ? detectedDays[selectedDayIndex].sec : 0;
            const parsedHeaderTotalSec = totalTrackedSec > 0 ? totalTrackedSec : activeDaySec;

            const hasUnder1HourWithMultipleShifts = parsedHeaderTotalSec < 3600 && extractedShifts.length >= 2;
            const combinedOcrText = (rawText || '') + ' ' + cleaned;
            const has8HrStringWithUnder1MinTotal = /\b0?8\s*(?:hr|h|hrs)\b/i.test(combinedOcrText) && parsedHeaderTotalSec < 60;
            const isShiftSumAround8h = totalShiftSec >= 6 * 3600 && totalShiftSec <= 12 * 3600;
            const hasShiftSumMismatch = isShiftSumAround8h && parsedHeaderTotalSec < 3600;

            if (hasUnder1HourWithMultipleShifts || has8HrStringWithUnder1MinTotal || hasShiftSumMismatch) {
                let mismatchReason = '';
                if (has8HrStringWithUnder1MinTotal) {
                    mismatchReason = `Timesheet text contains "08 hr" but parsed total is only ${formatHms(parsedHeaderTotalSec)} (< 1 min). Local OCR marked INVALID.`;
                } else if (hasUnder1HourWithMultipleShifts) {
                    mismatchReason = `${extractedShifts.length} work shifts detected summing to ~${Math.round(totalShiftSec / 3600)}h, but parsed header total is only ${formatHms(parsedHeaderTotalSec)} (< 1h). Local OCR marked INVALID.`;
                } else {
                    mismatchReason = `Shift intervals sum to ~${Math.round(totalShiftSec / 3600)}h (${formatHms(totalShiftSec)}), but parsed header total is < 1h (${formatHms(parsedHeaderTotalSec)}). Local OCR marked INVALID.`;
                }

                console.warn('snip8: Sanity check failed:', mismatchReason);
                updateParseSourceBadge('parsing');

                if (base64Image) {
                    const handledByAi = await triggerAiValidationFallback(base64Image, mismatchReason);
                    if (handledByAi) return;
                }
            }

            // OCR Validation Heuristic
            const fallbackCheck = Snip8Validation.shouldTriggerAiFallback({
                rawText: cleaned,
                parsedDurations,
                totalTrackedSec,
                detectedDays,
                extractedShifts,
                shiftSumSec: totalShiftSec
            });

            if (fallbackCheck.shouldFallback && base64Image) {
                console.log('snip8: triggering AI Vision fallback:', fallbackCheck.reason);
                updateParseSourceBadge('parsing');
                const handledByAi = await triggerAiValidationFallback(base64Image, fallbackCheck.reason);
                if (handledByAi) return;
            }

            // Local OCR completed successfully
            updateParseSourceBadge('ocr');

            if (aiValidationNotice) aiValidationNotice.classList.add('hidden');
            renderAll();
        }

        function formatHms(seconds) {
            const s = Math.max(0, Math.floor(seconds));
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            return `${h}h ${m}m ${sec}s`;
        }

        // Day labels can now arrive via a shared URL, so never inject them as raw HTML
        function escapeHtml(str) {
            return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        function getElapsedSeconds() {
            if (!timerStartTime) return 0;
            return Math.max(0, Math.floor((Date.now() - timerStartTime) / 1000));
        }

        function updateLoggedDisplays() {
            const isLiveEnabled = liveIncrementToggle ? liveIncrementToggle.checked : true;
            let elapsed = 0;

            if (isLiveEnabled && timerStartTime) {
                if (timerCompleted) {
                    elapsed = completedElapsedSec;
                } else {
                    elapsed = getElapsedSeconds();
                }
            }

            const currentTodaySec = baseTodaySec + elapsed;
            const currentTotalSec = baseTotalTrackedSec + elapsed;

            dispTodayLogged.textContent = formatHms(currentTodaySec);
            dispTotalTracked.textContent = formatHms(currentTotalSec);

            const remSec = Math.max(0, TARGET_DAILY_SEC - currentTodaySec);
            dispRemaining.textContent = formatHms(remSec);

            const today = detectedDays[selectedDayIndex] || { label: 'Active Day' };
            const isRunningLive = isLiveEnabled && countdownInterval !== null;
            dispTodayLabel.textContent = `${today.label} Active Column${isRunningLive ? ' • Live' : ''}`;
        }

        function initLiveIncrementToggle() {
            if (!liveIncrementToggle) return;
            const saved = localStorage.getItem(STORAGE_KEY_LIVE_INCREMENT);
            if (saved !== null) {
                liveIncrementToggle.checked = saved === 'true';
            } else {
                liveIncrementToggle.checked = true;
            }

            liveIncrementToggle.addEventListener('change', () => {
                localStorage.setItem(STORAGE_KEY_LIVE_INCREMENT, liveIncrementToggle.checked);
                updateLoggedDisplays();
            });
        }

        // options.restore = { startTime, target, alarmDismissed } when hydrating from localStorage
        function renderAll(options = {}) {
            const restore = options.restore || null;
            dashboard.classList.remove('hidden');

            const today = detectedDays[selectedDayIndex] || { label: 'Active Day', h: 0, m: 0, s: 0, sec: 0 };
            baseTodaySec = today.sec;
            baseTotalTrackedSec = totalTrackedSec;
            timerCompleted = false;
            completedElapsedSec = 0;

            if (restore) {
                // Keep the original baseline so live increment + countdown continue seamlessly after refresh
                timerStartTime = restore.startTime;
                targetTimestamp = new Date(restore.target.getTime());
            } else {
                timerStartTime = Date.now();
                const remSec = Math.max(0, TARGET_DAILY_SEC - today.sec);
                targetTimestamp = new Date(timerStartTime + remSec * 1000);
            }
            updateStopTimeDisplay();

            // Table Render
            weeklyTableBody.innerHTML = '';
            let runningCumulative = 0;

            detectedDays.forEach((day, idx) => {
                runningCumulative += day.sec;
                const deltaSec = day.sec - TARGET_DAILY_SEC;

                let deltaStr = "Upcoming";
                let deltaColor = "text-slate-500";
                let statusBadge = `<span class="text-slate-500">Pending</span>`;

                if (day.sec > 0) {
                    const absDelta = Math.abs(deltaSec);
                    const dh = Math.floor(absDelta / 3600);
                    const dm = Math.floor((absDelta % 3600) / 60);
                    const ds = absDelta % 60;
                    const sign = deltaSec >= 0 ? '+' : '-';
                    deltaStr = `${sign}${dh}h ${dm}m ${ds}s`;
                    deltaColor = deltaSec >= 0 ? 'text-emerald-400' : 'text-amber-400';
                    statusBadge = `<span class="text-emerald-400 font-semibold">✔ Logged</span>`;
                }

                const isCurrent = idx === selectedDayIndex;
                const tr = document.createElement('tr');
                tr.className = `${isCurrent ? 'bg-emerald-950/30 border-l-2 border-emerald-400' : 'hover:bg-slate-900/60'} transition cursor-pointer`;
                tr.onclick = () => {
                    selectedDayIndex = idx;
                    renderAll();
                };

                const cumH = Math.floor(runningCumulative / 3600);
                const cumM = Math.floor((runningCumulative % 3600) / 60);
                const cumS = runningCumulative % 60;

                tr.innerHTML = `
            <td class="py-3 px-3 font-bold ${isCurrent ? 'text-emerald-300' : 'text-white'}">
                ${isCurrent ? '● ' : ''}${escapeHtml(day.label)}
            </td>
            <td class="py-3 px-3 text-slate-200">${day.h}h ${String(day.m).padStart(2, '0')}m ${String(day.s).padStart(2, '0')}s</td>
            <td class="py-3 px-3 ${deltaColor} font-semibold">${deltaStr}</td>
            <td class="py-3 px-3 text-slate-300">${cumH}h ${String(cumM).padStart(2, '0')}m ${String(cumS).padStart(2, '0')}s</td>
            <td class="py-3 px-3 text-right">${statusBadge}</td>
            `;
                weeklyTableBody.appendChild(tr);
            });

            updateLoggedDisplays();

            // Re-arm for the new target. Uses silenceAlarm() rather than stopAlarm(): the old code called
            // stopAlarm() here, which set alarmDismissed = true and prevented the alarm from ever firing.
            silenceAlarm();
            alarmDismissed = restore ? !!restore.alarmDismissed : false;

            if (restore) {
                updateSessionMeta('restored');
            } else {
                debouncedSaveSession();
            }

            updateSyncUrl();
            startCountdown();
        }

        function formatClock(date) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        function updateStopTimeDisplay() {
            dispStopTime.textContent = targetTimestamp ? formatClock(targetTimestamp) : '--';
        }

        function clearCountdownTimers() {
            if (countdownInterval) clearInterval(countdownInterval);
            countdownInterval = null;
            if (deadlineTimeout) clearTimeout(deadlineTimeout);
            deadlineTimeout = null;
            if (periodicSyncInterval) clearInterval(periodicSyncInterval);
            periodicSyncInterval = null;
        }

        function tickCountdown() {
            if (!targetTimestamp) return;
            const diffMs = targetTimestamp - Date.now();

            if (diffMs <= 0) {
                countdown.textContent = "00:00:00";
                countdown.classList.remove('text-white');
                countdown.classList.add('text-emerald-400');
                clearCountdownTimers();
                timerCompleted = true;
                // Freeze at the moment the target was hit (not "now") so throttled background ticks
                // or a late page reload don't over-count logged time.
                completedElapsedSec = timerStartTime
                    ? Math.max(0, Math.round((targetTimestamp - timerStartTime) / 1000))
                    : 0;
                updateLoggedDisplays();
                debouncedSaveSession();
                if (!alarmDismissed) triggerAlarm();
                return;
            }

            const sec = Math.floor(diffMs / 1000);
            const h = String(Math.floor(sec / 3600)).padStart(2, '0');
            const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
            const s = String(sec % 60).padStart(2, '0');
            countdown.textContent = `${h}:${m}:${s}`;

            updateLoggedDisplays();
        }

        function startCountdown() {
            clearCountdownTimers();
            if (!targetTimestamp) return;
            countdown.classList.remove('text-emerald-400');
            countdown.classList.add('text-white');

            countdownInterval = setInterval(tickCountdown, 1000);
            // One-shot deadline timer: background tabs throttle repeating intervals (down to ~1/min),
            // while a single non-chained timeout is much more likely to fire on time.
            const remainingMs = targetTimestamp - Date.now();
            if (remainingMs > 0) deadlineTimeout = setTimeout(tickCountdown, remainingMs + 50);

            // Periodic cloud sync every 60s while timer runs
            periodicSyncInterval = setInterval(() => {
                if (targetTimestamp && countdownInterval) {
                    debouncedSaveSession();
                }
            }, 60000);

            tickCountdown();
        }

        // Catch up immediately when the tab becomes visible again
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && countdownInterval) tickCountdown();
        });

        async function triggerAlarm() {
            if (alarmActive) return;
            alarmActive = true;
            alarmBanner.classList.remove('hidden');
            try { dismissBtn.focus({ preventScroll: true }); } catch (e) { }
            startTitleFlash();
            showAlarmNotification();

            const ctx = getAudioContext();
            if (ctx && ctx.state === 'suspended') {
                try { await ctx.resume(); } catch (e) { /* locked until next gesture; notification still fires */ }
            }
            if (!alarmActive) return; // dismissed while awaiting resume

            playBeep();
            if (alarmInterval) clearInterval(alarmInterval);
            alarmInterval = setInterval(playBeep, 2000);
        }

        // Internal: silence everything without marking the alarm as user-acknowledged
        function silenceAlarm() {
            alarmActive = false;
            alarmBanner.classList.add('hidden');
            if (alarmInterval) {
                clearInterval(alarmInterval);
                alarmInterval = null;
            }
            stopTitleFlash();
            if (alarmNotification) {
                try { alarmNotification.close(); } catch (e) { }
                alarmNotification = null;
            }
        }

        // User dismissal (button, banner click, Esc). No-op when nothing is ringing, so a stray Esc
        // before 00:00:00 can't suppress the upcoming alarm.
        function stopAlarm() {
            if (!alarmActive) return;
            alarmDismissed = true;
            silenceAlarm();
            if (targetTimestamp) {
                try { writeJSON(SESSION_KEYS.alarmAck, targetTimestamp.toISOString()); } catch (e) { }
            }
        }

        function startTitleFlash() {
            stopTitleFlash();
            let on = true;
            document.title = ALARM_TITLE;
            titleFlashInterval = setInterval(() => {
                on = !on;
                document.title = on ? ALARM_TITLE : BASE_TITLE;
            }, 1000);
        }

        function stopTitleFlash() {
            if (titleFlashInterval) clearInterval(titleFlashInterval);
            titleFlashInterval = null;
            document.title = BASE_TITLE;
        }

        // Offset Buttons
        function adjustRemaining(seconds) {
            if (!targetTimestamp) return;
            targetTimestamp = new Date(targetTimestamp.getTime() + seconds * 1000);
            updateStopTimeDisplay();
            if (timerCompleted && (targetTimestamp - new Date()) > 0) {
                // Pushed the target back into the future: silence and re-arm
                silenceAlarm();
                alarmDismissed = false;
                timerCompleted = false;
                startCountdown();
            } else if (countdownInterval) {
                startCountdown(); // reschedule the precise deadline timer
            }
            if (detectedDays.length) debouncedSaveSession();
            updateSyncUrl();
        }

        document.getElementById('adjustMinus5').addEventListener('click', () => adjustRemaining(-300));
        document.getElementById('adjustMinus1').addEventListener('click', () => adjustRemaining(-60));
        document.getElementById('adjustPlus1').addEventListener('click', () => adjustRemaining(60));
        document.getElementById('adjustPlus5').addEventListener('click', () => adjustRemaining(300));

        // Clicking anywhere on the banner (including the Dismiss button, via bubbling) silences the alarm
        alarmBanner.addEventListener('click', stopAlarm);
        window.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopAlarm(); });

        document.getElementById('resetBtn').addEventListener('click', () => {
            silenceAlarm();
            clearCountdownTimers();
            timerStartTime = null;
            timerCompleted = false;
            completedElapsedSec = 0;
            countdown.textContent = "00:00:00";
            countdown.classList.remove('text-emerald-400');
            countdown.classList.add('text-white');
            updateLoggedDisplays();
            debouncedSaveSession();
        });

        document.getElementById('clearSessionBtn').addEventListener('click', () => {
            if (!confirm('Clear the saved timesheet session? You will need to paste a new screenshot.')) return;
            clearSession();
            try {
                const pin = getUserPin();
                if (pin) {
                    fetch('/api/snip8-session', {
                        method: 'DELETE',
                        headers: { 'x-user-pin': pin }
                    }).catch(() => {});
                }
            } catch (e) { }
            updateNeonBadge('ready', 'Neon Ready');
            if (aiValidationNotice) aiValidationNotice.classList.add('hidden');
            silenceAlarm();
            clearCountdownTimers();
            detectedDays = [];
            selectedDayIndex = 0;
            totalTrackedSec = 0;
            targetTimestamp = null;
            timerStartTime = null;
            timerCompleted = false;
            completedElapsedSec = 0;
            baseTodaySec = 0;
            baseTotalTrackedSec = 0;
            alarmDismissed = false;
            weeklyTableBody.innerHTML = '';
            countdown.textContent = "00:00:00";
            countdown.classList.remove('text-emerald-400');
            countdown.classList.add('text-white');
            updateStopTimeDisplay();
            fileInput.value = '';
            rawOcrText.textContent = '(No image scanned yet)';
            dashboard.classList.add('hidden');
            updateSessionMeta('cleared');
            updateParseSourceBadge('reset');
            window.lastUploadedTimesheet = null;
            window.lastUploadedTimesheetBase64 = null;
            clearSyncUrl();
            closeSyncModal();
        });

        document.getElementById('manBtn').addEventListener('click', () => {
            requestNotificationPermission();
            const h = parseInt(document.getElementById('manH').value || 0, 10);
            const m = parseInt(document.getElementById('manM').value || 0, 10);
            const s = parseInt(document.getElementById('manS').value || 0, 10);
            if (detectedDays.length === 0) {
                detectedDays = [{ label: 'Today', h, m, s, sec: h * 3600 + m * 60 + s }];
                selectedDayIndex = 0;
            } else if (detectedDays[selectedDayIndex]) {
                detectedDays[selectedDayIndex].h = h;
                detectedDays[selectedDayIndex].m = m;
                detectedDays[selectedDayIndex].s = s;
                detectedDays[selectedDayIndex].sec = h * 3600 + m * 60 + s;
            }
            totalTrackedSec = detectedDays.reduce((acc, d) => acc + d.sec, 0);
            renderAll();
            debouncedSaveSession();
        });

        // Wire up manual override action: ✨ Re-parse with Gemini AI
        if (forceAiBtn) {
            forceAiBtn.addEventListener('click', async () => {
                const targetImage = window.lastUploadedTimesheet;
                const targetB64 = window.lastUploadedTimesheetBase64;
                if (!targetImage && !targetB64) {
                    alert('Please paste or upload a timesheet screenshot first before requesting Gemini AI parsing.');
                    return;
                }

                const originalBtnHtml = forceAiBtn.innerHTML;
                forceAiBtn.disabled = true;
                forceAiBtn.innerHTML = `<span>⏳ Validating with Gemini AI...</span>`;
                updateParseSourceBadge('parsing');

                try {
                    let b64 = null;
                    if (typeof targetImage === 'string' && targetImage.startsWith('data:')) {
                        b64 = targetImage;
                    } else if (targetImage instanceof Blob || targetImage instanceof File) {
                        b64 = await Snip8Validation.toBase64(targetImage);
                    } else if (targetB64) {
                        b64 = targetB64;
                    }

                    if (!b64) {
                        throw new Error('Could not convert uploaded screenshot to base64.');
                    }

                    const handled = await triggerAiValidationFallback(b64, 'Manual override via "Re-parse with Gemini AI" button');
                    if (handled) {
                        await saveToNeon();
                    } else {
                        alert('Gemini AI validation could not process the timesheet. Check your network connection or API key.');
                        updateParseSourceBadge('ocr');
                    }
                } catch (err) {
                    console.error('snip8: forceAiBtn error', err);
                    alert('Gemini AI re-scan failed: ' + (err.message || err));
                    updateParseSourceBadge('ocr');
                } finally {
                    forceAiBtn.disabled = false;
                    forceAiBtn.innerHTML = originalBtnHtml;
                }
            });
        }

        // ===== Neon Database Persistence & Local Storage =====
        function updateNeonBadge(state, label) {
            if (!neonSyncBadge || !neonSyncDot || !neonSyncLabel) return;
            neonSyncLabel.textContent = label;
            if (state === 'synced') {
                neonSyncDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
                neonSyncBadge.className = 'text-xs font-mono px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-emerald-400 flex items-center gap-1.5';
            } else if (state === 'syncing') {
                neonSyncDot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
                neonSyncBadge.className = 'text-xs font-mono px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-amber-400 flex items-center gap-1.5';
            } else if (state === 'offline') {
                neonSyncDot.className = 'w-2 h-2 rounded-full bg-slate-500';
                neonSyncBadge.className = 'text-xs font-mono px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-slate-400 flex items-center gap-1.5';
            } else {
                neonSyncDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
                neonSyncBadge.className = 'text-xs font-mono px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-slate-300 flex items-center gap-1.5';
            }
        }

        function debouncedSaveSession() {
            // Instant local persistence for offline reliability
            saveSession();

            // Debounced Neon write (1.5s) to preserve connection pool
            if (neonSaveTimeout) clearTimeout(neonSaveTimeout);
            neonSaveTimeout = setTimeout(() => {
                saveToNeon();
            }, 1500);
        }

        async function saveToNeon() {
            if (detectedDays.length === 0 && !targetTimestamp) return;
            const pin = getUserPin();
            if (!pin) {
                updateNeonBadge('ready', 'Enter PIN');
                openPinModal();
                return;
            }

            try {
                const isLiveEnabled = liveIncrementToggle ? liveIncrementToggle.checked : true;
                let elapsed = 0;
                if (isLiveEnabled && timerStartTime) {
                    elapsed = timerCompleted ? completedElapsedSec : getElapsedSeconds();
                }

                const currentTodaySec = baseTodaySec + elapsed;
                const remSec = Math.max(0, TARGET_DAILY_SEC - currentTodaySec);

                const payload = {
                    user_pin: pin,
                    total_seconds_remaining: remSec,
                    daily_cap_seconds: TARGET_DAILY_SEC,
                    logged_seconds: currentTodaySec,
                    timesheet_data: detectedDays,
                    last_scanned_image_url: null
                };

                updateNeonBadge('syncing', 'Saving...');

                const res = await fetch('/api/snip8-session', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-user-pin': pin
                    },
                    body: JSON.stringify(payload)
                });

                if (res.status === 401) {
                    clearUserPin();
                    updateNeonBadge('offline', 'PIN Required');
                    openPinModal();
                    return;
                }

                if (res.ok) {
                    updateNeonBadge('synced', 'Neon Synced');
                    updateSessionMeta('neon_saved');
                } else {
                    throw new Error(`HTTP ${res.status}`);
                }
            } catch (err) {
                console.warn('snip8: Neon save error:', err.message);
                updateNeonBadge('offline', 'Saved Locally');
            }
        }

        async function fetchNeonSession() {
            const pin = getUserPin();
            if (!pin) {
                updateNeonBadge('ready', 'Enter PIN');
                return false;
            }

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);

                const res = await fetch('/api/snip8-session', {
                    signal: controller.signal,
                    headers: {
                        'x-user-pin': pin
                    }
                });
                clearTimeout(timeoutId);

                if (res.status === 401) {
                    clearUserPin();
                    updateNeonBadge('offline', 'PIN Required');
                    openPinModal();
                    return false;
                }

                if (!res.ok) return false;
                const data = await res.json();
                if (!data.success || !data.session) return false;

                const session = data.session;
                let days = session.timesheet_data;
                if (typeof days === 'string') {
                    try { days = JSON.parse(days); } catch (e) { days = []; }
                }

                // If this is a fresh daily session without scanned days yet
                if (!Array.isArray(days) || days.length === 0) {
                    updateNeonBadge('synced', 'Neon Ready (Today)');
                    return false;
                }

                const cleanDays = days.map((d, i) => {
                    const h = Number(d && d.h) || 0;
                    const m = Number(d && d.m) || 0;
                    const s = Number(d && d.s) || 0;
                    return {
                        label: String((d && d.label) || `Day ${i + 1}`),
                        dayName: String((d && d.dayName) || ''),
                        h, m, s,
                        sec: h * 3600 + m * 60 + s,
                        shifts: d.shifts || []
                    };
                });

                const updatedAt = new Date(session.updated_at || Date.now());
                const now = new Date();
                const dailyCap = Number(session.daily_cap_seconds) || TARGET_DAILY_SEC;
                const logged = Number(session.logged_seconds) || 0;
                const remainingSec = session.total_seconds_remaining !== undefined
                    ? Number(session.total_seconds_remaining)
                    : Math.max(0, dailyCap - logged);

                // Check calendar window
                if (!isWithinTodayWindow(updatedAt, now)) {
                    return false;
                }

                detectedDays = cleanDays;
                selectedDayIndex = 0;
                totalTrackedSec = logged > 0 ? logged : cleanDays.reduce((acc, d) => acc + d.sec, 0);

                const target = new Date(Date.now() + remainingSec * 1000);

                renderAll({
                    restore: {
                        startTime: updatedAt.getTime(),
                        target,
                        alarmDismissed: remainingSec <= 0
                    }
                });

                // Update local storage cache
                saveSession();

                updateSessionMeta('neon');
                updateNeonBadge('synced', 'Neon Synced');
                rawOcrText.textContent = `(Session restored from Neon PostgreSQL for today • PIN ${maskPin(pin)} • last updated ${formatClock(updatedAt)}.)`;
                return true;
            } catch (err) {
                console.warn('snip8: could not fetch session from Neon:', err);
                return false;
            }
        }

        // ===== Session Persistence (localStorage) =====
        function writeJSON(key, value) {
            localStorage.setItem(key, JSON.stringify(value));
        }

        function readJSON(key) {
            const raw = localStorage.getItem(key);
            return raw === null ? null : JSON.parse(raw);
        }

        function saveSession() {
            try {
                writeJSON(SESSION_KEYS.detectedDays, detectedDays);
                writeJSON(SESSION_KEYS.selectedDayIndex, selectedDayIndex);
                writeJSON(SESSION_KEYS.targetTimestamp, targetTimestamp ? targetTimestamp.toISOString() : null);
                // lastUpdated doubles as the live-increment baseline (when the screenshot/entry was processed)
                writeJSON(SESSION_KEYS.lastUpdated, new Date(timerStartTime || Date.now()).toISOString());
                writeJSON(SESSION_KEYS.totalTrackedSec, totalTrackedSec);
                return true;
            } catch (e) {
                console.warn('snip8: could not save session', e);
                return false;
            }
        }

        function loadSession() {
            try {
                const days = readJSON(SESSION_KEYS.detectedDays);
                if (!Array.isArray(days) || days.length === 0) return null;

                const cleanDays = days.map((d, i) => {
                    const h = Number(d && d.h) || 0;
                    const m = Number(d && d.m) || 0;
                    const s = Number(d && d.s) || 0;
                    return {
                        label: String((d && d.label) || `Day ${i + 1}`),
                        dayName: String((d && d.dayName) || ''),
                        h, m, s,
                        sec: h * 3600 + m * 60 + s
                    };
                });

                const targetRaw = readJSON(SESSION_KEYS.targetTimestamp);
                const updatedRaw = readJSON(SESSION_KEYS.lastUpdated);
                if (!targetRaw || !updatedRaw) return null;
                const target = new Date(targetRaw);
                const lastUpdated = new Date(updatedRaw);
                if (isNaN(target.getTime()) || isNaN(lastUpdated.getTime())) return null;

                let idx = parseInt(readJSON(SESSION_KEYS.selectedDayIndex), 10);
                if (!Number.isInteger(idx) || idx < 0 || idx >= cleanDays.length) idx = 0;

                let total = Number(readJSON(SESSION_KEYS.totalTrackedSec));
                if (!Number.isFinite(total) || total < 0) total = cleanDays.reduce((acc, d) => acc + d.sec, 0);

                return {
                    detectedDays: cleanDays,
                    selectedDayIndex: idx,
                    targetTimestamp: target,
                    lastUpdated,
                    totalTrackedSec: total,
                    alarmAckTarget: readJSON(SESSION_KEYS.alarmAck)
                };
            } catch (e) {
                console.warn('snip8: could not load session', e);
                return null;
            }
        }

        function clearSession() {
            try {
                Object.values(SESSION_KEYS).forEach(k => localStorage.removeItem(k));
            } catch (e) { /* storage unavailable */ }
        }

        // Same calendar day, or still upcoming (covers shifts that cross midnight)
        function isWithinTodayWindow(target, now = new Date()) {
            return target.toDateString() === now.toDateString() || target.getTime() > now.getTime();
        }

        function updateSessionMeta(state) {
            if (!sessionMeta) return;
            if (state === 'cleared') { sessionMeta.textContent = 'No saved session'; return; }
            if (state === 'error') { sessionMeta.textContent = '⚠ Session not saved (storage unavailable)'; return; }
            const when = timerStartTime ? formatClock(new Date(timerStartTime)) : '--';
            if (state === 'synced') { sessionMeta.textContent = `📱 Synced from link • saved on this device`; return; }
            if (state === 'neon') { sessionMeta.textContent = `☁ Restored from Neon DB • active session`; return; }
            if (state === 'neon_saved') { sessionMeta.textContent = `☁ Saved to Neon DB • last updated ${when}`; return; }
            sessionMeta.textContent = state === 'restored'
                ? `↻ Restored session • last updated ${when}`
                : `💾 Session saved • last updated ${when}`;
        }

        function hydrateSession() {
            const session = loadSession();
            if (!session) return false;

            const now = new Date();
            if (!isWithinTodayWindow(session.targetTimestamp, now)) {
                clearSession(); // stale (previous day) — start fresh
                return false;
            }

            detectedDays = session.detectedDays;
            selectedDayIndex = session.selectedDayIndex;
            totalTrackedSec = session.totalTrackedSec;

            const expiredMs = now - session.targetTimestamp;
            const acknowledged = session.alarmAckTarget === session.targetTimestamp.toISOString();

            renderAll({
                restore: {
                    startTime: session.lastUpdated.getTime(),
                    target: session.targetTimestamp,
                    alarmDismissed: acknowledged || expiredMs > ALARM_RESTORE_GRACE_MS
                }
            });
            rawOcrText.textContent = `(Session restored from ${session.lastUpdated.toLocaleString()} — paste a new screenshot to rescan.)`;
            return true;
        }

        // ===== Cross-Device Sync (URL params + QR, no backend) =====
        // Link format: ?sync=<target epoch ms>&logged=<selected day logged sec>&label=<day label>
        function getBaseUrl() {
            return window.location.href.split(/[?#]/)[0];
        }

        function buildSyncUrl() {
            if (!targetTimestamp) return null;
            const today = detectedDays[selectedDayIndex];
            const params = new URLSearchParams();
            params.set('sync', String(targetTimestamp.getTime()));
            params.set('logged', String(Math.max(0, Math.round(baseTodaySec))));
            params.set('label', today ? today.label : 'Today');
            return `${getBaseUrl()}?${params.toString()}`;
        }

        // replaceState (not pushState) so adjustments don't flood the back-button history
        function updateSyncUrl() {
            const url = buildSyncUrl();
            if (!url) return;
            try { history.replaceState(null, '', url); } catch (e) { /* e.g. sandboxed iframe */ }
            if (syncModal && syncModal.open) renderSyncModal();
        }

        function clearSyncUrl() {
            if (!window.location.search) return;
            try { history.replaceState(null, '', getBaseUrl()); } catch (e) { }
        }

        function parseSyncParams() {
            const params = new URLSearchParams(window.location.search);
            if (!params.has('sync')) return null;
            const targetMs = Number(params.get('sync'));
            if (!Number.isFinite(targetMs) || targetMs <= 0) return null;
            const target = new Date(targetMs);
            if (isNaN(target.getTime())) return null;
            const loggedRaw = Number(params.get('logged'));
            const loggedSec = Number.isFinite(loggedRaw) ? Math.min(Math.max(0, Math.floor(loggedRaw)), 24 * 3600) : 0;
            const label = (params.get('label') || '').trim().slice(0, 40) || 'Today';
            return { target, loggedSec, label };
        }

        // Hydrate from a sync link (e.g. phone scanning the desktop QR). Returns true if handled.
        function hydrateFromSyncLink() {
            const sync = parseSyncParams();
            if (!sync) return false;

            const now = new Date();
            if (!isWithinTodayWindow(sync.target, now)) {
                clearSyncUrl(); // stale link from a previous day
                return false;
            }

            // Same device reloading its own URL (or a phone refreshing after a sync/adjust):
            // prefer the richer local session (full week table, exact live baseline).
            const local = loadSession();
            if (local && local.targetTimestamp.getTime() === sync.target.getTime()) return false;

            const h = Math.floor(sync.loggedSec / 3600);
            const m = Math.floor((sync.loggedSec % 3600) / 60);
            const s = sync.loggedSec % 60;
            detectedDays = [{ label: sync.label, dayName: '', h, m, s, sec: sync.loggedSec }];
            selectedDayIndex = 0;
            totalTrackedSec = sync.loggedSec;

            // Reconstruct the live-increment baseline so logged time reaches 8h exactly at the target
            const remainingAtStartMs = Math.max(0, TARGET_DAILY_SEC - sync.loggedSec) * 1000;
            const startTime = Math.min(now.getTime(), sync.target.getTime() - remainingAtStartMs);

            let ack = null;
            try { ack = readJSON(SESSION_KEYS.alarmAck); } catch (e) { }
            const expiredMs = now - sync.target;

            renderAll({
                restore: {
                    startTime,
                    target: sync.target,
                    alarmDismissed: ack === sync.target.toISOString() || expiredMs > ALARM_RESTORE_GRACE_MS
                }
            });

            // Persist on this device so a plain refresh (or reopening without the link) keeps the countdown
            updateSessionMeta(saveSession() ? 'synced' : 'error');
            rawOcrText.textContent = `(Countdown synced via link for "${sync.label}" — stop at ${formatClock(sync.target)}.)`;
            return true;
        }

        function isLocalOnlyUrl() {
            const host = window.location.hostname;
            return window.location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '';
        }

        function renderSyncModal() {
            const url = buildSyncUrl();
            if (!url) return;
            const today = detectedDays[selectedDayIndex] || { label: 'Today' };
            syncModalSummary.textContent = `${today.label} • stop at ${formatClock(targetTimestamp)}`;
            syncLinkInput.value = url;
            syncLocalWarning.classList.toggle('hidden', !isLocalOnlyUrl());

            const showFallback = (show) => {
                syncQrCanvas.classList.toggle('hidden', show);
                syncQrFallback.classList.toggle('hidden', !show);
            };

            if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
                window.QRCode.toCanvas(syncQrCanvas, url, {
                    width: 224,
                    margin: 1,
                    errorCorrectionLevel: 'M',
                    color: { dark: '#020617', light: '#ffffff' }
                }, (err) => {
                    if (err) console.warn('snip8: QR render failed', err);
                    showFallback(!!err);
                });
            } else {
                showFallback(true);
            }
        }

        function openSyncModal() {
            if (!targetTimestamp) {
                alert('Start a countdown first (paste a screenshot or use manual entry), then sync.');
                return;
            }
            updateSyncUrl();
            renderSyncModal();
            if (typeof syncModal.showModal === 'function') {
                if (!syncModal.open) syncModal.showModal();
            } else {
                syncModal.setAttribute('open', '');
            }
        }

        function closeSyncModal() {
            if (!syncModal || !syncModal.open) return;
            if (typeof syncModal.close === 'function') syncModal.close();
            else syncModal.removeAttribute('open');
        }

        let copyFeedbackTimeout = null;
        async function copySyncLink() {
            const url = syncLinkInput.value;
            if (!url) return;
            let ok = false;
            try {
                await navigator.clipboard.writeText(url);
                ok = true;
            } catch (e) {
                // Fallback for non-secure contexts (http://, file://) where the async Clipboard API is unavailable
                try {
                    syncLinkInput.focus();
                    syncLinkInput.select();
                    ok = document.execCommand('copy');
                } catch (e2) { ok = false; }
            }
            copySyncLinkBtn.textContent = ok ? '✔ Copied!' : 'Press Ctrl+C';
            copySyncLinkBtn.classList.toggle('bg-emerald-500', ok);
            if (!ok) syncLinkInput.select();
            if (copyFeedbackTimeout) clearTimeout(copyFeedbackTimeout);
            copyFeedbackTimeout = setTimeout(() => {
                copySyncLinkBtn.textContent = 'Copy Sync Link';
                copySyncLinkBtn.classList.remove('bg-emerald-500');
            }, 1800);
        }

        syncMobileBtn.addEventListener('click', openSyncModal);
        syncModalClose.addEventListener('click', closeSyncModal);
        copySyncLinkBtn.addEventListener('click', copySyncLink);
        syncLinkInput.addEventListener('focus', () => syncLinkInput.select());
        // Click on the backdrop (outside the inner card) closes the modal; Esc is handled natively by <dialog>
        syncModal.addEventListener('click', (e) => { if (e.target === syncModal) closeSyncModal(); });

        // PIN Dialog Handlers
        if (pinForm) {
            pinForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const enteredPin = (pinInput ? pinInput.value : '').trim();
                if (!/^\d{4,8}$/.test(enteredPin)) {
                    if (pinErrorMsg) pinErrorMsg.classList.remove('hidden');
                    return;
                }
                if (pinErrorMsg) pinErrorMsg.classList.add('hidden');
                try {
                    localStorage.setItem(STORAGE_KEY_PIN, enteredPin);
                } catch (err) { }
                updatePinUI();
                closePinModal();

                updateNeonBadge('syncing', 'Connecting...');
                const restored = await fetchNeonSession();
                if (!restored) {
                    const restoredLocal = hydrateSession();
                    if (!restoredLocal) {
                        updateNeonBadge('ready', 'Neon Ready');
                    }
                }
            });
        }

        if (switchPinBtn) {
            switchPinBtn.addEventListener('click', () => {
                clearUserPin();
                openPinModal();
            });
        }

        if (pinModal) {
            pinModal.addEventListener('click', (e) => { if (e.target === pinModal) closePinModal(); });
        }

        // Initialize user preferences, theme, then restore from Neon DB with localStorage fallback
        async function init() {
            Snip8Theme.init();
            initLiveIncrementToggle();
            updatePinUI();

            // 1. If explicit sync link was opened, hydrate from it
            if (hydrateFromSyncLink()) {
                debouncedSaveSession();
                return;
            }

            // 2. Check for PIN
            const userPin = getUserPin();
            if (!userPin) {
                openPinModal();
                updateNeonBadge('ready', 'Enter PIN');
                hydrateSession();
                return;
            }

            // 3. Query Neon backend for latest saved session for this PIN
            updateNeonBadge('syncing', 'Connecting...');
            const restoredFromNeon = await fetchNeonSession();

            // 4. Fallback to localStorage if Neon was unreachable or empty
            if (!restoredFromNeon) {
                const restoredFromLocal = hydrateSession();
                if (restoredFromLocal) {
                    updateNeonBadge('offline', 'Local Session');
                } else {
                    updateNeonBadge('ready', 'Neon Ready');
                }
            }
        }

        if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
