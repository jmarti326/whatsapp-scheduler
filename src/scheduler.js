const cron = require('node-cron')
const { getDb } = require('./db/index')
const { sendTextMessage, sendPoll, getStatus } = require('./bot')
const { buildMondaySummary, buildWednesdayReminder, buildThursdayPoll, buildSaturdayReminder, buildSaturdayPoll, buildPersonalNotifications, getWeekDates } = require('./messages')
const { initPollTracking, trackPoll, remindNonResponders } = require('./poll-handler')

async function getGroupJid() {
    const db = await getDb()
    const row = await db.get("SELECT value FROM app_settings WHERE key = 'group_jid'")
    return row?.value
}

function getToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' })
}

function messageKey(type, date) {
    return `${date}:${type}`
}

async function alreadySent(key) {
    const db = await getDb()
    const row = await db.get('SELECT 1 FROM message_logs WHERE message_key = ?', key)
    return !!row
}

async function logMessage(key, type, content) {
    const db = await getDb()
    await db.run(
        'INSERT OR IGNORE INTO message_logs (message_key, message_type, content) VALUES (?, ?, ?)',
        key, type, content
    )
}

async function sendScheduledMessage(type, buildFn, forceSend = false, dateOverride = null, groupJidOverride = null) {
    const today = dateOverride || getToday()
    const key = messageKey(type, today)
    const groupJid = groupJidOverride || await getGroupJid()

    if (!forceSend && await alreadySent(key)) {
        console.log(`[SCHEDULER] ⏭️ Already sent: ${key}`)
        return { skipped: true, key }
    }

    if (getStatus() !== 'connected') {
        console.log(`[SCHEDULER] ❌ Bot not connected, skipping: ${type}`)
        return { error: 'Bot not connected' }
    }

    try {
        if (type === 'thursday-poll') {
            const today2 = dateOverride || getToday()
            const { pollName, values, mentions } = await buildThursdayPoll(today2)
            const sentMsg = await sendPoll(groupJid, pollName, values, 1, mentions)
            // Track poll for vote monitoring
            const { thursday } = getWeekDates(today2)
            if (sentMsg?.key) await trackPoll(sentMsg.key, groupJid, thursday, 'thursday')
            await logMessage(key, type, pollName)
            console.log(`[SCHEDULER] ✅ Sent: ${type}`)
            return { sent: true, key, content: pollName }
        } else if (type === 'saturday-poll') {
            const today2 = dateOverride || getToday()
            const { pollName, values, mentions } = await buildSaturdayPoll(today2)
            const sentMsg = await sendPoll(groupJid, pollName, values, 1, mentions)
            // Track poll for vote monitoring — service date is tomorrow (Sunday)
            const parts = today2.split('-')
            const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
            date.setDate(date.getDate() + 1)
            const sunday = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
            if (sentMsg?.key) await trackPoll(sentMsg.key, groupJid, sunday, 'sunday')
            await logMessage(key, type, pollName)
            console.log(`[SCHEDULER] ✅ Sent: ${type}`)
            return { sent: true, key, content: pollName }
        } else {
            const { text, mentions } = await buildFn(today)
            await sendTextMessage(groupJid, text, mentions)
            await logMessage(key, type, text)
            console.log(`[SCHEDULER] ✅ Sent: ${type}`)
            return { sent: true, key, content: text }
        }
    } catch (err) {
        console.error(`[SCHEDULER] ❌ Failed to send ${type}:`, err.message)
        return { error: err.message }
    }
}

/**
 * Send personal DM notifications to all assigned members for a given day type.
 * Called automatically after the group reminder messages.
 */
async function sendPersonalDMs(today, dayType) {
    const dmKey = messageKey(`personal-dm-${dayType}`, today)
    if (await alreadySent(dmKey)) {
        console.log(`[SCHEDULER] ⏭️ Personal DMs already sent: ${dmKey}`)
        return { skipped: true }
    }

    if (getStatus() !== 'connected') {
        console.log(`[SCHEDULER] ❌ Bot not connected, skipping personal DMs`)
        return { error: 'Bot not connected' }
    }

    try {
        const notifications = await buildPersonalNotifications(today, dayType)
        let sentCount = 0

        for (const notif of notifications) {
            try {
                await sendTextMessage(notif.jid, notif.text)
                console.log(`[SCHEDULER] 📨 DM sent to ${notif.name} (${notif.role})`)
                sentCount++
                // Small delay between DMs to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 2000))
            } catch (err) {
                console.error(`[SCHEDULER] ❌ Failed DM to ${notif.name}:`, err.message)
            }
        }

        await logMessage(dmKey, `personal-dm-${dayType}`, `Sent ${sentCount}/${notifications.length} personal DMs`)
        console.log(`[SCHEDULER] ✅ Personal DMs complete: ${sentCount}/${notifications.length}`)
        return { sent: true, count: sentCount, total: notifications.length }
    } catch (err) {
        console.error(`[SCHEDULER] ❌ Personal DMs failed:`, err.message)
        return { error: err.message }
    }
}

