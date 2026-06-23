const { getDb } = require('./db/index')
const { getAssignedMembers, getWeekDates } = require('./messages')

const AUTO_FOOTER = '\n\n_🤖 Mensaje enviado automáticamente por IPR Team Scheduler AI Agent_'

// Poll options that indicate "No" (case-insensitive partial match)
const NO_OPTIONS = ['no puedo']

/**
 * Initialize the poll tracking table
 */
async function initPollTracking() {
    const db = await getDb()
    if (db._type === 'postgres') {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS active_polls (
                poll_msg_id TEXT PRIMARY KEY,
                poll_sender_jid TEXT NOT NULL,
                group_jid TEXT NOT NULL,
                service_date TEXT NOT NULL,
                day_type TEXT NOT NULL CHECK(day_type IN ('thursday', 'sunday')),
                created_at TIMESTAMPTZ DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS poll_responses (
                id SERIAL PRIMARY KEY,
                poll_msg_id TEXT NOT NULL,
                voter_jid TEXT NOT NULL,
                selected_option TEXT NOT NULL,
                processed INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT now(),
                UNIQUE(poll_msg_id, voter_jid)
            );
        `)
    } else {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS active_polls (
                poll_msg_id TEXT PRIMARY KEY,
                poll_sender_jid TEXT NOT NULL,
                group_jid TEXT NOT NULL,
                service_date TEXT NOT NULL,
                day_type TEXT NOT NULL CHECK(day_type IN ('thursday', 'sunday')),
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS poll_responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                poll_msg_id TEXT NOT NULL,
                voter_jid TEXT NOT NULL,
                selected_option TEXT NOT NULL,
                processed INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(poll_msg_id, voter_jid)
            );
        `)
    }
    console.log('[POLL-HANDLER] ✅ Poll tracking tables ready')
}

/**
 * Store a poll reference when we send one.
 * Called by scheduler after sending a poll.
 */
async function trackPoll(msgKey, groupJid, serviceDate, dayType) {
    const db = await getDb()
    const msgId = msgKey.id
    await db.run(
        `INSERT OR REPLACE INTO active_polls (poll_msg_id, poll_sender_jid, group_jid, service_date, day_type)
         VALUES (?, ?, ?, ?, ?)`,
        msgId, groupJid, groupJid, serviceDate, dayType
    )
    console.log(`[POLL-HANDLER] 📊 Tracking poll ${msgId} for ${dayType} ${serviceDate}`)
}

/**
 * Handle poll vote updates from Baileys messages.update event.
 * Called by bot.js when it detects pollUpdates.
 */
async function handlePollVote(pollMsgKey, pollUpdates, sendTextMessage) {
    const db = await getDb()
    const pollMsgId = pollMsgKey.id

    // Check if this poll is one we're tracking
    const poll = await db.get(
        'SELECT * FROM active_polls WHERE poll_msg_id = ?',
        pollMsgId
    )

    if (!poll) return // Not one of our tracked polls

    for (const update of pollUpdates) {
        const voterJid = update.pollUpdateMessageKey?.participant ||
                         update.pollUpdateMessageKey?.remoteJid
        if (!voterJid) continue

        const selectedOptions = update.vote?.selectedOptions || []
        if (selectedOptions.length === 0) continue

        const selectedText = selectedOptions[0] // Single-choice poll
        console.log(`[POLL-HANDLER] 🗳️ Vote received: ${voterJid} → "${selectedText}"`)

        // Store the response (upsert in case they change their vote)
        await db.run(
            `INSERT OR REPLACE INTO poll_responses (poll_msg_id, voter_jid, selected_option, processed)
             VALUES (?, ?, ?, 0)`,
            pollMsgId, voterJid, selectedText
        )

        // Check if this is a "No" vote from a primary member
        const isNoVote = NO_OPTIONS.some(opt =>
            selectedText.toLowerCase().includes(opt)
        )

        if (isNoVote) {
            await notifyBackup(poll, voterJid, sendTextMessage)
        }
    }
}

