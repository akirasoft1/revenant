# Centralized Ranked Recall — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorming) — pending implementation plan
**Spec:** #1 of a two-part memory-architecture effort. Spec #2 (Article Knowledge Base) follows and plugs into this one as a new source adapter.

---

## 1. Background & Goal

Today the bot's recall is **distributed and additive**. `ChatService` fires three parallel Mem0 searches plus a three-tier channel-context fetch, then concatenates the outputs as four-plus independent prompt blocks (`memoryContext`, `sharedContext`, the channel-context semantic/facts portions, and the few-shot block). There is:

- no ranking, recency weighting, or importance scoring anywhere — Mem0 returns by raw similarity;
- no dedup across sources — the same fact can appear as a Mem0 fact, a channel fact, *and* a semantic message hit;
- no provenance on memories;
- very tight per-source caps (3 + 3 + 2 → 5 personal; 5 channel semantic), so there is nothing to rank down from.

**Goal:** make recall *sharper and fresher* by centralizing it into one `recall()` step that over-retrieves from all content sources, dedupes across them, ranks by recency/importance with decay + access-count, bounds the result, and emits a single provenance-tagged `## Memory Context` block. Validated with an offline eval set **and** A/B shadow logging, shipped behind a feature flag.

This is the **recall-quality overhaul**. The article knowledge base (the "new capability") is a separate spec that becomes one more source adapter behind this service.

### In scope

- `RecallService` orchestrator + per-source adapters
- Recall ledger (new Mongo state: importance, access-count, last-access, provenance, content-hash)
- Recency/importance ranking with temporal decay + access boosting
- Cross-source dedup + **cross-block exclusion** (vs. the recent buffer)
- Richer recall-query derivation from the recent message window
- Single bounded, provenance-tagged `## Memory Context` block
- Offline eval harness + A/B shadow logging
- Feature flags + dark-launch rollout

### Out of scope (deliberate)

- **Robustness/keyword fallback** when the vector store is down — confirmed out; noted as a known gap.
- Episodes and typed graph (future sources behind the same service).
- Leaving Mem0 / owning the memory store (future evaluation — see §12).

### Decisions locked during brainstorming

- **Approach A** — orchestrator over existing sources + a Mongo recall ledger. Mem0/Qdrant unchanged for storage and extraction. (Rejected: pushing state into Qdrant payloads — fragments state across collections; owning the store — too big for a quality pass.)
- **Recent buffer + voice few-shot stay separate and unranked** — they optimize for different objectives (verbatim continuity; style mimicry) than relevance-weighted recall, and separate labeled blocks tell the model how to use each region.
- **Project risk posture:** this is a hobby project among friends; bias toward perceptible quality gains over minimal blast radius (still behind flags + tests).

---

## 2. Architecture

```
ChatService.generateReply()
        │  recall({ queryContext, scope, excludeKeys })
        ▼
┌──────────────────────────  RecallService  ──────────────────────────┐
│  0. QueryBuilder: derive search query from the recent-message window │
│  1. fan-out to source adapters (over-retrieve ~8–10 each)            │
│  2. normalize → Candidate[]                                          │
│  3. drop candidates whose key/hash ∈ excludeKeys (recent buffer)     │
│  4. dedup by contentHash (merge provenance, keep best similarity)    │
│  5. enrich from ledger (importance, accessCount, lastAccessedAtUtc)  │
│  6. score → sort → bound (top-N + token cap)                         │
│  7. format → "## Memory Context" block                               │
│  8. async, best-effort: bump ledger for injected candidates          │
└──────────────────────────────────────────────────────────────────────┘
   sources:  Mem0 personal · Mem0 explicit · Mem0 shared
             · channel semantic hits · channel facts
   state:    Mongo  recall_ledger  (new)

UNCHANGED, assembled separately by ChatService:
   • recent-conversation buffer (Tier-1)  → verbatim recency block
   • voice profile + IRC few-shot          → style block
```

`RecallService` is the only unit that knows about ranking, dedup, and budgeting. Each source adapter is the only unit that knows a source's quirks. Adding a new source later (article KB) = writing one adapter; nothing else changes.

---

## 3. Components

### 3.1 Source adapters

Each adapter wraps an existing service call and returns normalized `Candidate`s. Adapters over-retrieve (wider top-K than today) so the ranker has something to work with.

| Adapter | Backed by | Native fields | Notes |
|---|---|---|---|
| `mem0:personal` | `Mem0Service.searchMemories(q, userId, {personalityId})` | `id`, `memory`, `score` | personality-scoped facts |
| `mem0:explicit` | `Mem0Service.searchMemories(q, userId, {personalityId:'explicit_memory'})` | `id`, `memory`, `score` | user-authored facts; higher importance seed |
| `mem0:shared` | `Mem0Service.searchSharedChannelMemories(q, channelId)` | `id`, `memory`, `score` | channel-wide facts |
| `channel:semantic` | `ChannelContextService.searchRelevantHistory(q, channelId)` | `authorName`, `content`, `timestamp`, `score` | past channel messages; has real timestamps |
| `channel:facts` | `ChannelContextService.getChannelFacts(channelId)` | `id`, `memory` | Mem0 channel-context facts |

