const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

test('API role queues group sends instead of using the local scheduler', async () => {
    const originalRole = process.env.APP_ROLE
    process.env.APP_ROLE = 'api'

    const dbPath = require.resolve('../src/db/index')
    const triggerPath = require.resolve('../src/trigger')
    const routesPath = require.resolve('../src/routes')
    const dbModule = require(dbPath)
    const triggerModule = require(triggerPath)
    const originalGetDb = dbModule.getDb
    const originalFireDrainTrigger = triggerModule.fireDrainTrigger
    const writes = []

    dbModule.getDb = async () => ({
        run: async (...args) => writes.push(args),
    })
    triggerModule.fireDrainTrigger = async () => ({ ok: true })
    delete require.cache[routesPath]

    const app = express()
    app.use(express.json())
    app.use(require(routesPath))
    const server = app.listen(0, '127.0.0.1')

    try {
        await new Promise((resolve, reject) => {
            server.once('listening', resolve)
            server.once('error', reject)
        })
        const { port } = server.address()
        const response = await fetch(`http://127.0.0.1:${port}/api/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'monday-summary',
                date: '2026-08-17',
            }),
        })
        const body = await response.json()

        assert.equal(response.status, 200)
        assert.equal(body.queued, true)
        assert.equal(body.triggered, true)
        assert.equal(writes.length, 1)
        assert.match(writes[0][0], /INSERT INTO pending_sends/)
    } finally {
        await new Promise(resolve => server.close(resolve))
        dbModule.getDb = originalGetDb
        triggerModule.fireDrainTrigger = originalFireDrainTrigger
        delete require.cache[routesPath]
        if (originalRole === undefined) delete process.env.APP_ROLE
        else process.env.APP_ROLE = originalRole
    }
})
