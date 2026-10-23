// api/timer-signal.js
import { getSqlClient } from '../db/neon.js';

function sendJson(res, statusCode, data) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(data);
    }
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
    // CORS headers for browser UI & Springboard Tampermonkey userscript
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-pin');

    if (req.method === 'OPTIONS') {
        if (typeof res.status === 'function') {
            return res.status(204).end();
        }
        res.statusCode = 204;
        res.end();
        return;
    }

    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pin = (req.query?.pin || url.searchParams.get('pin') || req.headers['x-user-pin'] || '').trim();
        const action = (req.query?.action || url.searchParams.get('action') || '').trim();

        if (!pin) {
            return sendJson(res, 400, { error: 'Missing pin parameter' });
        }

        const sql = getSqlClient();

        // Ensure table exists for tracking signals
        await sql`
            CREATE TABLE IF NOT EXISTS snip8_signals (
                pin VARCHAR(64) PRIMARY KEY,
                stop_requested BOOLEAN DEFAULT FALSE,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        // 1. GET: Polled by Tampermonkey on desktop to check if a stop was requested
        if (req.method === 'GET') {
            const queryRes = await sql`SELECT stop_requested FROM snip8_signals WHERE pin = ${pin};`;
            const rows = Array.isArray(queryRes) ? queryRes : (queryRes?.rows || []);
            const requested = rows.length > 0 ? Boolean(rows[0].stop_requested) : false;
            return sendJson(res, 200, { stop_requested: requested });
        }

        // 2. POST: Trigger a stop request (from Mobile UI) OR acknowledge/clear it (from Tampermonkey)
        if (req.method === 'POST') {
            const shouldStop = action !== 'clear';
            await sql`
                INSERT INTO snip8_signals (pin, stop_requested, updated_at)
                VALUES (${pin}, ${shouldStop}, CURRENT_TIMESTAMP)
                ON CONFLICT (pin)
                DO UPDATE SET stop_requested = ${shouldStop}, updated_at = CURRENT_TIMESTAMP;
            `;
            return sendJson(res, 200, { success: true, stop_requested: shouldStop });
        }

        return sendJson(res, 405, { error: 'Method not allowed' });
    } catch (error) {
        console.error('Signal API Error:', error);
        return sendJson(res, 500, { error: error.message || 'Internal server error' });
    }
}