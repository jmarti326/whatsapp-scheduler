const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('baileys')
const pino = require('pino')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { getDb } = require('./db/index')
const { parseGroupAllowlist, filterAllowedGroups, unmatchedAllowlistEntries } = require('./group-filter')

const logger = pino({ level: 'silent' })
const AUTH_BASE = path.join(__dirname, '..', 'data', 'auth_info')

// In-memory state per account
const connections = new Map() // accountId → { socket, status, priority, label }

// Poll-vote handler, registered once via attachPollListeners. Stored at module
// scope so it can be (re)wired onto every new socket — including the fresh
// sockets created on reconnect — not just the ones that existed at startup.
let pollHandler = null

/**
 * Wire the registered poll-vote handler onto a single socket's messages.update
 * stream. Safe to call for every socket we create; does nothing until a handler
 * has been registered via attachPollListeners.
 */
function wirePollListener(accountId, socket, label) {
    if (!pollHandler) return
    socket.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            if (update.pollUpdates && update.pollUpdates.length > 0) {
                try {
                    await pollHandler(key, update.pollUpdates, accountId, socket)
                } catch (err) {
                    console.error(`[CONN-MGR] ❌ Poll handler error on "${label}":`, err.message)
                }
            }
        }
    })
}

/**
 * Pre-send failure types that are safe to failover (message was NOT delivered)
 */
const SAFE_FAILOVER_ERRORS = [
    'Bot is not connected',
    'not connected',
    'Connection Closed',
    'connection closed',
    'logged out',
    'Stream Errored',
    'Timed Out',
]

function isSafeToFailover(err) {
    const msg = err?.message || ''
    return SAFE_FAILOVER_ERRORS.some(s => msg.toLowerCase().includes(s.toLowerCase()))
}

/**
 * Load all registered accounts from DB and connect them.
 */
async function connectAll() {
    const db = await getDb()
    await autoMigrateLegacyAuth(db)
    const accounts = await db.all('SELECT * FROM wa_accounts ORDER BY priority ASC, created_at ASC')

    if (accounts.length === 0) {
        console.log('[CONN-MGR] No accounts registered. Use the portal to add one.')
        return
    }

    for (const account of accounts) {
        await connectOne(account)
    }
}

/**
 * Connect a single account by its DB row.
 */
async function connectOne(account) {
    const authPath = path.join(AUTH_BASE, account.id)
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath)
    const { version } = await fetchLatestBaileysVersion()

    const needsPairing = !!account.phone_number && !state.creds.registered

    const socket = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
        printQRInTerminal: false,
    })

    connections.set(account.id, {
        socket,
        status: 'connecting',
        priority: account.priority,
        label: account.label,
        accountId: account.id,
    })

    // Attach the poll-vote listener to THIS socket. Reconnects create a brand-new
    // socket, so wiring here (rather than only once at startup) guarantees votes
    // keep being captured after every reconnect.
    wirePollListener(account.id, socket, account.label)

    if (needsPairing) {
        setTimeout(async () => {
            try {
                const phone = account.phone_number.replace(/[^0-9]/g, '')
                const code = await socket.requestPairingCode(phone)
                console.log(`[CONN-MGR] 📱 Account "${account.label}" pairing code: ${code}`)
                await updateAccountStatus(account.id, 'waiting_for_pairing', null, code)
            } catch (err) {
                console.error(`[CONN-MGR] Failed pairing for "${account.label}":`, err.message)
                await updateAccountStatus(account.id, 'pairing_failed', err.message)
            }
        }, 3000)
    }

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update
        const conn = connections.get(account.id)
        if (!conn) return

        if (connection === 'open') {
            conn.status = 'connected'
            console.log(`[CONN-MGR] ✅ "${account.label}" connected (priority ${account.priority})`)
            scheduleStatusWrite(account.id, 'connected')
            // Sync groups for this account, but not on every reconnect — group
            // membership rarely changes, and rewriting ~100 rows on each of the
            // frequent WhatsApp reconnects keeps Postgres (Neon) needlessly busy.
            setTimeout(() => syncAccountGroups(account.id, socket), 5000)
        }

        if (connection === 'close') {
            conn.status = 'disconnected'
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const reason = lastDisconnect?.error?.message || 'unknown'
            console.log(`[CONN-MGR] ⚠️ "${account.label}" disconnected (code: ${statusCode}, reason: ${reason})`)
            scheduleStatusWrite(account.id, 'disconnected', reason)

            if (statusCode !== DisconnectReason.loggedOut) {
                const delay = statusCode === 408 || statusCode === 503 ? 15000 : 5000
                console.log(`[CONN-MGR] 🔄 Reconnecting "${account.label}" in ${delay / 1000}s...`)
                setTimeout(() => connectOne(account), delay)
            } else {
                conn.status = 'logged_out'
                scheduleStatusWrite(account.id, 'logged_out', reason)
            }
        }
    })

    socket.ev.on('creds.update', saveCreds)

    return socket
}

