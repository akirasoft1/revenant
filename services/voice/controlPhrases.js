'use strict';

// Spoken-command phrase matcher for the voice control feature. Pure logic: no
// I/O, no timers, no session state. Input is a single Gemini Live INPUT
// TRANSCRIPT of one spoken turn -- may include the wake phrase, ASR slips
// ("stop listenin"), lowercase/odd punctuation. False positives are worse
// than misses here (a stray match tears the whole voice session down), so
// every pattern is deliberately narrow; the end-of-utterance anchors on
// "that's all" / "we're done" exist specifically to reject the mid-sentence
// case ("that's all I know about it, what do you think?").

const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const UNIT_HOUR = new Set(['hour', 'hours']);
const UNIT_MIN = new Set(['min', 'mins', 'minute', 'minutes']);
const UNIT_SEC = new Set(['sec', 'secs', 'second', 'seconds']);

// end/stop/finish (the/this) conversation -- "of the conversation" (no verb
// directly adjacent) must NOT match, which is why the optional article sits
// directly between the verb and "conversation" with no other filler allowed.
const END_VERB_RE = /\b(?:end|stop|finish)\s+(?:(?:the|this)\s+)?conversation\b/;
// "that's all" / "we're done" (and their uncontracted spellings) only count
// as the whole utterance or trailing off the end of it -- never mid-sentence.
const END_TRAILING_RE = /\b(?:thats all|that is all|were done|we are done)$/;

const QUIET_VERB_RE =
  /\b(?:go|be)\s+quiet\b|\bshut\s+up\b|\bmute\b|\bleave\s+(?:us|me)\s+alone\b|\b(?:stop|quit)\s+listen(?:ing|in)?\b/;

/** lowercase, drop apostrophes (so contractions collapse to one word), fold all other punctuation to single spaces. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isQuantityToken(word) {
  return (
    /^\d+$/.test(word) ||
    Object.prototype.hasOwnProperty.call(ONES, word) ||
    Object.prototype.hasOwnProperty.call(TENS, word) ||
    word === 'hundred' ||
    word === 'couple' ||
    word === 'few' ||
    word === 'a' ||
    word === 'an'
  );
}

/** ones/tens/hundred word sequence -> number, e.g. ["one","hundred","twenty"] -> 120. null if unparseable. */
function wordsToNumber(tokens) {
  const filtered = tokens.filter((t) => t !== 'a' && t !== 'an');
  if (filtered.length === 0) return null;
  let current = 0;
  let matchedAny = false;
  for (const t of filtered) {
    if (Object.prototype.hasOwnProperty.call(ONES, t)) {
      current += ONES[t];
      matchedAny = true;
    } else if (Object.prototype.hasOwnProperty.call(TENS, t)) {
      current += TENS[t];
      matchedAny = true;
    } else if (t === 'hundred') {
      current = (current || 1) * 100;
      matchedAny = true;
    } else {
      return null; // unknown token inside the quantity run -- bail rather than guess
    }
  }
  return matchedAny ? current : null;
}

function parseQuantity(list) {
  if (list.includes('couple')) return 2;
  if (list.includes('few')) return 3;
  if (list.length === 1 && /^\d+$/.test(list[0])) return parseInt(list[0], 10);
  if (list.length === 1 && (list[0] === 'a' || list[0] === 'an')) return 1;
  return wordsToNumber(list);
}

/**
 * Find a spoken duration anywhere in `text` and return it in seconds.
 * Digits or number words up to "one hundred twenty", "a couple" -> 2,
 * "a few" -> 3, "half an hour" -> 30 min, "an hour"/"one hour" -> 60 min,
 * "N hours", and min/mins/minute(s)/second(s) units. Seconds are rounded up
 * to a whole minute (still returned in seconds). Returns null if no duration
 * is found. The caller (VoiceService) is responsible for clamping.
 */
function parseDurationSeconds(text) {
  const words = normalize(text).split(/\s+/).filter(Boolean);

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isHour = UNIT_HOUR.has(w);
    const isMin = UNIT_MIN.has(w);
    const isSec = UNIT_SEC.has(w);
    if (!isHour && !isMin && !isSec) continue;

    // "half an hour" is a fixed idiom, not "half" x "an" as separate quantities.
    if (isHour && i >= 2 && (words[i - 1] === 'an' || words[i - 1] === 'a') && words[i - 2] === 'half') {
      return 30 * 60;
    }

    let j = i - 1;
    const qty = [];
    while (j >= 0 && isQuantityToken(words[j])) {
      qty.unshift(words[j]);
      j--;
    }
    if (qty.length === 0) continue;

    const value = parseQuantity(qty);
    if (value === null || value <= 0) continue;

    if (isHour) return value * 3600;
    if (isMin) return value * 60;
    return Math.ceil(value / 60) * 60; // seconds, rounded up to a whole minute
  }

  return null;
}

/**
 * Match a spoken control command in one Gemini Live input transcript.
 * Returns {action:'end'}, {action:'quiet', seconds:number|null}, or null.
 * `seconds:null` means a quiet command with no duration spoken -- the
 * caller applies its own default.
 */
function matchControlPhrase(text) {
  const norm = normalize(text);
  if (!norm) return null;

  if (END_VERB_RE.test(norm) || END_TRAILING_RE.test(norm)) {
    return { action: 'end' };
  }

  if (QUIET_VERB_RE.test(norm)) {
    return { action: 'quiet', seconds: parseDurationSeconds(norm) };
  }

  return null;
}

module.exports = { matchControlPhrase, parseDurationSeconds };