### 3.2 Candidate model

```js
Candidate {
  key,         // stable identity: `${source}:${id}`, or `hash:${contentHash}` when no id
  source,      // mem0:personal | mem0:explicit | mem0:shared | channel:semantic | channel:facts
  type,        // fact | preference | message | channel-fact
  text,        // content injected into the prompt
  similarity,  // source score normalized to 0..1 (see §5.1)
  timestamp,   // ISO string when the source provides one (channel:semantic); else null
  provenance,  // { tag, when?, who? } → renders the [..] prefix in the block
}
```

### 3.3 QueryBuilder (richer query derivation — pulled into scope)

The recall query is no longer just "the last user message." A pluggable strategy (config `RECALL_QUERY_STRATEGY`) builds it from the recent-message window passed in by `ChatService`:

- `last-message` — current behavior; kept as the A/B and eval baseline.
- `recent-window` *(default)* — heuristic concatenation of the last *K* messages (config `RECALL_QUERY_WINDOW`, default 3), lightly cleaned (drop bot lines, collapse whitespace). No extra LLM call → no added latency.
- `llm-condense` *(optional)* — one small LLM call that condenses the recent window into a search query. Higher quality potential, adds a call per turn; off by default, available for eval comparison.

The eval harness (§8) sweeps strategy so we can see whether `recent-window` / `llm-condense` actually beat `last-message` before committing.

### 3.4 Recall ledger

New Mongo collection `recall_ledger`, **lazily** populated — a row is created the first time recall encounters a `memoryKey`.

```js
{
  _id,
  memoryKey,           // unique. `${source}:${id}` or `hash:${contentHash}`
  scope,               // { userId?, channelId?, personalityId? }
  source,              // originating adapter
  contentHash,         // normalized-text hash, for cross-source dedup
  importance,          // 0..1; seeded (explicit > others), nudged up on access (capped)
  accessCount,         // times this memory made it into an injected block
  firstSeenAtUtc,
  lastAccessedAtUtc,
  expiresAt,           // mirrors the underlying memory's expiry, for pruning; null if none
}
```

- **Indexes:** unique on `memoryKey`; `contentHash`; `expiresAt` (TTL/prune sweep).
- **Pruning:** a periodic/startup sweep deletes rows whose `expiresAt` has passed, aligned with the existing Qdrant channel-message expiry and Mem0 lifecycle. Cheap; does not need to be exact.

---

## 4. Dedup & exclusion

1. **Exclusion (cross-block).** `recall()` accepts `excludeKeys` — the content hashes / message IDs already present in the recent-buffer block that `ChatService` assembles separately. Any `channel:semantic` candidate matching is dropped before ranking. This prevents a recent message from appearing both in the verbatim buffer block and again as a "recalled" semantic hit. Required given the buffer/recall separation.
2. **Dedup (within recall).** Remaining candidates are collapsed by `contentHash` (normalized, lowercased, whitespace-collapsed text). Keep the highest-`similarity` instance; merge provenance tags so the surviving line can show it came from more than one place.

---

## 5. Ranking

### 5.1 Score

```
score = w_source
      × similarity_norm                    // 0..1, source score normalized
      × exp(-λ · days_since_last_access)    // temporal decay; 14-day half-life → λ = ln(2)/14
      × (1 + α · ln(1 + accessCount))       // access boost; α ≈ 0.1
      × importance                          // 0..1 from ledger
```

- `w_source` — base channel weights, seeded from today's implicit priority and tunable via config: `explicit > shared ≈ channel-facts ≈ personal > channel-semantic`.
- `similarity_norm` — Mem0 and Qdrant scores normalized to 0..1 per source (min-max or known-range clamp; exact normalization fixed in the plan).
- **First-sight candidates** (no ledger row yet): `importance = seed`, `accessCount = 0`, `days_since_last_access = 0` ⇒ decay factor = 1.
- `channel:semantic` recency uses the message `timestamp` directly for `days_since_last_access` when present; ledger access still tracked.
- **All of `w_source`, λ, α, and importance seeds live in config/env** so the eval harness can sweep them without code changes.

### 5.2 Ledger update (post-injection)

For every candidate that survives into the final injected block: increment `accessCount`, set `lastAccessedAtUtc = now`, nudge `importance` up by a small step (capped at a configured max). Writes are **async and best-effort** (§9).

---

## 6. The unified block

```
## Memory Context
[explicit] You prefer staging-first deploys.
[shared · channel] The build server is called "the toaster".
[fact] Acme switched to net-30 in May.
[history · 2026-05-18 · @anna] "shipping PO-2401 tonight"
```

