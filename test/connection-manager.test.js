const { test } = require('node:test')
const assert = require('node:assert')

const { isPairingRequestStillNeeded } = require('../src/connection-manager')

test('pairing request proceeds for the current connecting socket', () => {
    const socket = {}
    assert.strictEqual(
        isPairingRequestStillNeeded({ socket, status: 'connecting' }, socket),
        true
    )
})

test('pairing request is skipped after the socket connects', () => {
    const socket = {}
    assert.strictEqual(
        isPairingRequestStillNeeded({ socket, status: 'connected' }, socket),
        false
    )
})

test('pairing request is skipped when the socket was replaced', () => {
    assert.strictEqual(
        isPairingRequestStillNeeded({ socket: {}, status: 'connecting' }, {}),
        false
    )
})
