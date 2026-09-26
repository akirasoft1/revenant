# sc-knowledge

A standalone Star Citizen game-data service exposed as a FastMCP (mcp 2.x
`MCPServer`) streamable-HTTP server at `/mcp`. It gives the Discord bot's
agent sidecar (`discord-article-bot-agent`) and voice sidecar
(`discord-article-bot-voice`) fast, pre-computed answers to "what does the
game actually say right now" questions -- item stats and shop prices,
component rankings, faction mission rep-per-minute, profitable trade routes,
commodity prices, and org-authored strategy guides -- instead of relying on
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
| `sc_compare_components(type, size, rank_by=None, grade=None, component_class=None, limit=5)` | Ranks components of one type+size (shield, power_plant, cooler, quantum_drive, radar, weapon, missile) by a real stat. |
| `sc_faction_missions(faction, current_rank=None, system=None, limit=10)` | Faction missions ranked by reputation gained per estimated minute. |
| `sc_trade_routes(origin, destination=None, commodity=None, cargo_scu=None, budget_auec=None, limit=5)` | Profitable UEX commodity trade routes from an origin, capped by cargo/budget when given. |
| `sc_commodity_prices(commodity, location=None, side="sell", limit=5)` | Current UEX buy/sell prices for a commodity, best price first. |
| `sc_org_guides(query, limit=3)` | BM25 search over privately-synced org guide text (mining/salvage/trading strategy notes; live data from the other tools wins for prices/stats). |

Every successful result includes `source` and (except `sc_org_guides`, whose
sections each carry their own `version` instead) a top-level `game_version`.
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
| `SC_GUIDES_DIR` | `/guides` | Directory of `*.txt` org guides (mounted ConfigMap in-cluster). Missing/empty -> `sc_org_guides` returns `{"sections": [], "note": "no org guides loaded"}`, never an error. |

## Cache TTLs (seconds)

| Data | TTL |
|---|---|
| Trade routes / commodity prices | 1800 |
| Item shop prices | 7200 |
| Item stats / missions / factions | 43200 |
| Terminal/commodity name index, UEX game versions | 21600 |

Rate limits: Wiki <=60/min, UEX <=120/min. HTTP timeouts: connect 3s, total
8s; up to 2 jittered retries on 429/5xx only.

## Run tests

```bash
cd sc-knowledge
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
