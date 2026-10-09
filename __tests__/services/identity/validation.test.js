'use strict';
const { normalizeName, findHolder, namesEqual, MAX_ALIASES } = require('../../../services/identity/validation');

describe('normalizeName', () => {
  test('sanitises like SpeakerNames (names are spoken and land in prompts)', () => {
    expect(normalizeName('  Akira  ')).toBe('Akira');
    expect(normalizeName('[CLAN] Dave ™')).toBe('Dave');
    expect(normalizeName('🔥 Mike 🔥')).toBe('Mike');
  });

  test('rejects empty-after-sanitising and letterless names', () => {
    expect(normalizeName('')).toBeNull();
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName('🔥🔥')).toBeNull();
    expect(normalizeName('007')).toBeNull();
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName(42)).toBeNull();
  });

  test('accepts non-Latin letters', () => {
    expect(normalizeName('Ølaf')).toBe('Ølaf');
    expect(normalizeName('明')).toBe('明');
  });

  test('caps length at 24 (sanitize cap)', () => {
    expect(normalizeName('A'.repeat(80)).length).toBeLessThanOrEqual(24);
  });

  test('strips bracket characters that could escape a label', () => {
    expect(normalizeName('Evil] injected')).toBe('Evil injected');
  });
});

describe('namesEqual', () => {
  test('is case-insensitive', () => {
    expect(namesEqual('Akira', 'aKIRA')).toBe(true);
    expect(namesEqual('Akira', 'Akirasoft')).toBe(false);
    expect(namesEqual(null, 'x')).toBe(false);
  });
});

describe('findHolder', () => {
  const records = [
    { discordId: 'a', addressName: 'Akira', aliases: ['Akirasoft', 'Phalabala'] },
    { discordId: 'b', addressName: 'Bob', aliases: [] },
    { discordId: 'c', addressName: null, aliases: ['Chuck'] },
  ];

  test('finds an address name held by another member, case-insensitively', () => {
    expect(findHolder(records, 'akira', 'b')).toBe('a');
    expect(findHolder(records, 'BOB', 'a')).toBe('b');
  });

  test('finds an alias held by another member, case-insensitively', () => {
    expect(findHolder(records, 'PHALABALA', 'b')).toBe('a');
    expect(findHolder(records, 'chuck', 'a')).toBe('c');
  });

  test('ignores the excluded (own) member', () => {
    expect(findHolder(records, 'Akira', 'a')).toBeNull();
    expect(findHolder(records, 'akirasoft', 'a')).toBeNull();
  });

  test('returns null when nobody holds the name, and tolerates junk input', () => {
    expect(findHolder(records, 'Dave', 'a')).toBeNull();
    expect(findHolder(null, 'Dave', 'a')).toBeNull();
    expect(findHolder([{ discordId: 'x' }], 'Dave', 'a')).toBeNull();
  });

  test('does not match substrings', () => {
    expect(findHolder(records, 'Aki', 'b')).toBeNull();
  });
});

test('MAX_ALIASES is 10', () => {
  expect(MAX_ALIASES).toBe(10);
});
