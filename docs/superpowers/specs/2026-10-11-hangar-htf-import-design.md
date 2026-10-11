# Hangar: Hangar Transfer Format (HangarXPLOR) import + pledge leaderboard — Design

**Date:** 2026-10-11 · **Status:** approved (chat) · **Branch:** `feat/hangar-htf-import`

## Goal
Members import their RSI pledge hangar into hangar.aklabs.io from a **Hangar Transfer Format** (HTF) file — primarily HangarXPLOR's "Download JSON" (`shiplist.json`) — and re-import later to stay in sync. Imported ships carry their pledge data, which feeds a public, ranked **pledge leaderboard** (good-natured ribbing among friends) in Discord, the editor and the bot.

## Format (verified 2026-10-11)
- HTF is a draft community spec, OpenAPI `https://docs.starcitizen.fans/hangar-transfer-format.yaml` (v0.0.1). A file is a JSON **array** of entities. Common fields: `name`, `entity_type` (`ship` default | `component` | `decoration`). Ship code list: `https://docs.starcitizen.fans/ship-codes.json` (`ship_code` like `AEGS_Avenger_Titan`, `ship_name`, `manufacturer_code`, `manufacturer_name`).
- HangarXPLOR export (`src/web_resources/HangarXPLOR.Download.js` in `dolkensp/HangarXPLOR`), one element **per ship** (a package pledge yields several with the same `pledge_id`): `ship_code`, `ship_name` (the member's **custom RSI name** if set, else the model name), `name` (RSI title minus manufacturer), `manufacturer_code`, `manufacturer_name`, `entity_type: "ship"`, `pledge_id`, `pledge_name`, `pledge_date` (e.g. `"December 08, 2016"` — RSI date text), `pledge_cost` (e.g. `"$350.00 USD"`), `lti` (bool), `warbond` (bool); unmatched ships also carry `unidentified` + `lookup`. HangarXPLOR can export a **selection**, so a file may be partial. HTF carries **no components**.

## Decisions (owner-approved)
- **Re-import = sync with a removals preview** (not add-only, not authoritative replace).
- **Store all pledge data, including cost** — the group are IRL friends; visible to every signed-in guild member and the bot.
- **Public `/hangar leaderboard`** ranked by pledged amount, plus a bot tool for chat/voice.

## Matching (per HTF ship entity)
Only `entity_type` `ship` (or absent) is imported; other types → `skipped` (`not_a_ship`). Vehicle resolution, in order:
1. `ship_code` equals a catalog vehicle `className` (case-insensitive).
2. Else `name` (then `ship_name` if it differs and isn't a custom name) through the existing vehicle resolver (`resolve_vehicle`: exact → prefix/token → fuzzy). Ambiguous / not found → `skipped` (`unmatched`, with the RSI title and `ship_code`). HangarXPLOR `unidentified` rows take this path.
Sync key: `rsi.key = f"{pledge_id}:{ship_code_lower}:{ordinal}"`, `ordinal` = 0-based index of this ship among same-`ship_code` ships of the same `pledge_id`, in file order. A pledge with two Pisces → two ships.
Custom name: `rsiName = ship_name` when it differs (case-insensitive, trimmed) from both `name` and the matched vehicle name; else `null`.

## Preview — `POST /api/v1/import/htf/preview[?member=]` (also `/v1/...`)
Body `{file: <HTF array>}` (≤ 2 MB, ≤ 500 entities). Response:
```json
{"rows": [{"index": 0, "kind": "new|existing|link|skipped", "rsiKey": "...", "vehicle": {"uuid","name"}|null,
           "nickname": "Serenity"|null, "pledge": {"id","name","date","cost": {"amount","currency","raw"}|null,"lti","warbond"},
           "existing": {"shipId","label"}|null, "linkCandidates": [{"shipId","label"}], "reason": "..."|null}],
 "missing": [{"shipId","label","rsiKey","hasFittings": bool, "defaultRemove": bool}],
 "partial": bool, "summary": {"new","existing","link","skipped","missing"}}
```
- `existing`: a ship in this member's hangar already has `rsi.key == rsiKey` → will refresh pledge fields; nickname updated only if the stored `rsi.rsiName` differs from the new one (a manual rename since the last import is preserved when RSI's name didn't change).
- `link`: no ship has this key, and the member has ≥1 hand-added (no `rsi`) ship of the same `vehicleUuid` not already claimed by an earlier row in this file → `linkCandidates` (default target = the first when exactly one; client may choose "new").
- `new`: otherwise.
- `missing`: RSI-sourced ships (have `rsi`) whose key is absent from the file; `defaultRemove = not hasFittings`.
- `partial`: number of distinct `rsi.key`s in the file that match existing RSI ships < 50% of the member's RSI-sourced ships (and member has ≥ 2 such ships) → every `missing.defaultRemove` forced `false` and the UI shows a warning.
Nothing is written.

## Apply — `POST /api/v1/import/htf/apply[?member=]`
Body `{file, choices: {links: {<index>: <shipId>|"new"}, remove: [<shipId>, ...]}}`. Server re-derives the preview from `file` (never trusts client rows); applies `links` only to rows the server classified `link` and only to shipIds in that row's `linkCandidates`; removes only shipIds the server lists in `missing`. Any choice outside those sets (a link target not in that row's candidates, a link for a non-`link` row, a remove of a ship not in `missing`) → 400 `invalid_request` naming it, nothing written. Then: create `new` ships (`vehicleUuid/Name/ClassName`, `nickname`, `rsi`), set `rsi` on linked ships (+ nickname if the ship has none and `rsiName` exists), refresh `existing`, delete chosen `missing`. Fittings never touched except via deletion. Response: per-row `{index, result: "created|linked|updated|unchanged|skipped|error", shipId?, error?}` + `removed: [shipId]`. Idempotent: re-applying the same file with no choices → all `unchanged`. Write rule as today (own hangar; admins via `?member=`; session CSRF same-origin; service tokens with `X-Acting-Member`).

## Data model
Ship document gains optional `rsi`: `{key, pledgeId, shipCode, ordinal, pledgeName, pledgeDate, pledgeCost: {amount: number|null, currency: str|null, raw: str}, lti: bool, warbond: bool, rsiName: str|null, importedAt}`. `pledgeCost` parse: `^\s*([^\d\s-]*)\s*([\d.,]+)\s*([A-Z]{3})?\s*$` → amount (strip thousands separators; `,` decimal when followed by exactly 2 digits and no `.`), currency = ISO code if present else symbol map (`$`→USD, `€`→EUR, `£`→GBP); unparseable → amount/currency null, raw kept. `pledgeDate` stored as given plus `pledgeDateIso` when parseable (`%B %d, %Y` or ISO).

## Pledge ledger (concept ships count too)
Coverage check 2026-10-11: 144/186 HTF ship codes match a Wiki `className`; most misses are concept ships absent from the in-game catalog (Kraken, Odyssey, Nautilus, Pioneer, Merchantman…). Those can't become hangar ships but their pledges must count. So every apply also writes a per-member **pledge ledger** `members/{id}/rsiPledges/{pledgeId}` = `{pledgeId, name, date, dateIso, cost, lti, warbond, ships: [{shipCode, name, rsiName, vehicleUuid|null, matched}], importedAt}` for EVERY ship-bearing pledge in the file (matched or not). Ledger sync: upsert all pledges in the file; delete ledger pledges absent from the file only when the import is not `partial`. Totals and the leaderboard are computed from the ledger, not from ships. Unmatched rows show as skipped with `countedInTotals: true` ("counted in pledge total, not added to hangar — not in game yet").

## Pledge totals and leaderboard
- **Counting rule:** a pledge's cost counts **once per distinct `pledgeId`** per member (packages), using the first non-null parsed amount seen for that pledge. Totals are **per currency** (no FX conversion); USD ranked first. Label everywhere: "pledged on ships" — HTF exports only ship-bearing pledges, so paints/game packages/gear/melted items are excluded; CCU'd pledges count at current value.
- `GET /v1/pledges/leaderboard` (service tokens + sessions; also `/api/v1`): `{"entries": [{"member","displayName"|null,"totals": {"USD": 1234.5, ...},"pledges": n,"ships": n,"lti": n,"topPledge": {"name","amount","currency"},"lastImport"}], "caveat": "..."}` sorted by USD total desc, then other currencies, then member id. Only members with ≥1 RSI-sourced ship. Computed from Firestore per request (no cache).
- `GET /v1/members/{id}/hangar` adds `pledgeSummary: {totals, pledges, ships, lti}` when the member has RSI ships.

## Surfaces
- **Editor (`hangar-editor`):** Import page gains a "RSI hangar (HangarXPLOR / Hangar Transfer Format)" section: instructions (install HangarXPLOR, open RSI hangar, Download JSON → `shiplist.json`), file upload, preview table (row kind badges, vehicle, nickname, pledge name/cost/LTI, link-target select, skipped reasons), "Missing from this export" list with remove checkboxes, partial-export warning banner, Apply + per-row results. Ship cards / ship page: "RSI" badge (LTI, pledge name, date, cost) vs "Added manually". My hangar + member pages: total line "$X pledged on ships across N pledges".
- **Bot `/hangar leaderboard`** (new subcommand, **public**, non-ephemeral): rank, display name, total(s), ships, LTI count, top pledge; 🥇🥈🥉 for the top three; footer caveat "Pledged on ships only (HangarXPLOR exports) · last import <date per member or oldest>"; ≤ 2000 chars (truncate with "…and N more"). Display names via the bot's own resolver (member identity registry → Discord) for the ids returned. `/hangar list` appends the member's pledge total line when present.
- **sc-knowledge:** `sc_member_hangar` ship entries include `rsi` pledge fields (`pledgeName`, `pledgeDate`, `pledgeCost`, `lti`, `warbond`, `rsiName`) when present; new read-only tool `sc_pledge_leaderboard()` → the leaderboard JSON (same 3s/5s bounds and `unavailable` error as the other hangar tools). Docstring: for questions about who has pledged/spent the most on ships, totals, rankings. No prompt changes.

## Error handling
400 `invalid_request` for non-array / oversize / non-object entities beyond the per-row skip; per-row `skipped` for unmatched / not_a_ship / invalid fields; `unavailable` (503) when the catalog can't be read — preview and apply never half-classify. Apply writes ship-by-ship, returning per-row results so a mid-way failure shows what landed. Logs: one INFO `hangar: htf import member=<id> created=… linked=… updated=… removed=… skipped=…` per apply (never truncated).

## Testing
- **hangar-service:** HangarXPLOR-shaped fixture (standalone, 3-ship package with two same-code ships, custom-named ship, `unidentified` row, non-ship entity, costs `"$350.00 USD"`, `"€45,00 EUR"`, `"garbage"`); ship_code match vs name fallback; ordinal keys; all row kinds; link candidate claiming; partial guard; apply idempotence; hand-added untouched; choices validated server-side; totals over distinct pledges per currency; leaderboard ordering; permissions; date parsing.
- **Editor (Vitest):** HTF import section rows/choices/banner/results; pledge badge + totals.
- **Bot (Jest):** `/hangar leaderboard` format, medals, caveat footer, 2000-char cap, public reply; `/hangar list` total line.
- **sc-knowledge:** `sc_member_hangar` passes pledge fields; `sc_pledge_leaderboard` ok + unavailable.
- **Live:** owner imports their HangarXPLOR `shiplist.json`, re-imports, `/hangar leaderboard`, asks the bot "who's spent the most on ships?".

## Rollout
hangar-service (Cloud Run, SHA tag) → sc-knowledge (image SHA, deployed overlay) → bot (minor bump, `registerCommands.js` from the bot pod) → restart the voice sidecar so it reloads sc-knowledge declarations. Agent sidecar picks up the new tool automatically.

## Follow-ups (appended to the hangar queue)
- Optional FX conversion for mixed-currency leaderboards.
- Our own extension / bookmarklet producing HTF directly (only if HangarXPLOR breaks).
