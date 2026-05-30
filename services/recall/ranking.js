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

module.exports = { normalizeText, contentHash, normalizeSimilarity };
