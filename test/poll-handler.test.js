const { test } = require('node:test')
const assert = require('node:assert/strict')

const { jidToPhone, resolveVoterPhone } = require('../src/poll-handler')

// jidToPhone: the normalizer that reduces any WhatsApp JID to the digits-only
// form stored in team_members.phone. Regression coverage for the false-reminder
// bug where device-suffixed and LID JIDs failed to match the stored phone.
test('jidToPhone: plain phone JID', () => {
    assert.equal(jidToPhone('573001234567@s.whatsapp.net'), '573001234567')
})

test('jidToPhone: device-suffixed JID strips the device part', () => {
    assert.equal(jidToPhone('573001234567:12@s.whatsapp.net'), '573001234567')
})

test('jidToPhone: LID JID returns the LID user digits (device stripped)', () => {
    assert.equal(jidToPhone('223456789@lid'), '223456789')
    assert.equal(jidToPhone('223456789:5@lid'), '223456789')
})

test('jidToPhone: bare phone number with no domain', () => {
    assert.equal(jidToPhone('573001234567'), '573001234567')
    assert.equal(jidToPhone('573001234567:3'), '573001234567')
})

test('jidToPhone: empty / nullish input returns empty string', () => {
    assert.equal(jidToPhone(''), '')
    assert.equal(jidToPhone(null), '')
    assert.equal(jidToPhone(undefined), '')
})

// resolveVoterPhone: LID voters must be mapped back to their real phone using
// the socket's LID mapping store so they match team_members.phone.
test('resolveVoterPhone: PN JID needs no socket lookup', async () => {
    const phone = await resolveVoterPhone('573001234567:9@s.whatsapp.net', null)
    assert.equal(phone, '573001234567')
})

test('resolveVoterPhone: LID JID resolved to phone via socket mapping', async () => {
    const socket = {
        signalRepository: {
            lidMapping: {
                getPNForLID: async (lid) => {
                    assert.equal(lid, '223456789@lid')
                    return '573001234567:0@s.whatsapp.net'
                }
            }
        }
    }
    const phone = await resolveVoterPhone('223456789@lid', socket)
    assert.equal(phone, '573001234567')
})

test('resolveVoterPhone: LID with no mapping falls back to LID digits', async () => {
    const socket = {
        signalRepository: { lidMapping: { getPNForLID: async () => null } }
    }
    const phone = await resolveVoterPhone('223456789@lid', socket)
    assert.equal(phone, '223456789')
})

test('resolveVoterPhone: mapping error is swallowed and falls back', async () => {
    const socket = {
        signalRepository: {
            lidMapping: { getPNForLID: async () => { throw new Error('offline') } }
        }
    }
    const phone = await resolveVoterPhone('223456789@lid', socket)
    assert.equal(phone, '223456789')
})

test('resolveVoterPhone: LID with missing socket falls back gracefully', async () => {
    const phone = await resolveVoterPhone('223456789@lid', undefined)
    assert.equal(phone, '223456789')
})
