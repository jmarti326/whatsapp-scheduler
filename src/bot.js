const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('baileys')
const pino = require('pino')
const path = require('path')
const { getDb } = require('./db/index')
const { initPollTracking, handlePollVote } = require('./poll-handler')

const logger = pino({ level: 'silent' })
const AUTH_PATH = path.join(__dirname, '..', 'data', 'auth_info')

let sock = null
let connectionStatus = 'disconnected'

async function persistStatus(status) {
    try {
        const db = await getDb()
        await db.run(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bot_status', ?)",
            status
        )
    } catch (e) { /* non-critical */ }
}

async function syncGroupsToDb() {
    try {
        if (!sock) return
        const groups = await sock.groupFetchAllParticipating()
        const db = await getDb()
        const list = Object.values(groups).map(g => ({ jid: g.id, name: g.subject }))
        await db.run(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('groups_cache', ?)",
            JSON.stringify(list)
        )
        console.log(`[BOT] 📋 Synced ${list.length} groups to DB`)
    } catch (e) {
        console.error('[BOT] Failed to sync groups:', e.message)
    }
}

async function connectBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH)
    const { version } = await fetchLatestBaileysVersion()

    const usePairingCode = !!process.env.WHATSAPP_PHONE && !state.creds.registered

    sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
        printQRInTerminal: !usePairingCode,
    })

    if (usePairingCode) {
        // Wait a moment for socket to be ready, then request pairing code
        setTimeout(async () => {
            try {
                const phone = process.env.WHATSAPP_PHONE.replace(/[^0-9]/g, '')
                const code = await sock.requestPairingCode(phone)
                console.log(`[BOT] 📱 Pairing code: ${code}`)
                console.log(`[BOT] Enter this code in WhatsApp > Linked Devices > Link with phone number`)
            } catch (err) {
                console.error('[BOT] Failed to request pairing code:', err.message)
            }
        }, 3000)
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            connectionStatus = 'waiting_for_qr'
            console.log('[BOT] QR code generated - use pairing code instead')
        }

        if (connection === 'open') {
            connectionStatus = 'connected'
            console.log('[BOT] ✅ Connected to WhatsApp')
            persistStatus('connected')
            // Sync group list to DB for the API layer
            setTimeout(() => syncGroupsToDb(), 5000)
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected'
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const reason = lastDisconnect?.error?.message || 'unknown'
            console.log(`[BOT] ⚠️ Connection closed (code: ${statusCode}, reason: ${reason})`)
            if (statusCode !== DisconnectReason.loggedOut) {
                const delay = statusCode === 408 || statusCode === 503 ? 15000 : 5000
                console.log(`[BOT] 🔄 Reconnecting in ${delay/1000}s...`)
                setTimeout(connectBot, delay)
            } else {
                console.log('[BOT] ❌ Logged out')
                connectionStatus = 'logged_out'
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // Track groups we're part of
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            const jid = msg.key.remoteJid
            if (jid?.endsWith('@g.us')) {
                // Store group JID when we see messages from it
                const groupsFile = path.join(__dirname, '..', 'data', 'groups.json')
                let groups = {}
                try { groups = JSON.parse(require('fs').readFileSync(groupsFile, 'utf8')) } catch {}
                if (!groups[jid]) {
                    groups[jid] = { name: null, jid }
                    require('fs').writeFileSync(groupsFile, JSON.stringify(groups, null, 2))
                }
            }
        }
    })

    // Listen for poll vote updates → trigger backup notifications
    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            if (update.pollUpdates && update.pollUpdates.length > 0) {
                try {
                    await handlePollVote(key, update.pollUpdates, sendTextMessage)
                } catch (err) {
                    console.error('[BOT] ❌ Poll vote handler error:', err.message)
                }
            }
        }
    })

    return sock
}

function getSocket() {
    return sock
}

function getStatus() {
    return connectionStatus
}

async function sendTextMessage(jid, text, mentions = []) {
    if (!sock || connectionStatus !== 'connected') {
        throw new Error('Bot is not connected')
    }
    return await sock.sendMessage(jid, { text, mentions })
}

async function sendPoll(jid, name, values, selectableCount = 1, mentions = []) {
    if (!sock || connectionStatus !== 'connected') {
        throw new Error('Bot is not connected')
    }
    return await sock.sendMessage(jid, {
        poll: { name, values, selectableCount },
        mentions
    })
}

module.exports = { connectBot, getSocket, getStatus, sendTextMessage, sendPoll }
