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

module.exports = { initPollTracking, trackPoll, handlePollVote }
