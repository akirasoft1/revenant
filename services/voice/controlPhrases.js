'use strict';

// Spoken-command phrase matcher for the voice control feature. Pure logic: no
// I/O, no timers, no session state. Input is a single Gemini Live INPUT
// TRANSCRIPT of one spoken turn -- may include the wake phrase, ASR slips
// ("stop listenin", "quiet"/"quite" confusion), lowercase/odd punctuation.
// False positives are worse than misses here (a stray match silences the bot
// for the default duration in the middle of a live conversation, or tears
// the session down), so every pattern is deliberately narrow.
//
// The end-of-utterance anchors on "that's all" / "we're done" reject the
// mid-sentence case ("that's all I know about it, what do you think?"). The
// quiet verbs (mute/shut up/go|be quiet|quite/keep quiet/leave us|me
// alone/stop|quit listening) get the same treatment via a tail whitelist:
// after the verb, only a duration clause ("for N minutes", "for a while",
// "for now"), an address/politeness tail ("please", "jarvis", "revenant",
// "ok", "okay", "thanks"), or end-of-utterance may follow -- ANY other word
// (an object like "alex", "my mic", "the music bot", or a preposition like
// "to him", "about the cargo") rejects the whole match. This is what turns
// "mute alex please" and "stop listening to him" back into `null` instead of
// silencing the bot on a normal gaming-channel sentence that merely contains
// the verb.

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

// "quite" is included as an ASR mishearing of "quiet" (they're acoustically
// close and Gemini's transcript occasionally picks the wrong one).
const QUIET_VERB_RE =
  /\b(?:go|be)\s+(?:quiet|quite)\b|\bkeep\s+quiet\b|\bshut\s+up\b|\bmute\b|\bleave\s+(?:us|me)\s+alone\b|\b(?:stop|quit)\s+listen(?:ing|in)?\b/;

// Allowed standalone words after a quiet verb (in any order/combination).
const POLITENESS_TAIL_WORDS = new Set(['please', 'jarvis', 'revenant', 'ok', 'okay', 'thanks']);

/** lowercase, drop apostrophes (so contractions collapse to one word), turn a
 * hyphen glued to a digit into the word "minus" (so a negative duration like
 * "-5 minutes" is visible to the parser instead of the sign being silently
 * dropped by the punctuation fold below), fold all other punctuation to
 * single spaces. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/-(?=\d)/g, ' minus ')
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

    // Reject negative durations outright rather than silently dropping the
    // sign and using the magnitude ("-5 minutes" / "minus five minutes" /
    // "negative five minutes" must NOT resolve to 5 minutes).
    if (words[j] === 'minus' || words[j] === 'negative') continue;

    const value = parseQuantity(qty);
    if (value === null || value <= 0) continue;

    if (isHour) return value * 3600;
    if (isMin) return value * 60;
    return Math.ceil(value / 60) * 60; // seconds, rounded up to a whole minute
  }

  return null;
}

/**
 * Validate the words that follow a matched quiet verb. Only these are
 * allowed, in any combination, until end of string:
 *   - "for now" / "for a while" (duration clause with no explicit number)
 *   - "for <duration>" (optional "minus"/"negative" sign, then a quantity
 *     run, then an hour/min/sec unit -- or the "half an/a hour" idiom)
 *   - a politeness/address word (see POLITENESS_TAIL_WORDS)
 * Anything else (an object, a name, a preposition like "to"/"about") fails
 * the whole tail, which is what rejects "mute alex please" and "stop
 * listening to him".
 */
function isValidQuietTail(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];

    if (POLITENESS_TAIL_WORDS.has(w)) {
      i++;
      continue;
    }

    if (w === 'for') {
      if (words[i + 1] === 'now') {
        i += 2;
        continue;
      }
      if (words[i + 1] === 'a' && words[i + 2] === 'while') {
        i += 3;
        continue;
      }

      let j = i + 1;
      if (words[j] === 'minus' || words[j] === 'negative') j++;

      if (words[j] === 'half' && (words[j + 1] === 'an' || words[j + 1] === 'a') && UNIT_HOUR.has(words[j + 2])) {
        i = j + 3;
        continue;
      }

      const qtyStart = j;
      while (j < words.length && isQuantityToken(words[j])) j++;
      if (j === qtyStart) return false; // "for" with no recognizable duration after it

      if (j < words.length && (UNIT_HOUR.has(words[j]) || UNIT_MIN.has(words[j]) || UNIT_SEC.has(words[j]))) {
        i = j + 1;
        continue;
      }
      return false; // "for ten" with no unit, "for alex", etc.
    }

    return false; // an object/name/preposition -- the verb had a target, not a bare command
  }
  return true;
}

/** Find the (leftmost) quiet-verb match and validate its tail; null if no verb or an invalid tail. */
function matchQuietPhrase(norm) {
  const m = QUIET_VERB_RE.exec(norm);
  if (!m) return null;

  const tailText = norm.slice(m.index + m[0].length).trim();
  const tailWords = tailText ? tailText.split(/\s+/) : [];
  if (!isValidQuietTail(tailWords)) return null;

  return { action: 'quiet', seconds: parseDurationSeconds(norm) };
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

  return matchQuietPhrase(norm);
}

module.exports = { matchControlPhrase, parseDurationSeconds };
