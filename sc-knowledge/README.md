# sc-knowledge

A standalone Star Citizen game-data service exposed as a FastMCP (mcp 2.x
`MCPServer`) streamable-HTTP server at `/mcp`. It gives the Discord bot's
agent sidecar (`discord-article-bot-agent`) and voice sidecar
(`discord-article-bot-voice`) fast, pre-computed answers to "what does the
game actually say right now" questions -- item stats and shop prices,
component rankings, faction mission rep-per-minute, profitable trade routes,
commodity prices, org-authored strategy guides, and members' own ship
loadouts (read from hangar-service) -- instead of relying on
an LLM's training data, which is stale the moment a patch ships.

It wraps two upstream APIs (UEX Corp for crowd-sourced economy data, the
Star Citizen Wiki for per-patch extracted game data and embedded UEX shop
prices) behind a TTL cache, jittered retry, and rate limiting, and never
raises an exception across the MCP boundary -- every tool call returns a
result dict or a uniform `{"error": ..., "detail": ..., "stale_fallback": ...}`
envelope.

## MCP tools

| Tool | Purpose |
|---|---|
| `sc_find_item(name)` | Item/component lookup by fuzzy name; stats + every player-reported shop selling it, cheapest first. |
| `sc_compare_components(type, size, rank_by=None, grade=None, component_class=None, limit=5, purchasable_only=False)` | Ranks components of one type+size (shield, power_plant, cooler, quantum_drive, radar, weapon, missile) by a real stat. `purchasable_only=True` keeps only items with at least one current UEX shop buy price (adds `purchasable_only: true` and `excluded_not_purchasable: N`; ranking among the rest unchanged). |
| `sc_faction_missions(faction, current_rank=None, system=None, limit=10)` | Faction missions ranked by reputation gained per estimated minute. |
| `sc_trade_routes(origin, destination=None, commodity=None, cargo_scu=None, budget_auec=None, limit=5)` | Profitable UEX commodity trade routes from an origin, capped by cargo/budget when given. |
| `sc_commodity_prices(commodity, location=None, side="sell", limit=5)` | Current UEX buy/sell prices for a commodity, best price first. |
| `sc_location_shops(location, category=None, exclusive_only=False, limit=40)` | What a place's live UEX shops sell, and which of those items are sold nowhere else. Optional category filter (with ship-parts/FPS-gear aliases) and exclusive-only flag. |
| `sc_member_hangar(member_id, ship=None)` | A member's ships with their effective loadouts (slot, size, item, `stock`/`fitted`). `ship` resolves within that member's hangar: exact nickname → nickname fuzzy → exact model → model token/prefix (with a small community-shorthand table: "Connie" → Constellation, "Cutty" → Cutlass, …) → model fuzzy; ambiguous → `ambiguous` + `candidates`, unknown → `not_found` + `owned`. See "Member hangar tools" below. |
| `sc_member_fit_check(member_id, item)` | Is an item a usable upgrade for any of a member's ships? Resolves the item (Wiki), checks every owned ship's compatible slots, and gives a per-slot verdict against what is fitted now. See below. |
| `sc_org_guides(query, limit=3)` | BM25 search over privately-synced org guide text (mining/salvage/trading strategy notes; live data from the other tools wins for prices/stats). |

Every successful result includes `source` and (except `sc_org_guides`, whose
sections each carry their own `version` instead, and `sc_location_shops`, whose
UEX price rows carry no game version — it reports data age as `latest_report`)
a top-level `game_version`.
When a tool result's game version differs from the live game version (UEX
`game_versions()["live"]`), the response gets an extra `note_patch` field
flagging that the data may be stale relative to the current patch -- this
never fails the call, even if UEX itself is unreachable. The live-version
lookup for that note is bounded at 0.5s: on a cold cache or a slow UEX the
call returns without `note_patch` rather than waiting (a Wiki-only answer
never waits on UEX), and the lookup keeps running in the background to warm
the cache for the next call.

Also exposed: `GET /healthz` -> `200 {"ok": true, "version": ..., "game_version": ...}`.
Health means "process serving requests" -- an unreachable upstream is
reported per tool call, never as an unhealthy pod. `/healthz` NEVER fetches
upstream: `game_version` is the cached value (`null` on a cold cache) and a
missing/expired value triggers one single-flight background refresh. It is
also not subject to the Host allow-list below (kubelet probes send the pod
IP as Host).

