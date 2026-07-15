const { test } = require('node:test')
const assert = require('node:assert')

const { fireDrainTrigger, secretsMatch } = require('../src/trigger')

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
