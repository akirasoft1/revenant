# Hangar HTF Import + Pledge Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import members' RSI pledge hangars from Hangar Transfer Format files (HangarXPLOR `shiplist.json`) with sync-on-reimport, store full pledge data, and expose a pledge leaderboard (API, `/hangar leaderboard`, editor totals, sc-knowledge tool).

**Architecture:** A pure `hangar-service/src/htf.py` parses/classifies HTF entities against the catalog and a member's ships (no I/O); `app.py` adds preview/apply/leaderboard routes using the repository (gaining an `rsi` field); the editor adds an Import section and pledge badges; the bot adds a public `/hangar leaderboard`; sc-knowledge passes pledge fields through and adds `sc_pledge_leaderboard`.

**Tech Stack:** Python 3.14 FastAPI + pytest (hangar-service, sc-knowledge); React/TS/Vitest (hangar-editor); Node discord.js + Jest (bot).

**Spec:** `docs/superpowers/specs/2026-10-11-hangar-htf-import-design.md` (binding — row kinds, key format, partial rule, counting rule, response shapes, log line).

## Global Constraints
- Sync key exactly `f"{pledge_id}:{ship_code_lower}:{ordinal}"`; ordinal = 0-based index among same-`ship_code` ships within the same `pledge_id`, in file order.
- Row kinds exactly `new | existing | link | skipped`; `missing` is a separate list; skipped reasons `not_a_ship | unmatched | invalid`.
- Partial rule: member has ≥ 2 RSI ships AND matched RSI keys in file < 50% of them → `partial: true`, all `missing.defaultRemove = false`.
- Upload ≤ 2 MB, ≤ 500 entities; never trust client-sent rows — apply re-derives and validates `choices` against the server's own classification.
- Totals: once per distinct `pledgeId` per member, per currency, no FX; label "pledged on ships".
- Apply log line exactly: `hangar: htf import member=<id> created=<n> linked=<n> updated=<n> removed=<n> skipped=<n>` (INFO, never truncated).
- `/hangar leaderboard` reply is PUBLIC (not ephemeral), ≤ 2000 chars, 🥇🥈🥉 top three, caveat footer.
- Stage explicit paths only; commit trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; TDD; never read/print `.env*`; no deploys. Suites: `cd hangar-service && .venv/bin/python -m pytest -q`; `cd sc-knowledge && .venv/bin/python -m pytest -q`; `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null; cd hangar-editor && npm test && npm run build`; bot `npm test` (repo root, Node 22).

## Review Focus
1. **Same file imported twice** → second preview all `existing`/no `new`, apply all `unchanged` (no duplicate ships). → Task 1/2 tests.
2. **A package with two identical ships** stays two ships across re-imports (ordinal stable) and neither is reported missing. → Task 1 test.
3. **Partial selection export** never defaults to deleting the rest. → Task 1 test.
4. **Forged apply choices** (link to someone else's ship / another row's candidate, remove a hand-added ship) are rejected or ignored. → Task 2 test.
5. **Leaderboard with a package pledge** counts its cost once, not per ship. → Task 2 test.

---

