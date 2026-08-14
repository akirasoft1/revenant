'use strict';

// Turns a Discord user into a name we are willing to SAY OUT LOUD.
//
// Discord exposes four name layers and the two automatic ones are both
// unreliable here: `username` carries junk suffixes (`inc1067` for someone who
// goes by `inc`) and per-guild `nickname` is often a joke
// (`Macroplastics by Bic(tm)`). discord.js's `displayName` resolves
// `nickname ?? globalName ?? username`, i.e. it prefers exactly the worst one.
// Because Phase 3 names are spoken by TTS, an unsanitised nickname is voiced
// literally -- so an explicit override table leads, and everything is
// sanitised. See spec 5.4.1.
const MAX_LEN = 24;

// Defensive clamp applied BEFORE the bracket-stripping regex, which is O(n^2)
// on pathological input (many unclosed `[`/`(`/`{`). Not reachable via Discord
// (names are capped at 32 chars) -- only via admin-authored VOICE_SPEAKER_NAMES
// config -- but clamp anyway so a malformed override can never hang the process.
const MAX_RAW_LEN = 500;

function sanitize(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.length > MAX_RAW_LEN ? raw.slice(0, MAX_RAW_LEN) : raw;
  s = s.replace(/[​-‍﻿]/g, '');            // zero-width
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' '); // emoji/pictographs
  s = s.replace(/™/g, ' ');                           // ™
  s = s.replace(/\((?:tm|r|c)\)/gi, ' ');                  // (tm) (r) (c)
  s = s.replace(/[\[\({][^\])}]*[\])}]/g, ' ');            // [CLAN] (tag) {x}
  s = s.replace(/[_*~`|]/g, ' ');                          // markdown-ish noise
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_LEN) {
    const cut = s.slice(0, MAX_LEN);
    const sp = cut.lastIndexOf(' ');
    s = (sp > 8 ? cut.slice(0, sp) : cut).trim();
  }
  return s;
}

// A name must contain at least one letter to be worth saying.
function usable(s) { return !!s && /\p{L}/u.test(s); }

function createSpeakerNames({ overrides = {} } = {}) {
  const table = overrides && typeof overrides === 'object' ? overrides : {};

  function resolve(user, member) {
    if (!user) return null;

    // The override table is AUTHORITATIVE: it exists specifically to override
    // Discord names we don't trust, so it is never discarded for being
    // "weird" (letterless, all-digits, etc.) -- only for sanitising to empty.
    // It is still sanitised, because it is still spoken.
    const overridden = sanitize(table[user.id]);
    if (overridden !== '') return overridden;

    const autoCandidates = [
      user.globalName || user.global_name,
      member && (member.nickname || member.nick),
      // `inc1067` -> `inc`; a digits-only username yields '' and falls through.
      typeof user.username === 'string' ? user.username.replace(/\d+$/, '') : null,
    ];
    for (const c of autoCandidates) {
      const s = sanitize(c);
      if (usable(s)) return s;
    }
    return null; // never assert a name we are not confident in
  }

  return { resolve, sanitize };
}

module.exports = { createSpeakerNames, sanitize, MAX_LEN };
