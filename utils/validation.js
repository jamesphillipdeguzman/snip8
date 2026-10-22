/**
 * Timesheet Validation & AI Vision Fallback Utility for snip8
 */

export const Snip8Validation = {
    /**
     * Common keywords/tokens that indicate a timesheet image contains shift data
     */
    SHIFT_TOKENS: [
        /\b(?:total|tracked|time|duration|shift|clock|hours?|hrs?|mins?|seconds?|secs?)\b/i,
        /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i,
        /\b(?:mon|tue|wed|thu|fri|sat|sun)\b/i,
        /\b(?:in|out|break)\b/i
    ],

    /**
     * Extracts shift intervals (e.g. "5:05-8:22", "9:37-12:08", "12:32-2:45") and computes their sum
     * @param {string} text
     * @returns {{ shifts: Array<{start: string, end: string, durationMinutes: number, durationSec: number}>, totalShiftSec: number }}
     */
    extractShiftIntervals(text) {
        if (!text) return { shifts: [], totalShiftSec: 0 };
        const shiftRegex = /\b(\d{1,2}[:.;]\d{2})\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2}[:.;]\d{2})\s*(am|pm)?\b/gi;
        const shifts = [];
        let match;

        function parseTimeMinutes(str, ampm) {
            if (!str) return 0;
            const parts = str.replace(/[;.]/, ':').split(':');
            let h = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            if (ampm) {
                const ap = ampm.toLowerCase();
                if (ap === 'pm' && h < 12) h += 12;
                if (ap === 'am' && h === 12) h = 0;
            }
            return h * 60 + m;
        }

        while ((match = shiftRegex.exec(text)) !== null) {
            const startRaw = match[1].replace(/[;.]/, ':');
            const startAmpm = match[2] || null;
            const endRaw = match[3].replace(/[;.]/, ':');
            const endAmpm = match[4] || null;

            let startMin = parseTimeMinutes(startRaw, startAmpm);
            let endMin = parseTimeMinutes(endRaw, endAmpm);

            // Handle 12-hour shifts without AM/PM crossing noon (e.g. 12:32 to 2:45, or 11:30 to 1:15)
            if (!startAmpm && !endAmpm) {
                if (endMin < startMin) {
                    endMin += 12 * 60;
                }
            } else if (endMin < startMin) {
                // Crosses midnight
                endMin += 24 * 60;
            }

            const durationMin = endMin - startMin;
            // Plausible work shift interval between 5 mins and 14 hours
            if (durationMin >= 5 && durationMin <= 14 * 60) {
                const durationSec = durationMin * 60;
                shifts.push({
                    start: `${startRaw}${startAmpm ? ' ' + startAmpm.toUpperCase() : ''}`,
                    end: `${endRaw}${endAmpm ? ' ' + endAmpm.toUpperCase() : ''}`,
                    durationMinutes: durationMin,
                    durationSec
                });
            }
        }

        const totalShiftSec = shifts.reduce((acc, s) => acc + s.durationSec, 0);
        return { shifts, totalShiftSec };
    },

    /**
     * Determines whether to trigger the AI Vision fallback based on OCR results
     * 
     * Conditions:
     * 1. Extracted duration is <= 0
     * 2. Extracted duration is > 24 hours (86,400s)
     * 3. Shift tokens are present in the image text, but duration parsing failed to extract valid durations
     * 4. Shift Total Sanity Check: shift intervals sum to ~8h but header total is < 1h
     * 
     * @param {Object} params
     * @param {string} params.rawText - Raw OCR text
     * @param {Array} params.parsedDurations - Array of parsed durations from regex
     * @param {number} params.totalTrackedSec - Extracted total tracked seconds
     * @param {Array} params.detectedDays - Array of day objects { label, sec, ... }
     * @param {Array} [params.extractedShifts] - Array of extracted shift objects
     * @param {number} [params.shiftSumSec] - Sum of extracted shift durations in seconds
     * @returns {{ shouldFallback: boolean, reason: string }}
     */
    shouldTriggerAiFallback({ rawText = '', parsedDurations = [], totalTrackedSec = 0, detectedDays = [], extractedShifts = [], shiftSumSec = 0, totalHeaderSec = 0, daysFound = [] }) {
        const text = (rawText || '').trim();

        // 1. If text is completely empty or very short, OCR found nothing
        if (text.length < 5) {
            return {
                shouldFallback: true,
                reason: 'OCR detected no readable text.'
            };
        }

        // 2. Check for duration > 24 hours (impossible for a single workday)
        const hasExceeded24h = detectedDays.some(d => d.sec > 24 * 3600) || totalTrackedSec > 24 * 3600 * 7;
        if (hasExceeded24h) {
            return {
                shouldFallback: true,
                reason: 'Extracted duration exceeded 24 hours (invalid workday timeframe).'
            };
        }

        // 3. Shift Total Sanity Check:
        // When shift intervals are extracted (e.g. 5:05-8:22, 9:37-12:08, 12:32-2:45), sum their approximate durations.
        // If the shift sum is ~8 hours but parsed header total is < 1 hour (like 5 seconds), mark the local OCR as INVALID.
        let calculatedShiftSum = shiftSumSec;
        if (!calculatedShiftSum && text) {
            const shiftInfo = this.extractShiftIntervals(text);
            calculatedShiftSum = shiftInfo.totalShiftSec;
        }

        const activeSec = (detectedDays.length > 0 && detectedDays[0]) ? (detectedDays[0].sec || 0) : 0;
        const parsedHeaderSec = totalTrackedSec > 0 ? totalTrackedSec : activeSec;

        // Shift sum ~8 hours (e.g. 6h to 12h) while parsed total is under 1 hour (< 3600s, e.g. 5 seconds)
        if (calculatedShiftSum >= 6 * 3600 && calculatedShiftSum <= 12 * 3600 && parsedHeaderSec < 3600) {
            return {
                shouldFallback: true,
                reason: `Shift intervals sum to ~${Math.round(calculatedShiftSum / 3600)}h (${calculatedShiftSum}s), but parsed header total is < 1h (${parsedHeaderSec}s). Local OCR marked INVALID.`
            };
        }

        // Header vs logged duration mismatch (local OCR calculated less than header duration)
        if (totalHeaderSec > 0 && activeSec < totalHeaderSec) {
            return {
                shouldFallback: true,
                reason: `Local OCR logged time (${activeSec}s) is less than detected header duration (${totalHeaderSec}s).`
            };
        }

        // Ambiguous OCR: Multiple days or durations detected when only a single date header was present
        if (daysFound.length === 1 && (parsedDurations.length > 1 || detectedDays.length > 1)) {
            return {
                shouldFallback: true,
                reason: `Ambiguous OCR: Multiple days/durations detected for single date header (${daysFound[0]?.label || 'single date'}).`
            };
        }

        // 4. Shift tokens detected in text
        const hasShiftTokens = this.SHIFT_TOKENS.some(regex => regex.test(text));

        // 5. Check if duration parsing failed despite shift tokens being present
        const hasValidParsedDuration = (parsedDurations.length > 0 && parsedDurations.some(d => d.sec > 0)) ||
                                       (detectedDays.length > 0 && detectedDays.some(d => d.sec > 0)) ||
                                       totalTrackedSec > 0;

        if (hasShiftTokens && !hasValidParsedDuration) {
            return {
                shouldFallback: true,
                reason: 'Shift tokens detected in timesheet, but OCR failed to extract durations.'
            };
        }

        // 6. Check if total duration extracted is <= 0 while image contains substantial text
        const totalCalculated = detectedDays.reduce((acc, d) => acc + (d.sec || 0), 0) + totalTrackedSec;
        if (totalCalculated <= 0 && text.length > 20) {
            return {
                shouldFallback: true,
                reason: 'Parsed duration is <= 0 despite timesheet content detected.'
            };
        }

        return {
            shouldFallback: false,
            reason: 'OCR results valid.'
        };
    },

    /**
     * Converts a File or Blob or HTMLCanvasElement to a base64 string
     * @param {File|Blob|HTMLCanvasElement} source
     * @returns {Promise<string>}
     */
    async toBase64(source) {
        if (source instanceof HTMLCanvasElement) {
            return source.toDataURL('image/png');
        }
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(source);
        });
    },

    /**
     * Calls the backend serverless fallback endpoint /api/validate-timesheet
     * @param {string} base64Image
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async validateWithAi(base64Image, options = {}) {
        const pin = options.user_pin || options.pin || (typeof localStorage !== 'undefined' ? localStorage.getItem('snip8_user_pin') : '') || '';
        const workDate = options.work_date || (typeof window !== 'undefined' && window.state && window.state.workDate) || null;
        const payload = {
            image: base64Image,
            user_pin: pin,
            work_date: workDate,
            dailyCapSeconds: options.dailyCapSeconds || 28800
        };

        const headers = {
            'Content-Type': 'application/json'
        };
        if (pin) {
            headers['x-user-pin'] = pin;
        }

        const response = await fetch('/api/validate-timesheet', {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            let errorMsg = `Server error ${response.status}`;
            try {
                const errData = await response.json();
                if (errData && errData.error) errorMsg = errData.error;
            } catch (e) { }
            throw new Error(errorMsg);
        }

        return await response.json();
    }
};

if (typeof window !== 'undefined') {
    window.Snip8Validation = Snip8Validation;
}
