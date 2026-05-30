# Centralized Ranked Recall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bot's scattered, additive recall with one `RecallService` that over-retrieves from all content sources, dedupes/excludes, ranks by recency + importance with decay and access-count, bounds the output, and emits a single provenance-tagged `## Memory Context` block — behind feature flags, with offline eval and A/B shadow logging.

**Architecture:** A thin orchestrator (`RecallService`) calls per-source *adapters* that normalize each existing source (Mem0 personal/explicit/shared, channel semantic hits, channel facts) into a common `Candidate`. Pure functions in `services/recall/ranking.js` handle dedup, scoring, and bounding. A new Mongo `recall_ledger` collection (accessed via `MongoService`) holds the importance / access-count / last-access state Mem0 won't give us. `ChatService` calls `recall()` behind `RECALL_V2_ENABLED`; the recent-buffer and voice/few-shot blocks stay separate. Spec: `docs/superpowers/specs/2026-05-30-centralized-ranked-recall-design.md`.

**Tech Stack:** Node.js, Jest v30 (`--testPathPatterns`), MongoDB driver (`this.db.collection`), tiktoken via `utils/tokenCounter`, existing `Mem0Service` / `ChannelContextService`.

---

## Shared data shapes (referenced by every task)

**`Candidate`** — what every adapter returns and the ranker consumes:

```js
{
  key,          // ledger identity: `${source}:${id}` or `hash:${contentHash}`
  source,       // 'mem0:personal' | 'mem0:explicit' | 'mem0:shared' | 'channel:semantic' | 'channel:facts'
  type,         // 'fact' | 'preference' | 'message' | 'channel-fact'
  text,         // content injected into the prompt
  similarity,   // 0..1 (normalized source score)
  timestamp,    // ISO string or null (channel:semantic has it)
  contentHash,  // sha1 of normalized text — used for dedup + exclusion
  provenance,   // { tag, when?, who? } → renders the "[..]" prefix
  // added by enrichWithLedger():
  importance,        // 0..1
  accessCount,       // integer
  lastAccessedAtUtc, // Date | null
  // added by rankAndBound():
  score,        // number
}
```

**`recall_ledger` document:**
```js
{ memoryKey, scope:{userId?,channelId?,personalityId?}, source, contentHash,
  importance, accessCount, firstSeenAtUtc, lastAccessedAtUtc, expiresAt }
```

---

## File structure

| File | Responsibility | New/Mod |
|---|---|---|
| `config/config.js` | `recall` config block | Modify |
| `services/recall/ranking.js` | pure: hash, normalize, dedupe, score, enrich, format, bound | Create |
| `services/recall/queryBuilder.js` | derive recall query from recent window (3 strategies) | Create |
| `services/recall/adapters.js` | normalize each source into `Candidate[]` | Create |
| `services/RecallService.js` | orchestrate query→fan-out→exclude→dedupe→enrich→rank→format→bump | Create |
| `services/recall/evalMetrics.js` | pure: precision@N, nDCG@N | Create |
| `services/MongoService.js` | `recall_ledger` + `recall_comparisons` methods + indexes | Modify |
| `services/ChannelContextService.js` | `buildRecentContext()` (participants + buffer only) | Modify |
| `services/ChatService.js` | call `recall()` behind flag; shadow logging; prompt-size guard | Modify |
| `bot.js` | construct `RecallService`, inject into `ChatService` | Modify |
| `scripts/eval-recall.js` | offline eval harness (sweeps configs over fixtures) | Create |
| `eval/recall/sample.json` | seed eval fixture | Create |
| `features.md`, `README.md`, `CLAUDE.md` | docs + env vars | Modify |

Tests live under `__tests__/services/recall/` (pure modules) and `__tests__/services/` (service integration), mirroring existing layout.

---

### Task 1: Config block

**Files:**
- Modify: `config/config.js` (add a `recall:` block alongside the existing `mem0`/`channelContext` blocks, ~line 305)
- Test: `__tests__/recall-config.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/recall-config.test.js
describe('recall config', () => {
  beforeEach(() => { jest.resetModules(); });

  it('provides sane defaults', () => {
    delete process.env.RECALL_V2_ENABLED;
    const config = require('../config/config');
    expect(config.recall.enabled).toBe(false);
    expect(config.recall.maxItems).toBe(8);
    expect(config.recall.halfLifeDays).toBe(14);
    expect(config.recall.queryStrategy).toBe('recent-window');
    expect(config.recall.sourceWeights['mem0:explicit']).toBeGreaterThan(
      config.recall.sourceWeights['channel:semantic']
    );
  });

  it('reads overrides from env', () => {
    process.env.RECALL_V2_ENABLED = 'true';
    process.env.RECALL_MAX_ITEMS = '12';
    const config = require('../config/config');
    expect(config.recall.enabled).toBe(true);
    expect(config.recall.maxItems).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall-config"`
Expected: FAIL — `Cannot read properties of undefined (reading 'enabled')`

- [ ] **Step 3: Add the config block**

Insert after the `channelContext` block closes (right before `voiceProfile:`):

```js
  // Recall - centralized, ranked memory retrieval (spec 2026-05-30)
  recall: {
    enabled: process.env.RECALL_V2_ENABLED === 'true',
    shadowEnabled: process.env.RECALL_SHADOW_ENABLED === 'true',
    shadowInject: process.env.RECALL_SHADOW_INJECT || 'old', // 'old' | 'new'
    perSourceLimit: parseInt(process.env.RECALL_PER_SOURCE_LIMIT || '10', 10),
    maxItems: parseInt(process.env.RECALL_MAX_ITEMS || '8', 10),
    tokenBudget: parseInt(process.env.RECALL_TOKEN_BUDGET || '600', 10),
    halfLifeDays: parseFloat(process.env.RECALL_HALF_LIFE_DAYS || '14'),
    accessBoostAlpha: parseFloat(process.env.RECALL_ACCESS_BOOST_ALPHA || '0.1'),
    importanceSeed: parseFloat(process.env.RECALL_IMPORTANCE_SEED || '0.5'),
    importanceSeedExplicit: parseFloat(process.env.RECALL_IMPORTANCE_SEED_EXPLICIT || '0.7'),
    importanceNudge: parseFloat(process.env.RECALL_IMPORTANCE_NUDGE || '0.02'),
    importanceMax: parseFloat(process.env.RECALL_IMPORTANCE_MAX || '1.0'),
    queryStrategy: process.env.RECALL_QUERY_STRATEGY || 'recent-window', // last-message | recent-window | llm-condense
    queryWindow: parseInt(process.env.RECALL_QUERY_WINDOW || '3', 10),
    sourceWeights: {
      'mem0:explicit': parseFloat(process.env.RECALL_W_EXPLICIT || '1.3'),
      'mem0:shared': parseFloat(process.env.RECALL_W_SHARED || '1.1'),
      'channel:facts': parseFloat(process.env.RECALL_W_CHANNEL_FACTS || '1.0'),
      'mem0:personal': parseFloat(process.env.RECALL_W_PERSONAL || '1.0'),
      'channel:semantic': parseFloat(process.env.RECALL_W_CHANNEL_SEMANTIC || '0.8'),
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall-config"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add config/config.js __tests__/recall-config.test.js
git commit -m "feat(recall): add recall config block with defaults"
```

---

### Task 2: ranking — hashing & similarity normalization

**Files:**
- Create: `services/recall/ranking.js`
- Test: `__tests__/services/recall/ranking.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: FAIL — `Cannot find module '.../services/recall/ranking'`

- [ ] **Step 3: Create the module with these three functions**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/recall/ranking.js __tests__/services/recall/ranking.test.js
git commit -m "feat(recall): text hashing and similarity normalization"
```

---

### Task 3: ranking — dedupeCandidates

**Files:**
- Modify: `services/recall/ranking.js`
- Test: `__tests__/services/recall/ranking.test.js`

- [ ] **Step 1: Add the failing test**

```js
const { dedupeCandidates } = require('../../../services/recall/ranking');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: FAIL — `dedupeCandidates is not a function`

- [ ] **Step 3: Implement and export**

```js
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
```
Add `dedupeCandidates` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/recall/ranking.js __tests__/services/recall/ranking.test.js
git commit -m "feat(recall): cross-source dedupe by content hash"
```

---

