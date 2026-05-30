// services/recall/ranking.js
const crypto = require('crypto');
const { countTokens } = require('../../utils/tokenCounter');

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function contentHash(text) {
  return crypto.createHash('sha1').update(normalizeText(text)).digest('hex');
}

function normalizeSimilarity(score) {
  const n = typeof score === 'number' ? score : 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Deduplicates candidates by contentHash, keeping the entry with the highest raw similarity score.
 *
 * NOTE — tiebreak trade-off: ties are broken by RAW similarity (not source-weighted composite
 * score), because source weights are not known at dedupe time. This can rarely cause a candidate
 * with a higher composite score to be dropped in favour of one with equal or marginally higher
 * raw similarity. This is an accepted trade-off for v1 and should be revisited if source-weighted
 * deduplication becomes a measurable quality issue.
 */
function dedupeCandidates(candidates) {
  const byHash = new Map();
  for (const c of candidates) {
    const existing = byHash.get(c.contentHash);
    if (!existing || (c.similarity || 0) > (existing.similarity || 0)) {
      byHash.set(c.contentHash, c);
    }
  }
  return [...byHash.values()];
}

function decayFactor(daysSinceAccess, halfLifeDays) {
  if (!halfLifeDays || halfLifeDays <= 0) return 1; // no decay when unconfigured
  return Math.exp(-(Math.LN2 / halfLifeDays) * Math.max(0, daysSinceAccess));
}

function scoreCandidate(candidate, opts, now = new Date()) {
  const w = (opts.sourceWeights && opts.sourceWeights[candidate.source]) || 1.0;
  const ref = candidate.lastAccessedAtUtc || candidate.timestamp;
  const days = ref ? Math.max(0, (now.getTime() - new Date(ref).getTime()) / 86400000) : 0;
  const decay = decayFactor(days, opts.halfLifeDays);
  const accessBoost = 1 + opts.accessBoostAlpha * Math.log(1 + (candidate.accessCount || 0));
  const importance = typeof candidate.importance === 'number' ? candidate.importance : 0.5;
  return w * (candidate.similarity || 0) * decay * accessBoost * importance;
}

function enrichWithLedger(candidates, ledgerByKey, seeds = {}) {
  return candidates.map((c) => {
    const row = ledgerByKey && ledgerByKey[c.key];
    if (row) {
      return { ...c, importance: row.importance, accessCount: row.accessCount, lastAccessedAtUtc: row.lastAccessedAtUtc || null };
    }
    const seed = c.source === 'mem0:explicit' ? seeds.importanceSeedExplicit : seeds.importanceSeed;
    return { ...c, importance: seed, accessCount: 0, lastAccessedAtUtc: null };
  });
}

function formatLine(candidate) {
  const p = candidate.provenance || {};
  let tag = p.tag || candidate.type || 'memory';
  if (p.when) tag += ` · ${p.when}`;
  if (p.who) tag += ` · ${p.who}`;
  return `[${tag}] ${candidate.text}`;
}

function formatMemoryBlock(selected) {
  if (!selected || selected.length === 0) return '';
  const lines = selected.map(formatLine).join('\n');
  return `\n\n## Memory Context\n${lines}`;
}

function rankAndBound(candidates, opts) {
  const now = opts.now || new Date();
  const count = opts.countTokens || countTokens;
  const scored = candidates
    .map((c) => ({ ...c, score: scoreCandidate(c, opts, now) }))
    .sort((a, b) => b.score - a.score);

  const selected = [];
  let tokens = 0;
  for (const c of scored) {
    if (selected.length >= opts.maxItems) break;
    const lineTokens = count(formatLine(c));
    if (tokens + lineTokens > opts.tokenBudget) continue;
    selected.push(c);
    tokens += lineTokens;
  }
  return selected;
}

module.exports = { normalizeText, contentHash, normalizeSimilarity, dedupeCandidates, decayFactor, scoreCandidate, enrichWithLedger, formatLine, formatMemoryBlock, rankAndBound };
