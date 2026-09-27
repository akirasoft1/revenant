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
  ])('%p -> null', (input) => {
    expect(matchControlPhrase(input)).toBeNull();
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
  ])('%s -> %p', (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });
});