### Task 4: ranking — decay & scoreCandidate

**Files:**
- Modify: `services/recall/ranking.js`
- Test: `__tests__/services/recall/ranking.test.js`

- [ ] **Step 1: Add the failing test**

```js
const { decayFactor, scoreCandidate } = require('../../../services/recall/ranking');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: FAIL — `decayFactor is not a function`

- [ ] **Step 3: Implement and export**

```js
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
```
Add both to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/recall/ranking.js __tests__/services/recall/ranking.test.js
git commit -m "feat(recall): temporal-decay scoring with access boost"
```

---

### Task 5: ranking — enrichWithLedger

**Files:**
- Modify: `services/recall/ranking.js`
- Test: `__tests__/services/recall/ranking.test.js`

- [ ] **Step 1: Add the failing test**

```js
const { enrichWithLedger } = require('../../../services/recall/ranking');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: FAIL — `enrichWithLedger is not a function`

- [ ] **Step 3: Implement and export**

```js
function enrichWithLedger(candidates, ledgerByKey, seeds) {
  return candidates.map((c) => {
    const row = ledgerByKey && ledgerByKey[c.key];
    if (row) {
      return { ...c, importance: row.importance, accessCount: row.accessCount, lastAccessedAtUtc: row.lastAccessedAtUtc || null };
    }
    const seed = c.source === 'mem0:explicit' ? seeds.importanceSeedExplicit : seeds.importanceSeed;
    return { ...c, importance: seed, accessCount: 0, lastAccessedAtUtc: null };
  });
}
```
Add `enrichWithLedger` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/recall/ranking.js __tests__/services/recall/ranking.test.js
git commit -m "feat(recall): enrich candidates from ledger with seeded defaults"
```

---

### Task 6: ranking — formatting & rankAndBound

**Files:**
- Modify: `services/recall/ranking.js`
- Test: `__tests__/services/recall/ranking.test.js`

- [ ] **Step 1: Add the failing test**

```js
const { formatLine, formatMemoryBlock, rankAndBound } = require('../../../services/recall/ranking');

describe('ranking: formatting & bounding', () => {
  const baseOpts = {
    maxItems: 2, tokenBudget: 1000,
    sourceWeights: { 'mem0:explicit': 1.3, 'mem0:personal': 1.0 },
    halfLifeDays: 14, accessBoostAlpha: 0.1,
    countTokens: (s) => s.split(/\s+/).length, // fake tokenizer
    now: new Date('2026-05-30T00:00:00Z'),
  };

  it('formatLine renders provenance prefix', () => {
    expect(formatLine({ provenance: { tag: 'history', when: '2026-05-18', who: '@anna' }, text: 'hi' }))
      .toBe('[history · 2026-05-18 · @anna] hi');
    expect(formatLine({ provenance: { tag: 'explicit' }, text: 'x' })).toBe('[explicit] x');
  });

  it('formatMemoryBlock returns empty string for no candidates', () => {
    expect(formatMemoryBlock([])).toBe('');
  });

  it('rankAndBound caps to maxItems, highest score first', () => {
    const cands = [
      { key: 'a', source: 'mem0:personal', similarity: 0.4, importance: 0.5, accessCount: 0, provenance: { tag: 'fact' }, text: 'low' },
      { key: 'b', source: 'mem0:explicit', similarity: 0.9, importance: 0.7, accessCount: 0, provenance: { tag: 'explicit' }, text: 'high' },
      { key: 'c', source: 'mem0:personal', similarity: 0.6, importance: 0.5, accessCount: 0, provenance: { tag: 'fact' }, text: 'mid' },
    ];
    const out = rankAndBound(cands, baseOpts);
    expect(out).toHaveLength(2);
    expect(out[0].key).toBe('b');
  });

  it('rankAndBound respects the token budget', () => {
    const tight = { ...baseOpts, maxItems: 10, tokenBudget: 1 };
    const out = rankAndBound([
      { key: 'a', source: 'mem0:personal', similarity: 0.9, importance: 0.5, accessCount: 0, provenance: { tag: 'fact' }, text: 'too many words here' },
    ], tight);
    expect(out).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: FAIL — `formatLine is not a function`

- [ ] **Step 3: Implement and export**

```js
const { countTokens } = require('../../utils/tokenCounter');

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
```
Add `formatLine`, `formatMemoryBlock`, `rankAndBound` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall/ranking"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/recall/ranking.js __tests__/services/recall/ranking.test.js
git commit -m "feat(recall): provenance formatting + ranked top-N/token bounding"
```

---

### Task 7: queryBuilder — last-message & recent-window

**Files:**
- Create: `services/recall/queryBuilder.js`
- Test: `__tests__/services/recall/queryBuilder.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/services/recall/queryBuilder.test.js
const { buildQuery } = require('../../../services/recall/queryBuilder');

describe('queryBuilder', () => {
  const msgs = ['first message', 'second message', 'third message', 'current message'];

  it('last-message returns the final message', async () => {
    expect(await buildQuery(msgs, { strategy: 'last-message' })).toBe('current message');
  });

  it('recent-window joins the last N messages', async () => {
    expect(await buildQuery(msgs, { strategy: 'recent-window', windowSize: 2 }))
      .toBe('third message\ncurrent message');
  });

  it('returns empty string for empty input', async () => {
    expect(await buildQuery([], { strategy: 'recent-window' })).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall/queryBuilder"`
Expected: FAIL — `Cannot find module '.../queryBuilder'`

- [ ] **Step 3: Create the module**

```js
// services/recall/queryBuilder.js
async function buildQuery(recentMessages, opts = {}) {
  const msgs = (recentMessages || []).filter((m) => typeof m === 'string' && m.trim());
  if (msgs.length === 0) return '';

  const strategy = opts.strategy || 'recent-window';
  const last = msgs[msgs.length - 1];

  if (strategy === 'last-message') return last;

  if (strategy === 'recent-window') {
    const n = opts.windowSize || 3;
    return msgs.slice(-n).join('\n');
  }

  if (strategy === 'llm-condense') {
    if (typeof opts.condenser !== 'function') return last;
    try {
      const window = msgs.slice(-(opts.windowSize || 5)).join('\n');
      const condensed = await opts.condenser(window);
      return (condensed && condensed.trim()) ? condensed.trim() : last;
    } catch (e) {
      return last;
    }
  }

  return last;
}

module.exports = { buildQuery };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall/queryBuilder"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/recall/queryBuilder.js __tests__/services/recall/queryBuilder.test.js
git commit -m "feat(recall): query builder with last-message and recent-window strategies"
```

---

### Task 8: queryBuilder — llm-condense strategy

**Files:**
- Modify: `services/recall/queryBuilder.js` (already supports it — this task adds coverage and the fallback contract)
- Test: `__tests__/services/recall/queryBuilder.test.js`

- [ ] **Step 1: Add the failing test**

```js
describe('queryBuilder: llm-condense', () => {
  const msgs = ['talked about the deploy', 'and the sort change', 'what was the benchmark again'];

  it('uses the condenser output when provided', async () => {
    const condenser = jest.fn().mockResolvedValue('  sort benchmark results  ');
    const q = await buildQuery(msgs, { strategy: 'llm-condense', condenser });
    expect(condenser).toHaveBeenCalled();
    expect(q).toBe('sort benchmark results');
  });

  it('falls back to last message when no condenser given', async () => {
    expect(await buildQuery(msgs, { strategy: 'llm-condense' })).toBe('what was the benchmark again');
  });

  it('falls back to last message when condenser throws', async () => {
    const condenser = jest.fn().mockRejectedValue(new Error('llm down'));
    expect(await buildQuery(msgs, { strategy: 'llm-condense', condenser })).toBe('what was the benchmark again');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (logic already present from Task 7)**

Run: `npm test -- --testPathPatterns="recall/queryBuilder"`
Expected: PASS (Task 7's implementation already handles llm-condense; this task locks the contract with tests).

- [ ] **Step 3: Commit**

```bash
git add __tests__/services/recall/queryBuilder.test.js
git commit -m "test(recall): cover llm-condense strategy and fallbacks"
```

---

### Task 9: Source adapters

**Files:**
- Create: `services/recall/adapters.js`
- Test: `__tests__/services/recall/adapters.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/services/recall/adapters.test.js
const adapters = require('../../../services/recall/adapters');

