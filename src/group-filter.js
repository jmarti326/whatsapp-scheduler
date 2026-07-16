// Pure helpers for scoping WhatsApp group tracking to an allowlist.
// Kept dependency-free (no baileys) so they are unit-testable under `node --test`.

// Normalize a group name/JID for tolerant matching: lowercase, trim, collapse
// internal whitespace, and unify dash variants so minor punctuation differences
// in WhatsApp subjects (e.g. en-dash vs hyphen) still match the allowlist.
function normalizeGroupKey(value) {
    return String(value ?? '')
        .replace(/[\u2010-\u2015]/g, '-') // hyphen/dash variants → '-'
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
}

// Parse a GROUP_ALLOWLIST string. Comma-separated group names and/or JIDs.
// Empty/unset → null (meaning "track all groups", the original behavior).
function parseGroupAllowlist(raw) {
    if (!raw || !raw.trim()) return null
    const set = new Set(
        raw.split(',').map(s => normalizeGroupKey(s)).filter(Boolean)
    )
    return set.size > 0 ? set : null
}

// Filter fetched groups to the allowlist by normalized name OR JID. When no
// allowlist is provided, returns the list unchanged.
function filterAllowedGroups(list, allowlist) {
    if (!allowlist) return list
    return list.filter(g =>
        allowlist.has(normalizeGroupKey(g.subject)) ||
        allowlist.has(normalizeGroupKey(g.id))
    )
}

// Return allowlist entries that matched zero groups (name typos / subject drift).
function unmatchedAllowlistEntries(list, allowlist) {
    if (!allowlist) return []
    const present = new Set()
    for (const g of list) {
        present.add(normalizeGroupKey(g.subject))
        present.add(normalizeGroupKey(g.id))
    }
    return [...allowlist].filter(entry => !present.has(entry))
}

module.exports = {
    normalizeGroupKey,
    parseGroupAllowlist,
    filterAllowedGroups,
    unmatchedAllowlistEntries,
}