/**
 * Notify backup members when a primary votes "No"
 */
async function notifyBackup(poll, voterJid, sendTextMessage) {
    const db = await getDb()

    // Extract phone from JID (e.g., "573001234567@s.whatsapp.net" → "573001234567")
    const voterPhone = voterJid.replace('@s.whatsapp.net', '')

    // Verify this voter is a primary member for this service date
    const voterMember = await db.get(`
        SELECT tm.id, tm.name, tm.phone, se.role
        FROM team_members tm
        JOIN schedule_entries se ON se.member_id = tm.id
        WHERE tm.phone = ? AND se.service_date = ? AND se.day_type = ? AND se.role = 'primary'
    `, voterPhone, poll.service_date, poll.day_type)

    if (!voterMember) {
        console.log(`[POLL-HANDLER] ℹ️ Voter ${voterPhone} is not a primary for this date, ignoring`)
        return
    }

    // Check if we already notified the backup for this poll + voter
    const alreadyNotified = await db.get(
        `SELECT 1 FROM poll_responses
         WHERE poll_msg_id = ? AND voter_jid = ? AND processed = 1`,
        poll.poll_msg_id, voterJid
    )

    if (alreadyNotified) {
        console.log(`[POLL-HANDLER] ⏭️ Backup already notified for ${voterMember.name}`)
        return
    }

    // Get backup members for this service date
    const backups = await db.all(`
        SELECT tm.name, tm.phone
        FROM team_members tm
        JOIN schedule_entries se ON se.member_id = tm.id
        WHERE se.service_date = ? AND se.day_type = ? AND se.role = 'backup'
    `, poll.service_date, poll.day_type)

    if (backups.length === 0) {
        console.log(`[POLL-HANDLER] ⚠️ No backup assigned for ${poll.day_type} ${poll.service_date}`)
        return
    }

    const dayLabel = poll.day_type === 'thursday' ? 'jueves' : 'domingo'
    const dateFormatted = poll.service_date.split('-').slice(1).reverse().join('/')

    for (const backup of backups) {
        // 1. Send DM to backup
        const dmJid = `${backup.phone}@s.whatsapp.net`
        const dmText = `🚨 *¡Te necesitamos!*\n\n` +
            `Hola ${backup.name}, ${voterMember.name} indicó que *no puede asistir* ` +
            `este *${dayLabel} ${dateFormatted}*.\n\n` +
            `Como eres el backup asignado, ¿podrías cubrir el servicio de audiovisual?\n\n` +
            `¡Gracias por tu disponibilidad! 🙏` + AUTO_FOOTER

        try {
            await sendTextMessage(dmJid, dmText)
            console.log(`[POLL-HANDLER] 📨 DM sent to backup: ${backup.name}`)
        } catch (err) {
            console.error(`[POLL-HANDLER] ❌ Failed DM to ${backup.name}:`, err.message)
        }

        // 2. Send group notification mentioning the backup
        const groupText = `📢 *Aviso:* @${voterMember.phone} indicó que no puede asistir ` +
            `este ${dayLabel} ${dateFormatted}.\n\n` +
            `@${backup.phone} — como backup asignado, ¿puedes cubrir? 🙏` + AUTO_FOOTER

        const mentions = [
            `${voterMember.phone}@s.whatsapp.net`,
            `${backup.phone}@s.whatsapp.net`
        ]

        try {
            await sendTextMessage(poll.group_jid, groupText, mentions)
            console.log(`[POLL-HANDLER] 📢 Group notification sent mentioning ${backup.name}`)
        } catch (err) {
            console.error(`[POLL-HANDLER] ❌ Failed group notification:`, err.message)
        }
    }

    // Mark as processed so we don't notify again
    await db.run(
        `UPDATE poll_responses SET processed = 1 WHERE poll_msg_id = ? AND voter_jid = ?`,
        poll.poll_msg_id, voterJid
    )

    console.log(`[POLL-HANDLER] ✅ Backup notification complete for ${voterMember.name} → ${backups.map(b => b.name).join(', ')}`)
}

