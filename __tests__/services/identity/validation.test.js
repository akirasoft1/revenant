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
    // Single-character names (incl. a lone CJK character) fail the 2-char minimum.
    expect(normalizeName('明子')).toBe('明子');
    expect(normalizeName('明')).toBeNull();
  });

  test('caps length at 24 (sanitize cap)', () => {
    expect(normalizeName('A'.repeat(80)).length).toBeLessThanOrEqual(24);
  });

  test('rejects names containing a run of 15+ digits (Discord-ID lookalikes)', () => {
    expect(normalizeName('A · 161644375040983040')).toBeNull();
    expect(normalizeName('Bob 123456789012345')).toBeNull();
    expect(normalizeName('Bob 12345678901234')).toBe('Bob 12345678901234');
    expect(normalizeName('R2D2')).toBe('R2D2');
  });

  test('requires at least 2 characters after sanitising', () => {
    expect(normalizeName('a')).toBeNull();
    expect(normalizeName('I')).toBeNull();
    expect(normalizeName(' 🔥 J 🔥 ')).toBeNull();
    expect(normalizeName('Jo')).toBe('Jo');
    expect(normalizeName('明子')).toBe('明子');
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
