// services/recall/ranking.js
const crypto = require('crypto');

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

module.exports = { normalizeText, contentHash, normalizeSimilarity, dedupeCandidates, decayFactor, scoreCandidate };
