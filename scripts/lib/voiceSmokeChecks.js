'use strict';
// Pure verdict helpers for the real-model voice smoke scripts
// (scripts/smoke-voice-identity.js, scripts/smoke-voice-sc.js). Unit-tested in
// __tests__/scripts/voiceSmokeChecks.test.js; the smokes themselves need a live
// Gemini Live session.

// A spoken bracketed numeric citation: "[1]", "[1, 3]", "[ 2 ,4 ]".
// gemini-live-2.5-flash spoke ~150 of these across the 2026-10-10 spike runs.
const CITATION_RE = /\[\s*\d+(\s*,\s*\d+)*\s*\]/;
const CITATION_RE_G = new RegExp(CITATION_RE.source, 'g');

const countMatches = (text) => (String(text).match(CITATION_RE_G) || []).length;

/**
 * Output-transcript fragments that contain a citation. Live streams the
 * transcript in fragments, so "[1" + ", 3]" can straddle two of them: when the
 * concatenation holds more citations than the fragments do individually, the
 * whole concatenated transcript is returned as one extra offender (untruncated).
 */
function findCitationLeaks(transcripts) {
  const leaks = transcripts.filter((t) => CITATION_RE.test(t));
  const joined = transcripts.join('');
  const perFragment = leaks.reduce((n, t) => n + countMatches(t), 0);
  if (countMatches(joined) > perFragment) leaks.push(joined);
  return leaks;
}

function mentionsName(text, name) {
  return new RegExp(`\\b${name}\\b`, 'i').test(text);
}

/** "What's my name?" asked by `expected`: the reply must name them and not `other`. */
function speakerKnownVerdict(replyText, expected, other) {
  const hasExpected = mentionsName(replyText, expected);
  const hasOther = mentionsName(replyText, other);
  return { pass: hasExpected && !hasOther, hasExpected, hasOther };
}

/**
 * How many replies to a named speaker used that speaker's name. Segments with
 * no reply text are skipped. Informational: names help in a group, but on
 * more than two thirds of replies they're probably overused.
 */
function nameRate(segments) {
  const replied = segments.filter((s) => s.text && s.text.trim());
  const used = replied.filter((s) => mentionsName(s.text, s.name)).length;
  const total = replied.length;
  return { used, total, overuse: total > 0 && used / total > 2 / 3 };
}

module.exports = { CITATION_RE, findCitationLeaks, mentionsName, speakerKnownVerdict, nameRate };
