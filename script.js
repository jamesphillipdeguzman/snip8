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
let springboardAutoStopped = false;

// Master application state for sync & AI validation
const state = {
    userPin: (function () {
        try { return (localStorage.getItem('snip8_user_pin') || '').trim(); } catch (e) { return ''; }
    })(),
    workDate: new Date().toLocaleDateString('en-CA'), // 'YYYY-MM-DD' in local time
    loggedSeconds: 0,
    remainingSeconds: TARGET_DAILY_SEC,
    dailyCapSeconds: TARGET_DAILY_SEC,
    timesheetData: [],
    detectedDays: [],
    isAiSyncing: false,
    isTabActive: true,
    isLiveIncrement: true,
    tickerInterval: null,
    lastScannedImageUrl: null,
    get totalLoggedSeconds() {
        return this.loggedSeconds;
    },
    set totalLoggedSeconds(val) {
        this.loggedSeconds = Number(val) || 0;
    }
};
window.state = state;

function extractDayHeaderAndDate(str) {
    if (!str || typeof str !== 'string') return null;
    const trimmed = str.trim();

    // 1. Day of week + date (e.g. "Fri 10/23", "Fri, 10/23", "Friday 10/23", "Thu 10/22")
    const headerMatch = trimmed.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Man)[a-z]*[\s,]+(\d{1,2})[/\\](\d{1,2})(?:[/\\](\d{2,4}))?\b/i);
    if (headerMatch) {
        let dayName = headerMatch[1];
        if (/^man$/i.test(dayName)) dayName = 'Mon';
        const dayAbbr = dayName.charAt(0).toUpperCase() + dayName.slice(1, 3).toLowerCase();
        const m = parseInt(headerMatch[2], 10);
        const d = parseInt(headerMatch[3], 10);
        let y = headerMatch[4] ? parseInt(headerMatch[4], 10) : new Date().getFullYear();
        if (y < 100) y += 2000;
        const workDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayLabel = `${dayAbbr}, ${m}/${d}`;
        return { workDate, dayLabel, dayName: dayAbbr };
    }

    // 2. MM/DD or MM/DD/YYYY without day name (e.g. "10/23", "10/23/2026")
    const dateMatch = trimmed.match(/\b(\d{1,2})[/\\](\d{1,2})(?:[/\\](\d{2,4}))?\b/);
    if (dateMatch) {
        const m = parseInt(dateMatch[1], 10);
        const d = parseInt(dateMatch[2], 10);
        let y = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date().getFullYear();
        if (y < 100) y += 2000;
        const dateObj = new Date(y, m - 1, d);
        const dayAbbr = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
        const workDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayLabel = `${dayAbbr}, ${m}/${d}`;
        return { workDate, dayLabel, dayName: dayAbbr };
    }

    // 3. YYYY-MM-DD
    const isoMatch = trimmed.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoMatch) {
        const y = parseInt(isoMatch[1], 10);
        const m = parseInt(isoMatch[2], 10);
        const d = parseInt(isoMatch[3], 10);
        const dateObj = new Date(y, m - 1, d);
        const dayAbbr = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
        const workDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayLabel = `${dayAbbr}, ${m}/${d}`;
        return { workDate, dayLabel, dayName: dayAbbr };
    }

    return null;
}

function parseDateStringToYyyyMmDd(str) {
    const info = extractDayHeaderAndDate(str);
    return info ? info.workDate : null;
}

function formatDayLabel(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') {
        const now = new Date();
        return now.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
    }
    const clean = dateStr.trim();
    const headerInfo = extractDayHeaderAndDate(clean);
    if (headerInfo) {
        return headerInfo.dayLabel;
    }
    const parts = clean.split('-');
    if (parts.length === 3) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        const dateObj = new Date(y, m - 1, d);
        if (!isNaN(dateObj.getTime())) {
            return dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
        }
    }
    return clean;
}

function hydrateBreakdownFromTimesheetData(timesheetDataRaw, workDate, loggedSeconds) {
    let raw = timesheetDataRaw;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { raw = null; }
    }

    const fallbackLabel = formatDayLabel(workDate);
    const fallbackDayName = fallbackLabel.split(' ')[0].replace(/,/g, '');
    const logged = Math.max(0, Number(loggedSeconds) || 0);
    const loggedH = Math.floor(logged / 3600);
    const loggedM = Math.floor((logged % 3600) / 60);
    const loggedS = logged % 60;

    // 1. If timesheet_data is an object with dayLabel or days/blocks
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const explicitLabel = (raw.dayLabel || formatDayLabel(raw.workDate || workDate)).trim();
        const cleanLabel = explicitLabel || fallbackLabel;
        const dayName = cleanLabel.split(' ')[0].replace(/,/g, '');

        if (Array.isArray(raw.days) && raw.days.length > 0) {
            return raw.days.map((d, i) => {
                let dLabel = (d && d.label) ? String(d.label).trim() : (i === 0 ? cleanLabel : `Day ${i + 1}`);
                if (/^day\s*\d+$/i.test(dLabel) && i === 0) dLabel = cleanLabel;
                const h = Number(d && d.h) || 0;
                const m = Number(d && d.m) || 0;
                const s = Number(d && d.s) || 0;
                let sec = (d && d.sec !== undefined && d.sec !== null) ? Number(d.sec) : (h * 3600 + m * 60 + s);
                if (raw.days.length === 1 && sec === 0 && logged > 0) {
                    sec = logged;
                }
                return {
                    label: dLabel,
                    dayName: String((d && d.dayName) || dayName),
                    h: Math.floor(sec / 3600),
                    m: Math.floor((sec % 3600) / 60),
                    s: sec % 60,
                    sec,
                    shifts: (d && d.shifts) || raw.blocks || [],
                    date: raw.workDate || workDate
                };
            });
        }

        return [{
            label: cleanLabel,
            dayName,
            h: loggedH,
            m: loggedM,
            s: loggedS,
            sec: logged,
            shifts: Array.isArray(raw.blocks) ? raw.blocks : [],
            date: raw.workDate || workDate
        }];
    }

    // 2. If timesheet_data is an array
    if (Array.isArray(raw) && raw.length > 0) {
        // Check if items are shifts (have start/end/duration) rather than day objects
        const isShiftArray = raw.every(item => item && (item.start !== undefined || item.duration !== undefined) && item.sec === undefined && item.h === undefined);
        if (isShiftArray) {
            return [{
                label: fallbackLabel,
                dayName: fallbackDayName,
                h: loggedH,
                m: loggedM,
                s: loggedS,
                sec: logged,
                shifts: raw,
                date: workDate
            }];
        }

        return raw.map((d, i) => {
            let dLabel = (d && d.label) ? String(d.label).trim() : (i === 0 ? fallbackLabel : `Day ${i + 1}`);
            if (/^day\s*\d+$/i.test(dLabel) && i === 0) dLabel = fallbackLabel;
            const h = Number(d && d.h) || 0;
            const m = Number(d && d.m) || 0;
            const s = Number(d && d.s) || 0;
            let sec = (d && d.sec !== undefined && d.sec !== null) ? Number(d.sec) : (h * 3600 + m * 60 + s);
            if (raw.length === 1 && sec === 0 && logged > 0) {
                sec = logged;
            }
            return {
                label: dLabel,
                dayName: String((d && d.dayName) || fallbackDayName),
                h: Math.floor(sec / 3600),
                m: Math.floor((sec % 3600) / 60),
                s: sec % 60,
                sec,
                shifts: (d && d.shifts) || [],
                date: (d && d.date) || workDate
            };
        });
    }

    // 3. Fallback when timesheet_data is empty
    return [{
        label: fallbackLabel,
        dayName: fallbackDayName,
        h: loggedH,
        m: loggedM,
        s: loggedS,
        sec: logged,
        shifts: [],
        date: workDate
    }];
}

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

// Validation Progress Controller
function setValidationProgress(percent, message, state = 'running') {
    const container = document.getElementById('validationProgressContainer');
    const bar = document.getElementById('validationProgressBar');
    const text = document.getElementById('validationStatusText');
    const percentText = document.getElementById('validationPercentText');
    const spinner = document.getElementById('validationSpinner');

    if (!container || !bar) return;

    container.style.display = 'block';
    bar.style.width = `${percent}%`;
    if (text) text.textContent = message;
    if (percentText) percentText.textContent = `${Math.round(percent)}%`;

    if (state === 'success') {
        bar.style.background = '#10b981'; // Emerald Green
        if (spinner) spinner.style.display = 'none';
        setTimeout(() => {
            container.style.display = 'none';
            bar.style.width = '0%';
            bar.style.background = 'linear-gradient(90deg, #3b82f6, #6366f1)';
        }, 2500);
    } else if (state === 'warning') {
        bar.style.background = '#f59e0b'; // Amber Warning
        if (spinner) spinner.style.display = 'none';
        setTimeout(() => {
            container.style.display = 'none';
            bar.style.width = '0%';
            bar.style.background = 'linear-gradient(90deg, #3b82f6, #6366f1)';
        }, 3500);
    } else if (state === 'error') {
        bar.style.background = '#ef4444'; // Red
        if (spinner) spinner.style.display = 'none';
        setTimeout(() => {
            container.style.display = 'none';
            bar.style.width = '0%';
            bar.style.background = 'linear-gradient(90deg, #3b82f6, #6366f1)';
        }, 4000);
    } else {
        if (spinner) spinner.style.display = 'inline-block';
    }
}
window.setValidationProgress = setValidationProgress;
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
    state.userPin = '';
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

/**
 * Client-side resizing and optimization for mobile devices.
 * Downscales high-resolution camera photos (12MP–50MP) so the longest side
 * does not exceed maxDimension, and exports as an optimized JPEG Blob (< 500 KB).
 *
 * @param {Blob|File} fileOrBlob - Input image file or blob
 * @param {number} maxDimension - Maximum length of the longest side (default: 1600)
 * @param {number} quality - JPEG compression quality (default: 0.85)
 * @returns {Promise<Blob>}
 */
async function compressImageForMobile(fileOrBlob, maxDimension = 1600, quality = 0.85) {
    if (!fileOrBlob || !(fileOrBlob instanceof Blob)) {
        return fileOrBlob;
    }

    return new Promise((resolve) => {
        const img = new Image();
        let objectUrl = '';
        try {
            objectUrl = URL.createObjectURL(fileOrBlob);
        } catch (e) {
            console.warn('snip8: Could not create object URL for compression', e);
            resolve(fileOrBlob);
            return;
        }

        img.onload = () => {
            try {
                let width = img.naturalWidth || img.width;
                let height = img.naturalHeight || img.height;

                if (!width || !height) {
                    URL.revokeObjectURL(objectUrl);
                    resolve(fileOrBlob);
                    return;
                }

                // Calculate aspect ratio so the longest side does not exceed maxDimension
                if (width > maxDimension || height > maxDimension) {
                    if (width >= height) {
                        height = Math.round((height * maxDimension) / width);
                        width = maxDimension;
                    } else {
                        width = Math.round((width * maxDimension) / height);
                        height = maxDimension;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    URL.revokeObjectURL(objectUrl);
                    resolve(fileOrBlob);
                    return;
                }

                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    URL.revokeObjectURL(objectUrl);
                    if (!blob) {
                        resolve(fileOrBlob);
                        return;
                    }

                    // Ensure optimized JPEG Blob is < 500 KB: if it exceeds 500 KB, re-export at 0.70 quality
                    if (blob.size > 500 * 1024) {
                        canvas.toBlob((smallerBlob) => {
                            resolve(smallerBlob || blob);
                        }, 'image/jpeg', 0.70);
                    } else {
                        resolve(blob);
                    }
                }, 'image/jpeg', quality);
            } catch (err) {
                URL.revokeObjectURL(objectUrl);
                console.warn('snip8: compressImageForMobile processing error, using original:', err);
                resolve(fileOrBlob);
            }
        };

        img.onerror = (err) => {
            URL.revokeObjectURL(objectUrl);
            console.warn('snip8: compressImageForMobile image load error, using original:', err);
            resolve(fileOrBlob);
        };

        img.src = objectUrl;
    });
}
window.compressImageForMobile = compressImageForMobile;

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
    if (e.target.files.length) {
        const file = e.target.files[0];
        e.target.value = ''; // Reset input to permit re-uploading identical file
        await processFile(file);
    }
});

window.addEventListener('paste', async (e) => {
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
            const file = item.getAsFile();
            if (file) {
                await processFile(file);
                break;
            }
        }
    }
});

// Drag-and-drop support on dropZone
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('border-emerald-500', 'bg-slate-900/80');
});
dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('border-emerald-500', 'bg-slate-900/80');
});
dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('border-emerald-500', 'bg-slate-900/80');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length && files[0].type.startsWith('image/')) {
        await processFile(files[0]);
    }
});

