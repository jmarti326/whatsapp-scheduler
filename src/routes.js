const express = require('express')
const { getDb } = require('./db/index')
const { buildMondaySummary, buildWednesdayReminder, buildThursdayPoll, buildSaturdayReminder, buildSaturdayPoll, buildPersonalNotifications } = require('./messages')
const { getUsers, createUser, deleteUser, changePassword } = require('./auth')
const bcrypt = require('bcrypt')

// Bot and scheduler functions are loaded lazily to avoid pulling in ESM-only baileys on Vercel
function getBotModule() {
    try { return require('./bot') } catch { return null }
}
function getSchedulerModule() {
    try { return require('./scheduler') } catch { return null }
}
function getStatus() {
    const bot = getBotModule()
    return bot ? bot.getStatus() : null
}
function getSocket() {
    const bot = getBotModule()
    return bot ? bot.getSocket() : null
}
function sendScheduledMessage(...args) {
    const sched = getSchedulerModule()
    return sched ? sched.sendScheduledMessage(...args) : Promise.resolve()
}
function getToday() {
    const sched = getSchedulerModule()
    return sched ? sched.getToday() : new Date().toISOString().slice(0, 10)
}
function getGroupJid() {
    const sched = getSchedulerModule()
    if (sched) return sched.getGroupJid()
    // Fallback: read directly from DB (for Vercel/API-only mode)
    return getDb().then(db => db.get("SELECT value FROM app_settings WHERE key = 'group_jid'")).then(r => r?.value || null)
}

const router = express.Router()
const appVersion = require('../package.json').version

// --- Health check (no auth required) ---
router.get('/health', async (req, res) => {
    try {
        const db = await getDb()
        await db.get("SELECT 1")
        res.json({ status: 'ok', version: appVersion })
    } catch (err) {
        res.status(503).json({ status: 'error', error: err.message })
    }
})

