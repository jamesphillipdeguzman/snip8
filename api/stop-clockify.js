/**
 * Serverless API handler to stop the currently running Clockify timer.
 * Calls PATCH https://api.clockify.me/api/v1/workspaces/{workspaceId}/user/{userId}/time-entries
 */

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: 'Method not allowed. Use POST.' }));
        return;
    }

    try {
        let body = {};
        if (req.body && typeof req.body === 'object') {
            body = req.body;
        } else if (req.body && typeof req.body === 'string') {
            try { body = JSON.parse(req.body); } catch (e) { }
        } else if (typeof req.on === 'function') {
            body = await parseBody(req);
        }

        const apiKey = (process.env.CLOCKIFY_API_KEY || body.apiKey || body.api_key || req.headers['x-api-key'] || '').toString().trim();
        const workspaceId = (process.env.CLOCKIFY_WORKSPACE_ID || body.workspaceId || body.workspace_id || '').toString().trim();
        const userId = (process.env.CLOCKIFY_USER_ID || body.userId || body.user_id || '').toString().trim();

        if (!apiKey || !workspaceId || !userId) {
            const missing = [];
            if (!apiKey) missing.push('CLOCKIFY_API_KEY');
            if (!workspaceId) missing.push('CLOCKIFY_WORKSPACE_ID');
            if (!userId) missing.push('CLOCKIFY_USER_ID');

            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                success: false,
                error: `Missing Clockify credentials: ${missing.join(', ')}. Configure them in environment variables or request body.`
            }));
            return;
        }

        const endpoint = `https://api.clockify.me/api/v1/workspaces/${encodeURIComponent(workspaceId)}/user/${encodeURIComponent(userId)}/time-entries`;
        const stopPayload = {
            end: new Date().toISOString()
        };

        const clockifyRes = await fetch(endpoint, {
            method: 'PATCH',
            headers: {
                'X-Api-Key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(stopPayload)
        });

        const responseText = await clockifyRes.text();
        let responseData = null;
        try {
            responseData = responseText ? JSON.parse(responseText) : null;
        } catch (parseErr) {
            responseData = { message: responseText };
        }

        if (!clockifyRes.ok) {
            const errorMsg = responseData?.message || responseData?.error || `Clockify API error: HTTP ${clockifyRes.status}`;
            res.statusCode = clockifyRes.status >= 400 && clockifyRes.status < 600 ? clockifyRes.status : 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                success: false,
                error: errorMsg,
                details: responseData
            }));
            return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            success: true,
            stoppedEntry: responseData
        }));

    } catch (err) {
        console.error('Stop Clockify error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            success: false,
            error: err.message || 'Internal server error while stopping Clockify timer'
        }));
    }
}

function parseBody(req) {
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
