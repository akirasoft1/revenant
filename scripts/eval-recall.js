// scripts/eval-recall.js
/* Offline recall ranking eval. Runs fixtures through rankAndBound across a
 * config sweep and reports precision@N / nDCG@N per config. Read-only. */
const fs = require('fs');
const path = require('path');
const { rankAndBound } = require('../services/recall/ranking');
const { precisionAtN, ndcgAtN } = require('../services/recall/evalMetrics');

const FIXTURE = process.argv[2] || path.join(__dirname, '..', 'eval', 'recall', 'sample.json');
const N = parseInt(process.env.EVAL_N || '5', 10);
const NOW = new Date(process.env.EVAL_NOW || '2026-05-30T00:00:00Z');

const baseWeights = { 'mem0:explicit': 1.3, 'mem0:shared': 1.1, 'channel:facts': 1.0, 'mem0:personal': 1.0, 'channel:semantic': 0.8 };

const sweep = [
  { label: 'half-life=14 a=0.1', halfLifeDays: 14, accessBoostAlpha: 0.1 },
  { label: 'half-life=7 a=0.1', halfLifeDays: 7, accessBoostAlpha: 0.1 },
  { label: 'half-life=30 a=0.2', halfLifeDays: 30, accessBoostAlpha: 0.2 },
];

const cases = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

for (const cfg of sweep) {
  let pSum = 0;
  let nSum = 0;
  for (const c of cases) {
    const ranked = rankAndBound(c.candidates, {
      maxItems: N, tokenBudget: 100000,
      sourceWeights: baseWeights, halfLifeDays: cfg.halfLifeDays, accessBoostAlpha: cfg.accessBoostAlpha,
      now: NOW,
    }).map((x) => x.key);
    const expected = new Set(c.expectedKeys);
    pSum += precisionAtN(ranked, expected, N);
    nSum += ndcgAtN(ranked, expected, N);
  }
  const n = cases.length;
  console.log(`${cfg.label.padEnd(24)}  precision@${N}=${(pSum / n).toFixed(3)}  ndcg@${N}=${(nSum / n).toFixed(3)}`);
}
