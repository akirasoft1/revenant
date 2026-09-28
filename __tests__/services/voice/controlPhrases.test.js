'use strict';
const { matchControlPhrase, parseDurationSeconds } = require('../../../services/voice/controlPhrases');

describe('matchControlPhrase — positives', () => {
  test.each([
    ['end the conversation', { action: 'end' }],
    ['stop the conversation', { action: 'end' }],
    ["thanks jarvis, that's all", { action: 'end' }],
    ["okay we're done", { action: 'end' }],
    ['stop listening for ten minutes', { action: 'quiet', seconds: 600 }],
    ['go quiet for 20 minutes', { action: 'quiet', seconds: 1200 }],
    ['be quiet for a couple minutes', { action: 'quiet', seconds: 120 }],
    ['shut up for half an hour', { action: 'quiet', seconds: 1800 }],
    ['mute for an hour', { action: 'quiet', seconds: 3600 }],
    ['go quiet', { action: 'quiet', seconds: null }],
    ['leave us alone for 5 min', { action: 'quiet', seconds: 300 }],
    ['stop listening', { action: 'quiet', seconds: null }],
  ])('%s', (input, expected) => {
    expect(matchControlPhrase(input)).toEqual(expected);
  });

  test('wake phrase prefix does not interfere with matching', () => {
    expect(matchControlPhrase('hey jarvis, go quiet for ten minutes')).toEqual({
      action: 'quiet',
      seconds: 600,
    });
    expect(matchControlPhrase('hey jarvis, stop the conversation')).toEqual({ action: 'end' });
  });

  test('case and punctuation insensitive', () => {
    expect(matchControlPhrase("STOP THE CONVERSATION!")).toEqual({ action: 'end' });
    expect(matchControlPhrase("Go Quiet For Ten Minutes.")).toEqual({
      action: 'quiet',
      seconds: 600,
    });
    expect(matchControlPhrase("THAT'S    ALL")).toEqual({ action: 'end' });
  });

  test('finish/this conversation variants', () => {
    expect(matchControlPhrase('finish the conversation')).toEqual({ action: 'end' });
    expect(matchControlPhrase('stop this conversation')).toEqual({ action: 'end' });
  });

  test('quit listening variant', () => {
    expect(matchControlPhrase('quit listening')).toEqual({ action: 'quiet', seconds: null });
  });

  test('number-word durations up to one hundred twenty', () => {
    expect(matchControlPhrase('go quiet for twenty five minutes')).toEqual({
      action: 'quiet',
      seconds: 1500,
    });
    expect(matchControlPhrase('go quiet for one hundred twenty minutes')).toEqual({
      action: 'quiet',
      seconds: 7200,
    });
  });

  test('a few minutes -> 3', () => {
    expect(matchControlPhrase('be quiet for a few minutes')).toEqual({
      action: 'quiet',
      seconds: 180,
    });
  });

  test('N hours', () => {
    expect(matchControlPhrase('go quiet for two hours')).toEqual({
      action: 'quiet',
      seconds: 7200,
    });
  });

  test('seconds are rounded up to whole minutes but returned in seconds', () => {
    expect(matchControlPhrase('go quiet for 30 seconds')).toEqual({
      action: 'quiet',
      seconds: 60,
    });
    expect(matchControlPhrase('go quiet for 90 seconds')).toEqual({
      action: 'quiet',
      seconds: 120,
    });
  });

  test("we are done / that is all uncontracted variants", () => {
    expect(matchControlPhrase('okay we are done')).toEqual({ action: 'end' });
    expect(matchControlPhrase('that is all')).toEqual({ action: 'end' });
  });

  test('bare mute with no tail', () => {
    expect(matchControlPhrase('mute')).toEqual({ action: 'quiet', seconds: null });
  });

  test('anchored quiet-verb tail: duration + politeness combinations', () => {
    expect(matchControlPhrase('mute for an hour please')).toEqual({
      action: 'quiet',
      seconds: 3600,
    });
    expect(matchControlPhrase('shut up for ten minutes jarvis')).toEqual({
      action: 'quiet',
      seconds: 600,
    });
    expect(matchControlPhrase('stop listening for now')).toEqual({
      action: 'quiet',
      seconds: null,
    });
    expect(matchControlPhrase('ok jarvis mute for an hour please')).toEqual({
      action: 'quiet',
      seconds: 3600,
    });
  });

  test('"quiet"/"quite" ASR alias', () => {
    expect(matchControlPhrase('go quite for ten minutes')).toEqual({
      action: 'quiet',
      seconds: 600,
    });
    expect(matchControlPhrase('be quite for five minutes')).toEqual({
      action: 'quiet',
      seconds: 300,
    });
  });

  test('"keep quiet" verb', () => {
    expect(matchControlPhrase('keep quiet for 5 min')).toEqual({
      action: 'quiet',
      seconds: 300,
    });
    expect(matchControlPhrase('keep quiet')).toEqual({ action: 'quiet', seconds: null });
  });

  test('negative durations are rejected, not silently dropped to the magnitude', () => {
    expect(matchControlPhrase('go quiet for -5 minutes')).toEqual({
      action: 'quiet',
      seconds: null,
    });
    expect(matchControlPhrase('mute for minus five minutes')).toEqual({
      action: 'quiet',
      seconds: null,
    });
    expect(matchControlPhrase('mute for negative 5 minutes')).toEqual({
      action: 'quiet',
      seconds: null,
    });
  });
});