/**
 * Send a follow-up DM to primaries who haven't responded to today's poll.
 * Called by cron at 3:00 PM AST on Thu and Sat.
 */
async function remindNonResponders(dayType, sendTextMessage) {
    const db = await getDb()

    // Find today's poll for this day type
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Puerto_Rico' })
    const poll = await db.get(
        `SELECT * FROM active_polls WHERE day_type = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
        dayType, today
    )

    if (!poll) {
        console.log(`[POLL-HANDLER] ℹ️ No active ${dayType} poll found for today, skipping reminder`)
        return { skipped: true, reason: 'no_poll' }
    }

    // Get primaries assigned for this service date
    const primaries = await db.all(`
        SELECT tm.name, tm.phone
        FROM team_members tm
        JOIN schedule_entries se ON se.member_id = tm.id
        WHERE se.service_date = ? AND se.day_type = ? AND se.role = 'primary'
    `, poll.service_date, dayType)

    if (primaries.length === 0) {
        console.log(`[POLL-HANDLER] ℹ️ No primaries for ${dayType} ${poll.service_date}`)
        return { skipped: true, reason: 'no_primaries' }
    }

    // Get who already responded
    const responses = await db.all(
        `SELECT voter_jid FROM poll_responses WHERE poll_msg_id = ?`,
        poll.poll_msg_id
    )
    const respondedPhones = new Set(
        responses.map(r => r.voter_jid.replace('@s.whatsapp.net', ''))
    )

    // Find who hasn't responded
    const nonResponders = primaries.filter(m => !respondedPhones.has(m.phone))

    if (nonResponders.length === 0) {
        console.log(`[POLL-HANDLER] ✅ All primaries responded to ${dayType} poll`)
        return { skipped: true, reason: 'all_responded' }
    }

    // Check if we already sent reminders today
    const reminderKey = `${today}:poll-reminder-${dayType}`
    const alreadySent = await db.get(
        `SELECT 1 FROM message_logs WHERE message_key = ?`, reminderKey
    )
    if (alreadySent) {
        console.log(`[POLL-HANDLER] ⏭️ Poll reminders already sent: ${reminderKey}`)
        return { skipped: true, reason: 'already_sent' }
    }

    const dayLabel = dayType === 'thursday' ? 'hoy jueves' : 'mañana domingo'
    let sentCount = 0

    for (const member of nonResponders) {
        const jid = `${member.phone}@s.whatsapp.net`
        const text = `👋 Hola ${member.name},\n\n` +
            `Aún no has respondido la encuesta de asistencia para *${dayLabel}*. ` +
            `¿Podrás estar? 🙏\n\n` +
            `Por favor responde en el grupo para que podamos confirmar el equipo.` + AUTO_FOOTER

        try {
            await sendTextMessage(jid, text)
            console.log(`[POLL-HANDLER] 📨 Reminder sent to ${member.name}`)
            sentCount++
            await new Promise(resolve => setTimeout(resolve, 2000))
        } catch (err) {
            console.error(`[POLL-HANDLER] ❌ Failed reminder to ${member.name}:`, err.message)
        }
    }

    // Log so we don't send again today
    await db.run(
        `INSERT OR IGNORE INTO message_logs (message_key, message_type, content) VALUES (?, ?, ?)`,
        reminderKey, `poll-reminder-${dayType}`, `Reminded ${sentCount}/${nonResponders.length}: ${nonResponders.map(m => m.name).join(', ')}`
    )

    console.log(`[POLL-HANDLER] ✅ Reminders sent: ${sentCount}/${nonResponders.length} non-responders`)
    return { sent: true, count: sentCount, total: nonResponders.length, names: nonResponders.map(m => m.name) }
}

module.exports = { initPollTracking, trackPoll, handlePollVote, remindNonResponders }
