'use strict';
const { createSpeakerNames, sanitize } = require('../../services/SpeakerNames');

const U = (o) => ({ id: 'u1', username: 'inc1067', globalName: null, ...o });

test('override table wins over every Discord source', () => {
  const r = createSpeakerNames({ overrides: { u1: 'Mike' } });
  expect(r.resolve(U({ globalName: 'inc' }), { nickname: 'Macroplastics by Bic(tm)' })).toBe('Mike');
});

test('falls back to globalName, then nickname, then de-suffixed username', () => {
  const r = createSpeakerNames({});
  expect(r.resolve(U({ globalName: 'inc' }), { nickname: 'Joke Name' })).toBe('inc');
  expect(r.resolve(U({ globalName: null }), { nickname: 'Joke Name' })).toBe('Joke Name');
  expect(r.resolve(U({ globalName: null }), null)).toBe('inc'); // inc1067 -> inc
});

test('accepts the snake_case global_name shape too', () => {
  const r = createSpeakerNames({});
  expect(r.resolve({ id: 'u1', username: 'x9', global_name: 'Ecks' })).toBe('Ecks');
});

test('sanitises names that would otherwise be SPOKEN literally', () => {
  expect(sanitize('Macroplastics by Bic(tm)')).toBe('Macroplastics by Bic');
  expect(sanitize('[CLAN] Dave ™')).toBe('Dave');
  expect(sanitize('🔥🔥 Mike 🔥')).toBe('Mike');
  expect(sanitize('   spaced   out   ')).toBe('spaced out');
});

test('returns null rather than asserting a wrong name', () => {
  const r = createSpeakerNames({});
  expect(r.resolve({ id: 'u1', username: '12345', globalName: null })).toBeNull(); // all digits
  expect(r.resolve({ id: 'u1', username: '🔥', globalName: null })).toBeNull();
});

test('a username that is only digits does not become an empty string', () => {
  const r = createSpeakerNames({});
  expect(r.resolve({ id: 'u1', username: '007', globalName: null })).toBeNull();
});

test('caps absurdly long names', () => {
  const long = 'A'.repeat(80);
  expect(sanitize(long).length).toBeLessThanOrEqual(24);
});

test('a letterless-but-non-empty override is authoritative and is NOT discarded for being weird', () => {
  const r1 = createSpeakerNames({ overrides: { u1: '12345' } });
  expect(r1.resolve({ id: 'u1', username: 'fallback99', globalName: null }, null)).toBe('12345');

  const r2 = createSpeakerNames({ overrides: { u1: '007' } });
  expect(r2.resolve({ id: 'u1', username: 'fallback99', globalName: null }, null)).toBe('007');
});

test('an override that sanitises to empty still falls through to the next candidate', () => {
  const r1 = createSpeakerNames({ overrides: { u1: '   ' } });
  expect(r1.resolve(U({ globalName: 'inc' }), null)).toBe('inc');

  const r2 = createSpeakerNames({ overrides: { u1: '🔥' } });
  expect(r2.resolve(U({ globalName: 'inc' }), null)).toBe('inc');
});

test('auto-resolved behaviour is unchanged: a digits-only username (no override) still yields null', () => {
  const r = createSpeakerNames({});
  expect(r.resolve({ id: 'u1', username: '12345', globalName: null })).toBeNull();
});
