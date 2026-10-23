import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sessionHandler from './api/snip8-session.js';
import validateHandler from './api/validate-timesheet.js';
import uploadScreenshotHandler from './api/upload-screenshot.js';
import stopClockifyHandler from './api/stop-clockify.js';
import timerSignalHandler from './api/timer-signal.js';
import { initDb } from './db/neon.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // API Routing
    if (pathname === '/api/snip8-session') {
        return sessionHandler(req, res);
    }
    if (pathname === '/api/validate-timesheet') {
        return validateHandler(req, res);
    }
    if (pathname === '/api/upload-screenshot') {
        return uploadScreenshotHandler(req, res);
    }
    if (pathname === '/api/stop-clockify') {
        return stopClockifyHandler(req, res);
    }
    if (pathname === '/api/timer-signal') {
        return timerSignalHandler(req, res);
    }

    // Static File Serving
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    
    // Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain');
            res.end('404 Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        fs.createReadStream(filePath).pipe(res);
    });
});

function startServer(port) {
    server.listen(port, async () => {
        console.log(`[snip8] Server running at http://localhost:${port}`);
        try {
            await initDb();
            console.log('[snip8] Connected to Neon PostgreSQL.');
        } catch (dbErr) {
            console.warn('[snip8] Neon DB initialization warning:', dbErr.message);
        }
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[snip8] Port ${port} is in use, trying port ${port + 1}...`);
            startServer(port + 1);
        } else {
            console.error('[snip8] Server error:', err);
        }
    });
}

startServer(PORT);

export default server;
