        const TARGET_DAILY_SEC = 8 * 3600;
        let countdownInterval = null;
        let alarmInterval = null;
        let targetTimestamp = null;
        let alarmDismissed = false;

        // Dynamic days model (populated directly via OCR)
        let detectedDays = [];
        let selectedDayIndex = 0;
        let totalTrackedSec = 0;

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

        // Web Audio Chime (Triple Bell Pattern)
        function playBeep() {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                const ctx = new AudioContext();

                const notes = [587.33, 739.99, 880]; // D5, F#5, A5
                notes.forEach((freq, idx) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();

                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.15);

                    gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.15);
                    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + idx * 0.15 + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.15 + 0.35);

                    osc.connect(gain);
                    gain.connect(ctx.destination);

                    osc.start(ctx.currentTime + idx * 0.15);
                    osc.stop(ctx.currentTime + idx * 0.15 + 0.4);
                });
            } catch (e) {
                console.error("Audio error", e);
            }
        }

        document.getElementById('testAudioBtn').addEventListener('click', playBeep);

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
            statusContainer.classList.remove('hidden');
            statusContainer.textContent = "Enhancing contrast and running OCR on timesheet...";

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

            try {
                const result = await Tesseract.recognize(canvas, 'eng');
                statusContainer.classList.add('hidden');
                rawOcrText.textContent = result.data.text || "(No readable text detected)";
                parseText(result.data.text);
            } catch (err) {
                statusContainer.classList.remove('hidden');
                statusContainer.textContent = "OCR scan failed. Use manual entry below.";
            }
        }

        function parseText(rawText) {
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
            const totalRegex = /Total\s*(?:time|tire|tine)?[\s\S]{0,35}?(\d{1,2})\s*(?:hr|h|br)\s*,?\s*(\d{1,2})\s*(?:min|m)\s*,?\s*(\d{1,2})\s*(?:sec|s)/i;
            const totalMatch = cleaned.match(totalRegex);
            totalTrackedSec = 0;
            if (totalMatch) {
                totalTrackedSec = parseInt(totalMatch[1], 10) * 3600 + parseInt(totalMatch[2], 10) * 60 + parseInt(totalMatch[3], 10);
            }

            // 3. Remove all lines containing "total" so it doesn't get captured in columns
            const lines = cleaned.split('\n').filter(line => !/total/i.test(line)).join('\n');

            // 4. Sanitize timezone markers, time ranges, and lone axis digits/offsets before day durations
            let textForColumns = lines
                .replace(/\bGMT\b/gi, ' ')
                .replace(/\b\d{1,2}\s*(?:AM|PM)\b/gi, ' ') // e.g. 10 AM, 12 AM
                .replace(/(?:^|\s)[+-]?\d{1,2}(?:\s+[a-z])?(?=\s+(?:00|\d{1,2}\s*hr))/gim, ' ')
                .replace(/(?:^|\s)[+-]?\d{1,2}(?=\s+[+-]?\d{1,2}\s+(?:00|\d{1,2}\s*hr))/gim, ' ')
                .replace(/(?:^|\s)[+-]?\d{1,2}(?=\s+(?:00|\d{1,2}\s*hr))/gim, ' ');

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
            const durRegex = /(?:(\d{1,2})\s*(?:hr|h)\s*,?\s*)?(\d{1,2})\s*(?:min|m)\s*,?\s*(\d{1,2})\s*(?:sec|s)/gi;
            const parsedDurations = [];
            let dm;
            while ((dm = durRegex.exec(textForColumns)) !== null) {
                let h = dm[1] !== undefined ? parseInt(dm[1], 10) : 0;
                let m = parseInt(dm[2], 10);
                let s = parseInt(dm[3], 10);

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

            renderAll();
        }

        function renderAll() {
            dashboard.classList.remove('hidden');

            // Top Cards
            const totH = Math.floor(totalTrackedSec / 3600);
            const totM = Math.floor((totalTrackedSec % 3600) / 60);
            const totS = totalTrackedSec % 60;
            dispTotalTracked.textContent = `${totH}h ${totM}m ${totS}s`;

            const today = detectedDays[selectedDayIndex] || { label: 'Active Day', h: 0, m: 0, s: 0, sec: 0 };
            dispTodayLogged.textContent = `${today.h}h ${today.m}m ${today.s}s`;
            dispTodayLabel.textContent = `${today.label} Active Column`;

            const remSec = Math.max(0, TARGET_DAILY_SEC - today.sec);
            const remH = Math.floor(remSec / 3600);
            const remM = Math.floor((remSec % 3600) / 60);
            const remS = remSec % 60;
            dispRemaining.textContent = `${remH}h ${remM}m ${remS}s`;

            const now = new Date();
            targetTimestamp = new Date(now.getTime() + remSec * 1000);
            dispStopTime.textContent = targetTimestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
                ${isCurrent ? '● ' : ''}${day.label}
            </td>
            <td class="py-3 px-3 text-slate-200">${day.h}h ${String(day.m).padStart(2, '0')}m ${String(day.s).padStart(2, '0')}s</td>
            <td class="py-3 px-3 ${deltaColor} font-semibold">${deltaStr}</td>
            <td class="py-3 px-3 text-slate-300">${cumH}h ${String(cumM).padStart(2, '0')}m ${String(cumS).padStart(2, '0')}s</td>
            <td class="py-3 px-3 text-right">${statusBadge}</td>
            `;
                weeklyTableBody.appendChild(tr);
            });

            alarmDismissed = false;
            stopAlarm();
            startCountdown();
        }

        function startCountdown() {
            if (countdownInterval) clearInterval(countdownInterval);

            function tick() {
                const now = new Date();
                const diffMs = targetTimestamp - now;

                if (diffMs <= 0) {
                    countdown.textContent = "00:00:00";
                    countdown.classList.remove('text-white');
                    countdown.classList.add('text-emerald-400');
                    clearInterval(countdownInterval);
                    if (!alarmDismissed) triggerAlarm();
                    return;
                }

                const sec = Math.floor(diffMs / 1000);
                const h = String(Math.floor(sec / 3600)).padStart(2, '0');
                const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
                const s = String(sec % 60).padStart(2, '0');
                countdown.textContent = `${h}:${m}:${s}`;
            }

            tick();
            countdownInterval = setInterval(tick, 1000);
        }

        function triggerAlarm() {
            alarmBanner.classList.remove('hidden');
            playBeep();
            alarmInterval = setInterval(playBeep, 2000);
        }

        function stopAlarm() {
            alarmDismissed = true;
            alarmBanner.classList.add('hidden');
            if (alarmInterval) {
                clearInterval(alarmInterval);
                alarmInterval = null;
            }
        }

        // Offset Buttons
        function adjustRemaining(seconds) {
            if (!targetTimestamp) return;
            targetTimestamp = new Date(targetTimestamp.getTime() + seconds * 1000);
            dispStopTime.textContent = targetTimestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        document.getElementById('adjustMinus5').addEventListener('click', () => adjustRemaining(-300));
        document.getElementById('adjustMinus1').addEventListener('click', () => adjustRemaining(-60));
        document.getElementById('adjustPlus1').addEventListener('click', () => adjustRemaining(60));
        document.getElementById('adjustPlus5').addEventListener('click', () => adjustRemaining(300));

        document.getElementById('dismissBtn').addEventListener('click', stopAlarm);
        document.getElementById('resetBtn').addEventListener('click', () => {
            stopAlarm();
            if (countdownInterval) clearInterval(countdownInterval);
            countdown.textContent = "00:00:00";
        });

        document.getElementById('manBtn').addEventListener('click', () => {
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
        });