describe('recall adapters', () => {
  it('mem0PersonalAdapter normalizes results', async () => {
    const mem0 = {
      isEnabled: () => true,
      searchMemories: jest.fn().mockResolvedValue({ results: [{ id: '1', memory: 'likes net-30', score: 0.8 }] }),
    };
    const out = await adapters.mem0PersonalAdapter(mem0, { query: 'q', userId: 'u', personalityId: 'p', limit: 10 });
    expect(out[0]).toMatchObject({ key: 'mem0:personal:1', source: 'mem0:personal', type: 'fact', text: 'likes net-30', similarity: 0.8 });
    expect(out[0].contentHash).toBeDefined();
    expect(out[0].provenance.tag).toBe('fact');
  });

  it('mem0 adapters return [] when service disabled or throwing', async () => {
    expect(await adapters.mem0PersonalAdapter({ isEnabled: () => false }, {})).toEqual([]);
    const boom = { isEnabled: () => true, searchMemories: jest.fn().mockRejectedValue(new Error('x')) };
    expect(await adapters.mem0PersonalAdapter(boom, {})).toEqual([]);
  });

  it('channelSemanticAdapter maps history hits with timestamp + author provenance', async () => {
    const svc = {
      isChannelTracked: () => true,
      searchRelevantHistory: jest.fn().mockResolvedValue([
        { authorName: 'anna', content: 'shipping tonight', timestamp: '2026-05-18T09:00:00Z', score: 0.7 },
      ]),
    };
    const [c] = await adapters.channelSemanticAdapter(svc, { query: 'q', channelId: 'c', limit: 10 });
    expect(c).toMatchObject({ source: 'channel:semantic', type: 'message', text: 'shipping tonight', similarity: 0.7 });
    expect(c.provenance).toMatchObject({ tag: 'history', when: '2026-05-18', who: '@anna' });
    expect(c.key.startsWith('hash:')).toBe(true);
  });

  it('channelSemanticAdapter returns [] when channel not tracked', async () => {
    expect(await adapters.channelSemanticAdapter({ isChannelTracked: () => false }, { channelId: 'c' })).toEqual([]);
  });

  it('channelFactsAdapter normalizes channel facts', async () => {
    const svc = { getChannelFacts: jest.fn().mockResolvedValue([{ id: '9', memory: 'toaster = build-01' }]) };
    const [c] = await adapters.channelFactsAdapter(svc, { channelId: 'c' });
    expect(c).toMatchObject({ key: 'channel:facts:9', source: 'channel:facts', type: 'channel-fact', text: 'toaster = build-01' });
    expect(c.provenance.tag).toBe('channel');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall/adapters"`
Expected: FAIL — `Cannot find module '.../adapters'`

- [ ] **Step 3: Create the module**

```js
// services/recall/adapters.js
const { contentHash, normalizeSimilarity } = require('./ranking');

function mem0Candidate(item, source, type, tag) {
  const text = item.memory || '';
  const hash = contentHash(text);
  return {
    key: item.id ? `${source}:${item.id}` : `hash:${hash}`,
    source,
    type,
    text,
    similarity: normalizeSimilarity(item.score),
    timestamp: null,
    contentHash: hash,
    provenance: { tag },
  };
}

async function mem0PersonalAdapter(mem0Service, { query, userId, personalityId, limit }) {
  if (!mem0Service || !mem0Service.isEnabled || !mem0Service.isEnabled()) return [];
  try {
    const res = await mem0Service.searchMemories(query, userId, { personalityId, limit });
    return (res.results || []).map((it) => mem0Candidate(it, 'mem0:personal', 'fact', 'fact'));
  } catch (e) { return []; }
}

async function mem0ExplicitAdapter(mem0Service, { query, userId, limit }) {
  if (!mem0Service || !mem0Service.isEnabled || !mem0Service.isEnabled()) return [];
  try {
    const res = await mem0Service.searchMemories(query, userId, { personalityId: 'explicit_memory', limit });
    return (res.results || []).map((it) => mem0Candidate(it, 'mem0:explicit', 'fact', 'explicit'));
  } catch (e) { return []; }
}

async function mem0SharedAdapter(mem0Service, { query, channelId, limit }) {
  if (!mem0Service || !mem0Service.isEnabled || !mem0Service.isEnabled()) return [];
  if (!channelId || !mem0Service.searchSharedChannelMemories) return [];
  try {
    const res = await mem0Service.searchSharedChannelMemories(query, channelId, { limit });
    return (res.results || []).map((it) => mem0Candidate(it, 'mem0:shared', 'fact', 'shared · channel'));
  } catch (e) { return []; }
}

async function channelSemanticAdapter(channelContextService, { query, channelId, limit }) {
  if (!channelContextService || !channelContextService.isChannelTracked || !channelContextService.isChannelTracked(channelId)) return [];
  try {
    const hits = await channelContextService.searchRelevantHistory(query, channelId, { limit });
    return (hits || []).map((h) => {
      const text = h.content || '';
      const hash = contentHash(text);
      return {
        key: `hash:${hash}`,
        source: 'channel:semantic',
        type: 'message',
        text,
        similarity: normalizeSimilarity(h.score),
        timestamp: h.timestamp || null,
        contentHash: hash,
        provenance: {
          tag: 'history',
          when: h.timestamp ? String(h.timestamp).slice(0, 10) : undefined,
          who: h.authorName ? `@${h.authorName}` : undefined,
        },
      };
    });
  } catch (e) { return []; }
}

async function channelFactsAdapter(channelContextService, { channelId }) {
  if (!channelContextService || !channelContextService.getChannelFacts) return [];
  try {
    const facts = await channelContextService.getChannelFacts(channelId);
    return (facts || []).map((it) => mem0Candidate(it, 'channel:facts', 'channel-fact', 'channel'));
  } catch (e) { return []; }
}

module.exports = {
  mem0Candidate,
  mem0PersonalAdapter,
  mem0ExplicitAdapter,
  mem0SharedAdapter,
  channelSemanticAdapter,
  channelFactsAdapter,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall/adapters"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/recall/adapters.js __tests__/services/recall/adapters.test.js
git commit -m "feat(recall): source adapters normalizing all five recall sources"
```

---

### Task 10: MongoService — ledger & comparison methods

**Files:**
- Modify: `services/MongoService.js` (add methods near the channel-message section ~line 1393; add indexes in `connect()` ~line 58)
- Test: `__tests__/services/MongoService.recall.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/services/MongoService.recall.test.js
jest.mock('mongodb', () => ({ MongoClient: jest.fn().mockImplementation(() => ({ connect: jest.fn(), db: jest.fn() })) }));
jest.mock('../../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));
jest.mock('../../tracing', () => ({ withSpan: (n, a, fn) => fn({ setAttribute: jest.fn(), setAttributes: jest.fn() }) }));
jest.mock('../../tracing-attributes', () => ({ DB: {}, ERROR: {} }), { virtual: true });

const MongoService = require('../../services/MongoService');

function makeService(collectionImpl) {
  const svc = Object.create(MongoService.prototype);
  svc.db = { collection: jest.fn(() => collectionImpl) };
  return svc;
}

describe('MongoService recall methods', () => {
  it('getRecallLedger returns a map keyed by memoryKey', async () => {
    const coll = { find: jest.fn(() => ({ toArray: () => Promise.resolve([{ memoryKey: 'k1', importance: 0.5 }]) })) };
    const svc = makeService(coll);
    const out = await svc.getRecallLedger(['k1']);
    expect(out.k1.importance).toBe(0.5);
  });

  it('getRecallLedger returns {} for empty input', async () => {
    const svc = makeService({});
    expect(await svc.getRecallLedger([])).toEqual({});
  });

  it('bumpRecallAccess issues a bulkWrite with upsert pipeline ops', async () => {
    const bulkWrite = jest.fn().mockResolvedValue({});
    const svc = makeService({ bulkWrite });
    await svc.bumpRecallAccess([{ memoryKey: 'k1', scope: {}, source: 'mem0:personal', contentHash: 'h', importanceSeed: 0.5 }], { nudge: 0.02, importanceMax: 1.0 });
    expect(bulkWrite).toHaveBeenCalled();
    const ops = bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.upsert).toBe(true);
    expect(Array.isArray(ops[0].updateOne.update)).toBe(true); // pipeline update
  });

  it('recordRecallComparison inserts a doc with a ts', async () => {
    const insertOne = jest.fn().mockResolvedValue({});
    const svc = makeService({ insertOne });
    await svc.recordRecallComparison({ query: 'q' });
    expect(insertOne).toHaveBeenCalled();
    expect(insertOne.mock.calls[0][0].ts).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="MongoService.recall"`
Expected: FAIL — `svc.getRecallLedger is not a function`

- [ ] **Step 3: Add the methods**

Insert before the final closing brace of the class (after `getRecentChannelMessages`):

```js
    // ==================== RECALL LEDGER ====================

    async getRecallLedger(memoryKeys) {
        if (!this.db || !memoryKeys || memoryKeys.length === 0) return {};
        try {
            const rows = await this.db.collection('recall_ledger')
                .find({ memoryKey: { $in: memoryKeys } }).toArray();
            const byKey = {};
            for (const r of rows) byKey[r.memoryKey] = r;
            return byKey;
        } catch (error) {
            logger.error(`Error reading recall_ledger: ${error.message}`);
            return {};
        }
    }

    async bumpRecallAccess(entries, opts = {}) {
        if (!this.db || !entries || entries.length === 0) return;
        const now = new Date();
        const nudge = typeof opts.nudge === 'number' ? opts.nudge : 0.02;
        const max = typeof opts.importanceMax === 'number' ? opts.importanceMax : 1.0;
        try {
            const ops = entries.map((e) => ({
                updateOne: {
                    filter: { memoryKey: e.memoryKey },
                    update: [
                        { $set: {
                            memoryKey: e.memoryKey,
                            scope: e.scope || {},
                            source: e.source || null,
                            contentHash: e.contentHash || null,
                            accessCount: { $add: [{ $ifNull: ['$accessCount', 0] }, 1] },
                            importance: { $min: [max, { $add: [{ $ifNull: ['$importance', e.importanceSeed != null ? e.importanceSeed : 0.5] }, nudge] }] },
                            firstSeenAtUtc: { $ifNull: ['$firstSeenAtUtc', now] },
                            lastAccessedAtUtc: now,
                            expiresAt: { $ifNull: ['$expiresAt', e.expiresAt || null] },
                        } },
                    ],
                    upsert: true,
                },
            }));
            await this.db.collection('recall_ledger').bulkWrite(ops, { ordered: false });
        } catch (error) {
            logger.error(`Error bumping recall_ledger: ${error.message}`);
        }
    }

    async pruneRecallLedger(now = new Date()) {
        if (!this.db) return 0;
        try {
            const res = await this.db.collection('recall_ledger').deleteMany({ expiresAt: { $ne: null, $lt: now } });
            return res.deletedCount || 0;
        } catch (error) {
            logger.error(`Error pruning recall_ledger: ${error.message}`);
            return 0;
        }
    }

    async recordRecallComparison(doc) {
        if (!this.db) return;
        try {
            await this.db.collection('recall_comparisons').insertOne({ ...doc, ts: doc.ts || new Date() });
        } catch (error) {
            logger.error(`Error recording recall_comparison: ${error.message}`);
        }
    }
```

Then add indexes inside `connect()` after the existing `channel_messages` index:

```js
            this.db.collection('recall_ledger').createIndex(
              { memoryKey: 1 }, { unique: true }
            ).catch(err => logger.debug(`Index creation (recall_ledger): ${err.message}`));
            this.db.collection('recall_ledger').createIndex(
              { expiresAt: 1 }
            ).catch(err => logger.debug(`Index creation (recall_ledger.expiresAt): ${err.message}`));
            this.db.collection('recall_comparisons').createIndex(
              { ts: 1 }
            ).catch(err => logger.debug(`Index creation (recall_comparisons): ${err.message}`));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="MongoService.recall"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/MongoService.js __tests__/services/MongoService.recall.test.js
git commit -m "feat(recall): recall_ledger + recall_comparisons storage on MongoService"
```

---

### Task 11: RecallService orchestration

**Files:**
- Create: `services/RecallService.js`
- Test: `__tests__/services/RecallService.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/services/RecallService.test.js
jest.mock('../../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));
const RecallService = require('../../services/RecallService');

const baseConfig = {
  recall: {
    perSourceLimit: 10, maxItems: 8, tokenBudget: 1000,
    halfLifeDays: 14, accessBoostAlpha: 0.1,
    importanceSeed: 0.5, importanceSeedExplicit: 0.7, importanceNudge: 0.02, importanceMax: 1.0,
    queryStrategy: 'last-message', queryWindow: 3,
    sourceWeights: { 'mem0:explicit': 1.3, 'mem0:shared': 1.1, 'channel:facts': 1.0, 'mem0:personal': 1.0, 'channel:semantic': 0.8 },
  },
};

function makeService(overrides = {}) {
  return new RecallService({
    mem0Service: {
      isEnabled: () => true,
      searchMemories: jest.fn().mockResolvedValue({ results: [{ id: '1', memory: 'likes net-30', score: 0.8 }] }),
      searchSharedChannelMemories: jest.fn().mockResolvedValue({ results: [] }),
    },
    channelContextService: { isChannelTracked: () => false, getChannelFacts: jest.fn().mockResolvedValue([]) },
    mongoService: { getRecallLedger: jest.fn().mockResolvedValue({}), bumpRecallAccess: jest.fn().mockResolvedValue() },
    config: baseConfig,
    ...overrides,
  });
}

describe('RecallService.recall', () => {
  it('returns a Memory Context block from candidates', async () => {
    const svc = makeService();
    const out = await svc.recall({ recentMessages: ['tell me about acme'], scope: { userId: 'u', channelId: 'c', personalityId: 'p' } });
    expect(out.block).toContain('## Memory Context');
    expect(out.block).toContain('likes net-30');
    expect(out.candidates).toHaveLength(1);
  });

  it('drops candidates whose contentHash is excluded', async () => {
    const { contentHash } = require('../../services/recall/ranking');
    const svc = makeService();
    const out = await svc.recall({
      recentMessages: ['q'],
      scope: { userId: 'u', channelId: 'c', personalityId: 'p' },
      excludeHashes: [contentHash('likes net-30')],
    });
    expect(out.candidates).toHaveLength(0);
    expect(out.block).toBe('');
  });

  it('returns empty block when query is empty', async () => {
    const svc = makeService();
    const out = await svc.recall({ recentMessages: [], scope: {} });
    expect(out.block).toBe('');
  });

  it('still returns a block when the ledger read fails', async () => {
    const svc = makeService({ mongoService: { getRecallLedger: jest.fn().mockRejectedValue(new Error('mongo down')), bumpRecallAccess: jest.fn() } });
    const out = await svc.recall({ recentMessages: ['q'], scope: { userId: 'u' } });
    expect(out.block).toContain('likes net-30');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="RecallService"`
Expected: FAIL — `Cannot find module '.../RecallService'`

- [ ] **Step 3: Create the service**

```js
// services/RecallService.js
const logger = require('../logger');
const { dedupeCandidates, enrichWithLedger, rankAndBound, formatMemoryBlock } = require('./recall/ranking');
const { buildQuery } = require('./recall/queryBuilder');
const adapters = require('./recall/adapters');

class RecallService {
  /**
   * @param {Object} deps
   * @param {Object} deps.mem0Service
   * @param {Object} deps.channelContextService
   * @param {Object} deps.mongoService
   * @param {Object} deps.config - full config object (uses config.recall)
   * @param {Function} [deps.condenser] - optional async (text)=>query for llm-condense
   */
  constructor({ mem0Service, channelContextService, mongoService, config, condenser = null }) {
    this.mem0Service = mem0Service;
    this.channelContextService = channelContextService;
    this.mongoService = mongoService;
    this.config = config.recall;
    this.condenser = condenser;
  }

  async recall({ recentMessages, scope = {}, excludeHashes = [] }) {
    const cfg = this.config;

    const query = await buildQuery(recentMessages, {
      strategy: cfg.queryStrategy,
      windowSize: cfg.queryWindow,
      condenser: cfg.queryStrategy === 'llm-condense' ? this.condenser : undefined,
    });
    if (!query) return { block: '', candidates: [], query: '' };

    const limit = cfg.perSourceLimit;
    const { userId, channelId, personalityId } = scope;

    const results = await Promise.all([
      adapters.mem0PersonalAdapter(this.mem0Service, { query, userId, personalityId, limit }),
      adapters.mem0ExplicitAdapter(this.mem0Service, { query, userId, limit }),
      adapters.mem0SharedAdapter(this.mem0Service, { query, channelId, limit }),
      adapters.channelSemanticAdapter(this.channelContextService, { query, channelId, limit }),
      adapters.channelFactsAdapter(this.channelContextService, { channelId }),
    ]);

    const exclude = new Set(excludeHashes);
    let candidates = results.flat().filter((c) => !exclude.has(c.contentHash));
    candidates = dedupeCandidates(candidates);
    if (candidates.length === 0) return { block: '', candidates: [], query };

    let ledgerByKey = {};
    try {
      ledgerByKey = await this.mongoService.getRecallLedger(candidates.map((c) => c.key));
    } catch (e) {
      logger.debug(`recall ledger read failed: ${e.message}`);
    }

    const enriched = enrichWithLedger(candidates, ledgerByKey, {
      importanceSeed: cfg.importanceSeed,
      importanceSeedExplicit: cfg.importanceSeedExplicit,
    });

    const selected = rankAndBound(enriched, {
      maxItems: cfg.maxItems,
      tokenBudget: cfg.tokenBudget,
      sourceWeights: cfg.sourceWeights,
      halfLifeDays: cfg.halfLifeDays,
      accessBoostAlpha: cfg.accessBoostAlpha,
    });

    const block = formatMemoryBlock(selected);

    // fire-and-forget: never block or fail the turn on ledger writes
    this._bumpLedger(selected, scope).catch((e) => logger.debug(`recall ledger bump failed: ${e.message}`));

    return { block, candidates: selected, query };
  }

  async _bumpLedger(selected, scope) {
    if (!selected.length) return;
    const entries = selected.map((c) => ({
      memoryKey: c.key,
      scope,
      source: c.source,
      contentHash: c.contentHash,
      importanceSeed: c.source === 'mem0:explicit' ? this.config.importanceSeedExplicit : this.config.importanceSeed,
    }));
    await this.mongoService.bumpRecallAccess(entries, {
      nudge: this.config.importanceNudge,
      importanceMax: this.config.importanceMax,
    });
  }
}

module.exports = RecallService;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="RecallService"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/RecallService.js __tests__/services/RecallService.test.js
git commit -m "feat(recall): RecallService orchestrator (fan-out, exclude, dedupe, rank, bump)"
```

---

### Task 12: RecallService — ledger bump is best-effort & non-blocking

**Files:**
- Test only: `__tests__/services/RecallService.test.js`

- [ ] **Step 1: Add the failing test**

```js
describe('RecallService ledger bump', () => {
  it('does not reject the turn when bumpRecallAccess throws', async () => {
    const bump = jest.fn().mockRejectedValue(new Error('write fail'));
    const svc = makeService({ mongoService: { getRecallLedger: jest.fn().mockResolvedValue({}), bumpRecallAccess: bump } });
    const out = await svc.recall({ recentMessages: ['q'], scope: { userId: 'u' } });
    expect(out.block).toContain('likes net-30'); // turn succeeds
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget settle
    expect(bump).toHaveBeenCalled();
  });

  it('bumps the ledger for injected candidates with correct seed', async () => {
    const bump = jest.fn().mockResolvedValue();
    const svc = makeService({ mongoService: { getRecallLedger: jest.fn().mockResolvedValue({}), bumpRecallAccess: bump } });
    await svc.recall({ recentMessages: ['q'], scope: { userId: 'u', channelId: 'c' } });
    await new Promise((r) => setImmediate(r));
    const entries = bump.mock.calls[0][0];
    expect(entries[0]).toMatchObject({ memoryKey: 'mem0:personal:1', source: 'mem0:personal', importanceSeed: 0.5 });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="RecallService"`
Expected: PASS (behavior implemented in Task 11; this locks the non-blocking contract).

- [ ] **Step 3: Commit**

```bash
git add __tests__/services/RecallService.test.js
git commit -m "test(recall): ledger bump is non-blocking and seeds correctly"
```

---

### Task 13: ChannelContextService — buildRecentContext

**Files:**
- Modify: `services/ChannelContextService.js` (add method near `buildHybridContext`, ~line 838)
- Test: `__tests__/services/ChannelContextService.recent.test.js`

**Why:** In v2, the ranked recall owns semantic hits + channel facts, so channel context must contribute *only* the participant list + recent buffer (the verbatim recency block that stays separate).

- [ ] **Step 1: Write the failing test**

```js
// __tests__/services/ChannelContextService.recent.test.js
jest.mock('@qdrant/js-client-rest', () => ({ QdrantClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));
const ChannelContextService = require('../../services/ChannelContextService');

describe('buildRecentContext', () => {
  let svc;
  beforeEach(() => {
    svc = Object.create(ChannelContextService.prototype);
    svc.getRecentContext = jest.fn(() => [
      { authorName: 'anna', content: 'morning' },
      { authorName: 'bob', content: 'deploy time?' },
    ]);
    svc.getActiveParticipants = jest.fn(() => ['anna', 'bob']);
  });

  it('includes participants and recent messages, not semantic/facts', async () => {
    const out = await svc.buildRecentContext('c1');
    expect(out).toContain('anna');
    expect(out).toContain('deploy time?');
  });

  it('returns empty string when there is no recent activity', async () => {
    svc.getRecentContext = jest.fn(() => []);
    svc.getActiveParticipants = jest.fn(() => []);
    expect(await svc.buildRecentContext('c1')).toBe('');
  });
});
```

> Note: confirm the exact participant accessor name while implementing — `getActiveParticipants` is used here; if the service exposes participants differently (e.g. a `participants` map), adapt the implementation and test together to the real accessor. The behavior (participants + recent buffer only) is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="ChannelContextService.recent"`
Expected: FAIL — `svc.buildRecentContext is not a function`

- [ ] **Step 3: Implement `buildRecentContext`**

```js
  /**
   * Build ONLY the participant list + recent in-memory buffer for a channel
   * (no semantic hits, no channel facts). Used by the v2 recall path, which
   * sources semantic/fact recall through RecallService instead.
   * @param {string} channelId
   * @returns {Promise<string>} formatted block, or '' when there is nothing
   */
  async buildRecentContext(channelId) {
    const recent = (this.getRecentContext && this.getRecentContext(channelId)) || [];
    const participants = (this.getActiveParticipants && this.getActiveParticipants(channelId)) || [];
    if (recent.length === 0 && participants.length === 0) return '';

    const parts = [];
    if (participants.length > 0) {
      parts.push(`Active in this channel recently: ${participants.join(', ')}.`);
    }
    if (recent.length > 0) {
      const lines = recent.map((m) => `[${m.authorName || m.author || 'user'}]: ${m.content}`).join('\n');
      parts.push(`Recent conversation:\n${lines}`);
    }
    return `\n\n${parts.join('\n\n')}`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="ChannelContextService.recent"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/ChannelContextService.js __tests__/services/ChannelContextService.recent.test.js
git commit -m "feat(recall): buildRecentContext (participants + buffer only) for v2 path"
```

---

### Task 14: ChatService — v2 recall path behind the flag

**Files:**
- Modify: `services/ChatService.js` (constructor; the `Promise.all` block ~line 496-503; add `_getRecallContext` helper)
- Test: `__tests__/services/ChatService.recall.test.js`

**Constructor note:** ensure `ChatService` stores `this.config` and a `this.recallService`. If the constructor does not already accept them, add them to its options object (matching how other deps like `mongoService` are injected) and to the `this.x = x` assignments.

- [ ] **Step 1: Write the failing test**

```js
// __tests__/services/ChatService.recall.test.js
jest.mock('../../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));
const ChatService = require('../../services/ChatService');

function makeChat(recallEnabled) {
  const svc = Object.create(ChatService.prototype);
  svc.config = { recall: { enabled: recallEnabled, shadowEnabled: false } };
  svc.recallService = { recall: jest.fn().mockResolvedValue({ block: '\n\n## Memory Context\n[fact] x', candidates: [{}], query: 'q' }) };
  svc.channelContextService = {
    isChannelTracked: () => true,
    getRecentContext: jest.fn(() => [{ authorName: 'anna', content: 'hi' }]),
    buildRecentContext: jest.fn().mockResolvedValue('\n\nRecent conversation:\n[anna]: hi'),
    buildHybridContext: jest.fn().mockResolvedValue('LEGACY-CHANNEL'),
  };
  svc._getRelevantMemories = jest.fn().mockResolvedValue({ context: 'LEGACY-MEM', sharedContext: 'LEGACY-SHARED' });
  return svc;
}

describe('ChatService._getRecallContext', () => {
  it('uses RecallService and buildRecentContext when flag is on', async () => {
    const svc = makeChat(true);
    const out = await svc._getRecallContext('chan', 'hello', { id: 'u' }, 'p');
    expect(svc.recallService.recall).toHaveBeenCalled();
    expect(out.memoryContext).toContain('## Memory Context');
    expect(out.channelContext).toContain('Recent conversation');
    expect(out.sharedContext).toBe('');
  });

  it('passes recent-buffer hashes as excludeHashes', async () => {
    const { contentHash } = require('../../services/recall/ranking');
    const svc = makeChat(true);
    await svc._getRecallContext('chan', 'hello', { id: 'u' }, 'p');
    const arg = svc.recallService.recall.mock.calls[0][0];
    expect(arg.excludeHashes).toContain(contentHash('hi'));
    expect(arg.recentMessages[arg.recentMessages.length - 1]).toBe('hello');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="ChatService.recall"`
Expected: FAIL — `svc._getRecallContext is not a function`

- [ ] **Step 3: Add the helper and wire the flag**

Add the helper method to `ChatService`:

```js
  /**
   * v2 recall path: returns the prompt context strings sourced from RecallService
   * (memory block) + the separate recent-buffer block. Shared block folds into recall.
   * @returns {Promise<{memoryContext:string, sharedContext:string, channelContext:string}>}
   * @private
   */
  async _getRecallContext(channelId, userMessage, user, personalityId) {
    const { contentHash } = require('./recall/ranking');

    const recentBuffer = (this.channelContextService?.getRecentContext)
      ? (this.channelContextService.getRecentContext(channelId) || [])
      : [];
    const recentMessages = recentBuffer.map((m) => m.content).filter(Boolean);
    recentMessages.push(userMessage);
    const excludeHashes = recentBuffer.map((m) => contentHash(m.content || '')).filter(Boolean);

    const [recall, recentContext] = await Promise.all([
      this.recallService.recall({
        recentMessages,
        scope: { userId: user.id, channelId, personalityId },
        excludeHashes,
      }),
      this.channelContextService?.buildRecentContext
        ? this.channelContextService.buildRecentContext(channelId)
        : Promise.resolve(''),
    ]);

    return { memoryContext: recall.block || '', sharedContext: '', channelContext: recentContext || '', recallDebug: recall };
  }
```

Then change the orchestration block (currently ~line 496-503) to branch on the flag:

```js
      let memoryContext, sharedContext, channelContext, voiceContext;
      const useRecallV2 = this.config?.recall?.enabled;

      if (useRecallV2) {
        const [recall, vc] = await Promise.all([
          this._getRecallContext(channelId, userMessage, user, personalityId),
          personality.useVoiceProfile ? this._getVoiceContext(channelId, userMessage) : Promise.resolve(null),
        ]);
        ({ memoryContext, sharedContext, channelContext } = recall);
        voiceContext = vc;
      } else {
        const [{ context, sharedContext: shared }, legacyChannel, vc] = await Promise.all([
          this._getRelevantMemories(userMessage, user.id, personalityId, channelId),
          this._getChannelContext(channelId, userMessage),
          personality.useVoiceProfile ? this._getVoiceContext(channelId, userMessage) : Promise.resolve(null),
        ]);
        memoryContext = context; sharedContext = shared; channelContext = legacyChannel; voiceContext = vc;
      }
```

(The subsequent `_buildGroupSystemPrompt(personality, memoryContext, channelContext, sharedContext, voiceContext)` call stays exactly as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="ChatService.recall"`
Expected: PASS

- [ ] **Step 5: Run the full ChatService suite to confirm the legacy path is unchanged**

Run: `npm test -- --testPathPatterns="ChatService"`
Expected: PASS (existing tests still green — default flag is off).

- [ ] **Step 6: Commit**

```bash
git add services/ChatService.js __tests__/services/ChatService.recall.test.js
git commit -m "feat(recall): ChatService v2 recall path behind RECALL_V2_ENABLED"
```

---

### Task 15: ChatService — A/B shadow logging

**Files:**
- Modify: `services/ChatService.js` (extend the orchestration branch; add `_logRecallShadow`)
- Test: `__tests__/services/ChatService.recall.test.js`

- [ ] **Step 1: Add the failing test**

```js
describe('ChatService shadow logging', () => {
  function makeShadowChat(inject) {
    const svc = Object.create(ChatService.prototype);
    svc.config = { recall: { enabled: inject === 'new', shadowEnabled: true, shadowInject: inject } };
    svc.mongoService = { recordRecallComparison: jest.fn().mockResolvedValue() };
    svc.recallService = { recall: jest.fn().mockResolvedValue({ block: '\n\n## Memory Context\n[fact] NEW', candidates: [{ key: 'k' }], query: 'q' }) };
    svc.channelContextService = {
      isChannelTracked: () => true,
      getRecentContext: jest.fn(() => []),
      buildRecentContext: jest.fn().mockResolvedValue('RECENT'),
      buildHybridContext: jest.fn().mockResolvedValue('LEGACY-CHANNEL'),
    };
    svc._getRelevantMemories = jest.fn().mockResolvedValue({ context: 'LEGACY-MEM', sharedContext: '' });
    svc._getChannelContext = jest.fn().mockResolvedValue('LEGACY-CHANNEL');
    return svc;
  }

  it('logs both old and new and injects per shadowInject=old', async () => {
    const svc = makeShadowChat('old');
    const out = await svc._composeRecallContexts('chan', 'hi', { id: 'u' }, 'p', { useVoiceProfile: false });
    expect(svc.mongoService.recordRecallComparison).toHaveBeenCalled();
    expect(out.memoryContext).toBe('LEGACY-MEM'); // injected old
    await new Promise((r) => setImmediate(r));
    const logged = svc.mongoService.recordRecallComparison.mock.calls[0][0];
    expect(logged.newBlock).toContain('NEW');
  });

  it('injects new when shadowInject=new', async () => {
    const svc = makeShadowChat('new');
    const out = await svc._composeRecallContexts('chan', 'hi', { id: 'u' }, 'p', { useVoiceProfile: false });
    expect(out.memoryContext).toContain('NEW');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="ChatService.recall"`
Expected: FAIL — `svc._composeRecallContexts is not a function`

- [ ] **Step 3: Refactor the branch into `_composeRecallContexts` with shadow support**

Replace the inline branch from Task 14 with a single call:

```js
      const { memoryContext, sharedContext, channelContext, voiceContext } =
        await this._composeRecallContexts(channelId, userMessage, user, personalityId, personality);
```

And add the method:

```js
  /**
   * Decide which recall path feeds the prompt and (optionally) shadow-log the other.
   * @private
   */
  async _composeRecallContexts(channelId, userMessage, user, personalityId, personality) {
    const recallCfg = this.config?.recall || {};
    const voiceP = personality.useVoiceProfile
      ? this._getVoiceContext(channelId, userMessage)
      : Promise.resolve(null);

    const wantNew = recallCfg.enabled || recallCfg.shadowEnabled;
    const wantOld = !recallCfg.enabled || recallCfg.shadowEnabled;

    const [newCtx, oldCtx, voiceContext] = await Promise.all([
      wantNew ? this._getRecallContext(channelId, userMessage, user, personalityId) : Promise.resolve(null),
      wantOld ? this._getLegacyContext(channelId, userMessage, user, personalityId) : Promise.resolve(null),
      voiceP,
    ]);

    if (recallCfg.shadowEnabled && newCtx && oldCtx) {
      this._logRecallShadow(channelId, userMessage, user, personalityId, oldCtx, newCtx)
        .catch((e) => logger.debug(`recall shadow log failed: ${e.message}`));
    }

    const injectNew = recallCfg.enabled || recallCfg.shadowInject === 'new';
    const chosen = injectNew ? newCtx : oldCtx;
    return { ...chosen, voiceContext };
  }

  /**
   * Legacy recall path (today's behavior), extracted so shadow mode can run it
   * alongside the v2 path.
   * @private
   */
  async _getLegacyContext(channelId, userMessage, user, personalityId) {
    const [{ context, sharedContext }, channelContext] = await Promise.all([
      this._getRelevantMemories(userMessage, user.id, personalityId, channelId),
      this._getChannelContext(channelId, userMessage),
    ]);
    return { memoryContext: context, sharedContext, channelContext };
  }

  /**
   * @private
   */
  async _logRecallShadow(channelId, userMessage, user, personalityId, oldCtx, newCtx) {
    if (!this.mongoService?.recordRecallComparison) return;
    await this.mongoService.recordRecallComparison({
      query: userMessage,
      derivedQuery: newCtx.recallDebug?.query || null,
      scope: { userId: user.id, channelId, personalityId },
      oldBlock: `${oldCtx.memoryContext || ''}${oldCtx.sharedContext || ''}`,
      newBlock: newCtx.memoryContext || '',
      newKeys: (newCtx.recallDebug?.candidates || []).map((c) => c.key),
      strategy: this.config?.recall?.queryStrategy || null,
      ts: new Date(),
    });
  }
```

> Remove the inline flag-branch from Task 14 (the `let memoryContext, ...; if (useRecallV2) {...}` block) and the standalone `voiceContext` Promise — `_composeRecallContexts` now owns all of it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --testPathPatterns="ChatService"`
Expected: PASS (recall, shadow, and existing ChatService tests all green).

- [ ] **Step 5: Commit**

```bash
git add services/ChatService.js __tests__/services/ChatService.recall.test.js
git commit -m "feat(recall): A/B shadow logging of old vs new recall blocks"
```

---

### Task 16: bot.js — construct and inject RecallService

**Files:**
- Modify: `bot.js` (near where `ChatService` and `MongoService`/`ChannelContextService` are constructed)

- [ ] **Step 1: Locate the wiring**

Run: `grep -n "new ChatService\|new ChannelContextService\|require('./config" bot.js`
Expected: shows where services are instantiated and where `config` is required.

- [ ] **Step 2: Add the require near the other service requires**

```js
const RecallService = require('./services/RecallService');
```

- [ ] **Step 3: Construct RecallService after its dependencies exist**

Place this *after* `mem0Service`, `channelContextService`, and `mongoService` are constructed, and *before* `ChatService`:

```js
const recallService = new RecallService({
  mem0Service,
  channelContextService,
  mongoService,
  config,
  condenser: null, // llm-condense disabled by default; inject an async (text)=>query to enable
});
```

- [ ] **Step 4: Pass it (and config) into ChatService**

Add `recallService` and `config` to the `ChatService` constructor options object (alongside the existing injected services), e.g.:

```js
const chatService = new ChatService({
  // ...existing deps (mongoService, mem0Service, channelContextService, voiceProfileService, qdrantService, ...)
  recallService,
  config,
});
```

Confirm `ChatService`'s constructor assigns `this.recallService = recallService;` and `this.config = config;` (added in Task 14). If ChatService uses positional args instead of an options object, append `recallService` and `config` consistently with the existing signature and update the constructor body to match.

- [ ] **Step 5: Smoke-test boot wiring**

Run: `node -e "require('./services/RecallService'); console.log('RecallService loads')"`
Expected: prints `RecallService loads` with no throw.

- [ ] **Step 6: Commit**

```bash
git add bot.js
git commit -m "feat(recall): wire RecallService into bot.js and ChatService"
```

---

### Task 17: Offline eval harness

**Files:**
- Create: `services/recall/evalMetrics.js`
- Create: `scripts/eval-recall.js`
- Create: `eval/recall/sample.json`
- Test: `__tests__/services/recall/evalMetrics.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/services/recall/evalMetrics.test.js
const { precisionAtN, ndcgAtN } = require('../../../services/recall/evalMetrics');

describe('evalMetrics', () => {
  it('precisionAtN counts expected keys in the top N', () => {
    expect(precisionAtN(['a', 'b', 'c'], new Set(['b', 'c']), 3)).toBeCloseTo(2 / 3);
    expect(precisionAtN(['a', 'b'], new Set(['x']), 2)).toBe(0);
  });

  it('ndcgAtN rewards expected keys ranked higher', () => {
    const expected = new Set(['a']);
    const top = ndcgAtN(['a', 'b', 'c'], expected, 3);
    const bottom = ndcgAtN(['b', 'c', 'a'], expected, 3);
    expect(top).toBeGreaterThan(bottom);
    expect(top).toBeCloseTo(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="recall/evalMetrics"`
Expected: FAIL — `Cannot find module '.../evalMetrics'`

- [ ] **Step 3: Create `evalMetrics.js`**

```js
// services/recall/evalMetrics.js
function precisionAtN(rankedKeys, expectedSet, n) {
  const top = rankedKeys.slice(0, n);
  if (top.length === 0) return 0;
  const hits = top.filter((k) => expectedSet.has(k)).length;
  return hits / top.length;
}

function ndcgAtN(rankedKeys, expectedSet, n) {
  const top = rankedKeys.slice(0, n);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    if (expectedSet.has(top[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(expectedSet.size, n);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

module.exports = { precisionAtN, ndcgAtN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="recall/evalMetrics"`
Expected: PASS

- [ ] **Step 5: Create the fixture**

```json
// eval/recall/sample.json
[
  {
    "name": "acme payment terms",
    "expectedKeys": ["mem0:explicit:1", "channel:facts:9"],
    "candidates": [
      { "key": "mem0:explicit:1", "source": "mem0:explicit", "type": "fact", "text": "Acme is on net-30 terms", "similarity": 0.82, "timestamp": null, "contentHash": "h1", "provenance": { "tag": "explicit" }, "importance": 0.7, "accessCount": 3, "lastAccessedAtUtc": "2026-05-20T00:00:00Z" },
      { "key": "channel:facts:9", "source": "channel:facts", "type": "channel-fact", "text": "vendor handbook: orders over 50k default net-30", "similarity": 0.66, "timestamp": null, "contentHash": "h2", "provenance": { "tag": "channel" }, "importance": 0.5, "accessCount": 0, "lastAccessedAtUtc": null },
      { "key": "channel:semantic:h3", "source": "channel:semantic", "type": "message", "text": "lunch tomorrow?", "similarity": 0.41, "timestamp": "2026-01-02T00:00:00Z", "contentHash": "h3", "provenance": { "tag": "history" }, "importance": 0.5, "accessCount": 0, "lastAccessedAtUtc": null }
    ]
  }
]
```

- [ ] **Step 6: Create the harness script**

```js
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
```

- [ ] **Step 7: Run the harness to verify it produces a table**

Run: `node scripts/eval-recall.js`
Expected: three lines printed, each with `precision@5=…  ndcg@5=…` values between 0 and 1.

- [ ] **Step 8: Commit**

```bash
git add services/recall/evalMetrics.js scripts/eval-recall.js eval/recall/sample.json __tests__/services/recall/evalMetrics.test.js
git commit -m "feat(recall): offline eval harness (precision@N, nDCG@N) with config sweep"
```

---

### Task 18: Documentation & env vars

**Files:**
- Modify: `features.md` (add a "Centralized Ranked Recall" entry under Conversation Memory / AI Memory)
- Modify: `README.md` (add a Recall config env-var table)
- Modify: `CLAUDE.md` (add a short "Recall (v2)" note: flags, ledger collection, shadow logging, eval script)

- [ ] **Step 1: Update `features.md`**

Add under the memory section:

```markdown
### Centralized Ranked Recall (v2)
- **One recall step**: `RecallService` queries all content sources (Mem0 personal/explicit/shared, channel semantic hits, channel facts), dedupes across them, ranks by recency + importance with a 14-day decay half-life and access-count boosting, bounds to a token/item budget, and emits a single provenance-tagged `## Memory Context` block.
- **Recall ledger**: MongoDB `recall_ledger` tracks per-memory importance, access count, and last-access (the signals Mem0 doesn't expose), lazily populated and pruned by expiry.
- **Recent buffer + voice few-shot stay separate**: verbatim recency and style grounding are not run through the ranker; a cross-block exclusion-set prevents the buffer and semantic hits from double-injecting.
- **Validation**: offline eval harness (`scripts/eval-recall.js`) over `eval/recall/*.json`, plus `recall_comparisons` A/B shadow logging.
- **Flags**: `RECALL_V2_ENABLED` (default off), `RECALL_SHADOW_ENABLED`, `RECALL_SHADOW_INJECT`.
```

- [ ] **Step 2: Update `README.md`**

Add a config table:

```markdown
### Recall (v2 ranked recall) Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RECALL_V2_ENABLED` | `false` | Route chat recall through the centralized ranked RecallService |
| `RECALL_SHADOW_ENABLED` | `false` | Compute old + new recall per turn and log both to `recall_comparisons` |
| `RECALL_SHADOW_INJECT` | `old` | Which path feeds the prompt during shadow mode (`old`/`new`) |
| `RECALL_MAX_ITEMS` | `8` | Max memories in the Memory Context block |
| `RECALL_TOKEN_BUDGET` | `600` | Token ceiling for the Memory Context block |
| `RECALL_PER_SOURCE_LIMIT` | `10` | Over-retrieval cap per source before ranking |
| `RECALL_HALF_LIFE_DAYS` | `14` | Recency decay half-life |
| `RECALL_ACCESS_BOOST_ALPHA` | `0.1` | Access-count boost coefficient |
| `RECALL_IMPORTANCE_SEED` | `0.5` | Seed importance for first-sight memories |
| `RECALL_IMPORTANCE_SEED_EXPLICIT` | `0.7` | Seed importance for explicit (user-authored) memories |
| `RECALL_IMPORTANCE_NUDGE` | `0.02` | Importance increment per access (capped) |
| `RECALL_IMPORTANCE_MAX` | `1.0` | Importance ceiling |
| `RECALL_QUERY_STRATEGY` | `recent-window` | `last-message` / `recent-window` / `llm-condense` |
| `RECALL_QUERY_WINDOW` | `3` | Messages used to build the recall query |
| `RECALL_W_*` | see config | Per-source ranking weights |
```

- [ ] **Step 3: Update `CLAUDE.md`**

Add a short section:

```markdown
## Recall (v2 centralized ranked recall)

`RecallService` (`services/RecallService.js`) replaces the scattered Mem0 + channel-context recall when `RECALL_V2_ENABLED=true`. It over-retrieves from all sources, dedupes, ranks by recency+importance (Mongo `recall_ledger` holds importance/access/last-access), and injects one `## Memory Context` block. Pure logic in `services/recall/` (ranking, queryBuilder, adapters, evalMetrics).

- **Validate before flipping on**: run `node scripts/eval-recall.js` (offline ranker eval) and enable `RECALL_SHADOW_ENABLED=true` to log old-vs-new to `recall_comparisons`.
- Recent buffer + voice few-shot are intentionally NOT ranked (separate blocks).
- Spec: `docs/superpowers/specs/2026-05-30-centralized-ranked-recall-design.md`.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add features.md README.md CLAUDE.md
git commit -m "docs(recall): document v2 ranked recall, env vars, and validation"
```

---

## Self-Review

**Spec coverage** (each spec §, with the task that implements it):
- §2 architecture / §3.1 adapters → Task 9; §3.2 candidate model → shared shapes + Task 9; §3.3 QueryBuilder → Tasks 7–8; §3.4 ledger → Task 10.
- §4 dedup + exclusion → Task 3 (dedup) + Task 11 (exclusion) + Task 14 (buffer hashes passed in).
- §5 ranking + ledger update → Tasks 4, 5, 6 (score/enrich/bound) + Task 10 (`bumpRecallAccess`) + Task 12 (non-blocking).
- §6 unified block + prompt-size guard → Task 6 (block) + **see note below on the guard**.
- §7 integration + flags + rollout → Tasks 14, 15, 16.
- §8 eval + shadow → Task 17 (eval) + Tasks 10/15 (shadow logging).
- §9 error handling → Tasks 9/11/12 (isolated adapters, best-effort ledger), Task 14/15 (flag fail-safe via try/catch already in helpers).
- §10 testing → every task is TDD.

**Gap found & resolved:** The spec §6 prompt-size guard (one overall assembled-prompt check that trims the memory block first) is *not* yet its own task — Task 6 bounds the memory block in isolation but does not add the cross-block guard in `ChatService`. **Add Task 14b below.**

**Placeholder scan:** No TBD/TODO; the two "confirm the accessor/constructor shape while implementing" notes (Tasks 13, 16) are explicit verification steps with concrete fallbacks, not placeholders.

**Type consistency:** `Candidate` keys (`key`, `source`, `contentHash`, `similarity`, `importance`, `accessCount`, `lastAccessedAtUtc`, `provenance{tag,when,who}`) are consistent across ranking, adapters, RecallService, and the eval fixture. Method names (`getRecallLedger`, `bumpRecallAccess`, `recordRecallComparison`, `buildRecentContext`, `recall`, `_composeRecallContexts`, `_getRecallContext`, `_getLegacyContext`) are used identically across tasks.

---

### Task 14b: Prompt-size guard (cross-block)

**Files:**
- Modify: `services/ChatService.js` (in `_buildGroupSystemPrompt`, after assembling the final string)
- Test: `__tests__/services/ChatService.recall.test.js`

- [ ] **Step 1: Add the failing test**

```js
describe('ChatService prompt-size guard', () => {
  it('trims the memory block first when the assembled prompt is too large', () => {
    const svc = Object.create(ChatService.prototype);
    svc.config = { recall: { promptMaxTokens: 50 } };
    const personality = { systemPrompt: 'BASE', useVoiceProfile: false };
    const bigMemory = '\n\n## Memory Context\n' + Array.from({ length: 200 }, (_, i) => `[fact] item ${i}`).join('\n');
    const out = svc._buildGroupSystemPrompt(personality, bigMemory, '\n\nRecent conversation:\n[anna]: hi', '', null);
    expect(out).toContain('Recent conversation'); // recency preserved
    expect(out.length).toBeLessThan(('BASE' + bigMemory).length); // memory trimmed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="ChatService.recall"`
Expected: FAIL — prompt is not trimmed.

- [ ] **Step 3: Add the guard in `_buildGroupSystemPrompt`**

Add a config default in Task 1's block: `promptMaxTokens: parseInt(process.env.RECALL_PROMPT_MAX_TOKENS || '4000', 10),`. Then, before the final `return` in `_buildGroupSystemPrompt`, compute the assembled string into a variable `assembled` and guard it:

```js
    const assembled = `${systemPrompt}

You are in a group conversation with multiple users in a Discord channel.
Their names appear before their messages like "[Username]: message".
Address users by name when relevant. Do not announce when new users join the conversation.${memoryContext}${sharedContext}${channelContext}${fewShotBlock}`;

    const max = this.config?.recall?.promptMaxTokens;
    if (max && countTokens(assembled) > max && memoryContext) {
      // Trim the memory block (most compressible) line-by-line until under budget.
      const header = '\n\n## Memory Context\n';
      if (memoryContext.startsWith(header)) {
        let lines = memoryContext.slice(header.length).split('\n');
        let trimmed = memoryContext;
        while (lines.length > 0 && countTokens(
          assembled.replace(memoryContext, trimmed)
        ) > max) {
          lines = lines.slice(0, -1);
          trimmed = lines.length ? header + lines.join('\n') : '';
        }
        return assembled.replace(memoryContext, trimmed);
      }
    }
    return assembled;
```

(`countTokens` is already imported in `ChatService.js`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="ChatService"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/ChatService.js config/config.js __tests__/services/ChatService.recall.test.js
git commit -m "feat(recall): cross-block prompt-size guard trims memory block first"
```

---

## Execution order & notes

- Tasks 2–9 are pure/leaf modules with no cross-dependencies beyond `ranking.js`; they can be implemented in order with fast unit feedback.
- Task 10 (Mongo) and Task 13 (ChannelContext) are independent of the pure modules.
- Task 11 depends on 2–9 + 10. Tasks 14/14b/15 depend on 11 + 13. Task 16 depends on 11. Task 17 depends on 6.
- Keep `RECALL_V2_ENABLED=false` through the whole build; the legacy path stays the live default until eval + shadow review justify flipping it.