// --- API: Dashboard ---
router.get('/api/status', async (req, res) => {
    try {
        const db = await getDb()
        const recentLogs = await db.all('SELECT * FROM message_logs ORDER BY sent_at DESC LIMIT 10')
        const groupJid = await getGroupJid()
        const alias = await db.get('SELECT alias FROM group_aliases WHERE jid = ?', groupJid)

        // Use in-memory status if bot is local, otherwise read from DB
        let connection = getStatus()
        if (!connection) {
            const row = await db.get("SELECT value FROM app_settings WHERE key = 'bot_status'")
            connection = row?.value || 'disconnected'
        }

        // Try alias first, then look up group name from cache
        let groupName = alias?.alias || null
        if (!groupName && groupJid) {
            const cache = await db.get("SELECT value FROM app_settings WHERE key = 'groups_cache'")
            if (cache?.value) {
                try {
                    const groups = JSON.parse(cache.value)
                    const match = groups.find(g => g.jid === groupJid)
                    if (match) groupName = match.name
                } catch {}
            }
        }

        res.json({
            version: appVersion,
            connection,
            groupJid,
            groupAlias: groupName,
            today: getToday(),
            recentLogs,
        })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Team Members ---
router.get('/api/team', async (req, res) => {
    try {
        const db = await getDb()
        const members = await db.all('SELECT * FROM team_members ORDER BY name')
        res.json(members)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/team', async (req, res) => {
    try {
        const db = await getDb()
        const { name, phone } = req.body
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' })
        const cleanPhone = phone.replace(/[^0-9]/g, '')
        await db.run('INSERT OR IGNORE INTO team_members (name, phone) VALUES (?, ?)', name, cleanPhone)
        res.json({ success: true })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
})

router.delete('/api/team/:id', async (req, res) => {
    try {
        const db = await getDb()
        await db.run('DELETE FROM team_members WHERE id = ?', req.params.id)
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.put('/api/team/:id', async (req, res) => {
    try {
        const db = await getDb()
        const { name, phone } = req.body
        if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' })
        const cleanPhone = phone.replace(/[^0-9]/g, '')
        await db.run('UPDATE team_members SET name = ?, phone = ? WHERE id = ?', name, cleanPhone, req.params.id)
        res.json({ success: true })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
})

// --- API: Schedule ---
router.get('/api/schedule', async (req, res) => {
    try {
        const db = await getDb()
        const entries = await db.all(`
            SELECT se.id, se.service_date, se.day_type, se.role, tm.name, tm.phone, tm.id as member_id
            FROM schedule_entries se
            JOIN team_members tm ON se.member_id = tm.id
            ORDER BY se.service_date ASC, se.day_type, CASE se.role WHEN 'primary' THEN 0 ELSE 1 END
        `)
        res.json(entries)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/schedule', async (req, res) => {
    try {
        const db = await getDb()
        const { service_date, day_type, member_id, role } = req.body
        if (!service_date || !day_type || !member_id) {
            return res.status(400).json({ error: 'service_date, day_type, and member_id required' })
        }
        // Only allow Thursday or Sunday service days
        const [y, m, d] = service_date.split('-').map(Number)
        const dayOfWeek = new Date(y, m - 1, d).getDay()
        if ((day_type === 'thursday' && dayOfWeek !== 4) || (day_type === 'sunday' && dayOfWeek !== 0)) {
            return res.status(400).json({ error: 'Date does not match the day type' })
        }
        if (dayOfWeek !== 4 && dayOfWeek !== 0) {
            return res.status(400).json({ error: 'Only Thursday or Sunday dates are allowed' })
        }
        const memberRole = role || 'primary'
        await db.run(
            'INSERT OR IGNORE INTO schedule_entries (service_date, day_type, member_id, role) VALUES (?, ?, ?, ?)',
            service_date, day_type, member_id, memberRole
        )
        res.json({ success: true })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
})

router.delete('/api/schedule/:id', async (req, res) => {
    try {
        const db = await getDb()
        await db.run('DELETE FROM schedule_entries WHERE id = ?', req.params.id)
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Calendar (monthly view) ---
router.get('/api/calendar/:year/:month', async (req, res) => {
    try {
        const db = await getDb()
        const year = parseInt(req.params.year)
        const month = parseInt(req.params.month)
        if (!year || !month || month < 1 || month > 12) {
            return res.status(400).json({ error: 'Invalid year/month' })
        }
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`
        const lastDay = new Date(year, month, 0).getDate()
        const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

        const entries = await db.all(`
            SELECT se.id, se.service_date, se.day_type, se.role, tm.name, tm.id as member_id
            FROM schedule_entries se
            JOIN team_members tm ON se.member_id = tm.id
            WHERE se.service_date >= ? AND se.service_date <= ?
            ORDER BY se.service_date ASC, CASE se.role WHEN 'primary' THEN 0 ELSE 1 END, tm.name
        `, startDate, endDate)

        const byDate = {}
        entries.forEach(e => {
            if (!byDate[e.service_date]) byDate[e.service_date] = []
            byDate[e.service_date].push(e)
        })

        res.json({ year, month, lastDay, entries: byDate })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Manual Send / Preview ---
router.post('/api/preview', async (req, res) => {
    const { type, date } = req.body
    const targetDate = date || getToday()

    try {
        let result = {}
        switch (type) {
            case 'monday-summary':
                result = await buildMondaySummary(targetDate)
                break
            case 'wednesday-reminder':
                result = await buildWednesdayReminder(targetDate)
                break
            case 'thursday-poll':
                result = await buildThursdayPoll(targetDate)
                result = { text: `📊 POLL: ${result.pollName}\nOptions: ${result.values.join(', ')}`, mentions: result.mentions }
                break
            case 'saturday-reminder':
                result = await buildSaturdayReminder(targetDate)
                break
            case 'saturday-poll':
                result = await buildSaturdayPoll(targetDate)
                result = { text: `📊 POLL: ${result.pollName}\nOptions: ${result.values.join(', ')}`, mentions: result.mentions }
                break
            default:
                return res.status(400).json({ error: 'Invalid message type' })
        }
        res.json({ preview: result.text, mentions: result.mentions, type, date: targetDate })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/send', async (req, res) => {
    const { type, force, date, groupJid } = req.body

    const validTypes = ['monday-summary', 'wednesday-reminder', 'thursday-poll', 'saturday-reminder', 'saturday-poll']
    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'Invalid message type' })
    }

    // If bot is local (worker/all mode), send directly
    const sched = getSchedulerModule()
    if (sched) {
        const buildFns = {
            'monday-summary': buildMondaySummary,
            'wednesday-reminder': buildWednesdayReminder,
            'thursday-poll': null,
            'saturday-reminder': buildSaturdayReminder,
            'saturday-poll': null,
        }
        const result = await sched.sendScheduledMessage(type, buildFns[type], force === true, date, groupJid)
        return res.json(result)
    }

    // Otherwise queue it for the worker to pick up
    const db = await getDb()
    const targetDate = date || getToday()
    await db.run(
        "INSERT INTO pending_sends (type, date, group_jid, force_send) VALUES (?, ?, ?, ?)",
        type, targetDate, groupJid || null, force ? 1 : 0
    )
    // Push-notify the worker to drain immediately (best-effort; falls back to the
    // worker's optional safety-net poll if the trigger is unconfigured or fails).
    const { fireDrainTrigger } = require('./trigger')
    const trigger = await fireDrainTrigger()
    res.json({ queued: true, type, date: targetDate, triggered: !!trigger.ok, message: 'Message queued — worker will send it shortly' })
})

// --- API: Personal DMs ---
router.post('/api/personal/preview', async (req, res) => {
    const { date, dayType } = req.body
    const targetDate = date || getToday()
    const type = dayType || 'thursday'
    try {
        const notifications = await buildPersonalNotifications(targetDate, type)
        res.json(notifications)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/personal/send', async (req, res) => {
    const { date, dayType, phone } = req.body
    const targetDate = date || getToday()
    const type = dayType || 'thursday'

    if (getStatus() !== 'connected') {
        return res.status(503).json({ error: 'Bot not connected' })
    }

    try {
        const { sendTextMessage } = require('./bot')
        const notifications = await buildPersonalNotifications(targetDate, type)
        const toSend = phone ? notifications.filter(n => n.phone === phone) : notifications
        const results = []

        for (const n of toSend) {
            await sendTextMessage(n.jid, n.text)
            results.push({ name: n.name, role: n.role, sent: true })
        }

        res.json({ sent: results.length, results })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Settings ---
router.get('/api/settings', async (req, res) => {
    try {
        const db = await getDb()
        const rows = await db.all('SELECT * FROM app_settings')
        const settings = {}
        rows.forEach(r => settings[r.key] = r.value)
        res.json(settings)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/settings', async (req, res) => {
    try {
        const db = await getDb()
        const { key, value } = req.body
        await db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', key, value)
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Groups (fetch from WhatsApp or DB cache) ---
router.get('/api/groups', async (req, res) => {
    try {
        const db = await getDb()
        const aliasRows = await db.all('SELECT jid, alias FROM group_aliases')
        const aliases = {}
        aliasRows.forEach(r => aliases[r.jid] = r.alias)

        // Try live fetch from socket if available
        const sock = getSocket()
        if (sock) {
            const groups = await sock.groupFetchAllParticipating()
            const list = Object.values(groups).map(g => ({
                jid: g.id,
                name: g.subject,
                alias: aliases[g.id] || null,
                participants: g.participants?.length || 0,
            })).sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name))
            return res.json(list)
        }

        // Fall back to cached groups from DB
        const cache = await db.get("SELECT value FROM app_settings WHERE key = 'groups_cache'")
        if (!cache?.value) {
            return res.status(503).json({ error: 'Bot not connected' })
        }
        const cached = JSON.parse(cache.value)
        const list = cached.map(g => ({
            ...g,
            alias: aliases[g.jid] || null,
            participants: 0,
        })).sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name))
        res.json(list)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/groups/alias', async (req, res) => {
    try {
        const db = await getDb()
        const { jid, alias } = req.body
        if (!jid || !alias) return res.status(400).json({ error: 'jid and alias required' })
        await db.run('INSERT OR REPLACE INTO group_aliases (jid, alias) VALUES (?, ?)', jid, alias.trim())
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Logs ---
router.get('/api/logs', async (req, res) => {
    try {
        const db = await getDb()
        const logs = await db.all('SELECT * FROM message_logs ORDER BY sent_at DESC LIMIT 50')
        res.json(logs)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Users (admin only) ---
router.get('/api/users', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    try {
        res.json(await getUsers())
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/users', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    const { username, password, isAdmin } = req.body
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
    try {
        await createUser(username, password, isAdmin ? 1 : 0)
        res.json({ success: true })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
})

router.delete('/api/users/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    const id = parseInt(req.params.id)
    if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' })
    try {
        await deleteUser(id)
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/users/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' })
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

    try {
        const db = await getDb()
        const user = await db.get('SELECT * FROM users WHERE id = ?', req.session.userId)
        if (!await bcrypt.compare(currentPassword, user.password_hash)) {
            return res.status(401).json({ error: 'Current password is incorrect' })
        }
        await changePassword(req.session.userId, newPassword)
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Current user ---
router.get('/api/me', (req, res) => {
    res.json({ username: req.session.username, isAdmin: req.session.isAdmin })
})

// --- API: WhatsApp Accounts (admin only) ---
router.get('/api/accounts', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    try {
        const db = await getDb()
        const accounts = await db.all(`
            SELECT a.id, a.label, a.phone_number, a.priority, a.status,
                   a.last_connected_at, a.last_error, a.created_at,
                   p.value AS pairing_code, q.value AS pairing_qr
            FROM wa_accounts a
            LEFT JOIN app_settings p ON p.key = 'pairing_code_' || a.id
            LEFT JOIN app_settings q ON q.key = 'pairing_qr_' || a.id
            ORDER BY a.priority ASC, a.created_at ASC
        `)
        res.json(accounts)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/accounts', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    const { label, phoneNumber, priority, registrationMethod = 'phone' } = req.body
    if (!label) return res.status(400).json({ error: 'Label is required' })
    if (!['phone', 'qr'].includes(registrationMethod)) {
        return res.status(400).json({ error: 'Registration method must be phone or qr' })
    }
    if (registrationMethod === 'phone' && !phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required for phone pairing' })
    }
    try {
        const db = await getDb()
        const crypto = require('crypto')
        const id = crypto.randomUUID()
        const effectivePriority = priority || ((await db.get('SELECT MAX(priority) as max_p FROM wa_accounts'))?.max_p || 0) + 1
        const cleanPhone = phoneNumber ? phoneNumber.replace(/[^0-9]/g, '') : null

        await db.run(
            'INSERT INTO wa_accounts (id, label, phone_number, priority) VALUES (?, ?, ?, ?)',
            id, label, cleanPhone, effectivePriority
        )

        if ((process.env.APP_ROLE || 'all') === 'all') {
            const cm = require('./connection-manager')
            const account = await db.get('SELECT * FROM wa_accounts WHERE id = ?', id)
            await cm.connectOne(account, { registrationMethod })
        } else {
            const { fireAccountReconnectTrigger } = require('./trigger')
            const trigger = await fireAccountReconnectTrigger(id, true, registrationMethod)
            if (!trigger.ok) {
                return res.status(502).json({
                    error: trigger.body?.error || trigger.error || 'Worker registration trigger failed',
                    id,
                })
            }
        }

        res.json({ success: true, id, label, priority: effectivePriority })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.put('/api/accounts/:id/priority', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    const { priority } = req.body
    if (priority == null || priority < 1) return res.status(400).json({ error: 'Priority must be >= 1' })
    try {
        const db = await getDb()
        await db.run('UPDATE wa_accounts SET priority = ? WHERE id = ?', priority, req.params.id)

        // Update in-memory state if connection manager is loaded
        try {
            const cm = require('./connection-manager')
            cm.updatePriority(req.params.id, priority)
        } catch {}

        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.delete('/api/accounts/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    try {
        // Use connection manager if available (handles socket disconnect + file cleanup)
        try {
            const cm = require('./connection-manager')
            await cm.removeAccount(req.params.id)
        } catch {
            // Fallback: just delete from DB
            const db = await getDb()
            await db.run('DELETE FROM wa_accounts WHERE id = ?', req.params.id)
        }
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.post('/api/accounts/:id/reconnect', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    try {
        const registrationMethod = req.body?.registrationMethod || 'phone'
        if (!['phone', 'qr'].includes(registrationMethod)) {
            return res.status(400).json({ error: 'Registration method must be phone or qr' })
        }
        const db = await getDb()
        const account = await db.get('SELECT * FROM wa_accounts WHERE id = ?', req.params.id)
        if (!account) return res.status(404).json({ error: 'Account not found' })
        const resetAuth = registrationMethod === 'qr' ||
            account.status === 'logged_out' ||
            account.status === 'pairing_failed' ||
            /(?:401|logged out|connection failure)/i.test(account.last_error || '')

        if ((process.env.APP_ROLE || 'all') === 'all') {
            const cm = require('./connection-manager')
            if (resetAuth) await cm.restartRegistration(req.params.id, registrationMethod)
            else {
                await cm.disconnectOne(req.params.id)
                await cm.connectOne(account)
            }
        } else {
            const { fireAccountReconnectTrigger } = require('./trigger')
            const trigger = await fireAccountReconnectTrigger(req.params.id, resetAuth, registrationMethod)
            if (!trigger.ok) {
                return res.status(502).json({
                    error: trigger.body?.error || trigger.error || 'Worker reconnect trigger failed',
                })
            }
        }
        res.json({
            success: true,
            resetAuth,
            registrationMethod,
            message: resetAuth
                ? `Fresh registration started for "${account.label}"`
                : `Reconnecting "${account.label}"...`,
        })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

router.get('/api/accounts/health', async (req, res) => {
    try {
        const db = await getDb()
        const accounts = await db.all(`
            SELECT a.id, a.label, a.phone_number, a.priority, a.status,
                   a.last_connected_at, a.last_error, p.value AS pairing_code,
                   q.value AS pairing_qr
            FROM wa_accounts a
            LEFT JOIN app_settings p ON p.key = 'pairing_code_' || a.id
            LEFT JOIN app_settings q ON q.key = 'pairing_qr_' || a.id
            ORDER BY a.priority ASC
        `)
        const total = accounts.length
        const connected = accounts.filter(a => a.status === 'connected').length
        const aggregate = total === 0 ? 'no_accounts' : connected === total ? 'connected' : connected > 0 ? 'degraded' : 'disconnected'
        res.json({ aggregate, total, connected, accounts })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// --- API: Send Log ---
router.get('/api/send-log', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin only' })
    try {
        const db = await getDb()
        const logs = await db.all(`
            SELECT sl.*, wa.label as account_label
            FROM send_log sl
            LEFT JOIN wa_accounts wa ON sl.account_id = wa.id
            ORDER BY sl.created_at DESC LIMIT 100
        `)
        res.json(logs)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

module.exports = router