async function processFile(file) {
    if (!file) return;

    // Called from a paste/upload gesture: good moment to unlock audio + ask for notifications
    ensureAudioRunning();
    requestNotificationPermission();

    setValidationProgress(15, 'Extracting timesheet text (OCR)...');
    if (statusContainer) {
        statusContainer.classList.remove('hidden');
        statusContainer.classList.add('animate-pulse');
        statusContainer.textContent = "Compressing image...";
    }

    // 1. Immediately compress the image before any further processing
    const compressedBlob = await compressImageForMobile(file);

    // Store the compressed blob in memory as window.lastUploadedTimesheet
    window.lastUploadedTimesheet = compressedBlob;

    let base64Image = null;
    try {
        base64Image = await Snip8Validation.toBase64(compressedBlob);
    } catch (b64Err) {
        console.warn('snip8: Could not encode image to base64', b64Err);
    }
    if (base64Image) {
        window.lastUploadedTimesheetBase64 = base64Image;
        // Dispatch screenshot asynchronously to Cloudinary without blocking OCR or user interaction
        uploadScreenshotToCloudinary(base64Image, getUserPin());
    }

    // 2. Fast Mobile Path: Skip heavy local Tesseract OCR on mobile and route directly to Gemini AI
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
    if (isMobile) {
        setValidationProgress(50, 'Validating timesheet with Gemini Vision...');
        if (statusContainer) statusContainer.textContent = "✨ Analyzing with Gemini AI...";
        updateParseSourceBadge('parsing');
        try {
            const handled = await triggerAiValidationFallback(base64Image, 'Mobile direct Gemini AI route');
            if (handled) return;
        } catch (mobErr) {
            console.error('snip8: Mobile AI validation failed:', mobErr);
            setValidationProgress(100, 'Failed to validate timesheet', 'error');
            if (statusContainer) {
                statusContainer.classList.remove('animate-pulse');
                statusContainer.textContent = `AI analysis failed (${mobErr.message || 'Network error'}). Using manual entry.`;
                setTimeout(() => { statusContainer.classList.add('hidden'); }, 5000);
            }
            return;
        }
        setValidationProgress(100, 'Failed to validate timesheet', 'error');
        if (statusContainer) {
            statusContainer.classList.remove('animate-pulse');
            statusContainer.textContent = "AI scan returned incomplete data. Use manual entry below.";
            setTimeout(() => { statusContainer.classList.add('hidden'); }, 4000);
        }
        return;
    }

    // 3. Desktop Path: Contrast enhancement and local OCR with strict 5-second timeout
    setValidationProgress(25, 'Extracting timesheet text (OCR)...');
    if (statusContainer) statusContainer.textContent = "Enhancing contrast and running OCR on timesheet...";

    const img = new Image();
    img.src = URL.createObjectURL(compressedBlob);
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
        uploadScreenshotToCloudinary(base64Image, getUserPin());
    }

    try {
        // Strict 5-second timeout on local OCR
        const ocrPromise = Tesseract.recognize(canvas, 'eng');
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Tesseract OCR timeout (5s limit exceeded)')), 5000)
        );
        const result = await Promise.race([ocrPromise, timeoutPromise]);

        if (statusContainer) {
            statusContainer.classList.remove('animate-pulse');
            statusContainer.classList.add('hidden');
        }
        rawOcrText.textContent = result.data.text || "(No readable text detected)";
        await parseText(result.data.text, base64Image);
    } catch (err) {
        console.warn('snip8: Tesseract OCR error/timeout, evaluating AI fallback:', err);
        setValidationProgress(50, 'Validating timesheet with Gemini Vision...');
        if (statusContainer) statusContainer.textContent = "✨ Analyzing with Gemini AI...";
        updateParseSourceBadge('parsing');
        if (base64Image) {
            const fallbackHandled = await triggerAiValidationFallback(
                base64Image,
                err.message && err.message.includes('timeout') ? 'Tesseract OCR timeout (5s)' : 'Tesseract OCR failure'
            );
            if (fallbackHandled) return;
        }
        setValidationProgress(100, 'Failed to validate timesheet', 'error');
        if (statusContainer) {
            statusContainer.classList.remove('animate-pulse');
            statusContainer.classList.remove('hidden');
            statusContainer.textContent = "OCR scan failed. Use manual entry below.";
            setTimeout(() => { statusContainer.classList.add('hidden'); }, 4000);
        }
    }
}

