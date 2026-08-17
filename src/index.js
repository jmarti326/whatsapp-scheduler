const express = require('express')
const session = require('express-session')
const rateLimit = require('express-rate-limit')
const path = require('path')
const { getDb } = require('./db/index')
const { initUsersTable, seedAdminFromEnv, requireAuth, hasAnyUsers, authenticate, createUser } = require('./auth')
const routes = require('./routes')

// APP_ROLE controls what this process runs:
//   all    (default) — web server + bot + scheduler  (local / Docker)
//   api               — web server only               (Vercel)
//   worker            — bot + scheduler only          (Azure Container Apps)
const APP_ROLE = process.env.APP_ROLE || 'all'
const IS_API    = APP_ROLE === 'all' || APP_ROLE === 'api'
const IS_WORKER = APP_ROLE === 'all' || APP_ROLE === 'worker'

async function buildSessionStore(sessionMiddlewareOptions) {
    if (process.env.DATABASE_URL) {
        const pgSession = require('connect-pg-simple')(session)
        return new pgSession({
            conString: process.env.DATABASE_URL,
            tableName: 'sessions',
            createTableIfMissing: true,
        })
    } else {
        const SqliteStore = require('better-sqlite3-session-store')(session)
        const db = await getDb()
        return new SqliteStore({
            client: db._raw,
            expired: { clear: true, intervalMs: 900000 },
        })
    }
}

async function start() {
    const db = await getDb()
    console.log('[APP] ✅ Database ready')

    await initUsersTable()
    await seedAdminFromEnv()

    if (IS_WORKER) {
        const { connectBot } = require('./bot')
        const { startScheduler } = require('./scheduler')
        await connectBot()
        console.log('[APP] ✅ Bot connecting...')
        startScheduler()
    }

    if (!IS_API) {
        // Pure worker: start a minimal HTTP server so the frontend can push
        // on-demand queue drains (POST /internal/drain) and health checks.
        require('./trigger').startWorkerServer()
        console.log(`[APP] Running as worker (APP_ROLE=${APP_ROLE}) — trigger server only, no portal`)
        return
    }

    const SESSION_SECRET = process.env.SESSION_SECRET
    if (!SESSION_SECRET) {
        console.error('[APP] ❌ SESSION_SECRET environment variable is required')
        process.exit(1)
    }

    const app = express()
    const PORT = process.env.PORT || 3000

    app.use(express.json())
    app.use(express.urlencoded({ extended: true }))

    const store = await buildSessionStore()
    app.use(session({
        store,
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production' && process.env.TRUST_PROXY === '1',
            maxAge: 24 * 60 * 60 * 1000,
        },
    }))

    if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)

    app.get('/login', (req, res) => {
        if (req.session.userId) return res.redirect('/')
        res.sendFile(path.join(__dirname, '..', 'views', 'login.html'))
    })

    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 5,
        message: { error: 'Too many login attempts. Try again in 15 minutes.' },
        standardHeaders: true,
        legacyHeaders: false,
    })

    app.post('/api/login', authLimiter, async (req, res) => {
        const { username, password } = req.body
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' })
        const user = await authenticate(username, password)
        if (!user) return res.status(401).json({ error: 'Invalid credentials' })
        req.session.regenerate((err) => {
            if (err) return res.status(500).json({ error: 'Session error' })
            req.session.userId = user.id
            req.session.username = user.username
            req.session.isAdmin = user.is_admin
            res.json({ success: true, username: user.username })
        })
    })

    app.get('/setup', async (req, res) => {
        if (await hasAnyUsers()) return res.redirect('/login')
        res.sendFile(path.join(__dirname, '..', 'views', 'setup.html'))
    })

    app.post('/api/setup', authLimiter, async (req, res) => {
        if (await hasAnyUsers()) return res.status(403).json({ error: 'Setup already complete' })
        const { username, password } = req.body
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' })
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })
        await createUser(username, password, 1)
        console.log(`[AUTH] ✅ Initial admin "${username}" created via setup`)
        res.json({ success: true })
    })

    app.post('/api/logout', (req, res) => {
        req.session.destroy(() => res.json({ success: true }))
    })

    app.get('/health', (req, res) => {
        res.json({
            ok: true,
            role: APP_ROLE,
            commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || null,
        })
    })

    app.use(requireAuth)
    app.use(express.static(path.join(__dirname, '..', 'views')))
    app.use(routes)

    app.get('/', async (req, res) => {
        if (!await hasAnyUsers()) return res.redirect('/setup')
        res.sendFile(path.join(__dirname, '..', 'views', 'index.html'))
    })

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[APP] 🌐 Web UI available at http://localhost:${PORT}`)
    })
}

start().catch(err => {
    console.error('[APP] Fatal error:', err)
    process.exit(1)
})