**Host allow-list (DNS-rebinding protection):** `/mcp` rejects any request
whose `Host` header is not in `SC_ALLOWED_HOSTS` with `421 Invalid Host
header`. mcp 2.x enables this protection with a loopback-only list by
default, so the in-cluster Service names must be allowed explicitly -- the
default list covers every in-cluster spelling of the Service
(`sc-knowledge`, `sc-knowledge.discord-article-bot`, `...svc`,
`...svc.cluster.local`) plus `localhost`/`127.0.0.1`/`[::1]`, any port. If
the Service is renamed or reached through another name, extend the env var or
every call will 421.

## Member hangar tools

`sc_member_hangar` and `sc_member_fit_check` read per-member ship loadouts
from **hangar-service** (Cloud Run, see `hangar-service/README.md` and the
"Member hangar" section of the repo `CLAUDE.md`). They are for questions
about a member's OWN ships only; `member_id` is the numeric Discord ID from
the bot's `[Name · id]` message labels or the "People in this conversation"
roster ("my" = the labelled speaker). A non-numeric `member_id` returns
`bad_request` without a call. Reads of any member are allowed ("can Micro use
it?"); there is no write path here.

- **Read-only client** (`src/hangar.py`): only `GET /v1/members/{id}/hangar`,
  never an `X-Acting-Member` header (a test pins the absence of any write
  verb). Auth is a Google ID token minted from the `hangar-api@` key at
  `HANGAR_SA_KEY_PATH` (`service_account.IDTokenCredentials`, audience =
  `HANGAR_API_URL`), single-flight, cached until 5 minutes before expiry.
  Token + request are bounded at 3s; successful bodies are cached 30s per
  member (errors are not).
- **Deadlines:** each tool has a 5s overall deadline (the voice sidecar
  bounds a tool call at 6s). `sc_member_fit_check` fetches the hangar and
  looks up the item concurrently (item lookup capped at 3s → `wiki_unavailable`
  on timeout); stat lookups for the currently fitted items share whatever
  time remains (≤2s each) and fall back to verdict `unknown`.
- **Errors never raise:** hangar down / timed out / our credentials refused
  (5xx, 401, 403, connect error) → `unavailable`; other 4xx pass the
  service's code through. Without `HANGAR_API_URL` both tools are still
  registered (stable tool list) and return `unavailable`.
- **Fit check output:** `{item: {name, type, sub_type, size, grade, class,
  key_stats}, key_stat, order, ships: [{…, slots: [{slot, size, item_value,
  current: {name, source, value}, verdict, delta_pct}]}], not_compatible:
  [{…, reason, detail}]}`. Verdicts: `upgrade` / `downgrade` / `sidegrade`
  (|Δ| ≤ 2% on the key stat `sc_compare_components` ranks by) / `same`
  (same uuid; names only when a uuid is missing) / `unknown` (no stat to
  compare, or the lookup ran out of time). An empty slot is an `upgrade`.
  `not_compatible` reasons: `size_mismatch` (the ship has slots of that type
  but none of the right size), `no_slot` (no such slot, or a sub-type the
  slot rejects), `loadout_unavailable`.
- **Compatibility parity with hangar-service** (`check_compatible`): the
  item's type must be in the slot's `compatibleTypes` (falling back to the
  slot's own type for older loadouts), sub-types are enforced only when the
  slot lists some and the item's sub-type isn't empty/`UNDEFINED`, and the
  size must be within `[sizeMin, sizeMax]`. A gimbal/turret mount slot is not
  offered when a fitting child slot is visible. Change the rule in BOTH
  places.
- **Not tracked:** missiles (→ `not_tracked`; a `MissileLauncher` rack is a
  slot only where the Wiki marks it editable, which the common ships don't),
  and any item type outside hangar-service's slot types.
- **UC1** ("a purchasable upgraded shield for my Harbinger") is
  `sc_member_hangar` (current shield + slot size) then
  `sc_compare_components(..., purchasable_only=True)`.

**Upstream failure backoff:** after a failed fetch the cache does not retry
that key for 30s -- it serves the stale entry (or re-raises the failure)
immediately, so an outage does not cost every caller the full retry budget.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SC_LISTEN_HOST` | `0.0.0.0` | Bind host. |
| `SC_LISTEN_PORT` | `8080` | Bind port. |
| `UEX_BASE_URL` | `https://api.uexcorp.uk/2.0` | UEX Corp API base. |
| `WIKI_BASE_URL` | `https://api.star-citizen.wiki/api` | Star Citizen Wiki API base. |
| `UEXCORP_BEARER` | unset | Optional UEX bearer token (higher rate limits); omitted -> unauthenticated requests. |
| `SC_KNOWLEDGE_VERSION` | `dev` | Sent as `User-Agent: revenant-discord-bot/<version>` and `X-Client-Version: revenant-sc-knowledge/<version>`; also the `/healthz` `version` field. Set to the deployed image's git short-SHA. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP gRPC endpoint for traces; unset -> tracing is a no-op. |
| `SC_ALLOWED_HOSTS` | the in-cluster Service names + loopback, each `:*` | Comma-separated `Host` header allow-list for `/mcp` (`name:*` = any port, otherwise exact match). Anything else gets `421`. |
| `HANGAR_API_URL` | unset | hangar-service base URL, ALSO the ID-token audience: must equal the service's `HANGAR_AUDIENCE` byte for byte (`https://hangar-service-hvmf2jpuca-uc.a.run.app`); whitespace and a trailing `/` are stripped. Unset → the hangar tools return `unavailable`. |
| `HANGAR_SA_KEY_PATH` | `/var/secrets/hangar/key.json` | `hangar-api@` service-account key (Secret `hangar-api-sa`). The image runs as uid 1000, so the mount must be readable by it (the default 0644 secret mode works; `defaultMode: 0400` breaks it → `unavailable` + a WARNING naming the path). Rotating the key needs a pod restart. |
| `SC_GUIDES_DIR` | `/guides` | Directory of `*.txt` org guides (mounted ConfigMap in-cluster). Missing/empty -> `sc_org_guides` returns `{"sections": [], "note": "no org guides loaded"}`, never an error. |

## Cache TTLs (seconds)

| Data | TTL |
|---|---|
| Trade routes / commodity prices | 1800 |
| Item shop prices | 7200 |
| Item stats / missions / factions | 43200 |
| Terminal/commodity name index, UEX game versions | 21600 |
| Location shops (`items_prices_all`, `categories`) | 3600, stale-while-revalidate, warmed at startup |

Rate limits: Wiki <=60/min, UEX <=120/min. HTTP timeouts: connect 3s, total
8s; up to 2 jittered retries on 429/5xx only.

## Run tests

Test-only dependencies (pytest, pytest-asyncio) live in
`requirements-dev.txt`, which includes `requirements.txt`; the production
image installs `requirements.txt` only.

```bash
cd sc-knowledge
python3 -m venv .venv  # first time only
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

`tests/test_server_mcp.py` drives a real in-process uvicorn server with a
real `mcp` streamable-HTTP client (no mocked transport at the MCP layer);
upstream HTTP calls go through `httpx.MockTransport` fixtures
(`tests/conftest.py`'s `fixture_transport`), never the real network.

## Run locally

```bash
cd sc-knowledge
.venv/bin/python -m src.server
# serves MCP at http://0.0.0.0:8080/mcp, health at :8080/healthz
```

## Capture fixtures

Recorded real upstream responses live in `tests/fixtures/*.json`. To
recapture against the live APIs (never done automatically by tests):

```bash
cd sc-knowledge
UEXCORP_BEARER=... .venv/bin/python scripts/capture_fixtures.py
```

Guide fixtures under `tests/fixtures/guides/` are synthetic (never real org
guide text -- see `src/tools_guides.py`'s header and the global constraints'
`OrgGuides/` rule) and are not touched by this script.

## Container and deployment

See `Dockerfile` (built `FROM python:3.14-slim`, runs as uid 1000, `CMD
["python", "-m", "src.server"]`) and `k8s/sc-knowledge/README.md` for the
build/push/deploy workflow and NetworkPolicy details.
