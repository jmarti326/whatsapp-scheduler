const { test } = require('node:test')
const assert = require('node:assert')

const {
    fireAccountReconnectTrigger,
    fireAccountRemoveTrigger,
    fireDrainTrigger,
    secretsMatch,
} = require('../src/trigger')

test('secretsMatch: identical secrets match', () => {
    assert.strictEqual(secretsMatch('super-secret-token', 'super-secret-token'), true)
})

test('secretsMatch: different secrets do not match', () => {
    assert.strictEqual(secretsMatch('super-secret-token', 'wrong-token'), false)
})

test('secretsMatch: empty token never matches (even against empty secret)', () => {
    assert.strictEqual(secretsMatch('', ''), false)
    assert.strictEqual(secretsMatch('', 'something'), false)
})

test('secretsMatch: different lengths do not match', () => {
    assert.strictEqual(secretsMatch('short', 'much-longer-secret'), false)
})

test('fireDrainTrigger: skips when WORKER_TRIGGER_URL / secret are not configured', async () => {
    const savedUrl = process.env.WORKER_TRIGGER_URL
    const savedSecret = process.env.WORKER_TRIGGER_SECRET
    delete process.env.WORKER_TRIGGER_URL
    delete process.env.WORKER_TRIGGER_SECRET
    try {
        const result = await fireDrainTrigger()
        assert.deepStrictEqual(result, { skipped: true, reason: 'not_configured' })
    } finally {
        if (savedUrl !== undefined) process.env.WORKER_TRIGGER_URL = savedUrl
        if (savedSecret !== undefined) process.env.WORKER_TRIGGER_SECRET = savedSecret
    }
})

test('fireAccountReconnectTrigger: calls the worker with resetAuth', async () => {
    const savedUrl = process.env.WORKER_TRIGGER_URL
    const savedSecret = process.env.WORKER_TRIGGER_SECRET
    const savedFetch = global.fetch
    process.env.WORKER_TRIGGER_URL = 'https://worker.example.test/'
    process.env.WORKER_TRIGGER_SECRET = 'shared-secret'
    let request
    global.fetch = async (url, options) => {
        request = { url, options }
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }

    try {
        const result = await fireAccountReconnectTrigger('account id', true, 'qr')
        assert.strictEqual(result.ok, true)
        assert.strictEqual(request.url, 'https://worker.example.test/internal/accounts/account%20id/reconnect')
        assert.strictEqual(request.options.headers.authorization, 'Bearer shared-secret')
        assert.deepStrictEqual(JSON.parse(request.options.body), {
            resetAuth: true,
            registrationMethod: 'qr',
        })

        test('fireAccountRemoveTrigger: calls the worker removal endpoint', async () => {
            const savedUrl = process.env.WORKER_TRIGGER_URL
            const savedSecret = process.env.WORKER_TRIGGER_SECRET
            const savedFetch = global.fetch
            process.env.WORKER_TRIGGER_URL = 'https://worker.example.test'
            process.env.WORKER_TRIGGER_SECRET = 'shared-secret'
            let request
            global.fetch = async (url, options) => {
                request = { url, options }
                return { ok: true, status: 200, json: async () => ({ ok: true }) }
            }

            try {
                const result = await fireAccountRemoveTrigger('account id')
                assert.strictEqual(result.ok, true)
                assert.strictEqual(request.url, 'https://worker.example.test/internal/accounts/account%20id/remove')
                assert.deepStrictEqual(JSON.parse(request.options.body), {})
            } finally {
                global.fetch = savedFetch
                if (savedUrl === undefined) delete process.env.WORKER_TRIGGER_URL
                else process.env.WORKER_TRIGGER_URL = savedUrl
                if (savedSecret === undefined) delete process.env.WORKER_TRIGGER_SECRET
                else process.env.WORKER_TRIGGER_SECRET = savedSecret
            }
        })
    } finally {
        global.fetch = savedFetch
        if (savedUrl === undefined) delete process.env.WORKER_TRIGGER_URL
        else process.env.WORKER_TRIGGER_URL = savedUrl
        if (savedSecret === undefined) delete process.env.WORKER_TRIGGER_SECRET
        else process.env.WORKER_TRIGGER_SECRET = savedSecret
    }
})
