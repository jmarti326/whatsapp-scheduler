/**
 * On-demand queue trigger.
 *
 * The Vercel frontend (APP_ROLE=api) has no WhatsApp connection, so when a user
 * hits "send now" it writes a row to pending_sends and then calls the worker's
 * POST /internal/drain endpoint. The worker (APP_ROLE=worker) drains the queue
 * immediately — no polling required, so the database can stay idle between real
 * events instead of being kept awake 24/7.
 *
 * Auth is a shared bearer secret (WORKER_TRIGGER_SECRET). If the secret or the
 * URL is not configured the trigger degrades gracefully: the frontend simply
 * skips the call and the send is picked up by the optional safety-net poll (see
 * PENDING_SENDS_POLL_MS in scheduler.js).
 */

const express = require('express')
const crypto = require('crypto')

function secretsMatch(a, b) {
    const ab = Buffer.from(a || '', 'utf8')
    const bb = Buffer.from(b || '', 'utf8')
    if (ab.length === 0 || ab.length !== bb.length) return false
    return crypto.timingSafeEqual(ab, bb)
}

/**
 * Start the minimal worker HTTP server. Exposes only a health check and the
 * authenticated drain trigger — no session, no static assets, no portal.
 */
function startWorkerServer() {
    const { processPendingSends } = require('./scheduler')
    const PORT = parseInt(process.env.PORT || '3000', 10)
    const SECRET = process.env.WORKER_TRIGGER_SECRET || ''

    const app = express()
    app.use(express.json({ limit: '8kb' }))

    app.get('/health', (req, res) => res.json({ ok: true, role: 'worker' }))

    app.post('/internal/drain', (req, res) => {
        if (!SECRET) return res.status(503).json({ error: 'trigger not configured' })
        const auth = req.get('authorization') || ''
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!secretsMatch(token, SECRET)) return res.status(401).json({ error: 'unauthorized' })

        // Respond immediately; drain asynchronously so the frontend isn't blocked
        // on WhatsApp round-trips.
        setImmediate(() => processPendingSends().catch(() => {}))
        res.json({ ok: true, triggered: true })
    })

    if (!SECRET) {
        console.warn('[WORKER] ⚠️ WORKER_TRIGGER_SECRET not set — /internal/drain will reject all calls')
    }
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[WORKER] 🩺 Trigger server on :${PORT} (GET /health, POST /internal/drain)`)
    })
}

/**
 * Fire the drain trigger from the frontend side after enqueuing. Best-effort:
 * never throws, short timeout, returns a small status object for logging.
 */
async function fireDrainTrigger() {
    const base = process.env.WORKER_TRIGGER_URL
    const secret = process.env.WORKER_TRIGGER_SECRET
    if (!base || !secret) return { skipped: true, reason: 'not_configured' }

    const url = base.replace(/\/+$/, '') + '/internal/drain'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            body: '{}',
            signal: controller.signal,
        })
        return { ok: resp.ok, status: resp.status }
    } catch (e) {
        return { ok: false, error: e.message }
    } finally {
        clearTimeout(timer)
    }
}

module.exports = { startWorkerServer, fireDrainTrigger, secretsMatch }
