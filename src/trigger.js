/**
 * Authenticated portal-to-worker operational triggers.
 *
 * The Vercel frontend has no WhatsApp connection or persistent auth storage.
 * It calls these Azure worker endpoints for queue drains and account lifecycle
 * operations.
 */

const express = require('express')
const crypto = require('crypto')

function secretsMatch(a, b) {
    const ab = Buffer.from(a || '', 'utf8')
    const bb = Buffer.from(b || '', 'utf8')
    if (ab.length === 0 || ab.length !== bb.length) return false
    return crypto.timingSafeEqual(ab, bb)
}

function startWorkerServer() {
    const { processPendingSends } = require('./scheduler')
    const PORT = parseInt(process.env.PORT || '3000', 10)
    const SECRET = process.env.WORKER_TRIGGER_SECRET || ''

    const app = express()
    app.use(express.json({ limit: '8kb' }))

    app.get('/health', (req, res) => res.json({ ok: true, role: 'worker' }))

    function requireTriggerAuth(req, res, next) {
        if (!SECRET) return res.status(503).json({ error: 'trigger not configured' })
        const auth = req.get('authorization') || ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!secretsMatch(token, SECRET)) return res.status(401).json({ error: 'unauthorized' })
        next()
    }

    app.post('/internal/drain', requireTriggerAuth, (req, res) => {
        setImmediate(() => processPendingSends().catch(() => {}))
        res.json({ ok: true, triggered: true })
    })

    app.post('/internal/accounts/:id/reconnect', requireTriggerAuth, async (req, res) => {
        try {
            const connectionManager = require('./connection-manager')
            if (req.body?.resetAuth) {
                await connectionManager.restartRegistration(
                    req.params.id,
                    req.body?.registrationMethod || 'phone'
                )
            } else {
                const { getDb } = require('./db/index')
                const db = await getDb()
                const account = await db.get('SELECT * FROM wa_accounts WHERE id = ?', req.params.id)
                if (!account) return res.status(404).json({ error: 'Account not found' })
                await connectionManager.disconnectOne(req.params.id)
                await connectionManager.connectOne(account)
            }
            res.json({ ok: true, triggered: true })
        } catch (err) {
            console.error(`[WORKER] Account reconnect failed for ${req.params.id}:`, err.message)
            res.status(500).json({ error: err.message })
        }
    })

    if (!SECRET) {
        console.warn('[WORKER] WORKER_TRIGGER_SECRET not set; internal triggers will reject calls')
    }
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[WORKER] Trigger server on :${PORT}`)
    })
}

async function fireWorkerTrigger(path, body = {}, timeoutMs = 4000) {
    const base = process.env.WORKER_TRIGGER_URL
    const secret = process.env.WORKER_TRIGGER_SECRET
    if (!base || !secret) return { skipped: true, reason: 'not_configured' }

    const url = base.replace(/\/+$/, '') + path
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                authorization: 'Bearer ' + secret,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        })
        let responseBody = null
        try {
            responseBody = await resp.json()
        } catch {}
        return { ok: resp.ok, status: resp.status, body: responseBody }
    } catch (err) {
        return { ok: false, error: err.message }
    } finally {
        clearTimeout(timer)
    }
}

function fireDrainTrigger() {
    return fireWorkerTrigger('/internal/drain')
}

function fireAccountReconnectTrigger(accountId, resetAuth = false, registrationMethod = 'phone') {
    return fireWorkerTrigger(
        `/internal/accounts/${encodeURIComponent(accountId)}/reconnect`,
        { resetAuth, registrationMethod },
        10000
    )
}

module.exports = {
    startWorkerServer,
    fireDrainTrigger,
    fireAccountReconnectTrigger,
    fireWorkerTrigger,
    secretsMatch,
}
