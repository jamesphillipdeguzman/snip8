import { getSession, upsertSession, deleteSession } from '../db/neon.js';

/**
 * Serverless handler for /api/snip8-session
 * Authenticated via x-user-pin header and scoped to CURRENT_DATE.
 */
export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-pin, x-user-email');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }

    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        
        let body = {};
        if (req.method === 'POST') {
            body = await parseBody(req);
        }

        // Read x-user-pin header (with query/body fallback)
        const headerPin = req.headers['x-user-pin'];
        const queryPin = url.searchParams.get('user_pin') || url.searchParams.get('pin');
        const bodyPin = body.user_pin || body.pin;
        const userPin = (headerPin || queryPin || bodyPin || '').toString().trim();

        if (!userPin) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                success: false,
                error: 'PIN required'
            }));
            return;
        }

        const workDate = url.searchParams.get('work_date') || url.searchParams.get('date') || body.work_date || body.date || null;
        const todayStr = new Date().toISOString().split('T')[0];

        // GET: Fetch active session for user_pin on CURRENT_DATE (or workDate)
        if (req.method === 'GET') {
            const existingSession = await getSession(userPin, workDate);
            
            // If none exists, return a fresh 8-hour default state
            const session = existingSession || {
                user_pin: userPin,
                work_date: workDate || todayStr,
                total_seconds_remaining: 28800,
                daily_cap_seconds: 28800,
                logged_seconds: 0,
                timesheet_data: [],
                last_scanned_image_url: null,
                updated_at: new Date().toISOString(),
                is_fresh_default: true
            };

            let isLiveIncrement = true;
            if (session.timesheet_data) {
                let td = session.timesheet_data;
                if (typeof td === 'string') {
                    try { td = JSON.parse(td); } catch (e) { td = null; }
                }
                if (td && typeof td === 'object' && td.isLiveIncrement !== undefined) {
                    isLiveIncrement = Boolean(td.isLiveIncrement);
                }
            }
            if (session.is_live_increment !== undefined) {
                isLiveIncrement = Boolean(session.is_live_increment);
            }
            session.isLiveIncrement = isLiveIncrement;

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                success: true,
                user_pin: userPin,
                work_date: session.work_date,
                session,
                row: session,
                source: 'neon'
            }));
            return;
        }

        // POST: Upsert session for user_pin on CURRENT_DATE
        if (req.method === 'POST') {
            const dailyCapSeconds = Number(body.daily_cap_seconds) || 28800;
            const loggedSeconds = Number(body.logged_seconds) || 0;
            const totalSecondsRemaining = body.total_seconds_remaining !== undefined 
                ? Number(body.total_seconds_remaining) 
                : Math.max(0, dailyCapSeconds - loggedSeconds);

            const session = await upsertSession({
                user_pin: userPin,
                work_date: workDate,
                total_seconds_remaining: totalSecondsRemaining,
                daily_cap_seconds: dailyCapSeconds,
                logged_seconds: loggedSeconds,
                timesheet_data: body.timesheet_data || [],
                last_scanned_image_url: body.last_scanned_image_url || null
            });

            if (session) {
                let isLiveIncrement = true;
                if (body.isLiveIncrement !== undefined) {
                    isLiveIncrement = Boolean(body.isLiveIncrement);
                } else if (body.timesheet_data && typeof body.timesheet_data === 'object' && body.timesheet_data.isLiveIncrement !== undefined) {
                    isLiveIncrement = Boolean(body.timesheet_data.isLiveIncrement);
                }
                session.isLiveIncrement = isLiveIncrement;
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                success: true,
                session,
                source: 'neon'
            }));
            return;
        }

        // DELETE: Clear session for user_pin today
        if (req.method === 'DELETE') {
            await deleteSession(userPin, workDate);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                success: true,
                message: 'Session cleared',
                user_pin: userPin,
                source: 'neon'
            }));
            return;
        }

        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed' }));

    } catch (err) {
        console.error('Session API error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            success: false,
            error: err.message || 'Internal server error'
        }));
    }
}

/**
 * Helper to parse JSON body from incoming request
 */
export function parseBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                resolve({});
            }
        });
    });
}
