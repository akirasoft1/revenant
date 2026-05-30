// __tests__/services/recall/ranking.test.js
const { normalizeText, contentHash, normalizeSimilarity } = require('../../../services/recall/ranking');

describe('ranking: hashing & normalization', () => {
  it('normalizeText lowercases and collapses whitespace', () => {
    expect(normalizeText('  Hello   WORLD\n')).toBe('hello world');
  });

  it('contentHash is stable and ignores case/whitespace', () => {
    expect(contentHash('Hello world')).toBe(contentHash('  hello   world '));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });

  it('normalizeSimilarity clamps to 0..1', () => {
    expect(normalizeSimilarity(0.7)).toBeCloseTo(0.7);
    expect(normalizeSimilarity(1.4)).toBe(1);
    expect(normalizeSimilarity(-0.2)).toBe(0);
    expect(normalizeSimilarity(undefined)).toBe(0);
  });
});