function startScheduler() {
    // Initialize poll tracking tables
    initPollTracking().catch(err => console.error('[SCHEDULER] Poll tracking init error:', err.message))

    // Monday 8:00 AM AST — Weekly summary + personal DMs for Thursday team
    cron.schedule('0 8 * * 1', async () => {
        console.log('[CRON] Monday summary triggered')
        await sendScheduledMessage('monday-summary', buildMondaySummary)
    }, { timezone: 'America/Puerto_Rico' })

    // Wednesday 8:00 AM AST — Thursday reminder + personal DMs to Thursday team
    cron.schedule('0 8 * * 3', async () => {
        console.log('[CRON] Wednesday reminder triggered')
        const today = getToday()
        await sendScheduledMessage('wednesday-reminder', buildWednesdayReminder)
        // Send individual DMs to Thursday team after group message
        setTimeout(() => sendPersonalDMs(today, 'thursday'), 5000)
    }, { timezone: 'America/Puerto_Rico' })

    // Thursday 8:00 AM AST — Attendance poll
    cron.schedule('0 8 * * 4', async () => {
        console.log('[CRON] Thursday poll triggered')
        await sendScheduledMessage('thursday-poll', null)
    }, { timezone: 'America/Puerto_Rico' })

    // Saturday 8:00 AM AST — Sunday reminder + poll + personal DMs to Sunday team
    cron.schedule('0 8 * * 6', async () => {
        console.log('[CRON] Saturday reminder + poll triggered')
        const today = getToday()
        await sendScheduledMessage('saturday-reminder', buildSaturdayReminder)
        setTimeout(async () => {
            await sendScheduledMessage('saturday-poll', null)
            // Send individual DMs to Sunday team after group messages
            setTimeout(() => sendPersonalDMs(today, 'sunday'), 5000)
        }, 3000)
    }, { timezone: 'America/Puerto_Rico' })

    // Poll for queued sends from the API every 10 seconds
    setInterval(processPendingSends, 10000)

    // Thursday 3:00 PM AST — Remind primaries who haven't responded to today's poll
    cron.schedule('0 15 * * 4', async () => {
        console.log('[CRON] Thursday poll reminder triggered')
        await remindNonResponders('thursday', sendTextMessage)
    }, { timezone: 'America/Puerto_Rico' })

    // Saturday 3:00 PM AST — Remind primaries who haven't responded to Sunday poll
    cron.schedule('0 15 * * 6', async () => {
        console.log('[CRON] Saturday poll reminder triggered')
        await remindNonResponders('sunday', sendTextMessage)
    }, { timezone: 'America/Puerto_Rico' })

    console.log('[SCHEDULER] ✅ Cron jobs started (Mon/Wed/Thu/Sat at 8:00 AM AST)')
    console.log('[SCHEDULER] 📨 Personal DMs enabled for Wed (Thu team) and Sat (Sun team)')
    console.log('[SCHEDULER] ⏰ Poll reminders at 3:00 PM AST (Thu & Sat) for non-responders')
}

async function processPendingSends() {
    try {
        const db = await getDb()
        const pending = await db.all(
            "SELECT * FROM pending_sends WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5"
        )
        if (!pending.length) return

        const buildFns = {
            'monday-summary': buildMondaySummary,
            'wednesday-reminder': buildWednesdayReminder,
            'thursday-poll': null,
            'saturday-reminder': buildSaturdayReminder,
            'saturday-poll': null,
        }

        for (const item of pending) {
            const result = await sendScheduledMessage(
                item.type, buildFns[item.type],
                item.force_send, item.date, item.group_jid
            )
            await db.run(
                "UPDATE pending_sends SET status = 'done', result = ?, processed_at = datetime('now') WHERE id = ?",
                JSON.stringify(result), item.id
            )
            console.log(`[QUEUE] Processed: ${item.type} → ${result.sent ? 'sent' : result.error || 'skipped'}`)
        }
    } catch (e) {
        // Non-critical — will retry next interval
    }
}

module.exports = { startScheduler, sendScheduledMessage, sendPersonalDMs, getToday, getGroupJid }
