const { getDb } = require('./db/index')
const { initPollTracking, handlePollVote } = require('./poll-handler')
const connectionManager = require('./connection-manager')

/**
 * Connect the bot using the multi-account connection manager.
 * Maintains backward compatibility with the rest of the codebase.
 */
async function connectBot() {
    await connectionManager.connectAll()

    // Attach poll-vote listeners to all connected sockets
    connectionManager.attachPollListeners(async (key, pollUpdates, accountId, socket) => {
        await handlePollVote(key, pollUpdates, sendTextMessage, socket)
    })

    // Persist aggregate status for the API layer
    const status = connectionManager.getAggregateStatus()
    try {
        const db = await getDb()
        await db.run(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bot_status', ?)",
            status
        )
    } catch (e) { /* non-critical */ }

    await initPollTracking()
}

function getSocket() {
    return connectionManager.getPrimarySocket()
}

function getStatus() {
    return connectionManager.getAggregateStatus()
}

/**
 * Send a text message with failover across all healthy accounts.
 */
async function sendTextMessage(jid, text, mentions = []) {
    return connectionManager.sendWithFailover(jid, 'text', (socket) => {
        return socket.sendMessage(jid, { text, mentions })
    })
}

/**
 * Send a poll with failover across all healthy accounts.
 */
async function sendPoll(jid, name, values, selectableCount = 1, mentions = []) {
    return connectionManager.sendWithFailover(jid, 'poll', (socket) => {
        return socket.sendMessage(jid, {
            poll: { name, values, selectableCount },
            mentions
        })
    })
}

module.exports = { connectBot, getSocket, getStatus, sendTextMessage, sendPoll }