async function triggerAiValidationFallback(base64Image, reason) {
    if (!base64Image) return false;
    try {
        setValidationProgress(50, 'Validating timesheet with Gemini Vision...');
        if (statusContainer) {
            statusContainer.classList.remove('hidden');
            statusContainer.classList.add('animate-pulse');
            statusContainer.innerHTML = `<span>🤖 <strong>Triggering AI Vision:</strong> ${escapeHtml(reason)}<br>Validating timesheet with Gemini Vision...</span>`;
        }
        updateParseSourceBadge('parsing');

        const result = await Snip8Validation.validateWithAi(base64Image, {
            dailyCapSeconds: TARGET_DAILY_SEC
        });

        if (result && result.success) {
            const aiResult = result;
            setValidationProgress(85, 'Applying timesheet values & syncing...');

            // Respect Extracted Date on Scan:
            const todayStr = new Date().toLocaleDateString('en-CA');
            const now = new Date();
            const defaultTodayLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

            let headerInfo = null;
            if (aiResult.dayLabel) {
                headerInfo = extractDayHeaderAndDate(aiResult.dayLabel);
            }
            if (!headerInfo && aiResult.work_date) {
                headerInfo = extractDayHeaderAndDate(aiResult.work_date);
            }
            if (!headerInfo && Array.isArray(aiResult.timesheetData) && aiResult.timesheetData.length > 0) {
                for (const item of aiResult.timesheetData) {
                    if (item && item.label) {
                        headerInfo = extractDayHeaderAndDate(item.label);
                        if (headerInfo) break;
                    }
                }
            }

            const resolvedWorkDate = headerInfo ? headerInfo.workDate : todayStr;
            const resolvedDayLabel = headerInfo ? headerInfo.dayLabel : defaultTodayLabel;
            const resolvedDayName = headerInfo ? headerInfo.dayName : defaultTodayLabel.split(' ')[0].replace(/,/g, '');

            state.workDate = resolvedWorkDate;

            // 1. Update the master state directly
            state.loggedSeconds = aiResult.loggedSeconds || 28805;
            state.remainingSeconds = Math.max(0, 28800 - state.loggedSeconds);

            // Immediately cancel any pending debounced Neon save from previous OCR/ticker
            if (neonSaveTimeout) {
                clearTimeout(neonSaveTimeout);
                neonSaveTimeout = null;
            }

            // Format detectedDays for UI table & dashboard
            const aiH = Math.floor(state.loggedSeconds / 3600);
            const aiM = Math.floor((state.loggedSeconds % 3600) / 60);
            const aiS = state.loggedSeconds % 60;

            if (Array.isArray(aiResult.timesheetData) && aiResult.timesheetData.length > 0) {
                detectedDays = aiResult.timesheetData.map((d, i) => {
                    let label = (d && d.label) || `${resolvedDayLabel} (AI)`;
                    if (i === 0) {
                        label = `${resolvedDayLabel} (AI)`;
                    }
                    return {
                        ...d,
                        label,
                        dayName: (d && d.dayName) || resolvedDayName,
                        h: (d && d.h !== undefined) ? d.h : aiH,
                        m: (d && d.m !== undefined) ? d.m : aiM,
                        s: (d && d.s !== undefined) ? d.s : aiS,
                        sec: (d && d.sec !== undefined) ? d.sec : state.loggedSeconds,
                        shifts: (d && d.shifts) || aiResult.shifts || []
                    };
                });
            } else {
                detectedDays = [{
                    label: `${resolvedDayLabel} (AI)`,
                    dayName: resolvedDayName,
                    h: aiH,
                    m: aiM,
                    s: aiS,
                    sec: state.loggedSeconds,
                    shifts: aiResult.shifts || []
                }];
            }

            // Master state timesheetData must be detectedDays with parsed day headers
            state.timesheetData = detectedDays;

            selectedDayIndex = 0;
            totalTrackedSec = state.loggedSeconds;
            baseTodaySec = state.loggedSeconds;
            baseTotalTrackedSec = state.loggedSeconds;

            if (state.loggedSeconds >= TARGET_DAILY_SEC) {
                timerCompleted = true;
                completedElapsedSec = 0;
                clearCountdownTimers();
            }

            // Explicitly call the Neon database save function immediately with these updated values
            await saveSessionToNeon(state.loggedSeconds, state.remainingSeconds, state.timesheetData);
            setValidationProgress(100, 'Timesheet successfully synced!', 'success');

            const rawConf = aiResult.confidence || 'High';
            const conf = rawConf.charAt(0).toUpperCase() + rawConf.slice(1).toLowerCase();
            updateParseSourceBadge('ai', conf);

            if (statusContainer) {
                statusContainer.classList.remove('animate-pulse');
                statusContainer.textContent = `✨ Done — Timesheet validated via Gemini Vision AI (${aiResult.confidence} confidence)`;
                setTimeout(() => { statusContainer.classList.add('hidden'); }, 3500);
            }

            if (aiValidationNotice && aiValidationDetail && aiValidationModel) {
                aiValidationDetail.textContent = `Confidence: ${(aiResult.confidence || 'high').toUpperCase()} (${formatHms(state.loggedSeconds)} logged)`;
                aiValidationModel.textContent = aiResult.modelUsed || 'Gemini Vision';
                aiValidationNotice.classList.remove('hidden');
            }

            rawOcrText.textContent = `=== VALIDATED VIA AI VISION (Gemini) ===\nModel: ${aiResult.modelUsed}\nConfidence: ${aiResult.confidence}\nLogged: ${formatHms(state.loggedSeconds)}\nRemaining for 8h: ${formatHms(state.remainingSeconds)}\n\nShifts:\n${JSON.stringify(aiResult.shifts, null, 2)}`;

            renderAll();
            debouncedSaveSession();
            return true;
        }
    } catch (err) {
        console.warn('snip8: AI Vision validation failed:', err);
        setValidationProgress(100, 'Failed to validate timesheet', 'error');
        if (statusContainer) {
            statusContainer.classList.remove('animate-pulse');
            statusContainer.classList.remove('hidden');
            statusContainer.textContent = `AI analysis failed (${err.message || 'Network error'}). Using manual entry.`;
            setTimeout(() => { statusContainer.classList.add('hidden'); }, 4000);
        }
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

    // 2. Top-Level Regex Priority in Local Parser (Daily Header Totals)
    // Regex: /(?:(\d{1,2})\s*hr[s]?\s*)?(?:(\d{1,2})\s*min[s]?\s*)?(?:(\d{1,2})\s*sec[s]?)?/i
    const headerTotalRegex = /(?:(\d{1,2})\s*hr[s]?\s*)?(?:(\d{1,2})\s*min[s]?\s*)?(?:(\d{1,2})\s*sec[s]?)?/i;
    let totalHeaderSec = 0;

    // Search cleaned OCR lines for daily header total with highest priority
    const linesForHeader = cleaned.split('\n');
    for (const line of linesForHeader) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/\b(?:hr[s]?|min[s]?|sec[s]?)\b/i.test(trimmed)) {
            const durIdx = trimmed.search(/\d{1,2}\s*(?:hr[s]?|min[s]?|sec[s]?)\b/i);
            if (durIdx !== -1) {
                const candidate = trimmed.substring(durIdx);
                const hm = candidate.match(headerTotalRegex);
                if (hm && (hm[1] !== undefined || hm[2] !== undefined || hm[3] !== undefined)) {
                    const h = hm[1] ? parseInt(hm[1], 10) : 0;
                    const m = hm[2] ? parseInt(hm[2], 10) : 0;
                    const s = hm[3] ? parseInt(hm[3], 10) : 0;
                    const calcSec = h * 3600 + m * 60 + s;
                    if (calcSec > 0) {
                        totalHeaderSec = calcSec;
                        break;
                    }
                }
            }
        }
    }

    // Fallback total time tracked extraction (top summary if not already matched)
    if (totalHeaderSec === 0) {
        const totalRegex = /(?:Total\s*(?:time|tire|tine|tracked)?)[\s\S]{0,35}?(\d{1,2})\s*(?:hr|h|br|hrs?)\s*,?\s*(\d{1,2})\s*(?:min|m|mins?)(?:\s*,?\s*(\d{1,2})\s*(?:sec|s|secs?))?/i;
        const totalMatch = cleaned.match(totalRegex);
        if (totalMatch) {
            const totH = parseInt(totalMatch[1], 10);
            const totM = parseInt(totalMatch[2], 10);
            const totS = totalMatch[3] !== undefined ? parseInt(totalMatch[3], 10) : 0;
            totalHeaderSec = totH * 3600 + totM * 60 + totS;
        }
    }

    totalTrackedSec = totalHeaderSec;

    // Extract shift intervals (e.g. 5:05-8:22, 9:37-12:08, 12:32-2:45)
    const { shifts: extractedShifts, totalShiftSec } = Snip8Validation.extractShiftIntervals((rawText || '') + '\n' + cleaned);
    const calculatedShiftSec = totalShiftSec;

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
    // Ensures "08 hr 00 min 05 sec" parses as 8h 0m 5s (28,805 sec) in a single duration match
    const durRegex = /(?:(\d{1,2})\s*(?:hr|h|hrs?)\b(?:\s*,?\s*(\d{1,2})\s*(?:min|m|mins?)\b)?(?:\s*,?\s*(\d{1,2})\s*(?:sec|s|secs?)\b)?)|(?:(\d{1,2})\s*(?:min|m|mins?)\b(?:\s*,?\s*(\d{1,2})\s*(?:sec|s|secs?)\b)?)|(?:(\d{1,2})\s*(?:sec|s|secs?)\b)/gi;
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

    if (daysFound.length === 0 && parsedDurations.length === 0 && totalHeaderSec === 0) {
        if (base64Image) {
            const handled = await triggerAiValidationFallback(base64Image, 'No timesheet columns detected by OCR');
            if (handled) return;
        }
        alert("Could not detect timesheet columns. Please use manual entry.");
        return;
    }

    // 7. Map parsed columns
    // Do NOT split the same day into multiple "Day 1" and "Day 2" rows when a single date header is detected
    detectedDays = [];
    if (daysFound.length === 1) {
        // Exactly one date header detected: treat total as the single daily total for this date
        const day = daysFound[0];
        const durSec = totalHeaderSec > 0 ? totalHeaderSec : (parsedDurations.length > 0 ? parsedDurations[0].sec : calculatedShiftSec);
        detectedDays = [{
            label: day.label,
            dayName: day.dayName,
            h: Math.floor(durSec / 3600),
            m: Math.floor((durSec % 3600) / 60),
            s: durSec % 60,
            sec: durSec,
            shifts: extractedShifts
        }];
        selectedDayIndex = 0;
    } else if (daysFound.length > 1) {
        for (let i = 0; i < daysFound.length; i++) {
            const dur = parsedDurations[i] || { h: 0, m: 0, s: 0, sec: 0 };
            detectedDays.push({
                label: daysFound[i].label,
                dayName: daysFound[i].dayName,
                h: dur.h,
                m: dur.m,
                s: dur.s,
                sec: dur.sec,
                shifts: i === 0 ? extractedShifts : []
            });
        }

        // Smart Active Day Selection: Match today's day of week or latest day with sec > 0
        const now = new Date();
        const todayName = now.toLocaleDateString('en-US', { weekday: 'short' });
        let matchedIndex = detectedDays.findIndex(d => d.label.toLowerCase().includes(todayName.toLowerCase()));
        if (matchedIndex === -1) {
            for (let i = detectedDays.length - 1; i >= 0; i--) {
                if (detectedDays[i].sec > 0) {
                    matchedIndex = i;
                    break;
                }
            }
        }
        selectedDayIndex = matchedIndex >= 0 ? matchedIndex : 0;
    } else {
        // No explicit date header: single active day
        const durSec = totalHeaderSec > 0 ? totalHeaderSec : (parsedDurations.length > 0 ? parsedDurations[0].sec : calculatedShiftSec);
        const now = new Date();
        const todayLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
        detectedDays = [{
            label: todayLabel,
            dayName: todayLabel.split(' ')[0],
            h: Math.floor(durSec / 3600),
            m: Math.floor((durSec % 3600) / 60),
            s: durSec % 60,
            sec: durSec,
            shifts: extractedShifts
        }];
        selectedDayIndex = 0;
    }

    // Respect Extracted Date on Scan:
    const todayStr = new Date().toLocaleDateString('en-CA');
    let headerInfo = null;
    if (detectedDays[selectedDayIndex] && detectedDays[selectedDayIndex].label) {
        headerInfo = extractDayHeaderAndDate(detectedDays[selectedDayIndex].label);
    }
    if (!headerInfo && daysFound && daysFound.length > 0) {
        headerInfo = extractDayHeaderAndDate(daysFound[0].label);
    }
    if (!headerInfo) {
        headerInfo = extractDayHeaderAndDate(rawText) || extractDayHeaderAndDate(cleaned);
    }

    if (headerInfo) {
        state.workDate = headerInfo.workDate;
        if (detectedDays[selectedDayIndex]) {
            detectedDays[selectedDayIndex].label = headerInfo.dayLabel;
            detectedDays[selectedDayIndex].dayName = headerInfo.dayName;
        }
    } else {
        state.workDate = todayStr;
    }

    // 8. Reconcile Active Day with Total Tracked Time
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

    // 9. Auto-fallback to Gemini if local OCR is ambiguous:
    // - If local OCR loggedSeconds calculates to less than the header duration
    // - If multiple days are erroneously created for a single date
    // - If shift sum is around 8 hours but parsed header total is < 1 hour
    const activeDaySec = detectedDays[selectedDayIndex] ? detectedDays[selectedDayIndex].sec : 0;
    const parsedHeaderTotalSec = totalTrackedSec > 0 ? totalTrackedSec : activeDaySec;

    const isLoggedLessThanHeader = totalHeaderSec > 0 && activeDaySec < totalHeaderSec;
    const hasMultipleDaysForSingleDate = daysFound.length === 1 && (parsedDurations.length > 1 || detectedDays.length > 1);
    const hasUnder1HourWithMultipleShifts = parsedHeaderTotalSec < 3600 && extractedShifts.length >= 2;
    const combinedOcrText = (rawText || '') + ' ' + cleaned;
    const has8HrStringWithUnder1MinTotal = /\b0?8\s*(?:hr|h|hrs)\b/i.test(combinedOcrText) && parsedHeaderTotalSec < 60;
    const isShiftSumAround8h = totalShiftSec >= 6 * 3600 && totalShiftSec <= 12 * 3600;
    const hasShiftSumMismatch = isShiftSumAround8h && parsedHeaderTotalSec < 3600;

    if (isLoggedLessThanHeader || hasMultipleDaysForSingleDate || hasUnder1HourWithMultipleShifts || has8HrStringWithUnder1MinTotal || hasShiftSumMismatch) {
        let mismatchReason = '';
        if (isLoggedLessThanHeader) {
            mismatchReason = `Local OCR logged time (${formatHms(activeDaySec)}) is less than header duration (${formatHms(totalHeaderSec)}). Auto-dispatching to Gemini AI.`;
        } else if (hasMultipleDaysForSingleDate) {
            mismatchReason = `Multiple days detected for a single date header (${daysFound[0]?.label}). Auto-dispatching to Gemini AI.`;
        } else if (has8HrStringWithUnder1MinTotal) {
            mismatchReason = `Timesheet text contains "08 hr" but parsed total is only ${formatHms(parsedHeaderTotalSec)} (< 1 min). Local OCR marked INVALID.`;
        } else if (hasUnder1HourWithMultipleShifts) {
            mismatchReason = `${extractedShifts.length} work shifts detected summing to ~${Math.round(totalShiftSec / 3600)}h, but parsed header total is only ${formatHms(parsedHeaderTotalSec)} (< 1h). Local OCR marked INVALID.`;
        } else {
            mismatchReason = `Shift intervals sum to ~${Math.round(totalShiftSec / 3600)}h (${formatHms(totalShiftSec)}), but parsed header total is < 1h (${formatHms(parsedHeaderTotalSec)}). Local OCR marked INVALID.`;
        }

        console.warn('snip8: Sanity check / ambiguity detected:', mismatchReason);
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
        shiftSumSec: totalShiftSec,
        totalHeaderSec,
        daysFound
    });

    if (fallbackCheck.shouldFallback && base64Image) {
        console.log('snip8: triggering AI Vision fallback:', fallbackCheck.reason);
        updateParseSourceBadge('parsing');
        const handledByAi = await triggerAiValidationFallback(base64Image, fallbackCheck.reason);
        if (handledByAi) return;
    }

    // 10. Immediate Neon Save with Header Total:
    const finalLoggedSec = totalHeaderSec > 0 ? totalHeaderSec : calculatedShiftSec;
    const finalRemainingSec = Math.max(0, 28800 - finalLoggedSec);

    state.loggedSeconds = finalLoggedSec;
    state.remainingSeconds = finalRemainingSec;

    const parsedShifts = extractedShifts && extractedShifts.length > 0
        ? extractedShifts
        : (detectedDays && detectedDays.length > 0
            ? detectedDays
            : [{ h: Math.floor(finalLoggedSec / 3600), m: Math.floor((finalLoggedSec % 3600) / 60), s: finalLoggedSec % 60 }]);

    // Ensure active day reflects finalLoggedSec
    if (detectedDays[selectedDayIndex]) {
        detectedDays[selectedDayIndex].h = Math.floor(finalLoggedSec / 3600);
        detectedDays[selectedDayIndex].m = Math.floor((finalLoggedSec % 3600) / 60);
        detectedDays[selectedDayIndex].s = finalLoggedSec % 60;
        detectedDays[selectedDayIndex].sec = finalLoggedSec;
        if (!detectedDays[selectedDayIndex].shifts || detectedDays[selectedDayIndex].shifts.length === 0) {
            detectedDays[selectedDayIndex].shifts = parsedShifts;
        }
    }

    // Master state timesheetData must be detectedDays with parsed day headers
    state.timesheetData = detectedDays;

    baseTodaySec = finalLoggedSec;
    baseTotalTrackedSec = Math.max(totalTrackedSec, finalLoggedSec);
    totalTrackedSec = baseTotalTrackedSec;

    if (finalLoggedSec >= TARGET_DAILY_SEC) {
        timerCompleted = true;
        completedElapsedSec = 0;
        clearCountdownTimers();
    }

    // Cancel any pending debounced save so it doesn't overwrite
    if (neonSaveTimeout) {
        clearTimeout(neonSaveTimeout);
        neonSaveTimeout = null;
    }

    // Immediate Neon save with verified header total and detectedDays
    setValidationProgress(85, 'Applying timesheet values & syncing...');
    await saveSessionToNeon(finalLoggedSec, finalRemainingSec, detectedDays);
    setValidationProgress(100, 'Timesheet successfully synced!', 'success');

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
    // Ensure the ticker does NOT recalculate and overwrite logged_seconds if the daily cap has been reached
    // or if an AI sync is currently committing to the database
    if (state.isAiSyncing) return;

    // Freeze on Cap Protection: explicitly disallow any timer tickers from recalculating downwards, and freeze remaining time at 00:00:00
    if (state.loggedSeconds >= TARGET_DAILY_SEC || baseTodaySec >= TARGET_DAILY_SEC) {
        const finalTodaySec = Math.max(baseTodaySec, state.loggedSeconds, TARGET_DAILY_SEC);
        const finalTotalSec = Math.max(baseTotalTrackedSec, totalTrackedSec, finalTodaySec);
        state.loggedSeconds = finalTodaySec;
        state.remainingSeconds = 0;
        dispTodayLogged.textContent = formatHms(finalTodaySec);
        dispTotalTracked.textContent = formatHms(finalTotalSec);
        dispRemaining.textContent = formatHms(0);
        if (countdown) {
            countdown.textContent = "00:00:00";
            countdown.classList.remove('text-white');
            countdown.classList.add('text-emerald-400');
        }
        const today = detectedDays[selectedDayIndex] || { label: 'Active Day' };
        dispTodayLabel.textContent = `${today.label} Active Column • 8h Cap Reached`;
        updateProgressBar(finalTodaySec);
        return;
    }

    const isLiveEnabled = liveIncrementToggle ? liveIncrementToggle.checked : true;
    let elapsed = 0;

    if (isLiveEnabled && timerStartTime) {
        if (timerCompleted) {
            elapsed = completedElapsedSec;
        } else {
            elapsed = getElapsedSeconds();
        }
    }

    let currentTodaySec = baseTodaySec + elapsed;
    let remSec = Math.max(0, TARGET_DAILY_SEC - currentTodaySec);

    // If targetTimestamp is set, anchor directly against absolute wall-clock
    if (isLiveEnabled && targetTimestamp && !timerCompleted) {
        const targetMs = targetTimestamp instanceof Date ? targetTimestamp.getTime() : Number(targetTimestamp);
        const msRemaining = targetMs - Date.now();
        remSec = Math.max(0, Math.round(msRemaining / 1000));
        currentTodaySec = Math.max(currentTodaySec, TARGET_DAILY_SEC - remSec);
    }

    state.loggedSeconds = currentTodaySec;
    state.totalLoggedSeconds = currentTodaySec;
    state.remainingSeconds = remSec;

    dispTodayLogged.textContent = formatHms(currentTodaySec);
    dispTotalTracked.textContent = formatHms(baseTotalTrackedSec + (currentTodaySec - baseTodaySec));
    dispRemaining.textContent = formatHms(remSec);

    const today = detectedDays[selectedDayIndex] || { label: 'Active Day' };
    const isRunningLive = isLiveEnabled && countdownInterval !== null;
    dispTodayLabel.textContent = `${today.label} Active Column${isRunningLive ? ' • Live' : ''}`;

    updateProgressBar(currentTodaySec);
}

function updateProgressBar(loggedSeconds) {
    const targetSeconds = state.dailyCapSeconds || TARGET_DAILY_SEC; // 28,800s
    const graceWindowSeconds = targetSeconds + (5 * 60); // 29,100s
    const percent = Math.min(105, (loggedSeconds / targetSeconds) * 100);

    const bar = document.getElementById('shiftProgressBar');
    const percentLabel = document.getElementById('progressBarPercent');
    const label = document.getElementById('progressBarLabel');
    const statusText = document.getElementById('progressStatusText');

    if (!bar) return;

    bar.style.width = Math.min(100, percent) + '%';
    if (percentLabel) percentLabel.textContent = `${Math.floor(percent)}%`;
    if (label) {
        const hrs = Math.floor(loggedSeconds / 3600);
        const mins = Math.floor((loggedSeconds % 3600) / 60);
        const targetHrs = Math.floor(targetSeconds / 3600);
        const targetMins = Math.floor((targetSeconds % 3600) / 60);
        label.textContent = `Progress: ${hrs}h ${mins.toString().padStart(2, '0')}m / ${targetHrs}h ${targetMins.toString().padStart(2, '0')}m`;
    }

    // Dynamic policy coloring
    if (loggedSeconds >= graceWindowSeconds) {
        // > 8h 05m Violation
        bar.className = 'h-full rounded-full transition-all duration-500 bg-red-600 animate-pulse';
        if (statusText) {
            statusText.className = 'text-center text-xs mt-1.5 font-bold text-red-400';
            statusText.textContent = '⚠️ Policy Violation: Exceeded 8h 05m Grace Limit';
        }
    } else if (loggedSeconds >= targetSeconds) {
        // 8h 00m to 8h 05m (Within Grace Window)
        bar.className = 'h-full rounded-full transition-all duration-500 bg-amber-500';
        if (statusText) {
            statusText.className = 'text-center text-xs mt-1.5 font-semibold text-amber-400';
            statusText.textContent = '⏱ 8h Target Reached! Inside 5m grace window. Stop now.';
        }
    } else if (loggedSeconds >= targetSeconds - (5 * 60)) {
        // 7h 55m to 8h 00m (Compliant Window)
        bar.className = 'h-full rounded-full transition-all duration-500 bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.5)]';
        if (statusText) {
            statusText.className = 'text-center text-xs mt-1.5 font-semibold text-emerald-400';
            statusText.textContent = '✓ 100% Compliant Window (7h 55m - 8h 00m). Ready to stop.';
        }
    } else {
        // Normal progress
        bar.className = 'h-full rounded-full transition-all duration-500 bg-emerald-500';
        if (statusText) {
            statusText.className = 'text-center text-xs mt-1.5 font-medium text-slate-400';
            statusText.textContent = 'Shift in progress';
        }
    }
}
window.updateProgressBar = updateProgressBar;

