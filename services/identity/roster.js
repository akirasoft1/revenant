'use strict';

// Pure helpers for "who said what" grounding (spec: 2026-10-09 member identity
// design, "Who-said-what plumbing"). No I/O, no Mongo, no Discord: callers
// (ChatService.buildTurnContext) resolve names and hand records in.

const ROSTER_CAP = 20;
const ROSTER_HEADING = '## People in this conversation';
const ROSTER_INSTRUCTION = 'Messages are labelled [Name · Discord ID]. "I", "me" and "my" mean the labelled speaker of that message. Use this list only to work out who is who; don\'t mention these aliases unless it matters.';
const CURRENT_SPEAKER_MARK = '  ← current speaker';

/** `[<name> · <discordId>]` — middle dot U+00B7 with single spaces. */
function labelFor({ discordId, name }) {
  return `[${name} · ${discordId}]`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive, Unicode-aware containment: `name` must not be
 * flanked by a letter, digit, combining mark or underscore. "Aki" does not
 * match inside "Akirasoft"; "Akira," and "@Akira" do match.
 */
function containsWholeWord(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || !text) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(n)}(?![\\p{L}\\p{M}\\p{N}_])`, 'iu');
  return re.test(text);
}

function recordNames(rec) {
  const names = [];
  if (rec && typeof rec.addressName === 'string' && rec.addressName) names.push(rec.addressName);
  if (rec && Array.isArray(rec.aliases)) {
    for (const a of rec.aliases) if (typeof a === 'string' && a) names.push(a);
  }
  return names;
}

/**
 * Pick the Discord IDs that belong in the roster, deduped, in order:
 *   1. the current speaker;
 *   2. distinct non-bot history authors, in order of first appearance;
 *   3. registry members whose addressName or any alias appears as a whole word
 *      in the history text or the current message.
 * Never the full registry; capped at `cap` (20).
 * @returns {string[]}
 */
function selectRosterMembers({ currentSpeakerId = null, historyDocs = [], currentText = '', records = [], cap = ROSTER_CAP } = {}) {
  const out = [];
  const seen = new Set();
  const add = (id) => {
    if (id === null || id === undefined) return;
    const s = String(id);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  add(currentSpeakerId);
  const docs = Array.isArray(historyDocs) ? historyDocs : [];
  for (const d of docs) {
    if (d && !d.isBot && d.authorId) add(d.authorId);
  }

  const texts = docs.filter((d) => d && typeof d.content === 'string').map((d) => d.content);
  if (typeof currentText === 'string' && currentText) texts.push(currentText);
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || !rec.discordId || seen.has(String(rec.discordId))) continue;
    const names = recordNames(rec);
    if (names.some((n) => texts.some((t) => containsWholeWord(t, n)))) add(rec.discordId);
  }

  return out.slice(0, Math.max(0, cap));
}

/**
 * Render the roster block. Entries: `{ discordId, name, addressName?, aliases? }`
 * (no registry record → just the resolved name). Returns '' with no entries.
 */
function formatRoster({ entries = [], currentSpeakerId = null } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.discordId && e.name);
  if (list.length === 0) return '';
  const lines = list.map((e) => {
    const lower = (s) => String(s).toLowerCase();
    const skip = new Set([lower(e.name)]);
    if (e.addressName) skip.add(lower(e.addressName));
    const aliases = [];
    for (const a of Array.isArray(e.aliases) ? e.aliases : []) {
      if (typeof a !== 'string' || !a || skip.has(lower(a))) continue;
      skip.add(lower(a));
      aliases.push(a);
    }
    const details = [];
    if (aliases.length) details.push(`also called ${aliases.join(', ')}`);
    if (e.addressName) details.push(`address as ${e.addressName}`);
    let line = `- ${e.name} (Discord ${e.discordId})`;
    if (details.length) line += ` — ${details.join('; ')}`;
    if (currentSpeakerId && String(e.discordId) === String(currentSpeakerId)) line += CURRENT_SPEAKER_MARK;
    return line;
  });
  return `${ROSTER_HEADING}\n${ROSTER_INSTRUCTION}\n${lines.join('\n')}`;
}

module.exports = {
  labelFor,
  selectRosterMembers,
  formatRoster,
  containsWholeWord,
  ROSTER_CAP,
  ROSTER_HEADING,
  ROSTER_INSTRUCTION,
};
