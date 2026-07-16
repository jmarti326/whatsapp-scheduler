const test = require('node:test')
const assert = require('node:assert')
const {
    normalizeGroupKey,
    parseGroupAllowlist,
    filterAllowedGroups,
    unmatchedAllowlistEntries,
} = require('../src/group-filter')

const groups = [
    { id: '111@g.us', subject: 'Audio Visual - IPR' },
    { id: '222@g.us', subject: 'Test Group Chat' },
    { id: '333@g.us', subject: 'Mom' },
    { id: '444@g.us', subject: 'Random Friends' },
]

test('normalizeGroupKey lowercases, trims, collapses whitespace, unifies dashes', () => {
    assert.strictEqual(normalizeGroupKey('  Audio   Visual  '), 'audio visual')
    // en-dash and em-dash both normalize to hyphen
    assert.strictEqual(normalizeGroupKey('Audio Visual \u2013 IPR'), 'audio visual - ipr')
    assert.strictEqual(normalizeGroupKey('Audio Visual \u2014 IPR'), 'audio visual - ipr')
    assert.strictEqual(normalizeGroupKey(null), '')
})

test('parseGroupAllowlist returns null for empty/unset', () => {
    assert.strictEqual(parseGroupAllowlist(undefined), null)
    assert.strictEqual(parseGroupAllowlist(''), null)
    assert.strictEqual(parseGroupAllowlist('   '), null)
    assert.strictEqual(parseGroupAllowlist(',, ,'), null)
})

test('parseGroupAllowlist splits and normalizes entries', () => {
    const set = parseGroupAllowlist('Audio Visual - IPR, Test Group Chat')
    assert.ok(set.has('audio visual - ipr'))
    assert.ok(set.has('test group chat'))
    assert.strictEqual(set.size, 2)
})

test('filterAllowedGroups returns list unchanged when no allowlist', () => {
    assert.strictEqual(filterAllowedGroups(groups, null), groups)
})

test('filterAllowedGroups matches by name', () => {
    const allowlist = parseGroupAllowlist('Audio Visual - IPR, Test Group Chat')
    const result = filterAllowedGroups(groups, allowlist)
    assert.deepStrictEqual(result.map(g => g.subject), ['Audio Visual - IPR', 'Test Group Chat'])
})

test('filterAllowedGroups matches by JID', () => {
    const allowlist = parseGroupAllowlist('333@g.us')
    const result = filterAllowedGroups(groups, allowlist)
    assert.deepStrictEqual(result.map(g => g.subject), ['Mom'])
})

test('filterAllowedGroups tolerates dash/whitespace differences in subjects', () => {
    const allowlist = parseGroupAllowlist('audio visual - ipr')
    const drifted = [{ id: '111@g.us', subject: 'Audio  Visual \u2014 IPR' }]
    assert.strictEqual(filterAllowedGroups(drifted, allowlist).length, 1)
})

test('unmatchedAllowlistEntries reports entries matching zero groups', () => {
    const allowlist = parseGroupAllowlist('Audio Visual - IPR, Nonexistent Group')
    assert.deepStrictEqual(unmatchedAllowlistEntries(groups, allowlist), ['nonexistent group'])
})

test('unmatchedAllowlistEntries returns empty when no allowlist', () => {
    assert.deepStrictEqual(unmatchedAllowlistEntries(groups, null), [])
})