function initLiveIncrementToggle() {
    if (!liveIncrementToggle) return;
    const saved = localStorage.getItem(STORAGE_KEY_LIVE_INCREMENT);
    if (saved !== null) {
        liveIncrementToggle.checked = saved === 'true';
    } else {
        liveIncrementToggle.checked = true;
    }

        liveIncrementToggle.addEventListener('change', () => {
            const isChecked = liveIncrementToggle.checked;
            state.isLiveIncrement = isChecked;
            localStorage.setItem(STORAGE_KEY_LIVE_INCREMENT, isChecked);
            if (isChecked) {
                const hint = document.getElementById('timerResumeHint');
                if (hint) hint.style.display = 'none';

                // Clear remote stop signal so cross-device sync doesn't immediately re-pause
                const pin = state.userPin || getUserPin();
                if (pin) {
                    fetch(`/api/timer-signal?pin=${encodeURIComponent(pin)}&action=clear`, { method: 'POST' }).catch(() => {});
                }

                if (!timerCompleted && state.remainingSeconds > 0 && !countdownInterval) {
                    timerStartTime = Date.now();
                    targetTimestamp = new Date(timerStartTime + state.remainingSeconds * 1000);
                    startCountdown();
                    updateStopTimeDisplay();
                }
                if (typeof saveSessionToNeon === 'function') {
                    saveSessionToNeon(baseTodaySec, state.remainingSeconds, detectedDays, null, { silent: true, isLiveIncrement: true });
                }
            } else {
                // Clear the interval and timestamps when switched off
                if (countdownInterval) {
                    clearInterval(countdownInterval);
                    countdownInterval = null;
                }
                if (window.countdownInterval) {
                    clearInterval(window.countdownInterval);
                    window.countdownInterval = null;
                }
                if (window.liveTimerInterval) {
                    clearInterval(window.liveTimerInterval);
                    window.liveTimerInterval = null;
                }
                clearCountdownTimers();
                timerStartTime = null;
                targetTimestamp = null;
                updateStopTimeDisplay();
                if (typeof saveSessionToNeon === 'function') {
                    saveSessionToNeon(baseTodaySec, state.remainingSeconds, detectedDays, null, { silent: true, isLiveIncrement: false });
                }
            }
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
    if (today.sec >= TARGET_DAILY_SEC || state.loggedSeconds >= TARGET_DAILY_SEC) {
        timerCompleted = true;
        completedElapsedSec = 0;
        clearCountdownTimers();
    } else {
        timerCompleted = false;
        completedElapsedSec = 0;
    }

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

function renderTimesheetBreakdown(options = {}) {
    renderAll(options);
}
window.renderTimesheetBreakdown = renderTimesheetBreakdown;

function formatClock(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function updateStopTimeDisplay() {
    dispStopTime.textContent = targetTimestamp ? formatClock(targetTimestamp) : '--';
}

function clearCountdownTimers() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = null;
    window.liveTimerInterval = null;
    state.tickerInterval = null;
    if (deadlineTimeout) clearTimeout(deadlineTimeout);
    deadlineTimeout = null;
    if (periodicSyncInterval) clearInterval(periodicSyncInterval);
    periodicSyncInterval = null;
}

function tickCountdown() {
    if (!state.isLiveIncrement) {
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
        return;
    }

    // Recalculate remaining seconds based on absolute target timestamp
    if (targetTimestamp) {
        const targetMs = targetTimestamp instanceof Date ? targetTimestamp.getTime() : Number(targetTimestamp);
        const msRemaining = targetMs - Date.now();
        state.remainingSeconds = Math.max(0, Math.round(msRemaining / 1000));
    } else {
        state.remainingSeconds = Math.max(0, state.remainingSeconds - 1);
    }

    // Ensure the ticker does NOT recalculate and overwrite logged_seconds if the daily cap has been reached
    // or if an AI sync is currently committing to the database
    if (state.isAiSyncing || baseTodaySec >= TARGET_DAILY_SEC || state.loggedSeconds >= TARGET_DAILY_SEC || state.remainingSeconds <= 0) {
        if (baseTodaySec >= TARGET_DAILY_SEC || state.loggedSeconds >= TARGET_DAILY_SEC || state.remainingSeconds <= 0) {
            countdown.textContent = "00:00:00";
            countdown.classList.remove('text-white');
            countdown.classList.add('text-emerald-400');
            clearCountdownTimers();
            timerCompleted = true;
            completedElapsedSec = 0;
            state.remainingSeconds = 0;
            state.isLiveIncrement = false;
            try { localStorage.setItem(STORAGE_KEY_LIVE_INCREMENT, 'false'); } catch (e) { }
            const liveToggle = document.getElementById('liveIncrementToggle') || document.getElementById('liveIncrementSwitch');
            if (liveToggle) liveToggle.checked = false;
            updateLoggedDisplays();
            updateStopTimeDisplay();
            debouncedSaveSession();
            if (!alarmDismissed) triggerAlarm();
            if (!springboardAutoStopped) {
                springboardAutoStopped = true;
                requestSpringboardStop();
            }
        }
        return;
    }

    const sec = state.remainingSeconds;
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    countdown.textContent = `${h}:${m}:${s}`;

    updateLoggedDisplays();
    updateStopTimeDisplay();
}

function startCountdown() {
    clearCountdownTimers();
    if (!targetTimestamp) return;
    countdown.classList.remove('text-emerald-400');
    countdown.classList.add('text-white');

    countdownInterval = setInterval(() => {
        if (!state.isLiveIncrement) {
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            return;
        }
        tickCountdown();
    }, 1000);
    window.liveTimerInterval = countdownInterval;
    state.tickerInterval = countdownInterval;

    // One-shot deadline timer: background tabs throttle repeating intervals (down to ~1/min),
    // while a single non-chained timeout is much more likely to fire on time.
    const remainingMs = targetTimestamp - Date.now();
    if (remainingMs > 0) deadlineTimeout = setTimeout(() => {
        if (!state.isLiveIncrement) return;
        tickCountdown();
    }, remainingMs + 50);

    // Periodic cloud sync every 60s while timer runs
    periodicSyncInterval = setInterval(() => {
        if (targetTimestamp && countdownInterval && state.isLiveIncrement) {
            debouncedSaveSession();
        }
    }, 60000);

    tickCountdown();
}

// ===== Wall-Clock Catch-Up Helper to Eliminate Timer Drift =====
function applyWallClockCatchUp(sessionData, dailyCap = TARGET_DAILY_SEC) {
    if (!sessionData) {
        return {
            loggedSeconds: 0,
            remainingSeconds: dailyCap,
            isRemoteRunning: false,
            elapsedSinceSave: 0
        };
    }

    const sessionUpdatedAt = sessionData.updated_at ? new Date(sessionData.updated_at).getTime() : null;
    let elapsedSinceSave = 0;

    if (sessionUpdatedAt && !isNaN(sessionUpdatedAt)) {
        elapsedSinceSave = Math.max(0, Math.floor((Date.now() - sessionUpdatedAt) / 1000));
    }

    let td = sessionData.timesheet_data;
    if (typeof td === 'string') {
        try { td = JSON.parse(td); } catch (e) { td = null; }
    }
    // Remote session is considered actively running unless explicitly false
    const isExplicitlyPaused = (td?.isLiveIncrement === false || sessionData.isLiveIncrement === false || sessionData.is_live_increment === false);
    const isRemoteRunning = !isExplicitlyPaused;

    const baseRemSec = sessionData.total_seconds_remaining !== undefined
        ? Number(sessionData.total_seconds_remaining)
        : (sessionData.remaining_seconds !== undefined ? Number(sessionData.remaining_seconds) : Math.max(0, dailyCap - (Number(sessionData.logged_seconds) || 0)));
    const baseLoggedSec = Number(sessionData.logged_seconds) || 0;

    let adjustedRemSec = baseRemSec;
    let adjustedLoggedSec = baseLoggedSec;

    if (isRemoteRunning && elapsedSinceSave > 0) {
        // Catch up the running timer values to the current second
        adjustedRemSec = Math.max(0, baseRemSec - elapsedSinceSave);
        adjustedLoggedSec = Math.min(dailyCap, baseLoggedSec + elapsedSinceSave);
    }

    return {
        loggedSeconds: adjustedLoggedSec,
        remainingSeconds: adjustedRemSec,
        isRemoteRunning: Boolean(isRemoteRunning),
        elapsedSinceSave
    };
}

// ===== Silent Background Sync & Mobile/Desktop Handoff =====
let lastForegroundSyncTime = 0;

function handleGoingToBackground() {
    state.isTabActive = false;

    const isLiveEnabled = liveIncrementToggle ? liveIncrementToggle.checked : true;
    let elapsed = 0;
    if (isLiveEnabled && timerStartTime && !timerCompleted) {
        elapsed = getElapsedSeconds();
        baseTodaySec += elapsed;
        baseTotalTrackedSec += elapsed;
        state.loggedSeconds = baseTodaySec;
        state.totalLoggedSeconds = baseTodaySec;
        state.remainingSeconds = Math.max(0, (state.dailyCapSeconds || TARGET_DAILY_SEC) - baseTodaySec);
        timerStartTime = null;

        if (detectedDays[selectedDayIndex]) {
            detectedDays[selectedDayIndex].sec = baseTodaySec;
            detectedDays[selectedDayIndex].h = Math.floor(baseTodaySec / 3600);
            detectedDays[selectedDayIndex].m = Math.floor((baseTodaySec % 3600) / 60);
            detectedDays[selectedDayIndex].s = baseTodaySec % 60;
        }
    }

    // Halt local interval tickers immediately to eliminate background clock drift
    clearCountdownTimers();

    // Commit pending debounced saves or elapsed seconds immediately via keepalive
    if (neonSaveTimeout || elapsed > 0) {
        if (neonSaveTimeout) {
            clearTimeout(neonSaveTimeout);
            neonSaveTimeout = null;
        }
        saveSessionToNeon(baseTodaySec, state.remainingSeconds, detectedDays, null, { keepalive: true, silent: true });
    } else {
        saveSession();
    }
}

async function handleReturningToForeground() {
    if (document.hidden) return;
    state.isTabActive = true;

    const now = Date.now();
    if (now - lastForegroundSyncTime < 800) {
        return;
    }
    lastForegroundSyncTime = now;

    const isLiveEnabled = liveIncrementToggle ? liveIncrementToggle.checked : true;
    const dailyCap = state.dailyCapSeconds || TARGET_DAILY_SEC;

    // 1. Seamlessly resume local ticker if enabled and daily cap not reached
    if (isLiveEnabled && !timerCompleted) {
        if (targetTimestamp && (targetTimestamp - Date.now()) > 0) {
            // Anchor against existing absolute target timestamp so sleeping screen doesn't cause drift
            const msRemaining = (targetTimestamp instanceof Date ? targetTimestamp.getTime() : Number(targetTimestamp)) - Date.now();
            const remSec = Math.max(0, Math.round(msRemaining / 1000));
            state.remainingSeconds = remSec;
            const newLogged = Math.min(dailyCap, dailyCap - remSec);
            baseTodaySec = Math.max(baseTodaySec, newLogged);
            baseTotalTrackedSec = Math.max(baseTotalTrackedSec, baseTodaySec);
            state.loggedSeconds = baseTodaySec;
            state.totalLoggedSeconds = baseTodaySec;
            timerStartTime = Date.now();
            targetTimestamp = new Date(Date.now() + remSec * 1000);
        } else {
            timerStartTime = Date.now();
            const remSec = Math.max(0, dailyCap - baseTodaySec);
            targetTimestamp = new Date(timerStartTime + remSec * 1000);
        }
        startCountdown();
        updateStopTimeDisplay();
        updateLoggedDisplays();
    }

    // 2. Perform silent, non-blocking fetch to check for handoff / progress from another device
    const pin = state.userPin || getUserPin();
    const date = state.workDate || getWorkDate();
    if (!pin || !navigator.onLine) return;

    try {
        const url = `/api/snip8-session?pin=${encodeURIComponent(pin)}&date=${encodeURIComponent(date)}`;
        const res = await fetch(url, {
            headers: {
                'x-user-pin': pin
            }
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const row = data?.row || data?.session;

        if (row && !row.is_fresh_default) {
            const catchUp = applyWallClockCatchUp(row, dailyCap);
            const remoteLogged = catchUp.loggedSeconds;
            const remoteRem = catchUp.remainingSeconds;

            // Monotonic fast-forward: if another device progressed further, silently update
            if (remoteLogged > (state.totalLoggedSeconds || state.loggedSeconds || 0)) {
                state.totalLoggedSeconds = remoteLogged;
                state.loggedSeconds = remoteLogged;
                state.remainingSeconds = remoteRem;

                baseTodaySec = remoteLogged;
                baseTotalTrackedSec = Math.max(baseTotalTrackedSec, remoteLogged);
                totalTrackedSec = baseTotalTrackedSec;

                detectedDays = hydrateBreakdownFromTimesheetData(row.timesheet_data, row.work_date || date, remoteLogged);
                state.detectedDays = detectedDays;
                state.timesheetData = detectedDays;

                if (row.last_scanned_image_url) {
                    state.lastScannedImageUrl = row.last_scanned_image_url;
                    renderLatestScannedImage(row.last_scanned_image_url, row.updated_at);
                }

                const isRemoteRunning = catchUp.isRemoteRunning;
                state.isLiveIncrement = isRemoteRunning;
                const liveToggle = document.getElementById('liveIncrementToggle') || 
                                   document.getElementById('liveIncrementSwitch');
                if (liveToggle) {
                    liveToggle.checked = isRemoteRunning;
                }
                try {
                    localStorage.setItem(STORAGE_KEY_LIVE_INCREMENT, String(isRemoteRunning));
                } catch (e) { }

                if (remoteLogged >= dailyCap || remoteRem <= 0) {
                    timerCompleted = true;
                    completedElapsedSec = 0;
                    state.isLiveIncrement = false;
                    if (liveToggle) liveToggle.checked = false;
                    clearCountdownTimers();
                } else if (state.isLiveIncrement) {
                    timerCompleted = false;
                    completedElapsedSec = 0;
                    timerStartTime = Date.now();
                    targetTimestamp = new Date(Date.now() + remoteRem * 1000);
                    startCountdown();
                    updateStopTimeDisplay();
                } else {
                    clearCountdownTimers();
                }

                // Re-render UI counters & table breakdown without reloading
                renderTimesheetBreakdown({
                    restore: {
                        startTime: timerStartTime || Date.now(),
                        target: targetTimestamp || new Date(),
                        alarmDismissed: remoteRem <= 0
                    }
                });
                updateLoggedDisplays();

                // Persist to local cache
                localStorage.setItem('snip8_cache_' + pin + '_' + (row.work_date || date), JSON.stringify(row));
                localStorage.setItem('snip8_detectedDays_' + pin + '_' + (row.work_date || date), JSON.stringify(detectedDays));
                saveSession();
            }
        }
    } catch (err) {
        console.warn('snip8: silent background handoff sync warning:', err.message || err);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.isLiveIncrement && targetTimestamp) {
        const targetMs = targetTimestamp instanceof Date ? targetTimestamp.getTime() : Number(targetTimestamp);
        const msRemaining = targetMs - Date.now();
        state.remainingSeconds = Math.max(0, Math.round(msRemaining / 1000));
        updateLoggedDisplays();
        updateStopTimeDisplay();
    }

    if (document.hidden) {
        handleGoingToBackground();
    } else {
        handleReturningToForeground();
    }
});

window.addEventListener('pagehide', () => {
    handleGoingToBackground();
});

window.addEventListener('pageshow', () => {
    handleReturningToForeground();
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

// Helper to dispatch remote stop signal to Springboard bridge
async function requestSpringboardStop() {
    const btn = document.getElementById('btnStopSpringboard');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Signaling Stop...';
    }

    // 1. Completely halt all countdown and display loops
    if (typeof countdownInterval !== 'undefined' && countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    if (window.countdownInterval) {
        clearInterval(window.countdownInterval);
        window.countdownInterval = null;
    }
    if (window.liveTimerInterval) {
        clearInterval(window.liveTimerInterval);
        window.liveTimerInterval = null;
    }
    clearCountdownTimers();

    // Commit any active elapsed time into base totals before zeroing timerStartTime
    const liveToggle = document.getElementById('liveIncrementToggle') || 
                       document.getElementById('liveIncrementSwitch');
    const wasLiveEnabled = liveToggle ? liveToggle.checked : state.isLiveIncrement;

    let elapsed = 0;
    if (wasLiveEnabled && timerStartTime && !timerCompleted) {
        elapsed = getElapsedSeconds();
        baseTodaySec += elapsed;
        baseTotalTrackedSec += elapsed;
        state.loggedSeconds = baseTodaySec;
        state.totalLoggedSeconds = baseTodaySec;
        state.remainingSeconds = Math.max(0, (state.dailyCapSeconds || TARGET_DAILY_SEC) - baseTodaySec);

        if (detectedDays[selectedDayIndex]) {
            detectedDays[selectedDayIndex].sec = baseTodaySec;
            detectedDays[selectedDayIndex].h = Math.floor(baseTodaySec / 3600);
            detectedDays[selectedDayIndex].m = Math.floor((baseTodaySec % 3600) / 60);
            detectedDays[selectedDayIndex].s = baseTodaySec % 60;
        }
    }

    // Nullify timestamps so background delta math stops recalculating
    timerStartTime = null;
    targetTimestamp = null;

    // Toggle off live increment state and UI
    if (liveToggle) {
        liveToggle.checked = false;
    }
    state.isLiveIncrement = false;
    try {
        localStorage.setItem(STORAGE_KEY_LIVE_INCREMENT, 'false');
    } catch (e) { }

    // Force a static UI redraw with current banked values
    updateLoggedDisplays();
    updateStopTimeDisplay();

    // 2. Update UI Status & Feedback
    setValidationProgress(100, '⏹️ Springboard timer stopped. Live countdown paused.', 'warning');

    const hint = document.getElementById('timerResumeHint');
    if (hint) {
        hint.textContent = '⏸️ Paused. When resuming on desktop, click Start timer on Springboard, then re-enable Live Increment or Sync.';
        hint.style.display = 'block';
    }

    // 3. Save Paused State immediately to Neon DB
    saveSession();
    if (typeof saveSessionToNeon === 'function') {
        saveSessionToNeon(baseTodaySec, state.remainingSeconds, detectedDays, null, {
            silent: true,
            isLiveIncrement: false
        });
    }

    // 4. Dispatch Remote Stop Signal to backend bridge
    try {
        const res = await fetch(`/api/timer-signal?pin=${encodeURIComponent(state.userPin || 'default')}&action=set`, {
            method: 'POST'
        });
        const data = await res.json();

        if (res.ok && data.success) {
            if (btn) btn.textContent = 'Stop Requested ⏹️';
        } else {
            throw new Error(data.error || 'Failed to dispatch stop signal');
        }
    } catch (err) {
        console.error('Remote stop failed:', err);
        setValidationProgress(100, `Bridge Warning: ${err.message}`, 'warning');
        if (btn) btn.textContent = '⏹️ Stop Springboard';
    } finally {
        if (btn) btn.disabled = false;
    }
}
window.requestSpringboardStop = requestSpringboardStop;

// ===== Cross-Device Stop Synchronization =====
function initCrossDeviceSyncListener() {
    if (window.crossDeviceSyncInterval) return;

    window.crossDeviceSyncInterval = setInterval(async () => {
        // Only check if local UI currently thinks it is ticking
        if (!state.isLiveIncrement) return;

        try {
            const pin = state.userPin || localStorage.getItem('snip8_user_pin');
            if (!pin) return;

            // Fetch the latest session state from snip8_sessions
            const res = await fetch(`/api/snip8-session?pin=${encodeURIComponent(pin)}`);
            if (!res.ok) return;
            const data = await res.json();

            // If remote session is explicitly paused, halt local ticking
            let td = data?.session?.timesheet_data;
            if (typeof td === 'string') {
                try { td = JSON.parse(td); } catch (e) { td = null; }
            }
            const remoteLive = td?.isLiveIncrement ?? data?.session?.timesheet_data?.isLiveIncrement ?? data?.session?.isLiveIncrement;

            if (remoteLive === false) {
                console.log('[snip8] Remote session is paused. Halting local countdown...');

                if (typeof countdownInterval !== 'undefined' && countdownInterval) {
                    clearInterval(countdownInterval);
                    countdownInterval = null;
                }
                if (window.countdownInterval) {
                    clearInterval(window.countdownInterval);
                    window.countdownInterval = null;
                }
                if (window.liveTimerInterval) {
                    clearInterval(window.liveTimerInterval);
                    window.liveTimerInterval = null;
                }
                clearCountdownTimers();

                timerStartTime = null;
                targetTimestamp = null;
                state.isLiveIncrement = false;
                try {
                    localStorage.setItem(STORAGE_KEY_LIVE_INCREMENT, 'false');
                } catch (e) { }

                const liveToggle = document.getElementById('liveIncrementToggle') || 
                                   document.getElementById('liveIncrementSwitch');
                if (liveToggle) liveToggle.checked = false;

                if (data.session.logged_seconds !== undefined && typeof data.session.logged_seconds === 'number' && data.session.logged_seconds > 0) {
                    baseTodaySec = Math.max(baseTodaySec, data.session.logged_seconds);
                    state.loggedSeconds = baseTodaySec;
                    state.totalLoggedSeconds = baseTodaySec;
                    state.remainingSeconds = Math.max(0, (state.dailyCapSeconds || TARGET_DAILY_SEC) - baseTodaySec);
                }

                updateLoggedDisplays();
                updateStopTimeDisplay();

                const hint = document.getElementById('timerResumeHint');
                if (hint) {
                    hint.textContent = '⏸️ Springboard stopped remotely. Local countdown paused.';
                    hint.style.display = 'block';
                }

                saveSession();
            } else if (state.isLiveIncrement && data && data.session) {
                // If remote session is live, prevent drift via wall-clock catch-up
                const catchUp = applyWallClockCatchUp(data.session, state.dailyCapSeconds || TARGET_DAILY_SEC);
                if (catchUp.loggedSeconds > (state.loggedSeconds || baseTodaySec)) {
                    baseTodaySec = catchUp.loggedSeconds;
                    state.loggedSeconds = catchUp.loggedSeconds;
                    state.totalLoggedSeconds = catchUp.loggedSeconds;
                    state.remainingSeconds = catchUp.remainingSeconds;
                    timerStartTime = Date.now();
                    targetTimestamp = new Date(Date.now() + catchUp.remainingSeconds * 1000);
                    updateLoggedDisplays();
                    updateStopTimeDisplay();
                }
            }
        } catch (err) {
            console.debug('[snip8 sync error]', err);
        }
    }, 10000); // Check every 10 seconds
}
window.initCrossDeviceSyncListener = initCrossDeviceSyncListener;

const btnStopSpringboard = document.getElementById('btnStopSpringboard');
if (btnStopSpringboard) {
    btnStopSpringboard.addEventListener('click', requestSpringboardStop);
}

// Helper to manually sync and refresh data from Neon DB
async function refreshSnip8Session() {
    const btn = document.getElementById('btnRefreshSession');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '🔄 Syncing...';
    }

    try {
        const pin = state.userPin || getUserPin();
        const todayStr = new Date().toLocaleDateString('en-CA');
        const workDate = state.workDate || todayStr;

        if (!pin) {
            openPinModal();
            updateNeonBadge('ready', 'Enter PIN');
            throw new Error('Please enter your PIN to sync');
        }

        updateNeonBadge('syncing', 'Syncing...');
        const res = await fetch(`/api/snip8-session?pin=${encodeURIComponent(pin)}&work_date=${encodeURIComponent(workDate)}`, {
            headers: { 'x-user-pin': pin }
        });

        if (res.status === 401) {
            clearUserPin();
            openPinModal();
            throw new Error('PIN unauthorized');
        }

        if (!res.ok) {
            throw new Error(`Server returned HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!data.success || !data.session) {
            throw new Error(data.error || 'Failed to retrieve cloud session');
        }

        const row = data.session;
        state.workDate = row.work_date || workDate;
        const dailyCap = Number(row.daily_cap_seconds) || TARGET_DAILY_SEC;

        const catchUp = applyWallClockCatchUp(row, dailyCap);
        const dbLogged = catchUp.loggedSeconds;
        const remSec = catchUp.remainingSeconds;

        state.loggedSeconds = dbLogged;
        state.totalLoggedSeconds = dbLogged;
        state.remainingSeconds = remSec;
        state.dailyCapSeconds = dailyCap;
        baseTodaySec = dbLogged;
        baseTotalTrackedSec = Math.max(baseTotalTrackedSec, dbLogged);
        totalTrackedSec = baseTotalTrackedSec;

        if (row.timesheet_data) {
            detectedDays = hydrateBreakdownFromTimesheetData(row.timesheet_data, row.work_date || workDate, dbLogged);
            state.detectedDays = detectedDays;
            state.timesheetData = detectedDays;
        }

        if (row.last_scanned_image_url) {
            state.lastScannedImageUrl = row.last_scanned_image_url;
            renderLatestScannedImage(row.last_scanned_image_url, row.updated_at);
        }

        const isRemoteRunning = catchUp.isRemoteRunning;
        state.isLiveIncrement = isRemoteRunning;
        const liveToggle = document.getElementById('liveIncrementToggle') || 
                           document.getElementById('liveIncrementSwitch');
        if (liveToggle) {
            liveToggle.checked = isRemoteRunning;
        }
        try {
            localStorage.setItem(STORAGE_KEY_LIVE_INCREMENT, String(isRemoteRunning));
        } catch (e) { }

        if (dbLogged >= dailyCap || remSec <= 0) {
            timerCompleted = true;
            completedElapsedSec = 0;
            state.isLiveIncrement = false;
            if (liveToggle) liveToggle.checked = false;
            clearCountdownTimers();
        } else if (state.isLiveIncrement) {
            timerCompleted = false;
            completedElapsedSec = 0;
            timerStartTime = Date.now();
            targetTimestamp = new Date(Date.now() + remSec * 1000);
            startCountdown();
            updateStopTimeDisplay();
            fetch(`/api/timer-signal?pin=${encodeURIComponent(pin)}&action=clear`, { method: 'POST' }).catch(() => {});
        } else {
            clearCountdownTimers();
        }

        // Update UI displays
        renderTimesheetBreakdown({
            restore: {
                startTime: timerStartTime || Date.now(),
                target: targetTimestamp || new Date(),
                alarmDismissed: remSec <= 0
            }
        });
        updateLoggedDisplays();
        updateSessionMeta('neon');
        updateNeonBadge('synced', 'Neon Synced');

        // Cache locally
        localStorage.setItem('snip8_cache_' + pin + '_' + (row.work_date || workDate), JSON.stringify(row));
        localStorage.setItem('snip8_detectedDays_' + pin + '_' + (row.work_date || workDate), JSON.stringify(detectedDays));
        saveSession();
        const hint = document.getElementById('timerResumeHint');
        if (hint) hint.style.display = 'none';

        setValidationProgress(100, 'Synced with Neon DB!', 'success');
        setTimeout(() => {
            const vp = document.getElementById('validationProgressContainer');
            if (vp) vp.style.display = 'none';
        }, 1500);
    } catch (err) {
        console.error('Manual refresh failed:', err);
        setValidationProgress(100, `Sync Error: ${err.message}`, 'error');
        setTimeout(() => {
            const vp = document.getElementById('validationProgressContainer');
            if (vp) vp.style.display = 'none';
        }, 2500);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '🔄 Sync';
        }
    }
}
window.refreshSnip8Session = refreshSnip8Session;

const refreshBtn = document.getElementById('btnRefreshSession');
if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshSnip8Session);
}

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
    springboardAutoStopped = false;
    const hint = document.getElementById('timerResumeHint');
    if (hint) hint.style.display = 'none';
    const btnSpringboard = document.getElementById('btnStopSpringboard');
    if (btnSpringboard) {
        btnSpringboard.textContent = '⏹️ Stop Springboard';
        btnSpringboard.disabled = false;
    }
});

document.getElementById('clearSessionBtn').addEventListener('click', () => {
    if (!confirm('Clear the saved timesheet session? You will need to paste a new screenshot.')) return;
    clearSession();
    const hint = document.getElementById('timerResumeHint');
    if (hint) hint.style.display = 'none';
    try {
        const pin = getUserPin();
        if (pin) {
            fetch('/api/snip8-session', {
                method: 'DELETE',
                headers: { 'x-user-pin': pin }
            }).catch(() => { });
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
    state.lastScannedImageUrl = null;
    renderLatestScannedImage(null);
    clearSyncUrl();
    closeSyncModal();
    springboardAutoStopped = false;
    const btnSpringboard = document.getElementById('btnStopSpringboard');
    if (btnSpringboard) {
        btnSpringboard.textContent = '⏹️ Stop Springboard';
        btnSpringboard.disabled = false;
    }
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

            setValidationProgress(50, 'Validating timesheet with Gemini Vision...');
            const handled = await triggerAiValidationFallback(b64, 'Manual override via "Re-parse with Gemini AI" button');
            if (handled) {
                // Explicitly call the Neon database save function immediately with master state values
                await saveSessionToNeon(state.loggedSeconds, state.remainingSeconds, state.timesheetData);
                setValidationProgress(100, 'Timesheet successfully synced!', 'success');
            } else {
                setValidationProgress(100, 'Failed to validate timesheet', 'error');
                alert('Gemini AI validation could not process the timesheet. Check your network connection or API key.');
                updateParseSourceBadge('ocr');
            }
        } catch (err) {
            console.error('snip8: forceAiBtn error', err);
            setValidationProgress(100, 'Failed to validate timesheet', 'error');
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
    // Do NOT overwrite Neon if an AI sync is committing or if the daily cap has already been reached
    if (state.isAiSyncing || baseTodaySec >= TARGET_DAILY_SEC || state.loggedSeconds >= TARGET_DAILY_SEC) {
        saveSession();
        return;
    }

    // Instant local persistence for offline reliability
    saveSession();

    // Debounced Neon write (1.5s) to preserve connection pool
    if (neonSaveTimeout) clearTimeout(neonSaveTimeout);
    neonSaveTimeout = setTimeout(() => {
        if (!state.isAiSyncing && baseTodaySec < TARGET_DAILY_SEC && state.loggedSeconds < TARGET_DAILY_SEC) {
            saveSessionToNeon();
        }
    }, 1500);
}

function getWorkDate() {
    return state.workDate || new Date().toLocaleDateString('en-CA');
}

const STORAGE_KEY_OFFLINE_QUEUE = 'snip8_offline_queue';

function queueOfflineMutation(pin, payload) {
    if (!pin || !payload) return;
    try {
        localStorage.setItem(STORAGE_KEY_OFFLINE_QUEUE, JSON.stringify({
            pin,
            payload,
            timestamp: Date.now()
        }));
    } catch (e) {
        console.warn('snip8: could not write to offline queue:', e);
    }
}

function clearOfflineMutation() {
    try {
        localStorage.removeItem(STORAGE_KEY_OFFLINE_QUEUE);
    } catch (e) { }
}

async function flushOfflineQueue() {
    try {
        const queuedRaw = localStorage.getItem(STORAGE_KEY_OFFLINE_QUEUE);
        if (!queuedRaw) return;
        const queued = JSON.parse(queuedRaw);
        if (!queued || !queued.payload || !queued.pin) {
            clearOfflineMutation();
            return;
        }

        updateNeonBadge('syncing', 'Syncing offline queue...');
        const res = await fetch('/api/snip8-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-user-pin': queued.pin
            },
            body: JSON.stringify(queued.payload)
        });

        if (res.ok) {
            clearOfflineMutation();
            updateNeonBadge('synced', 'Neon Synced');
            updateSessionMeta('neon_saved');
        } else if (res.status === 401) {
            clearUserPin();
            openPinModal();
        }
    } catch (err) {
        console.warn('snip8: flushOfflineQueue error:', err);
    }
}

function renderLatestScannedImage(imageUrl, timestamp = null) {
    const section = document.getElementById('scannedImageSection');
    const imgEl = document.getElementById('scannedImageElement');
    const linkEl = document.getElementById('openFullImageLink');
    const scanTimeEl = document.getElementById('imageScanTime');

    if (!imageUrl) {
        if (section) section.style.display = 'none';
        if (imgEl) imgEl.src = '';
        return;
    }

    if (section && imgEl) {
        // Append timestamp query parameter to bust browser cache on replaced single-asset uploads
        const bustUrl = imageUrl.includes('?') ? `${imageUrl}&t=${Date.now()}` : `${imageUrl}?t=${Date.now()}`;
        imgEl.src = bustUrl;
        if (linkEl) linkEl.href = imageUrl;
        if (scanTimeEl) {
            const d = timestamp ? new Date(timestamp) : new Date();
            scanTimeEl.textContent = `• Scanned ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }
        section.style.display = 'block';
    }
}
window.renderLatestScannedImage = renderLatestScannedImage;

function initImagePreviewCard() {
    const toggleBtn = document.getElementById('toggleImagePreviewBtn');
    const previewContainer = document.getElementById('imagePreviewContainer');
    const chevron = document.getElementById('previewChevron');

    if (toggleBtn && previewContainer) {
        toggleBtn.addEventListener('click', (e) => {
            if (e.target.id === 'openFullImageLink') return;
            const isHidden = previewContainer.style.display === 'none';
            previewContainer.style.display = isHidden ? 'block' : 'none';
            if (chevron) chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
        });
    }
}
window.initImagePreviewCard = initImagePreviewCard;

async function uploadScreenshotToCloudinary(base64Data, userPin) {
    if (!base64Data || !userPin) return null;

    try {
        const res = await fetch('/api/upload-screenshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageBase64: base64Data,
                user_pin: userPin,
            }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.secure_url) {
            state.lastScannedImageUrl = data.secure_url;
            try {
                localStorage.setItem(`snip8_last_img_${userPin}`, data.secure_url);
            } catch (e) { }

            renderLatestScannedImage(data.secure_url);

            // Update Neon immediately with the new image URL
            await saveSessionToNeon(state.loggedSeconds, state.remainingSeconds, state.timesheetData, data.secure_url);
            return data.secure_url;
        }
    } catch (err) {
        console.warn('Background Cloudinary upload failed:', err);
    }
    return null;
}
window.uploadScreenshotToCloudinary = uploadScreenshotToCloudinary;
const uploadScreenshotAsync = uploadScreenshotToCloudinary;
window.uploadScreenshotAsync = uploadScreenshotAsync;

async function saveSessionToNeon(overrideLoggedSec = null, overrideRemSec = null, overrideTimesheetData = null, overrideImageUrl = null, options = {}) {
    // Cancel any pending debounced save so stale ticker/OCR cannot overwrite
    if (neonSaveTimeout) {
        clearTimeout(neonSaveTimeout);
        neonSaveTimeout = null;
    }

    if (overrideImageUrl) {
        state.lastScannedImageUrl = overrideImageUrl;
    }

    const isExplicit = overrideLoggedSec !== null && overrideLoggedSec !== undefined;

    let currentTodaySec;
    let remSec;
    let timesheetDataToSave;

    if (isExplicit) {
        currentTodaySec = overrideLoggedSec;
        remSec = overrideRemSec !== null && overrideRemSec !== undefined
            ? overrideRemSec
            : Math.max(0, TARGET_DAILY_SEC - currentTodaySec);
        timesheetDataToSave = overrideTimesheetData || (state.timesheetData && state.timesheetData.length ? state.timesheetData : detectedDays);
    } else {
        if (detectedDays.length === 0 && !targetTimestamp && !state.lastScannedImageUrl && state.loggedSeconds === 0) return;

        // Freeze on Cap: If daily cap has been reached or timer completed, do not increment further or decrease logged_seconds
        if (state.loggedSeconds >= TARGET_DAILY_SEC || baseTodaySec >= TARGET_DAILY_SEC) {
            currentTodaySec = Math.max(baseTodaySec, state.loggedSeconds, TARGET_DAILY_SEC);
            remSec = 0;
        } else {
            const isLiveEnabled = liveIncrementToggle ? liveIncrementToggle.checked : true;
            let elapsed = 0;
            if (isLiveEnabled && timerStartTime) {
                elapsed = timerCompleted ? completedElapsedSec : getElapsedSeconds();
            }
            currentTodaySec = baseTodaySec + elapsed;
            remSec = Math.max(0, TARGET_DAILY_SEC - currentTodaySec);
        }
        timesheetDataToSave = (state.timesheetData && state.timesheetData.length ? state.timesheetData : detectedDays);
    }

    if (currentTodaySec >= TARGET_DAILY_SEC) {
        remSec = 0;
    }

    // Sync master state directly
    state.loggedSeconds = currentTodaySec;
    state.totalLoggedSeconds = currentTodaySec;
    state.remainingSeconds = remSec;
    state.timesheetData = timesheetDataToSave;
    state.detectedDays = detectedDays;

    const pin = state.userPin || getUserPin();
    state.userPin = pin;
    const todayStr = new Date().toLocaleDateString('en-CA');
    const targetScanDate = state.workDate || todayStr;
    const workDate = targetScanDate;
    const imageUrl = overrideImageUrl || state.lastScannedImageUrl || null;

    const activeDay = (detectedDays && detectedDays.length > selectedDayIndex && detectedDays[selectedDayIndex])
        ? detectedDays[selectedDayIndex]
        : (detectedDays && detectedDays[0]);

    const liveToggle = document.getElementById('liveIncrementToggle') || 
                       document.getElementById('liveIncrementSwitch');
    const isLiveIncrement = options.isLiveIncrement !== undefined
        ? Boolean(options.isLiveIncrement)
        : (liveToggle ? liveToggle.checked : (state.isLiveIncrement !== undefined ? state.isLiveIncrement : true));

    const cleanDayLabel = (activeDay && activeDay.label)
        ? activeDay.label.replace(/\s*\(AI\)/i, '').trim()
        : formatDayLabel(targetScanDate);

    const payloadTimesheetData = {
        dayLabel: cleanDayLabel,
        workDate: targetScanDate,
        blocks: (activeDay && activeDay.shifts) || [],
        days: detectedDays,
        isLiveIncrement: isLiveIncrement
    };

    const payload = {
        user_pin: pin,
        work_date: workDate,
        total_seconds_remaining: remSec,
        daily_cap_seconds: TARGET_DAILY_SEC,
        logged_seconds: currentTodaySec,
        timesheet_data: payloadTimesheetData,
        last_scanned_image_url: imageUrl,
        isLiveIncrement: isLiveIncrement,
        updated_at: new Date().toISOString()
    };

    // Before dispatching saveSessionToNeon(), verify payload.work_date === todayStr (or the targeted scan date)
    if (payload.work_date !== todayStr && payload.work_date !== targetScanDate) {
        payload.work_date = targetScanDate;
    }

    // Always persist immediately to local PWA cache & session keys (offline-first)
    // Separate Cache per Day:
    if (state.userPin && state.workDate) {
        localStorage.setItem('snip8_cache_' + state.userPin + '_' + state.workDate, JSON.stringify(payload));
        localStorage.setItem('snip8_detectedDays_' + state.userPin + '_' + state.workDate, JSON.stringify(detectedDays));
    } else if (pin) {
        localStorage.setItem('snip8_cache_' + pin + '_' + payload.work_date, JSON.stringify(payload));
        localStorage.setItem('snip8_detectedDays_' + pin + '_' + payload.work_date, JSON.stringify(detectedDays));
    }
    localStorage.setItem('snip8_detectedDays', JSON.stringify(detectedDays));
    saveSession();

    if (!pin) {
        if (!options.silent && !options.keepalive) {
            updateNeonBadge('ready', 'Enter PIN');
            openPinModal();
        }
        return;
    }

    // Offline Mutation Queue: if offline, queue update and return safely
    if (!navigator.onLine) {
        queueOfflineMutation(pin, payload);
        if (!options.silent) {
            updateNeonBadge('offline', 'Saved Locally (Offline)');
        }
        return;
    }

    try {
        state.isAiSyncing = true;
        if (!options.silent) {
            updateNeonBadge('syncing', 'Saving...');
        }

        const fetchOpts = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-user-pin': pin
            },
            body: JSON.stringify(payload)
        };
        if (options.keepalive) {
            fetchOpts.keepalive = true;
        }

        const res = await fetch('/api/snip8-session', fetchOpts);

        if (res.status === 401) {
            clearUserPin();
            if (!options.silent && !options.keepalive) {
                updateNeonBadge('offline', 'PIN Required');
                openPinModal();
            }
            return;
        }

        if (res.ok) {
            clearOfflineMutation();
            if (!options.silent) {
                updateNeonBadge('synced', 'Neon Synced');
            }
            updateSessionMeta('neon_saved');
        } else {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (err) {
        if (options.keepalive && navigator.sendBeacon) {
            try {
                const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
                navigator.sendBeacon('/api/snip8-session', blob);
            } catch (bErr) { }
        }
        console.warn('snip8: Neon save error (queued offline):', err.message);
        queueOfflineMutation(pin, payload);
        if (!options.silent) {
            updateNeonBadge('offline', 'Saved Locally');
        }
    } finally {
        state.isAiSyncing = false;
    }
}
window.saveSessionToNeon = saveSessionToNeon;
const saveToNeon = saveSessionToNeon;

// Immediate Local Hydration helper
function loadCachedSession(userPin = getUserPin(), workDate = getWorkDate()) {
    if (!userPin) return false;
    try {
        const todayStr = new Date().toLocaleDateString('en-CA');
        state.userPin = userPin;

        // 1. Locate cache: first look for exact match on workDate
        let cachedRaw = localStorage.getItem(`snip8_cache_${userPin}_${workDate}`);
        let isOlderDate = false;
        let cachedDate = '';

        // If no cache for workDate (or if workDate is older than today), check any older cached session
        if (!cachedRaw) {
            const allKeys = Object.keys(localStorage);
            const prefix = `snip8_cache_${userPin}_`;
            const matchingKeys = allKeys.filter(k => k.startsWith(prefix)).sort().reverse();
            if (matchingKeys.length > 0) {
                const latestKey = matchingKeys[0];
                cachedRaw = localStorage.getItem(latestKey);
                const dateSuffix = latestKey.slice(prefix.length);
                cachedDate = dateSuffix;
                if (dateSuffix && dateSuffix < todayStr) {
                    isOlderDate = true;
                }
            }
        }

        if (!cachedRaw) return false;
        const row = JSON.parse(cachedRaw);
        if (!row || typeof row !== 'object') return false;

        if (!cachedDate) {
            cachedDate = row.work_date || (row.updated_at ? new Date(row.updated_at).toLocaleDateString('en-CA') : '');
        }
        if (cachedDate && cachedDate < todayStr) {
            isOlderDate = true;
        }

        // If cached session is older than todayStr (e.g. yesterday 2026-10-22 vs today 2026-10-23):
        if (isOlderDate) {
            state.workDate = todayStr;
            state.loggedSeconds = 0;
            state.remainingSeconds = TARGET_DAILY_SEC;
            baseTodaySec = 0;
            timerStartTime = null;
            targetTimestamp = null;
            timerCompleted = false;
            completedElapsedSec = 0;
            clearCountdownTimers();

            let days = row.timesheet_data;
            if (typeof days === 'string') {
                try { days = JSON.parse(days); } catch (e) { days = []; }
            }
            const historicalDays = Array.isArray(days) ? days : [];

            if (historicalDays.length > 0) {
                detectedDays = historicalDays.map((d, i) => {
                    const h = Number(d && d.h) || 0;
                    const m = Number(d && d.m) || 0;
                    const s = Number(d && d.s) || 0;
                    let label = String((d && d.label) || `Day ${i + 1}`);
                    if (/^today\b/i.test(label)) {
                        label = cachedDate ? `Past (${cachedDate})` : `Day ${i + 1}`;
                    }
                    return {
                        label,
                        dayName: String((d && d.dayName) || ''),
                        h, m, s,
                        sec: (d.sec !== undefined && d.sec !== null) ? Number(d.sec) : (h * 3600 + m * 60 + s),
                        shifts: d.shifts || []
                    };
                });
            } else if (Number(row.logged_seconds) > 0) {
                const histLabel = cachedDate || 'Yesterday';
                const logged = Number(row.logged_seconds);
                detectedDays = [{
                    label: histLabel,
                    dayName: histLabel.split(' ')[0] || '',
                    h: Math.floor(logged / 3600),
                    m: Math.floor((logged % 3600) / 60),
                    s: logged % 60,
                    sec: logged,
                    shifts: []
                }];
            } else {
                detectedDays = [];
            }

            // Reset / create active day tab index for Today
            const now = new Date();
            const todayDayName = now.toLocaleDateString('en-US', { weekday: 'short' });
            const todayLabel = now.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

            let todayIdx = detectedDays.findIndex(d => d.label.toLowerCase().includes(todayLabel.toLowerCase()) || (d.dayName && d.dayName.toLowerCase() === todayDayName.toLowerCase() && !d.label.includes('Past')));
            if (todayIdx === -1) {
                detectedDays.push({
                    label: todayLabel,
                    dayName: todayDayName,
                    h: 0, m: 0, s: 0, sec: 0,
                    shifts: []
                });
                todayIdx = detectedDays.length - 1;
            } else {
                detectedDays[todayIdx].h = 0;
                detectedDays[todayIdx].m = 0;
                detectedDays[todayIdx].s = 0;
                detectedDays[todayIdx].sec = 0;
                detectedDays[todayIdx].shifts = [];
            }
            selectedDayIndex = todayIdx;

            totalTrackedSec = detectedDays.reduce((acc, d) => acc + d.sec, 0);
            baseTotalTrackedSec = totalTrackedSec;
            state.timesheetData = detectedDays;

            if (row.last_scanned_image_url) {
                state.lastScannedImageUrl = row.last_scanned_image_url;
                renderLatestScannedImage(row.last_scanned_image_url, row.updated_at);
            }

            renderAll();
            updateLoggedDisplays();
            updateNeonBadge('offline', 'Ready for Today');
            rawOcrText.textContent = `(Rolled over to ${todayStr} • PIN ${maskPin(userPin)} • Historical days preserved)`;
            saveSession();
            return true;
        }

        // Normal path: current/today's cached session
        state.workDate = row.work_date || workDate || todayStr;
        const dailyCap = Number(row.daily_cap_seconds) || TARGET_DAILY_SEC;
        const catchUp = applyWallClockCatchUp(row, dailyCap);
        const logged = catchUp.loggedSeconds;
        const rem = catchUp.remainingSeconds;

        state.loggedSeconds = logged;
        state.remainingSeconds = rem;
        if (row.last_scanned_image_url) {
            state.lastScannedImageUrl = row.last_scanned_image_url;
            renderLatestScannedImage(row.last_scanned_image_url, row.updated_at);
        } else {
            try {
                const localImg = localStorage.getItem(`snip8_last_img_${userPin}`);
                if (localImg) {
                    state.lastScannedImageUrl = localImg;
                    renderLatestScannedImage(localImg);
                }
            } catch (e) { }
        }

        detectedDays = hydrateBreakdownFromTimesheetData(row.timesheet_data, state.workDate, logged);
        state.detectedDays = detectedDays;
        state.timesheetData = detectedDays;

        selectedDayIndex = 0;
        baseTodaySec = logged;
        baseTotalTrackedSec = Math.max(totalTrackedSec, logged);
        totalTrackedSec = baseTotalTrackedSec;

        const updatedAt = new Date(row.updated_at || Date.now());
        const target = new Date(Date.now() + rem * 1000);

        if (logged >= TARGET_DAILY_SEC || rem <= 0) {
            timerCompleted = true;
            completedElapsedSec = 0;
            clearCountdownTimers();
        } else if (state.isLiveIncrement && catchUp.isRemoteRunning) {
            timerStartTime = Date.now();
            targetTimestamp = target;
            startCountdown();
            updateStopTimeDisplay();
        }

        renderTimesheetBreakdown({
            restore: {
                startTime: updatedAt.getTime(),
                target,
                alarmDismissed: rem <= 0
            }
        });

        updateLoggedDisplays();
        updateNeonBadge('offline', 'Local Cache');
        rawOcrText.textContent = `(Session restored from local offline cache • PIN ${maskPin(userPin)} • ${formatHms(logged)} logged.)`;
        return true;
    } catch (e) {
        console.warn('snip8: error loading cached session:', e);
        return false;
    }
}

// Background Neon Revalidation with Monotonic Guard
async function revalidateNeonSession(userPin = getUserPin(), workDate = getWorkDate()) {
    if (!userPin) return false;
    if (!navigator.onLine) {
        updateNeonBadge('offline', 'Offline Mode');
        return false;
    }

    try {
        updateNeonBadge('syncing', 'Checking cloud...');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const url = `/api/snip8-session?user_pin=${encodeURIComponent(userPin)}&work_date=${encodeURIComponent(workDate)}`;
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'x-user-pin': userPin
            }
        });
        clearTimeout(timeoutId);

        if (res.status === 401) {
            clearUserPin();
            updateNeonBadge('offline', 'PIN Required');
            openPinModal();
            return false;
        }

        if (!res.ok) {
            updateNeonBadge('offline', 'Offline Mode');
            return false;
        }

        const data = await res.json();
        if (!data.success || !data.session) {
            updateNeonBadge('ready', 'Neon Ready');
            return false;
        }

        const row = data.session;
        if (row.is_fresh_default) {
            updateNeonBadge('ready', 'Neon Ready');
            return true;
        }

        const localLogged = state.loggedSeconds || 0;
        const dailyCap = Number(row.daily_cap_seconds) || TARGET_DAILY_SEC;
        const catchUp = applyWallClockCatchUp(row, dailyCap);
        const dbLogged = catchUp.loggedSeconds;
        const remSec = catchUp.remainingSeconds;

        // Monotonic Guard: Only accept DB state if it is higher than local,
        // or if DB has completed (>= 28800), or if local is completely uninitialized (0).
        if (dbLogged >= 28800 || dbLogged > localLogged || localLogged === 0) {
            state.loggedSeconds = dbLogged;
            state.remainingSeconds = remSec;
            if (row.last_scanned_image_url) {
                state.lastScannedImageUrl = row.last_scanned_image_url;
                renderLatestScannedImage(row.last_scanned_image_url, row.updated_at);
            }

            detectedDays = hydrateBreakdownFromTimesheetData(row.timesheet_data, row.work_date || workDate, dbLogged);
            state.detectedDays = detectedDays;
            state.timesheetData = detectedDays;
            selectedDayIndex = 0;
            baseTodaySec = dbLogged;
            baseTotalTrackedSec = Math.max(totalTrackedSec, dbLogged);
            totalTrackedSec = baseTotalTrackedSec;

            const isRemoteRunning = catchUp.isRemoteRunning;
            state.isLiveIncrement = isRemoteRunning;
            const liveToggle = document.getElementById('liveIncrementToggle') || 
                               document.getElementById('liveIncrementSwitch');
            if (liveToggle) {
                liveToggle.checked = isRemoteRunning;
            }
            try {
                localStorage.setItem(STORAGE_KEY_LIVE_INCREMENT, String(isRemoteRunning));
            } catch (e) { }

            if (dbLogged >= TARGET_DAILY_SEC || remSec <= 0) {
                timerCompleted = true;
                completedElapsedSec = 0;
                state.isLiveIncrement = false;
                if (liveToggle) liveToggle.checked = false;
                clearCountdownTimers();
            } else if (state.isLiveIncrement) {
                timerCompleted = false;
                completedElapsedSec = 0;
                timerStartTime = Date.now();
                targetTimestamp = new Date(Date.now() + remSec * 1000);
                startCountdown();
            } else {
                clearCountdownTimers();
            }

            // Update local cache to match the verified remote state
            localStorage.setItem('snip8_cache_' + userPin + '_' + (row.work_date || workDate), JSON.stringify(row));
            localStorage.setItem('snip8_detectedDays_' + userPin + '_' + (row.work_date || workDate), JSON.stringify(detectedDays));
            localStorage.setItem('snip8_detectedDays', JSON.stringify(detectedDays));
            saveSession();

            const updatedAt = new Date(row.updated_at || Date.now());
            const target = targetTimestamp || new Date(Date.now() + state.remainingSeconds * 1000);
            renderTimesheetBreakdown({
                restore: {
                    startTime: updatedAt.getTime(),
                    target,
                    alarmDismissed: state.remainingSeconds <= 0
                }
            });

            updateLoggedDisplays();
            updateSessionMeta('neon');
            updateNeonBadge('synced', 'Neon Synced');
            rawOcrText.textContent = `(Session restored from Neon PostgreSQL for today • PIN ${maskPin(userPin)} • last updated ${formatClock(updatedAt)}.)`;
            return true;
        } else {
            if (row.last_scanned_image_url) {
                state.lastScannedImageUrl = row.last_scanned_image_url;
                renderLatestScannedImage(row.last_scanned_image_url, row.updated_at);
            }
            if (localLogged > dbLogged) {
                // Local device progressed while offline; sync new progress up to Neon
                updateNeonBadge('syncing', 'Syncing local progress...');
                debouncedSaveSession();
                return true;
            } else {
                updateNeonBadge('synced', 'Neon Synced');
                return true;
            }
        }
    } catch (err) {
        console.warn('snip8: could not revalidate session from Neon (offline/error):', err.message);
        updateNeonBadge('offline', 'Offline Mode');
        return false;
    }
}

async function fetchNeonSession() {
    return await revalidateNeonSession(getUserPin(), getWorkDate());
}

async function loadSessionFromNeon(userPin = getUserPin(), workDate = getWorkDate()) {
    return await revalidateNeonSession(userPin, workDate);
}
window.loadSessionFromNeon = loadSessionFromNeon;

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

        const pin = state.userPin || getUserPin();
        const workDate = state.workDate || getWorkDate();
        const activeDay = (detectedDays && detectedDays.length > selectedDayIndex && detectedDays[selectedDayIndex])
            ? detectedDays[selectedDayIndex]
            : (detectedDays && detectedDays[0]);

        const cleanDayLabel = (activeDay && activeDay.label)
            ? activeDay.label.replace(/\s*\(AI\)/i, '').trim()
            : formatDayLabel(workDate);

        const payloadTimesheetData = {
            dayLabel: cleanDayLabel,
            workDate: workDate,
            blocks: (activeDay && activeDay.shifts) || [],
            days: detectedDays
        };

        state.detectedDays = detectedDays;
        state.timesheetData = detectedDays;

        if (pin && workDate) {
            const cachePayload = {
                user_pin: pin,
                work_date: workDate,
                total_seconds_remaining: state.remainingSeconds,
                daily_cap_seconds: TARGET_DAILY_SEC,
                logged_seconds: state.loggedSeconds,
                timesheet_data: payloadTimesheetData,
                last_scanned_image_url: state.lastScannedImageUrl || null,
                updated_at: new Date().toISOString()
            };
            localStorage.setItem('snip8_cache_' + pin + '_' + workDate, JSON.stringify(cachePayload));
            localStorage.setItem('snip8_detectedDays_' + pin + '_' + workDate, JSON.stringify(detectedDays));
        }
        return true;
    } catch (e) {
        console.warn('snip8: could not save session', e);
        return false;
    }
}

