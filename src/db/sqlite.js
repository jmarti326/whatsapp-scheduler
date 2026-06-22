const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'scheduler.db')

async function createDb() {
    const raw = new Database(DB_PATH)
    raw.pragma('journal_mode = WAL')
    raw.pragma('foreign_keys = ON')

    const db = {
        async get(sql, ...args) {
            return raw.prepare(sql).get(...args.flat()) ?? undefined
        },
        async all(sql, ...args) {
            return raw.prepare(sql).all(...args.flat())
        },
        async run(sql, ...args) {
            const info = raw.prepare(sql).run(...args.flat())
            return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
        },
        async exec(sql) {
            raw.exec(sql)
        },
        async transaction(fn) {
            const tx = raw.transaction(() => fn(db))
            return tx()
        },
        async initSchema() {
            raw.exec(`
                CREATE TABLE IF NOT EXISTS team_members (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    phone TEXT NOT NULL UNIQUE,
                    active INTEGER DEFAULT 1,
                    created_at TEXT DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS schedule_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service_date TEXT NOT NULL,
                    day_type TEXT NOT NULL CHECK(day_type IN ('thursday', 'sunday')),
                    member_id INTEGER NOT NULL,
                    role TEXT NOT NULL DEFAULT 'primary' CHECK(role IN ('primary', 'backup')),
                    created_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY (member_id) REFERENCES team_members(id),
                    UNIQUE(service_date, member_id)
                );

                CREATE TABLE IF NOT EXISTS message_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_key TEXT NOT NULL UNIQUE,
                    message_type TEXT NOT NULL,
                    content TEXT,
                    sent_at TEXT DEFAULT (datetime('now')),
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
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    is_admin INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS pending_sends (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL,
                    date TEXT NOT NULL,
                    group_jid TEXT,
                    force_send INTEGER DEFAULT 0,
                    status TEXT DEFAULT 'pending',
                    result TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    processed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS wa_accounts (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    phone_number TEXT,
                    priority INTEGER NOT NULL DEFAULT 1,
                    status TEXT DEFAULT 'disconnected',
                    last_connected_at TEXT,
                    last_error TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS wa_account_groups (
                    account_id TEXT NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
                    group_jid TEXT NOT NULL,
                    group_name TEXT,
                    synced_at TEXT DEFAULT (datetime('now')),
                    PRIMARY KEY (account_id, group_jid)
                );

                CREATE TABLE IF NOT EXISTS send_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id TEXT,
                    target_jid TEXT NOT NULL,
                    message_type TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'attempted',
                    error TEXT,
                    wa_message_id TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY (account_id) REFERENCES wa_accounts(id)
                );
            `)

            const insert = raw.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)')
            insert.run('group_jid', 'YOUR_GROUP_JID@g.us')
            insert.run('timezone', 'America/Puerto_Rico')
            insert.run('send_hour', '8')
            insert.run('send_minute', '0')
        },
        // Expose raw instance for session store (SQLite only)
        _raw: raw,
        _type: 'sqlite',
    }

    await db.initSchema()
    return db
}

module.exports = { createDb }