describe('matchControlPhrase — negatives (must return null)', () => {
  test.each([
    ["that's all I know about it, what do you think?"],
    ["we're done with the raid, where do we sell the cargo"],
    ['I stopped listening to that album'],
    ["what's the best quiet quantum drive"],
    ['end of the conversation about shields was…'],
    ['can you be quieter please'],
    ['the video is muted'],
    ['quit your job before the meeting'],
    ['I really enjoy a quiet evening at home'],
    ["let's not end this on a bad note"],
    ['the conversation ended abruptly last time'],
    ['done and done, that was a great raid'],
    ['listening to the stop sign debate again'],
    [''],
    [null],
    [undefined],
    // Fix round 1: quiet verb with an object/preposition after it must not
    // fire -- these are ordinary gaming-channel sentences that merely
    // contain the verb, not a command directed at the bot.
    ['mute the music bot'],
    ['can you mute alex?'],
    ['mute alex please'],
    ['should I mute my mic'],
    ['shut up about the cargo already lol'],
    ['stop listening to him'],
    ['we should stop listening to their radio'],
  ])('%p -> null', (input) => {
    expect(matchControlPhrase(input)).toBeNull();
  });
});

describe('matchControlPhrase — leading-context anchor (final review I1)', () => {
  // The command must START the utterance, after at most a short lead-in
  // (wake phrase/name, please, thanks, can/could/would you, alright, ok so).
  // Ordinary speech that merely contains a command verb must not fire.
  test.each([
    // quiet verbs inside ordinary sentences
    ['how do I mute'],
    ['why wont my dog be quiet'],
    ["why won't my dog be quiet?"],
    ['tell him to shut up'],
    ['should I go quiet'],
    ['the kids need to be quiet'],
    // end verb negated / embedded
    ['dont end the conversation yet'],
    ["don't end the conversation yet"],
    ['I do not want to end this conversation, tell me more'],
    ['please never end the conversation'],
    ['not end the conversation'],
    // "that's all" / "we're done" not as a closing statement
    ['let me know when were done'],
    ["let me know when we're done"],
    ["and that's all?"],
    ['and thats all?'],
    ["that's all?"],
    ["is that all"],
    ["until we're done"],
    ["when we're done"],
    ["is we're done"],
    // an end verb followed by something other than an address/closing tail
    ['end the conversation about shields'],
  ])('%p -> null', (input) => {
    expect(matchControlPhrase(input)).toBeNull();
  });

  test.each([
    ['hey jarvis, go quiet for ten minutes', { action: 'quiet', seconds: 600 }],
    ['could you mute for an hour please', { action: 'quiet', seconds: 3600 }],
    ["thanks jarvis, that's all", { action: 'end' }],
    ['ok jarvis end the conversation', { action: 'end' }],
    ["that's all, thanks jarvis", { action: 'end' }],
    ['thank you jarvis, we are done', { action: 'end' }],
    ['alright, stop listening for five minutes', { action: 'quiet', seconds: 300 }],
    ['ok so go quiet', { action: 'quiet', seconds: null }],
    ['can you go quiet for a while', { action: 'quiet', seconds: null }],
    ['would you please end the conversation', { action: 'end' }],
    ['please end the conversation now', { action: 'end' }],
    ['end the conversation, bye', { action: 'end' }],
  ])('%p', (input, expected) => {
    expect(matchControlPhrase(input)).toEqual(expected);
  });
});

describe('parseDurationSeconds', () => {
  test.each([
    ['ten minutes', 600],
    ['20 minutes', 1200],
    ['a couple minutes', 120],
    ['a few minutes', 180],
    ['half an hour', 1800],
    ['an hour', 3600],
    ['one hour', 3600],
    ['two hours', 7200],
    ['twenty five minutes', 1500],
    ['one hundred twenty minutes', 7200],
    ['5 min', 300],
    ['30 seconds', 60],
    ['90 seconds', 120],
    ['no duration mentioned here', null],
    ['', null],
    [null, null],
    ['minus five minutes', null],
    ['negative 5 minutes', null],
    ['-5 minutes', null],
  ])('%s -> %p', (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });
});
