/**
 * Postgres adapter (Neon or any pg-compatible database).
 *
 * The DATABASE_URL is used as-is, so sslmode / channel_binding params
 * in the connection string are respected automatically by the pg driver.
 *
 * SQL dialect conversion (SQLite → Postgres):
 *   ?            → $1, $2, ...
 *   INSERT OR IGNORE  → INSERT ... ON CONFLICT DO NOTHING
 *   INSERT OR REPLACE → INSERT ... ON CONFLICT DO NOTHING  (callers must handle upserts explicitly)
 *   datetime('now')   → now()
 */

const { Pool } = require('pg')

let pool

function getPool() {
    if (!pool) {
        pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
    }
    return pool
}

/** Convert SQLite-flavoured SQL to Postgres SQL. */
function pgSql(sql) {
    let i = 0
    const base = sql
        .replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO')
        .replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO')
        .replace(/datetime\('now'\)/gi, 'now()')
        .replace(/\?/g, () => `$${++i}`)

    if (/^INSERT OR IGNORE/i.test(sql.trim())) return base + ' ON CONFLICT DO NOTHING'
    if (/^INSERT OR REPLACE/i.test(sql.trim())) {
        // Detect target table for proper upsert
        const tableMatch = base.match(/^INSERT INTO\s+(\w+)/i)
        const table = tableMatch ? tableMatch[1] : ''
        if (table === 'app_settings') return base + ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
        if (table === 'group_aliases') return base + ' ON CONFLICT (jid) DO UPDATE SET alias = EXCLUDED.alias'
        if (table === 'wa_accounts') return base + ' ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, phone_number = EXCLUDED.phone_number, priority = EXCLUDED.priority, status = EXCLUDED.status, last_connected_at = EXCLUDED.last_connected_at, last_error = EXCLUDED.last_error'
        return base + ' ON CONFLICT DO NOTHING'
    }
    return base
}

/** Normalise Postgres boolean columns to integers (mirrors SQLite behaviour). */
function norm(row) {
    if (!row) return undefined
    const out = { ...row }
    for (const k of Object.keys(out)) {
        if (typeof out[k] === 'boolean') out[k] = out[k] ? 1 : 0
    }
    return out
}

async function createDb() {
    const p = getPool()

    const db = {
        async get(sql, ...args) {
            const res = await p.query(pgSql(sql), args.flat())
            return norm(res.rows[0])
        },
        async all(sql, ...args) {
            const res = await p.query(pgSql(sql), args.flat())
            return res.rows.map(norm)
        },
        async run(sql, ...args) {
            const res = await p.query(pgSql(sql), args.flat())
            return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id ?? null }
        },
        async exec(sql) {
            const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
            for (const stmt of statements) await p.query(stmt)
        },
        async transaction(fn) {
            const client = await p.connect()
            try {
                await client.query('BEGIN')
                const result = await fn(db)
                await client.query('COMMIT')
                return result
            } catch (err) {
                await client.query('ROLLBACK')
                throw err
            } finally {
                client.release()
            }
        },
        async initSchema() {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS team_members (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    phone TEXT NOT NULL UNIQUE,
                    active INTEGER DEFAULT 1,
                    created_at TIMESTAMPTZ DEFAULT now()
                );

                CREATE TABLE IF NOT EXISTS schedule_entries (
                    id SERIAL PRIMARY KEY,
                    service_date TEXT NOT NULL,
                    day_type TEXT NOT NULL CHECK(day_type IN ('thursday', 'sunday')),
                    member_id INTEGER NOT NULL REFERENCES team_members(id),
                    role TEXT NOT NULL DEFAULT 'primary' CHECK(role IN ('primary', 'backup')),
                    created_at TIMESTAMPTZ DEFAULT now(),
                    UNIQUE(service_date, member_id)
                );

                CREATE TABLE IF NOT EXISTS message_logs (
                    id SERIAL PRIMARY KEY,
                    message_key TEXT NOT NULL UNIQUE,
                    message_type TEXT NOT NULL,
                    content TEXT,
                    sent_at TIMESTAMPTZ DEFAULT now(),
                    status TEXT DEFAULT 'sent'
                );

                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS group_aliases (
                    jid TEXT PRIMARY KEY,
                    alias TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    is_admin INTEGER DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT now()
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    sid TEXT PRIMARY KEY,
                    sess JSONB NOT NULL,
                    expire TIMESTAMPTZ NOT NULL
                );

                CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire);

                CREATE TABLE IF NOT EXISTS pending_sends (
                    id SERIAL PRIMARY KEY,
                    type TEXT NOT NULL,
                    date TEXT NOT NULL,
                    group_jid TEXT,
                    force_send BOOLEAN DEFAULT false,
                    status TEXT DEFAULT 'pending',
                    result TEXT,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    processed_at TIMESTAMPTZ
                );

                CREATE TABLE IF NOT EXISTS wa_accounts (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    phone_number TEXT,
                    priority INTEGER NOT NULL DEFAULT 1,
                    status TEXT DEFAULT 'disconnected',
                    last_connected_at TIMESTAMPTZ,
                    last_error TEXT,
                    created_at TIMESTAMPTZ DEFAULT now()
                );

                CREATE TABLE IF NOT EXISTS wa_account_groups (
                    account_id TEXT NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
                    group_jid TEXT NOT NULL,
                    group_name TEXT,
                    synced_at TIMESTAMPTZ DEFAULT now(),
                    PRIMARY KEY (account_id, group_jid)
                );

                CREATE TABLE IF NOT EXISTS send_log (
                    id SERIAL PRIMARY KEY,
                    account_id TEXT REFERENCES wa_accounts(id),
                    target_jid TEXT NOT NULL,
                    message_type TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'attempted',
                    error TEXT,
                    wa_message_id TEXT,
                    created_at TIMESTAMPTZ DEFAULT now()
                );
            `)

            const defaults = [
                ['group_jid', 'YOUR_GROUP_JID@g.us'],
                ['timezone', 'America/Puerto_Rico'],
                ['send_hour', '8'],
                ['send_minute', '0'],
            ]
            for (const [key, value] of defaults) {
                await p.query(
                    'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [key, value]
                )
            }
        },
        _pool: p,
        _type: 'postgres',
    }

    await db.initSchema()
    return db
}

module.exports = { createDb }