- Each line: `[provenance tag] text`. Tag derives from `source`/`type`, optionally with `when` / `who`.
- **Bounded** by top-N (config `RECALL_MAX_ITEMS`, default 8) **and** a token ceiling (config `RECALL_TOKEN_BUDGET`).
- Replaces today's `memoryContext` + `sharedContext` + the semantic/facts portions of channel context.
- **Prompt-size guard:** since the buffer, memory, and few-shot blocks are budgeted independently, `ChatService` applies one overall assembled-prompt size check so the three cannot collectively balloon; if exceeded, the memory block is trimmed first (it is the most compressible).

---

## 7. Integration & rollout

- `ChatService._getRelevantMemories` and the *content* portion of `_getChannelContext` collapse into one `recallService.recall({ queryContext, scope, excludeKeys })` returning `{ block, candidates, debug }`. The Tier-1 recent buffer and voice/few-shot paths are untouched.
- **`RECALL_V2_ENABLED`** (default `false`) — off ⇒ today's behavior, byte-for-byte.
- **`RECALL_SHADOW_ENABLED`** (default `false`) — compute old **and** new in parallel, inject the configured one (`RECALL_SHADOW_INJECT`, default `old`), log both to `recall_comparisons`.
- **Rollout:** ship dark (flags off) → enable shadow logging → review eval + comparisons → flip `RECALL_V2_ENABLED` → later retire the old path.

---

## 8. Validation

### 8.1 Offline eval set

- `eval/recall/*.json`: ~20–40 hand-labeled cases `{ query, scope, recentWindow?, expectedKeys | rubric }`, drawn from real channel queries.
- `scripts/eval-recall.js`: runs the ranker against a seeded fixture store (or a snapshot), scores precision@N and ranking order (e.g., nDCG-style), and **sweeps** weight/strategy configs (`w_source`, λ, α, seeds, `RECALL_QUERY_STRATEGY`). Output: a ranked table of configs so we pick weights with evidence.

### 8.2 A/B shadow logging

- `recall_comparisons` Mongo collection: `{ query, derivedQuery, scope, oldBlock, newBlock, oldKeys, newKeys, weights, strategy, ts }`. Mirrors the existing voice A/B pattern (`ab_comparisons`).
- Enables eyeball review of real-traffic old-vs-new diffs. An LLM-judge over these rows is a possible later add, not required here.

---

## 9. Error handling & degradation

- Each source adapter call is isolated: a failure or empty result contributes **zero** candidates and never throws up the stack. If every source fails, `recall()` returns an empty block — identical to today's empty-memory behavior.
- **Ledger writes are async and best-effort.** A ledger read/write failure must never block or fail a chat turn; recall degrades to similarity + (timestamp-based) recency ranking using only in-result data, skipping the importance/access factors.
- Flags fail safe: any error constructing the v2 block with `RECALL_V2_ENABLED` falls back to the legacy assembly path.

---

## 10. Testing (TDD)

- **Unit:** each adapter's normalization; `QueryBuilder` strategies; `excludeKeys` filtering; `contentHash` dedup + provenance merge; scoring (decay monotonicity over time, access-boost direction, source-weight ordering, first-sight defaults); block formatting + top-N/token bounding; overall prompt-size guard trimming memory first.
- **Ledger:** lazy create; access increment; importance nudge + cap; prune by `expiresAt`.
- **Integration:** `ChatService` with `RECALL_V2_ENABLED=false` (output byte-for-byte unchanged) and `=true` (single block, buffer + few-shot still separate); shadow mode logs both old and new.
- **Eval harness:** fixture-based tests for scoring/sweeps so the harness itself is trustworthy.

---

## 11. Components & boundaries summary

| Unit | Responsibility | Depends on |
|---|---|---|
| `RecallService` | orchestrate: query → fan-out → exclude → dedup → enrich → score → bound → format → ledger-bump | adapters, `RecallLedger`, `QueryBuilder`, config |
| Source adapters | normalize one source into `Candidate[]` | `Mem0Service`, `ChannelContextService` |
| `QueryBuilder` | derive recall query from recent window (pluggable strategy) | config (optionally an LLM client for `llm-condense`) |
| `RecallLedger` | Mongo CRUD for importance/access/provenance + prune | `MongoService` |
| `ChatService` (modified) | call `recall()`, assemble buffer + memory + few-shot blocks, prompt-size guard, flag/shadow wiring | `RecallService` |
| eval harness | score/sweep configs offline | `RecallService`, fixtures |

---

## 12. Future work / open questions

- **Evaluate leaving Mem0 (the option-C move).** Once the ledger proves out we will already own importance, access, and provenance — so taking over storage + extraction becomes incremental rather than a rewrite. Trigger this evaluation after v2 is the live path.
- **Benchmark vs. state-of-the-art.** Before committing to this design long-term, research *beyond* Clovar — other agent-memory frameworks and current retrieval/reranking literature — and fold in wider source ideas. This design should be treated as a strong v1, not the final word.
- **Episodes + typed graph** as future source adapters behind the same `RecallService`.
- **Robustness gap:** vector-store-down keyword/exact-match fallback, explicitly deferred from this spec.
