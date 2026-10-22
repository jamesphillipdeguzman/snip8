import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

let sqlClient = null;

export function getSqlClient() {
    if (!sqlClient) {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
            throw new Error('DATABASE_URL environment variable is not defined.');
        }
        sqlClient = neon(dbUrl);
    }
    return sqlClient;
}

let tableInitialized = false;

/**
 * Initializes the snip8_sessions table in Neon PostgreSQL with user_pin and work_date.
 */
export async function initDb() {
    if (tableInitialized) return;
    const sql = getSqlClient();
    
    // Check and migrate table if old schema (e.g. user_email or id instead of user_pin) exists
    const checkColumns = await sql.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'snip8_sessions';
    `);
    
    const colNames = checkColumns.map(c => c.column_name);
    if (colNames.length > 0 && !colNames.includes('user_pin')) {
        await sql.query(`DROP TABLE IF EXISTS snip8_sessions;`);
    }

    await sql.query(`
        CREATE TABLE IF NOT EXISTS snip8_sessions (
            user_pin VARCHAR(32) NOT NULL,
            work_date DATE NOT NULL DEFAULT CURRENT_DATE,
            total_seconds_remaining INTEGER DEFAULT 28800,
            daily_cap_seconds INTEGER DEFAULT 28800,
            logged_seconds INTEGER DEFAULT 0,
            timesheet_data JSONB,
            last_scanned_image_url TEXT,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_pin, work_date)
        );
    `);
    tableInitialized = true;
}

/**
 * Fetch the active session for user_pin on work_date (defaults to CURRENT_DATE)
 * @param {string} user_pin
 * @param {string|null} work_date - YYYY-MM-DD or null for today
 */
export async function getSession(user_pin, work_date = null) {
    if (!user_pin) {
        throw new Error('user_pin is required to getSession.');
    }
    await initDb();
    const sql = getSqlClient();
    const rows = await sql.query(
        `SELECT user_pin, work_date::text, total_seconds_remaining, daily_cap_seconds, logged_seconds, timesheet_data, last_scanned_image_url, updated_at 
         FROM snip8_sessions 
         WHERE user_pin = $1 
           AND work_date = COALESCE($2::date, CURRENT_DATE)`,
        [user_pin, work_date]
    );
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Upsert the session into snip8_sessions scoped by user_pin and work_date
 */
export async function upsertSession({
    user_pin,
    work_date = null,
    total_seconds_remaining = 28800,
    daily_cap_seconds = 28800,
    logged_seconds = 0,
    timesheet_data = {},
    last_scanned_image_url = null
}) {
    if (!user_pin) {
        throw new Error('user_pin is required to upsertSession.');
    }
    await initDb();
    const sql = getSqlClient();
    const timesheetJson = typeof timesheet_data === 'string' ? timesheet_data : JSON.stringify(timesheet_data);

    const rows = await sql.query(
        `INSERT INTO snip8_sessions (
            user_pin,
            work_date,
            total_seconds_remaining,
            daily_cap_seconds,
            logged_seconds,
            timesheet_data,
            last_scanned_image_url,
            updated_at
        ) VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6::jsonb, $7, NOW())
        ON CONFLICT (user_pin, work_date) DO UPDATE SET
            total_seconds_remaining = EXCLUDED.total_seconds_remaining,
            daily_cap_seconds = EXCLUDED.daily_cap_seconds,
            logged_seconds = EXCLUDED.logged_seconds,
            timesheet_data = EXCLUDED.timesheet_data,
            last_scanned_image_url = COALESCE(EXCLUDED.last_scanned_image_url, snip8_sessions.last_scanned_image_url),
            updated_at = NOW()
        RETURNING user_pin, work_date::text, total_seconds_remaining, daily_cap_seconds, logged_seconds, timesheet_data, last_scanned_image_url, updated_at;`,
        [user_pin, work_date, total_seconds_remaining, daily_cap_seconds, logged_seconds, timesheetJson, last_scanned_image_url]
    );

    return rows.length > 0 ? rows[0] : null;
}

/**
 * Delete session by user_pin and work_date (defaults to today)
 */
export async function deleteSession(user_pin, work_date = null) {
    if (!user_pin) {
        throw new Error('user_pin is required to deleteSession.');
    }
    await initDb();
    const sql = getSqlClient();
    await sql.query(
        `DELETE FROM snip8_sessions 
         WHERE user_pin = $1 
           AND work_date = COALESCE($2::date, CURRENT_DATE)`,
        [user_pin, work_date]
    );
    return true;
}
