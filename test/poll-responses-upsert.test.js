const { test } = require('node:test')
const assert = require('node:assert/strict')

// better-sqlite3 is a native module; its prebuilt binding may be unavailable in
// some local dev environments (e.g. unusual arch/Node combos) but is always
// built in CI. The binding error surfaces on `new Database()`, not on require,
// so probe by actually opening an in-memory database. Skip gracefully rather
// than failing the whole suite when it cannot load.
let Database
let dbAvailable = false
try {
    Database = require('better-sqlite3')
    const probe = new Database(':memory:')
    probe.close()
    dbAvailable = true
} catch {
    dbAvailable = false
}

const skip = dbAvailable ? false : 'better-sqlite3 native binding unavailable in this environment'

// This mirrors the exact vote-recording statement in src/poll-handler.js
// (handlePollVote). It is a portable UPSERT that must behave identically on
// SQLite and Postgres: re-delivered/changed votes update the stored option
// WITHOUT resetting `processed`, so a backup is never notified twice.
const UPSERT = `INSERT INTO poll_responses (poll_msg_id, voter_jid, selected_option, processed)
     VALUES (?, ?, ?, 0)
     ON CONFLICT (poll_msg_id, voter_jid)
     DO UPDATE SET selected_option = excluded.selected_option`

function freshDb() {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE poll_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_msg_id TEXT NOT NULL,
        voter_jid TEXT NOT NULL,
        selected_option TEXT NOT NULL,
        processed INTEGER DEFAULT 0,
        UNIQUE(poll_msg_id, voter_jid)
    );`)
    return db
}

test('poll_responses UPSERT: fresh vote inserts with processed = 0', { skip }, () => {
    const db = freshDb()
    db.prepare(UPSERT).run('P1', '573001234567@s.whatsapp.net', 'No puedo')
    const row = db.prepare('SELECT selected_option, processed FROM poll_responses').get()
    assert.equal(row.selected_option, 'No puedo')
    assert.equal(row.processed, 0)
    db.close()
})

test('poll_responses UPSERT: re-delivered vote preserves processed (no duplicate notify)', { skip }, () => {
    const db = freshDb()
    const jid = '573001234567@s.whatsapp.net'
    db.prepare(UPSERT).run('P1', jid, 'No puedo')
    // notifyBackup marks the row as processed after contacting the backup.
    db.prepare('UPDATE poll_responses SET processed = 1 WHERE poll_msg_id = ? AND voter_jid = ?').run('P1', jid)
    // Baileys re-delivers the same vote — processed must NOT reset to 0.
    db.prepare(UPSERT).run('P1', jid, 'No puedo')
    const row = db.prepare('SELECT processed FROM poll_responses WHERE poll_msg_id = ? AND voter_jid = ?').get('P1', jid)
    assert.equal(row.processed, 1)
    db.close()
})

test('poll_responses UPSERT: changed vote updates option and preserves processed', { skip }, () => {
    const db = freshDb()
    const jid = '573001234567@s.whatsapp.net'
    db.prepare(UPSERT).run('P1', jid, 'No puedo')
    db.prepare('UPDATE poll_responses SET processed = 1 WHERE poll_msg_id = ? AND voter_jid = ?').run('P1', jid)
    db.prepare(UPSERT).run('P1', jid, 'Sí puedo')
    const row = db.prepare('SELECT selected_option, processed FROM poll_responses WHERE poll_msg_id = ? AND voter_jid = ?').get('P1', jid)
    assert.equal(row.selected_option, 'Sí puedo')
    assert.equal(row.processed, 1)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM poll_responses').get().c, 1)
    db.close()
})