/**
 * Disconnect a specific account.
 */
async function disconnectOne(accountId) {
    const conn = connections.get(accountId)
    if (!conn) return
    try {
        conn.socket.end()
    } catch {}
    connections.delete(accountId)
    await updateAccountStatus(accountId, 'disconnected')
}

/**
 * Get healthy (connected) sockets sorted by priority.
 * If targetGroupJid is provided, filter to accounts that are members of that group.
 */
async function getHealthySockets(targetGroupJid) {
    const healthy = []
    for (const [id, conn] of connections) {
        if (conn.status === 'connected') {
            healthy.push(conn)
        }
    }
    healthy.sort((a, b) => a.priority - b.priority)

    if (!targetGroupJid) return healthy

    // Filter by group membership
    const db = await getDb()
    const memberAccountIds = await db.all(
        'SELECT account_id FROM wa_account_groups WHERE group_jid = ?',
        targetGroupJid
    )
    const memberSet = new Set(memberAccountIds.map(r => r.account_id))

    // If no membership data yet, don't filter (allow all to attempt)
    if (memberSet.size === 0) return healthy

    return healthy.filter(c => memberSet.has(c.accountId))
}

/**
 * Send a message with failover across healthy accounts.
 * Only fails over on pre-send/local errors — not on ambiguous timeouts.
 */
async function sendWithFailover(targetJid, messageType, sendFn) {
    const sockets = await getHealthySockets(targetJid.endsWith('@g.us') ? targetJid : null)
    const db = await getDb()

    if (sockets.length === 0) {
        throw new Error('No connected accounts available to send message')
    }

    const errors = []
    for (const conn of sockets) {
        try {
            const result = await sendFn(conn.socket)
            // Log success
            await db.run(
                'INSERT INTO send_log (account_id, target_jid, message_type, status, wa_message_id) VALUES (?, ?, ?, ?, ?)',
                conn.accountId, targetJid, messageType, 'delivered', result?.key?.id || null
            )
            if (conn.priority > 1) {
                console.log(`[CONN-MGR] 📨 Delivered via fallback "${conn.label}" (priority ${conn.priority})`)
            }
            return result
        } catch (err) {
            errors.push({ account: conn.label, error: err.message })
            await db.run(
                'INSERT INTO send_log (account_id, target_jid, message_type, status, error) VALUES (?, ?, ?, ?, ?)',
                conn.accountId, targetJid, messageType, 'failed', err.message
            )
            console.warn(`[CONN-MGR] ⚠️ Send failed via "${conn.label}": ${err.message}`)

            if (!isSafeToFailover(err)) {
                // Ambiguous failure — don't risk duplicates
                console.error(`[CONN-MGR] ❌ Unsafe to failover (possible duplicate risk). Stopping.`)
                throw err
            }
            // Safe to try next account
        }
    }

    const msg = `All ${sockets.length} account(s) failed: ${errors.map(e => `${e.account}: ${e.error}`).join('; ')}`
    throw new Error(msg)
}

/**
 * Get aggregate connection status.
 */
function getAggregateStatus() {
    if (connections.size === 0) return 'disconnected'
    let hasConnected = false
    let hasDisconnected = false
    for (const conn of connections.values()) {
        if (conn.status === 'connected') hasConnected = true
        else hasDisconnected = true
    }
    if (hasConnected && hasDisconnected) return 'degraded'
    if (hasConnected) return 'connected'
    return 'disconnected'
}

/**
 * Get all account statuses for the UI.
 */
function getAccountStatuses() {
    const statuses = []
    for (const [id, conn] of connections) {
        statuses.push({
            id,
            label: conn.label,
            priority: conn.priority,
            status: conn.status,
        })
    }
    return statuses.sort((a, b) => a.priority - b.priority)
}

/**
 * Get the primary (first healthy) socket — for poll listeners, group sync, etc.
 */
function getPrimarySocket() {
    const sorted = [...connections.values()]
        .filter(c => c.status === 'connected')
        .sort((a, b) => a.priority - b.priority)
    return sorted[0]?.socket || null
}

/**
 * Register a new account in the database.
 */