### Task 1: hangar-service `htf.py` — parsing, matching, classification (pure)
**Files:** Create `hangar-service/src/htf.py`, `hangar-service/tests/test_htf.py`, fixture `hangar-service/tests/fixtures/htf_hangarxplor.json` (HangarXPLOR-shaped: standalone Carrack `"$350.00 USD"` LTI warbond with custom `ship_name` "Serenity"; package pledge with Avenger Titan + two `ANVL_Pisces`-style identical ships; an `unidentified` row with a bogus code but resolvable `name`; an `entity_type:"component"` row; cost `"€45,00 EUR"`; cost `"garbage"`; `pledge_date` like `"December 08, 2016"`). Use ship codes that exist in the test catalog fixtures (`tests/fixtures/wiki_vehicles_index.json` className values) — check them first.
**Interfaces (Produces):**
```python
def parse_cost(raw: str | None) -> dict | None      # {"amount": float|None, "currency": str|None, "raw": str} ; None if raw empty
def parse_date(raw: str | None) -> str | None       # ISO yyyy-mm-dd or None
def rsi_key(pledge_id: str, ship_code: str, ordinal: int) -> str
@dataclass class HtfEntry: index:int; ship_code:str|None; name:str|None; ship_name:str|None; pledge:dict; raw:dict
def parse_file(data: Any) -> tuple[list[HtfEntry], list[dict]]   # (ship entries with ordinals assigned, skipped rows); raises ValueError on non-array / >500
def match_vehicle(entry: HtfEntry, vehicles: list[dict]) -> dict | None   # catalog summaries {uuid,name,className,...}; className exact (ci) then resolve_vehicle(name / ship_name)
def classify(entries, skipped, vehicles, ships: list[dict]) -> dict        # the preview body per spec (rows, missing, partial, summary)
def rsi_record(entry: HtfEntry, vehicle: dict, now_iso: str) -> dict      # the `rsi` map stored on a ship (spec Data model)
def pledge_records(entries, vehicles, now_iso) -> list[dict]             # one ledger record per pledge (matched or not)
def pledge_summary(pledges: list[dict]) -> dict | None                    # from ledger records: {totals, pledges, ships, lti, topPledge, lastImport}
def ledger_sync(existing, incoming, partial) -> tuple[list[dict], list[str]]  # (upserts, pledgeIds to delete; [] when partial)
```
- [ ] Write failing tests for each function (costs: `"$350.00 USD"`→350.0 USD, `"€45,00 EUR"`→45.0 EUR, `"$1,234.50 USD"`→1234.5, `"garbage"`→amount None raw kept; dates; ordinals for two identical ships = 0,1; non-ship → skipped not_a_ship; unmatched → skipped unmatched; custom name rule; classification of new/existing/link/missing incl. link-candidate claiming across rows, `defaultRemove` by `hasFittings`, partial guard incl. "< 2 RSI ships → never partial"; `pledge_summary` counts a package once and splits currencies). Run → fail. Implement. Run → pass. Commit `feat(hangar): HTF parsing and sync classification`.

### Task 2: hangar-service routes, repository `rsi`, leaderboard, hangar summary
**Files:** Modify `hangar-service/src/repository.py` (create_ship gains `rsi: dict | None = None`; new abstract `list_pledges(member_id)`, `upsert_pledges(member_id, records)`, `delete_pledges(member_id, ids)`, `list_pledge_members()` (ledger in `members/{id}/rsiPledges/{pledgeId}`) and `set_rsi(member_id, ship_id, rsi, *, nickname: str | None | _UNSET, updated_by, owner_name=None) -> dict | None` in all three implementations), `hangar-service/src/app.py` (routes + hangar `pledgeSummary`), `hangar-service/README.md`. Test `hangar-service/tests/test_htf_api.py`.
**Interfaces (Produces JSON):** `POST /v1|/api/v1/import/htf/preview[?member=]` `{file}` → spec preview body; `POST …/import/htf/apply[?member=]` `{file, choices:{links:{"<index>": shipId|"new"}, remove:[shipId]}}` → `{rows:[{index,result,shipId?,error?}], removed:[shipId]}`; `GET /v1|/api/v1/pledges/leaderboard` → spec leaderboard body; `GET …/members/{id}/hangar` adds `pledgeSummary` when present.
- [ ] Failing tests: preview/apply happy path from the Task 1 fixture; apply creates ships with `rsi` + nickname; re-apply same file → all `unchanged`, no new ships (Review Focus 1); link default + explicit "new"; removing a `missing` ship; **forged choices**: link to a shipId not in that row's candidates → row treated as `new`? NO — reject the whole apply with 400 `invalid_request` naming the bad choice; remove of a hand-added or unknown shipId → 400 (Review Focus 4); permissions (other member without admin → 403; admin `?member=` ok; session same-origin enforced); oversize/non-array → 400; catalog unavailable → 503 `unavailable`, nothing written; INFO log line exact; leaderboard ordering, distinct-pledge counting (Review Focus 5), per-currency, excludes members without RSI ships, service token + session both allowed; hangar `pledgeSummary`. Implement using `htf.py` (catalog vehicles via `catalog.vehicle_index()`), ship-by-ship writes with per-row results. Run full suite. Commit `feat(hangar): HTF import routes, pledge leaderboard`.

