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
Extract the following:
1. Total logged seconds for the active/selected work day (or total tracked time if only one duration is visible).
2. The remaining seconds needed to hit an 8-hour daily cap (8 hours = 28,800 seconds). If logged >= 28800, remaining is 0.
3. List of individual work shifts/intervals detected in the timesheet (start time, end time, and duration in minutes). If shift intervals are not explicitly listed with start/end, estimate or provide the overall active shift block.
4. Your confidence level: "high", "medium", or "low".
5. Explicit work date (YYYY-MM-DD) or day label (e.g. "Fri, 10/23" or "Thu 10/22") if visible.

Return your answer strictly according to the structured JSON schema.`;

    const schema = {
        type: 'object',
        properties: {
            loggedSeconds: { 
                type: 'integer',
                description: 'Total logged seconds for the current day'
            },
            remainingSeconds: { 
                type: 'integer',
                description: 'Remaining seconds needed to reach 28800 seconds (8 hours)'
            },
            work_date: {
                type: 'string',
                description: 'Explicit work date in YYYY-MM-DD format if visible, or empty string if not found'
            },
            dayLabel: {
                type: 'string',
                description: 'Day label if visible in the timesheet, e.g. "Fri, 10/23" or "Thu 10/22", or empty string'
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
        required: ['loggedSeconds', 'remainingSeconds', 'shifts', 'confidence']
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
        const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
        const h = Math.floor(loggedSeconds / 3600);
        const m = Math.floor((loggedSeconds % 3600) / 60);
        const s = loggedSeconds % 60;

        const timesheetData = [
            {
                label: `${todayLabel} (AI)`,
                dayName: todayLabel.split(' ')[0],
                h, m, s,
                sec: loggedSeconds,
                shifts: validationResult.shifts || []
            }
        ];

        // 2. Persist directly to Neon if userPin is present
        let savedSession = null;
        const workDate = body.work_date || validationResult.work_date || null;
        if (userPin) {
            try {
                savedSession = await upsertSession({
                    user_pin: userPin,
                    work_date: workDate,
                    total_seconds_remaining: remainingSeconds,
                    daily_cap_seconds: dailyCapSeconds,
                    logged_seconds: loggedSeconds,
                    timesheet_data: timesheetData,
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
            work_date: validationResult.work_date || null,
            dayLabel: validationResult.dayLabel || null,
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