async function registerAccount(label, phoneNumber, priority) {
    const db = await getDb()
    const id = crypto.randomUUID()

    // If no priority given, assign next available
    if (!priority) {
        const max = await db.get('SELECT MAX(priority) as max_p FROM wa_accounts')
        priority = (max?.max_p || 0) + 1
    }

    await db.run(
        'INSERT INTO wa_accounts (id, label, phone_number, priority) VALUES (?, ?, ?, ?)',
        id, label, phoneNumber || null, priority
    )

    console.log(`[CONN-MGR] 📝 Registered account "${label}" (priority ${priority})`)
    return { id, label, phoneNumber, priority }
}

/**
 * Remove an account — disconnect, delete auth, remove from DB.
 */
async function removeAccount(accountId) {
    await disconnectOne(accountId)

    const authPath = path.join(AUTH_BASE, accountId)
    if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true })
    }

    const db = await getDb()
    await db.run('DELETE FROM wa_accounts WHERE id = ?', accountId)
    console.log(`[CONN-MGR] 🗑️ Removed account ${accountId}`)
}

/**
 * Update priority for an account.
 */
async function updatePriority(accountId, newPriority) {
    const db = await getDb()
    await db.run('UPDATE wa_accounts SET priority = ? WHERE id = ?', newPriority, accountId)
    const conn = connections.get(accountId)
    if (conn) conn.priority = newPriority
}

// --- Internal helpers ---

let lastPersistedStatus = null
async function persistAggregateStatus() {
    try {
        const status = getAggregateStatus()
        // Skip redundant writes. Reconnect churn (WhatsApp closes idle sockets
        // frequently) would otherwise hammer Postgres and keep Neon awake.
        if (status === lastPersistedStatus) return
        const db = await getDb()
        await db.run(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bot_status', ?)",
            status
        )
        lastPersistedStatus = status
    } catch (e) { /* non-critical */ }
}

// Debounced/coalesced status persistence. WhatsApp drops idle sockets often
// (code 428 ~every 30 min), and each disconnect→reconnect flap would otherwise
// write to Postgres twice. We update in-memory conn.status immediately (so
// sending is never delayed) but delay the DB write, collapsing rapid flaps into
// a single write of the final state.
const STATUS_WRITE_DEBOUNCE_MS = parseInt(process.env.STATUS_WRITE_DEBOUNCE_MS ?? '20000', 10)
const statusWriteTimers = new Map()   // accountId → timer
const statusWriteDesired = new Map()  // accountId → { status, error }

function scheduleStatusWrite(accountId, status, error) {
    statusWriteDesired.set(accountId, { status, error })
    if (statusWriteTimers.has(accountId)) return // a write is already scheduled; it will pick up the latest desired state
    const timer = setTimeout(async () => {
        statusWriteTimers.delete(accountId)
        const desired = statusWriteDesired.get(accountId)
        statusWriteDesired.delete(accountId)
        if (!desired) return
        try {
            await updateAccountStatus(accountId, desired.status, desired.error)
        } catch { /* non-critical */ }
        await persistAggregateStatus()
    }, STATUS_WRITE_DEBOUNCE_MS)
    if (timer.unref) timer.unref()
    statusWriteTimers.set(accountId, timer)
}

async function updateAccountStatus(accountId, status, error, pairingCode) {
    const db = await getDb()
    const updates = ['status = ?']
    const args = [status]

    if (status === 'connected') {
        updates.push('last_connected_at = ' + (db._type === 'postgres' ? 'now()' : "datetime('now')"))
    }
    if (error !== undefined) {
        updates.push('last_error = ?')
        args.push(error)
    }

    args.push(accountId)
    await db.run(`UPDATE wa_accounts SET ${updates.join(', ')} WHERE id = ?`, ...args)

    // Store pairing code in app_settings if provided
    if (pairingCode) {
        await db.run(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
            `pairing_code_${accountId}`, pairingCode
        )
    }
}

const lastGroupSync = new Map() // accountId → epoch ms of last successful sync
const GROUP_SYNC_MIN_INTERVAL_MS = parseInt(process.env.GROUP_SYNC_MIN_INTERVAL_MS ?? '3600000', 10) // 1h

const GROUP_ALLOWLIST = parseGroupAllowlist(process.env.GROUP_ALLOWLIST)

