import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { upsertSession } from '../db/neon.js';
import { parseBody } from './snip8-session.js';

let genAIClient = null;

function getGenAI() {
    if (!genAIClient) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY environment variable is not defined.');
        }
        genAIClient = new GoogleGenAI({ apiKey });
    }
    return genAIClient;
}

const CANDIDATE_MODELS = [
    process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-flash-latest'
];

/**
 * Calls Gemini with image data and structured JSON response schema
 */
async function callGeminiVision(base64Data, mimeType = 'image/png') {
    const ai = getGenAI();

    const prompt = `You are an expert timesheet validation assistant for "snip8".
Analyze the provided timesheet screenshot (from Springboard, Clockify, Hubstaff, or similar).

CRITICAL INSTRUCTIONS FOR DAY HEADER ROW:
1. Carefully examine the top column header row or date banner of the timesheet crop (e.g. "Fri 10/23", "Fri, 10/23", "Thu 10/22", "10/23", etc.).
2. Explicitly capture the day of the week and date from this top header row.
3. In "dayLabel", return the day of week and date string from the header (e.g. "Fri, 10/23" or "Fri 10/23").
4. In "work_date", return the date in YYYY-MM-DD format (e.g. "2026-10-23", assuming current year 2026 if year is omitted).

CRITICAL INSTRUCTIONS FOR TIME & SHIFTS:
5. Extract total logged seconds for the active day/column (or total tracked time if only one duration is visible).
6. Remaining seconds needed to hit an 8-hour daily cap (8 hours = 28,800 seconds). If logged >= 28800, remaining is 0.
7. List of individual work shifts/intervals detected in the timesheet (start time, end time, and duration in minutes).
8. Confidence level: "high", "medium", or "low".

Return your answer strictly according to the structured JSON schema.`;

    const schema = {
        type: 'object',
        properties: {
            dayLabel: {
                type: 'string',
                description: 'Day of week and date captured directly from the top header row, e.g. "Fri 10/23" or "Fri, 10/23"'
            },
            work_date: {
                type: 'string',
                description: 'Explicit work date in YYYY-MM-DD format (e.g. "2026-10-23") derived from the top header row'
            },
            loggedSeconds: { 
                type: 'integer',
                description: 'Total logged seconds for the current day'
            },
            remainingSeconds: { 
                type: 'integer',
                description: 'Remaining seconds needed to reach 28800 seconds (8 hours)'
            },
            shifts: {
                type: 'array',
                description: 'List of recorded shifts or intervals',
                items: {
                    type: 'object',
                    properties: {
                        start: { type: 'string', description: 'Shift start time (e.g. 08:00 AM or 08:00)' },
                        end: { type: 'string', description: 'Shift end time (e.g. 12:00 PM or 12:30)' },
                        durationMinutes: { type: 'number', description: 'Duration of this shift in minutes' }
                    },
                    required: ['start', 'end', 'durationMinutes']
                }
            },
            confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'Confidence level of the extraction'
            }
        },
        required: ['dayLabel', 'work_date', 'loggedSeconds', 'remainingSeconds', 'shifts', 'confidence']
    };

    let lastError = null;
    for (const modelName of CANDIDATE_MODELS) {
        try {
            const response = await ai.models.generateContent({
                model: modelName,
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                inlineData: {
                                    mimeType,
                                    data: base64Data
                                }
                            },
                            {
                                text: prompt
                            }
                        ]
                    }
                ],
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: schema
                }
            });

            if (response && response.text) {
                const parsed = JSON.parse(response.text);
                return { data: parsed, modelUsed: modelName };
            }
        } catch (err) {
            console.warn(`Gemini model ${modelName} failed:`, err.message || err);
            lastError = err;
            // continue to next model candidate
        }
    }

    throw lastError || new Error('All Gemini Vision model candidates failed to validate timesheet.');
}

/**
 * Serverless handler for /api/validate-timesheet
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-pin');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Method ${req.method} Not Allowed` }));
        return;
    }

    try {
        const body = await parseBody(req);
        let rawImage = body.image;

        if (!rawImage || typeof rawImage !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing "image" base64 string in request payload.' }));
            return;
        }

        let mimeType = body.mimeType || 'image/png';
        const matchDataUrl = rawImage.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
        if (matchDataUrl) {
            mimeType = matchDataUrl[1];
            rawImage = matchDataUrl[2];
        }

        const userPin = (req.headers['x-user-pin'] || body.user_pin || body.pin || '').toString().trim();
        const dailyCapSeconds = Number(body.dailyCapSeconds) || 28800;

        // 1. Call Gemini Vision
        const { data: validationResult, modelUsed } = await callGeminiVision(rawImage, mimeType);

        // Sanitize / ensure calculations
        const loggedSeconds = Math.max(0, Number(validationResult.loggedSeconds) || 0);
        let remainingSeconds = Number(validationResult.remainingSeconds);
        if (isNaN(remainingSeconds) || remainingSeconds < 0) {
            remainingSeconds = Math.max(0, dailyCapSeconds - loggedSeconds);
        }

        // Format timesheet data for snip8 compatibility
        // Derive clean day label directly from Gemini's parsed header
        let resolvedDayLabel = (validationResult.dayLabel || '').trim();
        if (!resolvedDayLabel && validationResult.work_date) {
            const parts = validationResult.work_date.split('-');
            if (parts.length === 3) {
                const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                resolvedDayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
            }
        }
        if (!resolvedDayLabel && body.work_date) {
            const parts = body.work_date.split('-');
            if (parts.length === 3) {
                const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                resolvedDayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
            }
        }
        if (!resolvedDayLabel) {
            const today = new Date();
            resolvedDayLabel = today.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
        }

        // Standardize format: e.g. "Fri 10/23" -> "Fri, 10/23"
        const formattedLabel = resolvedDayLabel.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b\s*(?!,)/i, '$1, ');

        const h = Math.floor(loggedSeconds / 3600);
        const m = Math.floor((loggedSeconds % 3600) / 60);
        const s = loggedSeconds % 60;

        const timesheetData = [
            {
                label: `${formattedLabel} (AI)`,
                dayName: formattedLabel.split(' ')[0].replace(/,/g, ''),
                h, m, s,
                sec: loggedSeconds,
                shifts: validationResult.shifts || []
            }
        ];

        // 2. Persist directly to Neon if userPin is present
        let savedSession = null;
        const workDate = validationResult.work_date || body.work_date || null;
        const payloadTimesheetData = {
            dayLabel: formattedLabel,
            workDate: workDate,
            blocks: validationResult.shifts || [],
            days: timesheetData
        };

        if (userPin) {
            try {
                savedSession = await upsertSession({
                    user_pin: userPin,
                    work_date: workDate,
                    total_seconds_remaining: remainingSeconds,
                    daily_cap_seconds: dailyCapSeconds,
                    logged_seconds: loggedSeconds,
                    timesheet_data: payloadTimesheetData,
                    last_scanned_image_url: null
                });
            } catch (dbErr) {
                console.error('Failed to persist AI validation to Neon:', dbErr);
                // Non-fatal: still return the AI validation result to frontend
            }
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            success: true,
            validatedVia: 'AI',
            modelUsed,
            work_date: workDate,
            dayLabel: validationResult.dayLabel || formattedLabel,
            loggedSeconds,
            remainingSeconds,
            shifts: validationResult.shifts || [],
            confidence: validationResult.confidence || 'high',
            session: savedSession,
            timesheetData
        }));

    } catch (err) {
        console.error('Timesheet AI validation error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            success: false,
            error: err.message || 'AI Validation Error'
        }));
    }
}
