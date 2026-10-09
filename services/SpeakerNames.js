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
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, ' '); // emoji/pictographs/dingbats
  s = s.replace(/[\u{FE0F}\u{20E3}]/gu, '');              // variation selector-16 / combining enclosing keycap
  s = s.replace(/™/g, ' ');                           // ™
  s = s.replace(/\((?:tm|r|c)\)/gi, ' ');                  // (tm) (r) (c)
  s = s.replace(/[\[\({][^\])}]*[\])}]/g, ' ');            // [CLAN] (tag) {x}
  // Defence in depth: strip any leftover/unpaired bracket character (e.g. a
  // lone `]` with no opener, which the paired-bracket regex above never
  // matches). globalName is settable by ANY unprivileged Discord user, and
  // the resolved name is later embedded verbatim inside "[SPEAKER: <name>]"
  // -- an unpaired `]` there would close the marker early and let
  // attacker-chosen text land outside it in a role="user" context turn (and
  // in the stored Mongo authorName, re-injected via recall/tldr).
  s = s.replace(/[\[\]{}()<>]/g, ' ');
  s = s.replace(/[_*~`|]/g, ' ');                          // markdown-ish noise
  // Identity labels are `[Name · Discord ID]` (services/identity/roster.js):
  // the middle dot and look-alike separators would let a name forge a second
  // "· <id>" inside its own label.
  s = s.replace(/[\u00B7\u2022\u2219\u2027\u22C5]/g, ' ');
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

// Parse VOICE_SPEAKER_NAMES. Shared by config.voice.speakerNames and
// scripts/seed-member-identities.js so both read the table identically.
// Malformed JSON must never take the bot down -- fall back to an empty table,
// but SAY SO (a typo'd blob must not silently present as "my overrides just
// don't work"). console.warn by default because the logger isn't guaranteed to
// be initialized at config-load time.
function parseSpeakerNames(raw, warn = console.warn) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    warn(`VOICE_SPEAKER_NAMES is not valid JSON; ignoring it and using no overrides: ${e.message}`);
    return {};
  }
}

// The member identity registry (services/MemberIdentityService.js) is the
// first layer when supplied: members choose their own address name there.
// It is optional and must never break resolution -- absent, malformed or
// throwing, it is skipped and the pre-registry order applies unchanged.
function registryName(identity, userId) {
  if (!identity || typeof identity.get !== 'function') return '';
  try {
    const rec = identity.get(userId);
    const s = sanitize(rec && rec.addressName);
    return usable(s) ? s : '';
  } catch (_) {
    return '';
  }
}

function createSpeakerNames({ overrides = {}, identity = null } = {}) {
  const table = overrides && typeof overrides === 'object' ? overrides : {};

  function resolve(user, member) {
    if (!user) return null;

    const registered = registryName(identity, user.id);
    if (registered !== '') return registered;

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

module.exports = { createSpeakerNames, sanitize, usable, parseSpeakerNames, MAX_LEN };
