const { test } = require('node:test')
const assert = require('node:assert/strict')

const { jidToPhone, resolveVoterPhone, resolvePhoneToLidUser, memberRespondedViaLid } = require('../src/poll-handler')

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

test('resolveVoterPhone: LID with no mapping returns empty (never masquerade LID digits as a phone)', async () => {
    // A LID user id is NOT a phone number. Returning it as a phone is exactly
    // what made already-voted members look like non-responders. When the mapping
    // is unavailable we return '' and let the caller keep the raw @lid JID.
    const socket = {
        signalRepository: { lidMapping: { getPNForLID: async () => null } }
    }
    const phone = await resolveVoterPhone('223456789@lid', socket)
    assert.equal(phone, '')
})

test('resolveVoterPhone: mapping error is swallowed and returns empty', async () => {
    const socket = {
        signalRepository: {
            lidMapping: { getPNForLID: async () => { throw new Error('offline') } }
        }
    }
    const phone = await resolveVoterPhone('223456789@lid', socket)
    assert.equal(phone, '')
})

test('resolveVoterPhone: LID with missing socket returns empty', async () => {
    const phone = await resolveVoterPhone('223456789@lid', undefined)
    assert.equal(phone, '')
})

// resolvePhoneToLidUser: maps a stored team-member phone to their LID user
// digits via getLIDForPN (which can actively USync-resolve), so votes recorded
// under an unmapped LID can still be attributed at reminder/backup time.
test('resolvePhoneToLidUser: resolves phone to LID user digits', async () => {
    const socket = {
        signalRepository: {
            lidMapping: {
                getLIDForPN: async (pn) => {
                    assert.equal(pn, '573001234567@s.whatsapp.net')
                    return '223456789:3@lid'
                }
            }
        }
    }
    assert.equal(await resolvePhoneToLidUser('573001234567', socket), '223456789')
})

test('resolvePhoneToLidUser: missing socket/mapping returns empty', async () => {
    assert.equal(await resolvePhoneToLidUser('573001234567', undefined), '')
    assert.equal(await resolvePhoneToLidUser('', { signalRepository: {} }), '')
})

// memberRespondedViaLid: the reminder-time matcher that rescues votes stored
// under an unmapped LID.
test('memberRespondedViaLid: true when member LID is among LID responders', async () => {
    const socket = {
        signalRepository: {
            lidMapping: { getLIDForPN: async () => '223456789@lid' }
        }
    }
    const responded = new Set(['223456789'])
    assert.equal(await memberRespondedViaLid('573001234567', responded, socket), true)
})

test('memberRespondedViaLid: false when member LID is not among responders', async () => {
    const socket = {
        signalRepository: {
            lidMapping: { getLIDForPN: async () => '999999999@lid' }
        }
    }
    const responded = new Set(['223456789'])
    assert.equal(await memberRespondedViaLid('573001234567', responded, socket), false)
})

test('memberRespondedViaLid: false (no lookup) when there are no LID responders', async () => {
    let called = false
    const socket = {
        signalRepository: {
            lidMapping: { getLIDForPN: async () => { called = true; return '223456789@lid' } }
        }
    }
    assert.equal(await memberRespondedViaLid('573001234567', new Set(), socket), false)
    assert.equal(called, false)
})
