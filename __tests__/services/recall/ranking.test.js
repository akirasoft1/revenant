// __tests__/services/recall/ranking.test.js
const { normalizeText, contentHash, normalizeSimilarity } = require('../../../services/recall/ranking');
const { dedupeCandidates } = require('../../../services/recall/ranking');
const { decayFactor, scoreCandidate } = require('../../../services/recall/ranking');
const { enrichWithLedger } = require('../../../services/recall/ranking');

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

describe('ranking: scoring', () => {
  const weights = { 'mem0:explicit': 1.3, 'mem0:personal': 1.0, 'channel:semantic': 0.8 };
  const opts = { sourceWeights: weights, halfLifeDays: 14, accessBoostAlpha: 0.1 };
  const now = new Date('2026-05-30T00:00:00Z');

  it('decayFactor halves at the half-life', () => {
    expect(decayFactor(0, 14)).toBeCloseTo(1);
    expect(decayFactor(14, 14)).toBeCloseTo(0.5);
  });

  it('recent + high-similarity outranks old + low', () => {
    const fresh = { source: 'mem0:personal', similarity: 0.9, importance: 0.5, accessCount: 0,
      lastAccessedAtUtc: '2026-05-29T00:00:00Z', timestamp: null };
    const stale = { source: 'mem0:personal', similarity: 0.5, importance: 0.5, accessCount: 0,
      lastAccessedAtUtc: '2026-01-01T00:00:00Z', timestamp: null };
    expect(scoreCandidate(fresh, opts, now)).toBeGreaterThan(scoreCandidate(stale, opts, now));
  });

  it('source weight and access count both raise the score', () => {
    const base = { source: 'channel:semantic', similarity: 0.6, importance: 0.5, accessCount: 0, lastAccessedAtUtc: null, timestamp: null };
    const explicit = { ...base, source: 'mem0:explicit' };
    const accessed = { ...base, accessCount: 10 };
    expect(scoreCandidate(explicit, opts, now)).toBeGreaterThan(scoreCandidate(base, opts, now));
    expect(scoreCandidate(accessed, opts, now)).toBeGreaterThan(scoreCandidate(base, opts, now));
  });
});

describe('ranking: enrichWithLedger', () => {
  const seeds = { importanceSeed: 0.5, importanceSeedExplicit: 0.7 };

  it('uses ledger row when present', () => {
    const rows = { 'mem0:personal:1': { importance: 0.9, accessCount: 4, lastAccessedAtUtc: new Date('2026-05-01') } };
    const [c] = enrichWithLedger([{ key: 'mem0:personal:1', source: 'mem0:personal' }], rows, seeds);
    expect(c.importance).toBe(0.9);
    expect(c.accessCount).toBe(4);
  });

  it('seeds first-sight candidates (explicit higher)', () => {
    const [p, e] = enrichWithLedger(
      [{ key: 'k1', source: 'mem0:personal' }, { key: 'k2', source: 'mem0:explicit' }],
      {}, seeds
    );
    expect(p.importance).toBe(0.5);
    expect(p.accessCount).toBe(0);
    expect(p.lastAccessedAtUtc).toBeNull();
    expect(e.importance).toBe(0.7);
  });
});
