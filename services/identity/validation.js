'use strict';

// Pure validation helpers for the member identity registry. Names stored here
// land in model prompts AND are spoken by TTS, so they go through the same
// sanitiser as every other speaker name (SpeakerNames.sanitize: emoji/tags/
// brackets stripped, whitespace collapsed, 24-char cap).
const { sanitize, usable } = require('../SpeakerNames');

const MAX_ALIASES = 10;

// Sanitise a user-supplied name; null when nothing sayable is left (empty
// after sanitising, or no letter in it), when it is shorter than 2 characters
// (a single-letter alias like "a"/"I" would whole-word-match nearly every
// message and put its owner in every roster), or when it contains a run of
// 15+ digits (a Discord-ID lookalike that could impersonate an identity label).
const MIN_NAME_LEN = 2;
function normalizeName(raw) {
  const s = sanitize(raw);
  if (!usable(s)) return null;
  if ([...s].length < MIN_NAME_LEN) return null;
  if (/\d{15,}/.test(s)) return null;
  return s;
}

function nameKey(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// Case-insensitive name equality.
function namesEqual(a, b) {
  const ka = nameKey(a);
  return ka !== '' && ka === nameKey(b);
}

// discordId of the member OTHER than excludeId whose addressName or any alias
// equals `name` (case-insensitive), or null. Whole-name comparison only.
function findHolder(records, name, excludeId) {
  if (!Array.isArray(records) || nameKey(name) === '') return null;
  for (const rec of records) {
    if (!rec || rec.discordId === excludeId) continue;
    const names = [rec.addressName, ...(Array.isArray(rec.aliases) ? rec.aliases : [])];
    if (names.some((n) => namesEqual(n, name))) return rec.discordId;
  }
  return null;
}

module.exports = { normalizeName, namesEqual, findHolder, MAX_ALIASES };