function loadSession() {
    try {
        const days = readJSON(SESSION_KEYS.detectedDays);
        const workDate = state.workDate || getWorkDate();
        const cleanDays = hydrateBreakdownFromTimesheetData(days, workDate, state.loggedSeconds);
        if (!Array.isArray(cleanDays) || cleanDays.length === 0) return null;

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
    const todayStr = new Date().toLocaleDateString('en-CA');
    const sessionDate = session.lastUpdated ? new Date(session.lastUpdated).toLocaleDateString('en-CA') : '';

    if (sessionDate && sessionDate < todayStr) {
        clearSession();
        state.workDate = todayStr;
        return false;
    }

    if (!isWithinTodayWindow(session.targetTimestamp, now)) {
        clearSession(); // stale (previous day) — start fresh
        return false;
    }

    detectedDays = session.detectedDays;
    state.detectedDays = detectedDays;
    state.timesheetData = detectedDays;
    selectedDayIndex = session.selectedDayIndex;
    totalTrackedSec = session.totalTrackedSec;

    const expiredMs = now - session.targetTimestamp;
    const acknowledged = session.alarmAckTarget === session.targetTimestamp.toISOString();

    renderTimesheetBreakdown({
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
    if (syncModal && syncModal.open) {
        const url = buildSyncUrl();
        if (!url) return;
        try { history.replaceState(null, '', url); } catch (e) { /* e.g. sandboxed iframe */ }
        renderSyncModal();
    }
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
    clearSyncUrl();
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

if (syncMobileBtn) {
    syncMobileBtn.addEventListener('click', openSyncModal);
}
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
        state.userPin = enteredPin;
        updatePinUI();
        closePinModal();

        const todayStr = new Date().toLocaleDateString('en-CA');
        state.workDate = state.workDate || todayStr;
        const workDate = state.workDate;
        const cachedLoaded = loadCachedSession(enteredPin, workDate);
        if (!cachedLoaded) {
            hydrateSession();
        }

        if (navigator.onLine) {
            if (window.lastUploadedTimesheetBase64 && !state.lastScannedImageUrl) {
                uploadScreenshotToCloudinary(window.lastUploadedTimesheetBase64, enteredPin);
            }
            await flushOfflineQueue();
            await revalidateNeonSession(enteredPin, workDate);
        } else {
            updateNeonBadge('offline', 'Offline Mode');
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

// ===== Tab Navigation & Settings Management =====
function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

    const targetTab = document.getElementById(tabName + 'Tab');
    const targetBtn = document.getElementById(tabName + 'TabBtn');
    if (targetTab) targetTab.classList.remove('hidden');
    if (targetBtn) targetBtn.classList.add('active');
}
window.switchTab = switchTab;

function initTabsAndSettings() {
    // 1. Tab switching buttons
    const timerTabBtn = document.getElementById('timerTabBtn');
    const instructionsTabBtn = document.getElementById('instructionsTabBtn');
    if (timerTabBtn) timerTabBtn.addEventListener('click', () => switchTab('timer'));
    if (instructionsTabBtn) instructionsTabBtn.addEventListener('click', () => switchTab('instructions'));

    // 2. Bookmarklet copy button
    const copyBookmarkletBtn = document.getElementById('copyBookmarkletCodeBtn');
    const copyBookmarkletBtnText = document.getElementById('copyBookmarkletBtnText');
    if (copyBookmarkletBtn) {
        copyBookmarkletBtn.addEventListener('click', async () => {
            const bookmarkletCode = "javascript:(function(){if(window._sbSyncBridgeRunning){alert('Sync Bridge is already running.');return;}let p=localStorage.getItem('snip8_bridge_pin')||localStorage.getItem('snip8_user_pin');if(!p){p=prompt('Enter your 6-digit snip8 PIN:');if(!p)return;localStorage.setItem('snip8_bridge_pin',p.trim());}window._sbSyncBridgeRunning=true;const t=document.createElement('div');t.innerText='Sync Bridge Connected (PIN: '+p+')';t.style.cssText='position:fixed;bottom:16px;right:16px;background:#10b981;color:#fff;padding:8px 14px;border-radius:6px;font-size:12px;z-index:999999;box-shadow:0 4px 6px rgba(0,0,0,0.15);font-family:sans-serif;pointer-events:none;transition:opacity 0.5s ease;';document.body.appendChild(t);setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),500);},3000);setInterval(async()=>{try{const r=await fetch('https://snip8-eight.vercel.app/api/timer-signal?pin='+encodeURIComponent(p));if(!r.ok)return;const d=await r.json();if(d&&d.stop_requested){const b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim().toLowerCase().includes('stop timer'));if(b){b.click();}await fetch('https://snip8-eight.vercel.app/api/timer-signal?pin='+encodeURIComponent(p)+'&action=clear',{method:'POST'});}}catch(e){}},10000);})();";
            try {
                await navigator.clipboard.writeText(bookmarkletCode);
                if (copyBookmarkletBtnText) {
                    const originalText = copyBookmarkletBtnText.textContent;
                    copyBookmarkletBtnText.textContent = '✓ Copied to Clipboard!';
                    setTimeout(() => {
                        copyBookmarkletBtnText.textContent = originalText;
                    }, 2500);
                }
            } catch (err) {
                prompt('Copy bookmarklet code below:', bookmarkletCode);
            }
        });
    }

    // 3. Settings Modal
    const settingsModal = document.getElementById('settingsModal');
    const settingsModalBtn = document.getElementById('settingsModalBtn');
    const settingsModalClose = document.getElementById('settingsModalClose');
    const settingsPinInput = document.getElementById('settingsPinInput');
    const saveSettingsPinBtn = document.getElementById('saveSettingsPinBtn');
    const settingsPinVal = document.getElementById('settingsPinVal');
    const settingsStatusDot = document.getElementById('settingsStatusDot');
    const settingsStatusText = document.getElementById('settingsStatusText');
    const settingsLastPing = document.getElementById('settingsLastPing');
    const settingsResetTimerBtn = document.getElementById('settingsResetTimerBtn');
    const settingsClearSessionBtn = document.getElementById('settingsClearSessionBtn');
    const dailyCapHoursInput = document.getElementById('dailyCapHoursInput');

    function updateSettingsModalUI() {
        const pin = getUserPin() || (localStorage.getItem('snip8_bridge_pin') || '').trim();
        if (settingsPinVal) {
            settingsPinVal.textContent = pin ? maskPin(pin) + ` (${pin})` : 'None';
        }
        if (settingsPinInput && pin) {
            settingsPinInput.value = pin;
        }

        const capSec = state.dailyCapSeconds || TARGET_DAILY_SEC;
        if (dailyCapHoursInput) {
            dailyCapHoursInput.value = (capSec / 3600).toFixed(1);
        }

        const badgeLabel = document.getElementById('neonSyncLabel');
        const badgeText = badgeLabel ? badgeLabel.textContent : 'Neon Ready';
        if (settingsStatusText) {
            settingsStatusText.textContent = badgeText;
        }
        if (settingsLastPing) {
            settingsLastPing.textContent = 'PIN: ' + (pin ? maskPin(pin) : 'Not configured');
        }
    }

    if (settingsModalBtn) {
        settingsModalBtn.addEventListener('click', () => {
            updateSettingsModalUI();
            if (settingsModal) {
                if (typeof settingsModal.showModal === 'function') {
                    if (!settingsModal.open) settingsModal.showModal();
                } else {
                    settingsModal.setAttribute('open', '');
                }
            }
        });
    }

    if (settingsModalClose) {
        settingsModalClose.addEventListener('click', () => {
            if (settingsModal) {
                if (typeof settingsModal.close === 'function') settingsModal.close();
                else settingsModal.removeAttribute('open');
            }
        });
    }

    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                if (typeof settingsModal.close === 'function') settingsModal.close();
                else settingsModal.removeAttribute('open');
            }
        });
    }

    if (saveSettingsPinBtn && settingsPinInput) {
        saveSettingsPinBtn.addEventListener('click', () => {
            const entered = (settingsPinInput.value || '').trim();
            if (!/^\d{4,8}$/.test(entered)) {
                alert('Please enter a 4–8 digit numeric PIN.');
                return;
            }
            try {
                localStorage.setItem(STORAGE_KEY_PIN, entered);
                localStorage.setItem('snip8_bridge_pin', entered);
            } catch (e) { }
            state.userPin = entered;
            updatePinUI();
            updateSettingsModalUI();
            saveSettingsPinBtn.textContent = '✓ Saved!';
            setTimeout(() => {
                saveSettingsPinBtn.textContent = 'Save PIN';
            }, 1500);
            if (navigator.onLine) {
                revalidateNeonSession(entered, state.workDate || getWorkDate());
            }
        });
    }

    if (dailyCapHoursInput) {
        dailyCapHoursInput.addEventListener('change', () => {
            const h = parseFloat(dailyCapHoursInput.value);
            if (h && h > 0 && h <= 24) {
                const newCapSec = Math.round(h * 3600);
                state.dailyCapSeconds = newCapSec;
                state.remainingSeconds = Math.max(0, newCapSec - (state.loggedSeconds || baseTodaySec || 0));
                updateLoggedDisplays();
                updateStopTimeDisplay();
                debouncedSaveSession();
            }
        });
    }

    if (settingsResetTimerBtn) {
        settingsResetTimerBtn.addEventListener('click', () => {
            const mainReset = document.getElementById('resetBtn');
            if (mainReset) mainReset.click();
            if (settingsModal && typeof settingsModal.close === 'function') settingsModal.close();
        });
    }

    if (settingsClearSessionBtn) {
        settingsClearSessionBtn.addEventListener('click', () => {
            const mainClear = document.getElementById('clearSessionBtn');
            if (mainClear) mainClear.click();
            if (settingsModal && typeof settingsModal.close === 'function') settingsModal.close();
        });
    }
}