### Task 3: hangar-editor — HTF import UI, pledge badges and totals
**Files:** Modify `hangar-editor/src/api/types.ts`, `src/api/client.ts` (`htfPreview(file, member?)`, `htfApply(file, choices, member?)`, `getPledgeLeaderboard()`), `src/pages/ImportPage.tsx` (new section; reuse existing upload/preview patterns), `src/components/HangarView.tsx` (RSI badge + total line), ship page header (badge) in `src/components/ClassicShipView.tsx` and terminal top bar if trivial, tests (`ImportPage.test.tsx` additions, `HangarView` test), `hangar-editor/README.md`.
- [ ] Failing tests: HTF section renders instructions; upload → preview rows with kind badges, skipped reasons, link select (default single candidate), missing list with checkboxes defaulted from `defaultRemove`, partial banner; Apply sends exactly `{links, remove}` from the UI state; results rendered; hangar shows "RSI · LTI · <pledge> · $350.00" badge vs "Added manually", and "$X pledged on ships across N pledges" (multi-currency joined with " + "). Implement. `npm test && npm run build`. Commit `feat(hangar-editor): HTF import and pledge badges`.

### Task 4: bot `/hangar leaderboard` + list total; sc-knowledge pledge fields + `sc_pledge_leaderboard`
**Files:** `services/HangarClient.js` (`getPledgeLeaderboard()`), `commands/slash/HangarCommand.js` (+ `leaderboard` subcommand, public reply; `list` appends total line), `__tests__/` for both; `sc-knowledge/src/hangar.py` (client `pledge_leaderboard()` — read-only GET, same bounds/cache), `sc-knowledge/src/tools_hangar.py` (pass `rsi` fields through in `member_hangar` ship entries), `sc-knowledge/src/server.py` (register `sc_pledge_leaderboard`), sc-knowledge tests, `sc-knowledge/README.md`.
- [ ] Failing tests: leaderboard formatting (medals, totals per currency, ships/LTI/top pledge, caveat footer, ≤ 2000 chars with "…and N more", non-ephemeral reply, unavailable message, empty board message "No one has imported an RSI hangar yet — see Import on <editor url>"); display names resolved via the bot's existing name resolution used by `/hangar list`; `list` total line. sc-knowledge: pledge fields present in `sc_member_hangar`; `sc_pledge_leaderboard` ok/unavailable; the read-only-client test still holds (GET only, no `X-Acting-Member`). Implement; run bot `npm test` and sc-knowledge suite. Commit `feat(hangar): pledge leaderboard command and bot tool`.

### Task 5: docs
**Files:** `CLAUDE.md` (Member hangar: HTF import + sync semantics + pledge data visibility + leaderboard + bot tool; add the two spec follow-ups to the hangar "Next" list), `features.md`, `README.md`.
- [ ] Write from the code (verify each claim). Commit `docs(hangar): HTF import and pledge leaderboard`.

## Coordinator steps
Deploy hangar-service (Cloud Run, SHA) → sc-knowledge (SHA, deployed overlay) → bot (minor bump, deployed overlay, `registerCommands.js` in the bot pod) → restart voice sidecar. Live: owner imports `shiplist.json`, re-imports, `/hangar leaderboard`, bot question. Then PR + memory.