async function syncAccountGroups(accountId, socket) {
    // Throttle: skip if we synced this account recently. Group membership is
    // effectively static, so re-fetching + rewriting ~100 rows on every
    // reconnect is pure wasted Postgres compute.
    const last = lastGroupSync.get(accountId) || 0
    if (Date.now() - last < GROUP_SYNC_MIN_INTERVAL_MS) {
        return
    }
    try {
        const groups = await socket.groupFetchAllParticipating()
        const allParticipating = Object.values(groups)

        // Guard: a transient reconnect can make groupFetchAllParticipating()
        // return zero groups. Skip the sync entirely in that case — otherwise
        // the DELETE below would wipe the persisted groups (and groups_cache the
        // portal reads) until the next successful sync an hour later.
        if (allParticipating.length === 0) {
            console.warn(`[CONN-MGR] ⚠️ groupFetchAllParticipating returned 0 groups for ${accountId} — skipping sync (kept existing rows)`)
            return
        }

        const db = await getDb()

        // Clear old entries for this account
        await db.run('DELETE FROM wa_account_groups WHERE account_id = ?', accountId)

        const list = filterAllowedGroups(allParticipating, GROUP_ALLOWLIST)
        for (const g of list) {
            await db.run(
                'INSERT INTO wa_account_groups (account_id, group_jid, group_name) VALUES (?, ?, ?)',
                accountId, g.id, g.subject
            )
        }

        // Also maintain the legacy groups_cache for the API layer
        const allGroups = await db.all('SELECT DISTINCT group_jid as jid, group_name as name FROM wa_account_groups')
        await db.run(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('groups_cache', ?)",
            JSON.stringify(allGroups)
        )

        if (GROUP_ALLOWLIST) {
            console.log(`[CONN-MGR] 📋 Synced ${list.length} of ${allParticipating.length} participating groups for account ${accountId} (allowlist active)`)
            const missing = unmatchedAllowlistEntries(allParticipating, GROUP_ALLOWLIST)
            if (missing.length > 0) {
                console.warn(`[CONN-MGR] ⚠️ GROUP_ALLOWLIST entries matched no group: ${missing.join(', ')}`)
            }
        } else {
            console.log(`[CONN-MGR] 📋 Synced ${list.length} groups for account ${accountId}`)
        }
        lastGroupSync.set(accountId, Date.now())
    } catch (e) {
        console.error(`[CONN-MGR] Failed to sync groups for ${accountId}:`, e.message)
    }
}

/**
 * Auto-migrate legacy single-account auth state.
 * If data/auth_info/ has creds directly (no subdirs matching account IDs) and DB is empty,
 * create a default account and move files.
 */
async function autoMigrateLegacyAuth(db) {
    const accounts = await db.all('SELECT id FROM wa_accounts')
    if (accounts.length > 0) return // Already has accounts, skip migration

    // Check for legacy auth files (creds.json directly in AUTH_BASE)
    const legacyCreds = path.join(AUTH_BASE, 'creds.json')
    if (!fs.existsSync(legacyCreds)) return // No legacy auth

    console.log('[CONN-MGR] 🔄 Migrating legacy single-account auth state...')
    const id = crypto.randomUUID()
    const newPath = path.join(AUTH_BASE, id)
    fs.mkdirSync(newPath, { recursive: true })

    // Move all files from AUTH_BASE to AUTH_BASE/<id>/
    const files = fs.readdirSync(AUTH_BASE)
    for (const file of files) {
        const fullPath = path.join(AUTH_BASE, file)
        if (fs.statSync(fullPath).isFile()) {
            fs.renameSync(fullPath, path.join(newPath, file))
        }
    }

    await db.run(
        'INSERT INTO wa_accounts (id, label, phone_number, priority, status) VALUES (?, ?, ?, ?, ?)',
        id, 'Primary Account', process.env.WHATSAPP_PHONE || null, 1, 'disconnected'
    )

    console.log(`[CONN-MGR] ✅ Legacy auth migrated to account "${id}" (priority 1)`)
}

/**
 * Register the poll-vote handler and wire it onto all currently connected
 * sockets. The handler is also stored at module scope so connectOne can wire it
 * onto every socket created afterwards (including reconnect sockets).
 */
function attachPollListeners(handler) {
    pollHandler = handler
    for (const [accountId, conn] of connections) {
        wirePollListener(accountId, conn.socket, conn.label)
    }
}

/**
 * Get all sockets (for attaching message listeners, etc.)
 */
function getAllConnections() {
    return connections
}

module.exports = {
    connectAll,
    connectOne,
    disconnectOne,
    getHealthySockets,
    sendWithFailover,
    getAggregateStatus,
    getAccountStatuses,
    getPrimarySocket,
    registerAccount,
    removeAccount,
    updatePriority,
    attachPollListeners,
    getAllConnections,
    filterAllowedGroups,
    normalizeGroupKey: require('./group-filter').normalizeGroupKey,
    parseGroupAllowlist,
}
