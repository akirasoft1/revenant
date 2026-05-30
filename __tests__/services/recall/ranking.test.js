// __tests__/services/recall/ranking.test.js
const { normalizeText, contentHash, normalizeSimilarity } = require('../../../services/recall/ranking');
const { dedupeCandidates } = require('../../../services/recall/ranking');

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

describe('ranking: dedupe', () => {
  it('collapses same-content candidates, keeping the highest similarity', () => {
    const out = dedupeCandidates([
      { key: 'a', contentHash: 'h1', similarity: 0.4, text: 'net-30' },
      { key: 'b', contentHash: 'h1', similarity: 0.9, text: 'net-30' },
      { key: 'c', contentHash: 'h2', similarity: 0.5, text: 'toaster' },
    ]);
    expect(out).toHaveLength(2);
    const kept = out.find(c => c.contentHash === 'h1');
    expect(kept.similarity).toBe(0.9);
  });
});
