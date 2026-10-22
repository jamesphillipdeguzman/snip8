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
     * Determines whether to trigger the AI Vision fallback based on OCR results
     * 
     * Conditions:
     * 1. Extracted duration is <= 0
     * 2. Extracted duration is > 24 hours (86,400s)
     * 3. Shift tokens are present in the image text, but duration parsing failed to extract valid durations
     * 
     * @param {Object} params
     * @param {string} params.rawText - Raw OCR text
     * @param {Array} params.parsedDurations - Array of parsed durations from regex
     * @param {number} params.totalTrackedSec - Extracted total tracked seconds
     * @param {Array} params.detectedDays - Array of day objects { label, sec, ... }
     * @returns {{ shouldFallback: boolean, reason: string }}
     */
    shouldTriggerAiFallback({ rawText = '', parsedDurations = [], totalTrackedSec = 0, detectedDays = [] }) {
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

        // 3. Shift tokens detected in text
        const hasShiftTokens = this.SHIFT_TOKENS.some(regex => regex.test(text));

        // 4. Check if duration parsing failed despite shift tokens being present
        const hasValidParsedDuration = (parsedDurations.length > 0 && parsedDurations.some(d => d.sec > 0)) ||
                                       (detectedDays.length > 0 && detectedDays.some(d => d.sec > 0)) ||
                                       totalTrackedSec > 0;

        if (hasShiftTokens && !hasValidParsedDuration) {
            return {
                shouldFallback: true,
                reason: 'Shift tokens detected in timesheet, but OCR failed to extract durations.'
            };
        }

        // 5. Check if total duration extracted is <= 0 while image contains substantial text
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
        const payload = {
            image: base64Image,
            user_pin: pin,
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