// Offline Mutation Queue: Automatic flush when network connectivity resumes
window.addEventListener('online', async () => {
    updateNeonBadge('syncing', 'Back online...');
    await flushOfflineQueue();
    const userPin = getUserPin();
    const workDate = getWorkDate();
    if (userPin) {
        await revalidateNeonSession(userPin, workDate);
    }
});

window.addEventListener('offline', () => {
    updateNeonBadge('offline', 'Offline Mode');
});

// Initialize offline-first PWA storage with monotonic state reconciliation
async function initApp() {
    // 1. Immediately purge address bar parameters to protect against stale cache / URL parameter overwrites
    try {
        window.history.replaceState({}, '', window.location.pathname);
    } catch (e) { }

    Snip8Theme.init();
    initLiveIncrementToggle();
    initCrossDeviceSyncListener();
    initImagePreviewCard();
    initTabsAndSettings();
    updatePinUI();

    // Compute today's date in local time:
    const todayStr = new Date().toLocaleDateString('en-CA'); // 'YYYY-MM-DD'
    state.workDate = todayStr;
    const userPin = getUserPin();
    state.userPin = userPin;

    // 2. Check for PIN
    if (!userPin) {
        openPinModal();
        updateNeonBadge('ready', 'Enter PIN');
        hydrateSession();
        return;
    }

    // 3. Immediate Local Hydration (Stale-While-Revalidate):
    // Load active user session from localStorage snip8_cache_${userPin}_${workDate}
    const cachedLoaded = loadCachedSession(userPin, state.workDate);
    if (!cachedLoaded) {
        const localLoaded = hydrateSession();
        if (!localLoaded) {
            updateNeonBadge('ready', 'Neon Ready');
        }
    }

    // 4. Background Neon Revalidation (non-blocking)
    if (navigator.onLine) {
        (async () => {
            await flushOfflineQueue();
            await revalidateNeonSession(userPin, state.workDate);
        })().catch(e => {
            console.warn('snip8: background revalidation error:', e);
        });
    } else {
        updateNeonBadge('offline', 'Offline Mode');
    }
}
window.initApp = initApp;
const init = initApp;

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
