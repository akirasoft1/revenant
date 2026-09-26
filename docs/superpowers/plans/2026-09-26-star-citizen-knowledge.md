# Star Citizen Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `sc-knowledge` MCP server (UEX + Star Citizen Wiki APIs) exposing six task-shaped `sc_*` tools (five live-data + one over privately-synced org guides), consumed by the agent sidecar (text) and the voice sidecar (Gemini Live function calling), with a hard guarantee that Star Citizen questions never spin up a sandbox.

**Architecture:** `sc-knowledge/` is a standalone Python 3.14 FastMCP server (streamable HTTP `:8080/mcp`, `/healthz`) with async httpx clients, an in-process TTL cache with stale-on-error, client-side rate limits, and a fuzzy name index. The agent sidecar attaches it as an ADK `McpToolset` built once at startup and gated per turn by a cached health probe; the voice sidecar lists its tools at startup, converts them to Gemini `FunctionDeclaration`s, and answers Live `tool_call`s via MCP `call_tool`. `run_in_sandbox` refuses SC-host code before touching the orchestrator.

**Tech Stack:** Python 3.14, `mcp` 2.x (FastMCP server + streamable HTTP client), `httpx`, `rapidfuzz`, `opentelemetry-*`, google-adk 2.10 (`McpToolset`), google-genai 2.25 Live API, pytest + pytest-asyncio, Kubernetes.

**Spec:** `docs/superpowers/specs/2026-09-26-star-citizen-knowledge-design.md`

## Global Constraints

- Python base image `python:3.14-slim`; images tagged with git short SHA, never `:latest`.
- `mcp>=2.2.0`, `httpx>=0.28`, `rapidfuzz>=3.10`, `opentelemetry-api/sdk/exporter-otlp>=1.45.0` for sc-knowledge (it has no google-adk, so no protobuf<7 holdback).
- UEX base `https://api.uexcorp.uk/2.0`; Wiki base `https://api.star-citizen.wiki/api`.
- Timeouts: connect 3 s, total 8 s; ≤2 retries (jittered) on 429/5xx only.
- Cache TTLs (seconds): routes/commodity prices 1800; item prices 7200; item stats/missions/factions 43200; name index 21600.
- Rate limits: Wiki ≤60/min, UEX ≤120/min.
- User-Agent `revenant-discord-bot/<SC_KNOWLEDGE_VERSION>`; UEX also `X-Client-Version: revenant-sc-knowledge/<version>` and `Authorization: Bearer $UEXCORP_BEARER` when set.
- Error envelope (never raise across MCP): `{"error": code, "detail": str, "stale_fallback": bool, ...}`; codes `uex_unavailable`, `wiki_unavailable`, `not_found`, `ambiguous`, `bad_request`.
- Every successful result dict includes `source` and `game_version`.
- Flags: `SC_KNOWLEDGE_ENABLED` (default `false`) and `SC_KNOWLEDGE_URL` (default `http://sc-knowledge.discord-article-bot.svc.cluster.local:8080/mcp`) on BOTH sidecars.
- Voice tool call timeout 6 s; agent health probe cache 30 s.
- SC data hosts for the sandbox backstop: `uexcorp.space`, `uexcorp.uk`, `star-citizen.wiki`, `sc-trade.tools`, `scunpacked`.
- Stage explicit paths only (never `git add -A`/`git add .`); never commit `.venv`, `.env`, `*key*.json`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never truncate log messages.
- `OrgGuides/` (repo root) holds PRIVATE org PDFs: never commit them or any text extracted from them, never copy them into an image. Tests use synthetic guide fixtures only.
- Do NOT touch `k8s/overlays/deployed/` (gitignored, coordinator-owned) — tasks edit tracked manifests only.

## File Structure

```
sc-knowledge/                         NEW service
  Dockerfile, .dockerignore, requirements.txt, pyproject.toml, README.md
  src/__init__.py
  src/config.py        env config (frozen dataclass)
  src/cache.py         TTLCache (stale-on-error) + RateLimiter
  src/http.py          UpstreamClient base (timeouts, retry, UA, rate limit)
  src/uex.py           UexClient (terminals, commodities, items_prices, routes, commodity prices, game_versions)
  src/wiki.py          WikiClient (items, vehicle-items, missions, factions)
  src/names.py         normalise(), NameIndex (fuzzy resolve / candidates)
  src/tools_items.py   find_item(), compare_components()
  src/tools_missions.py faction_missions()
  src/tools_trade.py   trade_routes(), commodity_prices()
  src/tools_guides.py  GuideStore + org_guides() over the mounted ConfigMap
  src/server.py        FastMCP app: registers sc_* tools, /healthz, tracing, warmup
  src/tracing.py       OTLP setup
  tests/fixtures/*.json  recorded real responses
  tests/test_*.py
  scripts/capture_fixtures.py
k8s/sc-knowledge/     deployment.yaml, service.yaml, networkpolicy.yaml, README.md   (tracked, placeholders)
agent-sidecar/src/sc_tools.py      NEW: ScToolsProvider (toolset once + cached health probe)
agent-sidecar/src/{config,mcp_registry,agent,tools,server}.py   modified
agent-sidecar/eval/sc_eval_set.py, eval/eval_sc.py            NEW eval
voice-sidecar/src/sc_tools.py      NEW: ScToolExecutor (MCP client, declarations, call with timeout)
voice-sidecar/src/{config,live_bridge,server}.py              modified
scripts/smoke-voice-sc.js          NEW
scripts/sync-org-guides.sh         NEW (PDF text -> ConfigMap; guides never committed)
k8s/sandbox/agent-deployment.yaml, k8s/sandbox/agent-networkpolicy.yaml, k8s/voice/voice-deployment.yaml, k8s/voice/voice-networkpolicy.yaml  modified
CLAUDE.md, features.md, README.md  docs
```

---

### Task 1: sc-knowledge foundation — config, cache, rate limiter, upstream HTTP base

**Files:**
- Create: `sc-knowledge/requirements.txt`, `sc-knowledge/pyproject.toml`, `sc-knowledge/.dockerignore`, `sc-knowledge/src/__init__.py`, `sc-knowledge/src/config.py`, `sc-knowledge/src/cache.py`, `sc-knowledge/src/http.py`
- Test: `sc-knowledge/tests/__init__.py`, `sc-knowledge/tests/test_cache.py`, `sc-knowledge/tests/test_http.py`

**Interfaces:**
- Produces:
  - `config.Config` (frozen dataclass) fields: `listen_host: str`, `listen_port: int`, `uex_base: str`, `wiki_base: str`, `uex_bearer: str | None`, `version: str`, `otlp_endpoint: str | None`; `config.load() -> Config`.
  - `cache.TTLCache(clock=time.monotonic)`; `async get_or_fetch(key: str, ttl: float, fetch: Callable[[], Awaitable[Any]]) -> CacheResult`; `CacheResult(value: Any, status: Literal["hit","miss","stale"], age_s: float)`. On fetch exception: if an entry exists (even expired) return it with `status="stale"`; else re-raise.
  - `cache.RateLimiter(max_calls: int, per_seconds: float, clock=time.monotonic, sleep=asyncio.sleep)`; `async acquire()`.
  - `http.UpstreamError(Exception)` with `.upstream: str`, `.status: int | None`.
  - `http.UpstreamClient(name: str, base_url: str, headers: dict, limiter: RateLimiter, transport: httpx.AsyncBaseTransport | None = None, sleep=asyncio.sleep)`; `async get_json(path: str, params: dict | None = None) -> Any`; `async post_json(path, body) -> Any`; `async aclose()`.

- [ ] **Step 1: Create packaging files**

`sc-knowledge/requirements.txt`:
```
mcp>=2.2.0
httpx>=0.28.0
rapidfuzz>=3.10.0
uvicorn>=0.32.0
starlette>=0.41.0
opentelemetry-api>=1.45.0
opentelemetry-sdk>=1.45.0
opentelemetry-exporter-otlp>=1.45.0
pytest>=9.1.1
pytest-asyncio>=1.4.0
```
`sc-knowledge/pyproject.toml`:
```toml
[tool.pytest.ini_options]
pythonpath = ["."]
asyncio_mode = "auto"
testpaths = ["tests"]
```
`sc-knowledge/.dockerignore`:
```
.venv
tests
__pycache__
*.pyc
.env
*key*.json
```
Create empty `sc-knowledge/src/__init__.py` and `sc-knowledge/tests/__init__.py`. Create the venv: `cd sc-knowledge && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt` (if the host python is < 3.12, run tests in `docker run --rm -v $PWD:/w -w /w python:3.14-slim sh -c "pip install -q -r requirements.txt && python -m pytest -q"` instead).

- [ ] **Step 2: Write `src/config.py`**

```python
"""Environment-driven configuration for the sc-knowledge MCP server."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    listen_host: str
    listen_port: int
    uex_base: str
    wiki_base: str
    uex_bearer: str | None
    version: str
    otlp_endpoint: str | None


def load() -> Config:
    return Config(
        listen_host=os.environ.get("SC_LISTEN_HOST", "0.0.0.0"),
        listen_port=int(os.environ.get("SC_LISTEN_PORT", "8080")),
        uex_base=os.environ.get("UEX_BASE_URL", "https://api.uexcorp.uk/2.0"),
        wiki_base=os.environ.get("WIKI_BASE_URL", "https://api.star-citizen.wiki/api"),
        uex_bearer=os.environ.get("UEXCORP_BEARER") or None,
        version=os.environ.get("SC_KNOWLEDGE_VERSION", "dev"),
        otlp_endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or None,
    )
```

- [ ] **Step 3: Write failing cache tests** — `sc-knowledge/tests/test_cache.py`

```python
import pytest
from src.cache import TTLCache, RateLimiter


class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t


async def test_miss_then_hit_then_expire():
    clk = Clock(); c = TTLCache(clock=clk); calls = []
    async def fetch():
        calls.append(1); return len(calls)
    r1 = await c.get_or_fetch("k", 10, fetch)
    assert (r1.value, r1.status) == (1, "miss")
    clk.t += 5
    r2 = await c.get_or_fetch("k", 10, fetch)
    assert (r2.value, r2.status, r2.age_s) == (1, "hit", 5.0)
    clk.t += 6
    r3 = await c.get_or_fetch("k", 10, fetch)
    assert (r3.value, r3.status) == (2, "miss")


async def test_stale_on_error_serves_expired_entry():
    clk = Clock(); c = TTLCache(clock=clk)
    async def ok(): return "v1"
    async def boom(): raise RuntimeError("upstream down")
    await c.get_or_fetch("k", 10, ok)
    clk.t += 100
    r = await c.get_or_fetch("k", 10, boom)
    assert (r.value, r.status, r.age_s) == ("v1", "stale", 100.0)


async def test_error_without_entry_raises():
    c = TTLCache(clock=Clock())
    async def boom(): raise RuntimeError("down")
    with pytest.raises(RuntimeError):
        await c.get_or_fetch("k", 10, boom)


async def test_rate_limiter_sleeps_when_window_full():
    clk = Clock(); slept = []
    async def fake_sleep(s):
        slept.append(s); clk.t += s
    rl = RateLimiter(2, 60.0, clock=clk, sleep=fake_sleep)
    await rl.acquire(); await rl.acquire()
    await rl.acquire()
    assert slept and abs(slept[0] - 60.0) < 1e-6
```

- [ ] **Step 4: Run — expect FAIL** (`ModuleNotFoundError: src.cache`)

Run: `cd sc-knowledge && .venv/bin/python -m pytest tests/test_cache.py -q`

- [ ] **Step 5: Implement `src/cache.py`**

```python
"""In-process TTL cache with stale-on-error, and a sliding-window rate limiter."""
import asyncio
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal


@dataclass
class CacheResult:
    value: Any
    status: Literal["hit", "miss", "stale"]
    age_s: float


class TTLCache:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._data: dict[str, tuple[float, Any]] = {}  # key -> (stored_at, value)
        self._locks: dict[str, asyncio.Lock] = {}

    async def get_or_fetch(self, key: str, ttl: float,
                           fetch: Callable[[], Awaitable[Any]]) -> CacheResult:
        now = self._clock()
        entry = self._data.get(key)
        if entry and now - entry[0] < ttl:
            return CacheResult(entry[1], "hit", now - entry[0])
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = self._clock()
            entry = self._data.get(key)
            if entry and now - entry[0] < ttl:
                return CacheResult(entry[1], "hit", now - entry[0])
            try:
                value = await fetch()
            except Exception:
                if entry is not None:
                    return CacheResult(entry[1], "stale", now - entry[0])
                raise
            self._data[key] = (self._clock(), value)
            return CacheResult(value, "miss", 0.0)


class RateLimiter:
    def __init__(self, max_calls: int, per_seconds: float,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self._max = max_calls
        self._per = per_seconds
        self._clock = clock
        self._sleep = sleep
        self._stamps: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = self._clock()
                while self._stamps and now - self._stamps[0] >= self._per:
                    self._stamps.popleft()
                if len(self._stamps) < self._max:
                    self._stamps.append(now)
                    return
                await self._sleep(self._per - (now - self._stamps[0]))
```

- [ ] **Step 6: Run — expect PASS.** `cd sc-knowledge && .venv/bin/python -m pytest tests/test_cache.py -q`

- [ ] **Step 7: Write failing HTTP tests** — `sc-knowledge/tests/test_http.py`

```python
import httpx
import pytest
from src.cache import RateLimiter
from src.http import UpstreamClient, UpstreamError


def _client(handler, headers=None):
    async def nosleep(_): return None
    return UpstreamClient("uex", "https://x.test/2.0", headers or {"User-Agent": "ua"},
                          RateLimiter(1000, 60), transport=httpx.MockTransport(handler), sleep=nosleep)


async def test_get_json_sends_headers_and_params():
    seen = {}
    def handler(req):
        seen["url"] = str(req.url); seen["ua"] = req.headers["user-agent"]
        return httpx.Response(200, json={"status": "ok", "data": [1]})
    c = _client(handler)
    assert await c.get_json("/items", {"id_category": 83}) == {"status": "ok", "data": [1]}
    assert seen["url"] == "https://x.test/2.0/items?id_category=83" and seen["ua"] == "ua"


async def test_retries_503_then_succeeds():
    n = {"i": 0}
    def handler(req):
        n["i"] += 1
        return httpx.Response(503) if n["i"] < 3 else httpx.Response(200, json={"ok": 1})
    assert await _client(handler).get_json("/x") == {"ok": 1}
    assert n["i"] == 3


async def test_does_not_retry_404_and_raises_upstream_error():
    n = {"i": 0}
    def handler(req):
        n["i"] += 1; return httpx.Response(404)
    with pytest.raises(UpstreamError) as ei:
        await _client(handler).get_json("/x")
    assert ei.value.status == 404 and ei.value.upstream == "uex" and n["i"] == 1


async def test_network_error_after_retries_raises_upstream_error():
    def handler(req): raise httpx.ConnectError("boom")
    with pytest.raises(UpstreamError) as ei:
        await _client(handler).get_json("/x")
    assert ei.value.status is None
```

- [ ] **Step 8: Run — expect FAIL.** `.venv/bin/python -m pytest tests/test_http.py -q`

- [ ] **Step 9: Implement `src/http.py`**

```python
"""Shared async HTTP client for upstream APIs: timeouts, bounded jittered retry
on 429/5xx and network errors, rate limiting, honest identification."""
import asyncio
import random
from typing import Any, Awaitable, Callable

import httpx

from .cache import RateLimiter

_RETRY_STATUS = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 3  # 1 try + 2 retries


class UpstreamError(Exception):
    def __init__(self, upstream: str, status: int | None, detail: str) -> None:
        super().__init__(f"{upstream} {status}: {detail}")
        self.upstream = upstream
        self.status = status
        self.detail = detail


class UpstreamClient:
    def __init__(self, name: str, base_url: str, headers: dict, limiter: RateLimiter,
                 transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self.name = name
        self._limiter = limiter
        self._sleep = sleep
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            headers=headers,
            timeout=httpx.Timeout(8.0, connect=3.0),
            transport=transport,
        )

    async def _request(self, method: str, path: str, **kw) -> Any:
        last: UpstreamError | None = None
        for attempt in range(_MAX_ATTEMPTS):
            await self._limiter.acquire()
            try:
                resp = await self._http.request(method, path.lstrip("/"), **kw)
            except httpx.HTTPError as e:
                last = UpstreamError(self.name, None, f"{type(e).__name__}: {e}")
            else:
                if resp.status_code < 400:
                    return resp.json()
                last = UpstreamError(self.name, resp.status_code, resp.text[:500])
                if resp.status_code not in _RETRY_STATUS:
                    raise last
            if attempt < _MAX_ATTEMPTS - 1:
                await self._sleep(0.4 * (2 ** attempt) + random.uniform(0, 0.3))
        raise last  # type: ignore[misc]

    async def get_json(self, path: str, params: dict | None = None) -> Any:
        return await self._request("GET", path, params=params)

    async def post_json(self, path: str, body: dict) -> Any:
        return await self._request("POST", path, json=body)

    async def aclose(self) -> None:
        await self._http.aclose()
```

- [ ] **Step 10: Run all — expect PASS.** `.venv/bin/python -m pytest -q`

- [ ] **Step 11: Commit**

```bash
git add sc-knowledge/requirements.txt sc-knowledge/pyproject.toml sc-knowledge/.dockerignore sc-knowledge/src/__init__.py sc-knowledge/src/config.py sc-knowledge/src/cache.py sc-knowledge/src/http.py sc-knowledge/tests/__init__.py sc-knowledge/tests/test_cache.py sc-knowledge/tests/test_http.py
git commit -m "feat(sc-knowledge): config, TTL cache with stale-on-error, rate limiter, upstream client"
```

---

### Task 2: Upstream API clients + recorded fixtures

**Files:**
- Create: `sc-knowledge/src/uex.py`, `sc-knowledge/src/wiki.py`, `sc-knowledge/scripts/capture_fixtures.py`, `sc-knowledge/tests/fixtures/*.json`
- Test: `sc-knowledge/tests/conftest.py`, `sc-knowledge/tests/test_clients.py`

**Interfaces:**
- Consumes: `UpstreamClient`, `RateLimiter`, `Config`.
- Produces:
  - `uex.UexClient(upstream: UpstreamClient)` with async methods returning the `data` payload (list/dict): `game_versions() -> dict`, `terminals() -> list[dict]`, `commodities() -> list[dict]`, `commodities_routes(id_terminal_origin: int | None = None, id_terminal_destination: int | None = None, id_commodity: int | None = None) -> list[dict]`, `commodities_prices(id_commodity: int) -> list[dict]`, `items_prices(id_item: int) -> list[dict]`. Raises `UpstreamError` on non-`ok` status (`status` field != "ok").
  - `uex.build_uex(config, transport=None) -> UexClient` (UA + X-Client-Version + optional Bearer, limiter 120/60 s).
  - `wiki.WikiClient(upstream)`: `item(name_or_uuid: str) -> dict | None` (GET `v2/items/{name}`; 404 → None), `search_items(query: str) -> list[dict]` (GET `v2/items?filter[name]=<q>&limit=10`), `vehicle_items(type_: str, size: int | None) -> list[dict]` (GET `vehicle-items?filter[type]=&filter[size]=&limit=200`, follows `meta.last_page`), `missions(mission_giver: str) -> list[dict]` (GET `missions?filter[mission_giver]=&limit=200`, all pages), `factions() -> list[dict]` (GET `factions?limit=200`, all pages).
  - `wiki.build_wiki(config, transport=None) -> WikiClient` (UA, limiter 60/60 s).
  - Test fixture helper in `conftest.py`: `load_fixture(name: str) -> Any` and `fixture_transport(routes: dict[str, str]) -> httpx.MockTransport` mapping a path prefix (e.g. `"/2.0/terminals"`) to a fixture filename.

- [ ] **Step 1: Write `scripts/capture_fixtures.py`** (run once by the implementer against the live APIs; commit the JSON it writes)

```python
"""Capture real upstream responses into tests/fixtures (run manually; tests never hit the network).

Usage: cd sc-knowledge && UEXCORP_BEARER=... .venv/bin/python scripts/capture_fixtures.py
"""
import json
import os
import pathlib
import urllib.parse
import urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures"
UEX = "https://api.uexcorp.uk/2.0"
WIKI = "https://api.star-citizen.wiki/api"
TOKEN = os.environ.get("UEXCORP_BEARER")

CAPTURES = {
    "uex_game_versions.json": f"{UEX}/game_versions",
    "uex_terminals.json": f"{UEX}/terminals",
    "uex_commodities.json": f"{UEX}/commodities",
    "uex_routes_mic_l5.json": f"{UEX}/commodities_routes?id_terminal_origin=58",
    "uex_commodity_prices_79.json": f"{UEX}/commodities_prices?id_commodity=79",
    "uex_items_prices_5601.json": f"{UEX}/items_prices?id_item=5601",
    "wiki_item_v801_12.json": f"{WIKI}/v2/items/V801-12",
    "wiki_items_search_v801.json": f"{WIKI}/v2/items?" + urllib.parse.urlencode({"filter[name]": "V801", "limit": 10}),
    "wiki_vehicle_items_shield_s2.json": f"{WIKI}/vehicle-items?" + urllib.parse.urlencode({"filter[type]": "Shield", "filter[size]": 2, "limit": 200}),
    "wiki_missions_foxwell.json": f"{WIKI}/missions?" + urllib.parse.urlencode({"filter[mission_giver]": "Foxwell Enforcement", "limit": 200}),
    "wiki_factions.json": f"{WIKI}/factions?limit=200",
}


def fetch(url: str) -> dict:
    headers = {"User-Agent": "revenant-discord-bot/fixture-capture", "Accept": "application/json"}
    if url.startswith(UEX) and TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        return json.load(r)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, url in CAPTURES.items():
        (OUT / name).write_text(json.dumps(fetch(url), indent=1))
        print("wrote", name)
```

Run it (source the repo `.env` for `UEXCORP_BEARER`: `set -a; . ../.env; set +a`). If a fixture exceeds 2 MB (e.g. `uex_terminals.json`), keep it — tests need realistic name data — but verify it contains no auth material (it won't; these are public data responses).

- [ ] **Step 2: Write `tests/conftest.py`**

```python
import json
import pathlib

import httpx

FIX = pathlib.Path(__file__).parent / "fixtures"


def load_fixture(name: str):
    return json.loads((FIX / name).read_text())


def fixture_transport(routes: dict[str, str]) -> httpx.MockTransport:
    """routes: path-prefix (as seen by the server, e.g. '/2.0/terminals' or
    '/api/v2/items/V801-12') -> fixture filename. Longest prefix wins.
    Unmatched -> 404."""
    ordered = sorted(routes.items(), key=lambda kv: -len(kv[0]))

    def handler(req: httpx.Request) -> httpx.Response:
        for prefix, fname in ordered:
            if req.url.path.startswith(prefix):
                return httpx.Response(200, json=load_fixture(fname))
        return httpx.Response(404, json={"status": "not_found"})
    return httpx.MockTransport(handler)
```

- [ ] **Step 3: Write failing client tests** — `tests/test_clients.py`

```python
from src.config import load
from src.uex import build_uex
from src.wiki import build_wiki
from tests.conftest import fixture_transport


async def test_uex_parses_data_payloads():
    uex = build_uex(load(), transport=fixture_transport({
        "/2.0/game_versions": "uex_game_versions.json",
        "/2.0/terminals": "uex_terminals.json",
        "/2.0/commodities_routes": "uex_routes_mic_l5.json",
        "/2.0/items_prices": "uex_items_prices_5601.json",
    }))
    assert (await uex.game_versions())["live"]
    terms = await uex.terminals()
    assert any(t["nickname"] == "MIC-L5" or "MIC-L5" in t["name"] for t in terms)
    routes = await uex.commodities_routes(id_terminal_origin=58)
    assert routes and {"commodity_name", "price_origin", "price_destination", "profit"} <= set(routes[0])
    prices = await uex.items_prices(5601)
    assert prices[0]["price_buy"] > 0 and prices[0]["terminal_name"]


async def test_wiki_item_and_404_and_pagination_single_page():
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/v2/items/V801-12": "wiki_item_v801_12.json",
        "/api/vehicle-items": "wiki_vehicle_items_shield_s2.json",
        "/api/missions": "wiki_missions_foxwell.json",
    }))
    item = await wiki.item("V801-12")
    assert item["name"] == "V801-12" and item["type"] == "Radar"
    assert await wiki.item("NoSuchThing-999") is None
    shields = await wiki.vehicle_items("Shield", 2)
    assert len(shields) >= 10 and all(s["size"] == 2 for s in shields)
    missions = await wiki.missions("Foxwell Enforcement")
    assert len(missions) >= 50
```

- [ ] **Step 4: Run — expect FAIL** (`ModuleNotFoundError: src.uex`).

- [ ] **Step 5: Implement `src/uex.py`**

```python
"""UEX Corp API v2 client. Every endpoint returns {"status": "ok", "data": ...}."""
import httpx

from .cache import RateLimiter
from .config import Config
from .http import UpstreamClient, UpstreamError


class UexClient:
    def __init__(self, upstream: UpstreamClient) -> None:
        self._u = upstream

    async def _data(self, path: str, params: dict | None = None):
        body = await self._u.get_json(path, {k: v for k, v in (params or {}).items() if v is not None})
        if not isinstance(body, dict) or body.get("status") != "ok":
            raise UpstreamError("uex", None, f"non-ok status for {path}: {str(body)[:300]}")
        return body.get("data")

    async def game_versions(self) -> dict:
        return await self._data("game_versions")

    async def terminals(self) -> list[dict]:
        return await self._data("terminals")

    async def commodities(self) -> list[dict]:
        return await self._data("commodities")

    async def commodities_routes(self, id_terminal_origin: int | None = None,
                                 id_terminal_destination: int | None = None,
                                 id_commodity: int | None = None) -> list[dict]:
        return await self._data("commodities_routes", {
            "id_terminal_origin": id_terminal_origin,
            "id_terminal_destination": id_terminal_destination,
            "id_commodity": id_commodity,
        })

    async def commodities_prices(self, id_commodity: int) -> list[dict]:
        return await self._data("commodities_prices", {"id_commodity": id_commodity})

    async def items_prices(self, id_item: int) -> list[dict]:
        return await self._data("items_prices", {"id_item": id_item})


def build_uex(config: Config, transport: httpx.AsyncBaseTransport | None = None) -> UexClient:
    headers = {
        "User-Agent": f"revenant-discord-bot/{config.version}",
        "X-Client-Version": f"revenant-sc-knowledge/{config.version}",
        "Accept": "application/json",
    }
    if config.uex_bearer:
        headers["Authorization"] = f"Bearer {config.uex_bearer}"
    return UexClient(UpstreamClient("uex", config.uex_base, headers, RateLimiter(120, 60.0),
                                    transport=transport))
```

- [ ] **Step 6: Implement `src/wiki.py`**

```python
"""Star Citizen Wiki API client (per-patch extracted game data + embedded UEX prices)."""
from urllib.parse import quote

import httpx

from .cache import RateLimiter
from .config import Config
from .http import UpstreamClient, UpstreamError

_MAX_PAGES = 20


class WikiClient:
    def __init__(self, upstream: UpstreamClient) -> None:
        self._u = upstream

    async def _all_pages(self, path: str, params: dict) -> list[dict]:
        out: list[dict] = []
        page = 1
        while page <= _MAX_PAGES:
            body = await self._u.get_json(path, {**params, "page": page})
            out.extend(body.get("data") or [])
            last = (body.get("meta") or {}).get("last_page") or 1
            if page >= last:
                break
            page += 1
        return out

    async def item(self, name_or_uuid: str) -> dict | None:
        try:
            body = await self._u.get_json(f"v2/items/{quote(name_or_uuid, safe='')}")
        except UpstreamError as e:
            if e.status == 404:
                return None
            raise
        return body.get("data") if isinstance(body, dict) else None

    async def search_items(self, query: str) -> list[dict]:
        body = await self._u.get_json("v2/items", {"filter[name]": query, "limit": 10})
        return body.get("data") or []

    async def vehicle_items(self, type_: str, size: int | None) -> list[dict]:
        params = {"filter[type]": type_, "limit": 200}
        if size is not None:
            params["filter[size]"] = size
        return await self._all_pages("vehicle-items", params)

    async def missions(self, mission_giver: str) -> list[dict]:
        return await self._all_pages("missions", {"filter[mission_giver]": mission_giver, "limit": 200})

    async def factions(self) -> list[dict]:
        return await self._all_pages("factions", {"limit": 200})


def build_wiki(config: Config, transport: httpx.AsyncBaseTransport | None = None) -> WikiClient:
    headers = {"User-Agent": f"revenant-discord-bot/{config.version}", "Accept": "application/json"}
    return WikiClient(UpstreamClient("wiki", config.wiki_base, headers, RateLimiter(60, 60.0),
                                     transport=transport))
```

- [ ] **Step 7: Run all tests — expect PASS.** If the vehicle-items fixture has a `meta.last_page` > 1, the mock transport returns the same page for every `page=` — that's fine for the assertion but confirm `_all_pages` stops at `_MAX_PAGES`; if it loops 20 times, change the fixture capture `limit` so `last_page == 1`.

- [ ] **Step 8: Commit**

```bash
git add sc-knowledge/src/uex.py sc-knowledge/src/wiki.py sc-knowledge/scripts/capture_fixtures.py sc-knowledge/tests/conftest.py sc-knowledge/tests/test_clients.py sc-knowledge/tests/fixtures/
git commit -m "feat(sc-knowledge): UEX and Star Citizen Wiki API clients with recorded fixtures"
```

---

### Task 3: Name index (fuzzy resolution)

**Files:**
- Create: `sc-knowledge/src/names.py`
- Test: `sc-knowledge/tests/test_names.py`

**Interfaces:**
- Produces:
  - `names.normalise(s: str) -> str` — lowercase, strip everything that isn't `[a-z0-9]`. `"Admin - MIC-L5"` → `"adminmicl5"`, `"MIC-L5"` → `"micl5"`.
  - `names.Entry(kind: str, id: int | str, name: str, aliases: tuple[str, ...], data: dict)`.
  - `names.Resolution(status: Literal["exact","fuzzy","ambiguous","not_found"], match: Entry | None, candidates: list[Entry])`.
  - `names.NameIndex()`; `add(entry: Entry)`; `resolve(query: str, kind: str | None = None) -> Resolution`; `entries(kind: str) -> list[Entry]`.
  - `names.terminal_entries(terminals: list[dict]) -> list[Entry]` (kind `"terminal"`, aliases from `name`, `nickname`, `code`, `displayname`, `fullname`, and the name with a leading `"Admin - "` stripped); `names.commodity_entries(commodities: list[dict])` (kind `"commodity"`, aliases `name`, `code`, `slug`); `names.faction_entries(factions: list[dict])` (kind `"faction"`, id = `uuid`, alias `name`).
  - Resolution rules: normalised exact match on any alias → `exact` (if exactly one entry; >1 distinct entries → `ambiguous` with them as candidates). Else a normalised substring match (query contained in an alias or alias contained in query, min query length 3) with exactly one entry → `fuzzy`. Else `rapidfuzz.process.extract` (scorer `fuzz.WRatio`) over all aliases of that kind: top score ≥ 88 and ≥ 8 points above the next distinct entry → `fuzzy`; top ≥ 60 → `ambiguous` with the top 5 distinct entries; else `not_found` with the top 5 (score ≥ 40) as candidates.

- [ ] **Step 1: Write failing tests** — `tests/test_names.py`

```python
from src.names import NameIndex, normalise, terminal_entries, commodity_entries
from tests.conftest import load_fixture


def _idx():
    idx = NameIndex()
    for e in terminal_entries(load_fixture("uex_terminals.json")["data"]):
        idx.add(e)
    for e in commodity_entries(load_fixture("uex_commodities.json")["data"]):
        idx.add(e)
    return idx


def test_normalise():
    assert normalise("Admin - MIC-L5") == "adminmicl5"
    assert normalise("  MIC L5 ") == "micl5"


def test_mic_l5_variants_resolve_to_terminal_58():
    idx = _idx()
    for q in ("MIC-L5", "micl5", "Admin - MIC-L5", "mic l5"):
        r = idx.resolve(q, kind="terminal")
        assert r.match is not None and r.match.id == 58, (q, r.status, [c.name for c in r.candidates])


def test_commodity_fuzzy_typo():
    r = _idx().resolve("Laranite", kind="commodity")
    assert r.match is not None and r.match.name.lower().startswith("laranite")


def test_nonsense_is_not_found_with_no_match():
    r = _idx().resolve("zzqqxx", kind="commodity")
    assert r.status == "not_found" and r.match is None


def test_ambiguous_returns_candidates():
    idx = NameIndex()
    from src.names import Entry
    idx.add(Entry("terminal", 1, "Port Olisar Admin", ("Port Olisar Admin",), {}))
    idx.add(Entry("terminal", 2, "Port Olisar Cargo", ("Port Olisar Cargo",), {}))
    r = idx.resolve("Port Olisar", kind="terminal")
    assert r.status == "ambiguous" and {c.id for c in r.candidates} == {1, 2}
```

(If `Laranite` isn't in the captured commodities fixture, pick any commodity name present and misspell it by one letter.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/names.py`**

```python
"""Fuzzy name index for terminals, commodities, factions (and anything else)."""
import re
from dataclasses import dataclass, field
from typing import Literal

from rapidfuzz import fuzz, process

_NON_ALNUM = re.compile(r"[^a-z0-9]")


def normalise(s: str) -> str:
    return _NON_ALNUM.sub("", (s or "").lower())


@dataclass(frozen=True)
class Entry:
    kind: str
    id: int | str
    name: str
    aliases: tuple[str, ...]
    data: dict = field(default_factory=dict, compare=False, hash=False)


@dataclass
class Resolution:
    status: Literal["exact", "fuzzy", "ambiguous", "not_found"]
    match: Entry | None
    candidates: list[Entry]


class NameIndex:
    def __init__(self) -> None:
        self._by_kind: dict[str, list[Entry]] = {}

    def add(self, entry: Entry) -> None:
        self._by_kind.setdefault(entry.kind, []).append(entry)

    def entries(self, kind: str) -> list[Entry]:
        return list(self._by_kind.get(kind, []))

    def resolve(self, query: str, kind: str | None = None) -> Resolution:
        pool = self.entries(kind) if kind else [e for es in self._by_kind.values() for e in es]
        q = normalise(query)
        if not q or not pool:
            return Resolution("not_found", None, [])
        exact = _distinct([e for e in pool if any(normalise(a) == q for a in e.aliases)])
        if len(exact) == 1:
            return Resolution("exact", exact[0], [])
        if len(exact) > 1:
            return Resolution("ambiguous", None, exact[:5])
        if len(q) >= 3:
            sub = _distinct([e for e in pool if any(q in normalise(a) or (normalise(a) and normalise(a) in q and len(normalise(a)) >= 3) for a in e.aliases)])
            if len(sub) == 1:
                return Resolution("fuzzy", sub[0], [])
        choices = [(normalise(a), e) for e in pool for a in e.aliases if a]
        scored = process.extract(q, [c[0] for c in choices], scorer=fuzz.WRatio, limit=50)
        ranked: list[tuple[float, Entry]] = []
        seen: set = set()
        for _, score, i in scored:
            e = choices[i][1]
            key = (e.kind, e.id)
            if key in seen:
                continue
            seen.add(key)
            ranked.append((score, e))
        if not ranked:
            return Resolution("not_found", None, [])
        top_score, top = ranked[0]
        next_score = ranked[1][0] if len(ranked) > 1 else 0
        if top_score >= 88 and top_score - next_score >= 8:
            return Resolution("fuzzy", top, [])
        if top_score >= 60:
            return Resolution("ambiguous", None, [e for _, e in ranked[:5]])
        return Resolution("not_found", None, [e for s, e in ranked[:5] if s >= 40])


def _distinct(entries: list[Entry]) -> list[Entry]:
    seen, out = set(), []
    for e in entries:
        if (e.kind, e.id) not in seen:
            seen.add((e.kind, e.id))
            out.append(e)
    return out


def terminal_entries(terminals: list[dict]) -> list[Entry]:
    out = []
    for t in terminals:
        name = t.get("name") or ""
        aliases = {name, t.get("nickname") or "", t.get("code") or "", t.get("displayname") or "",
                   t.get("fullname") or ""}
        if name.startswith("Admin - "):
            aliases.add(name[len("Admin - "):])
        out.append(Entry("terminal", t["id"], name, tuple(a for a in aliases if a), t))
    return out


def commodity_entries(commodities: list[dict]) -> list[Entry]:
    return [Entry("commodity", c["id"], c.get("name") or "",
                  tuple(a for a in {c.get("name"), c.get("code"), c.get("slug")} if a), c)
            for c in commodities]


def faction_entries(factions: list[dict]) -> list[Entry]:
    return [Entry("faction", f.get("uuid") or f.get("name"), f.get("name") or "",
                  tuple(a for a in {f.get("name")} if a), f)
            for f in factions]
```

- [ ] **Step 4: Run — expect PASS.** If `test_mic_l5_variants_resolve_to_terminal_58` fails because several terminals share "MIC-L5" (e.g. a commodity admin terminal and an item shop at the same station), make the test and implementation agree that `resolve()` prefers the `type == "commodity"` terminal only via the caller: change the test to assert `58 in {c.id for c in ([r.match] if r.match else r.candidates)}` and leave route origin disambiguation to Task 6 (which accepts all terminals at a resolved location).

- [ ] **Step 5: Commit**

```bash
git add sc-knowledge/src/names.py sc-knowledge/tests/test_names.py
git commit -m "feat(sc-knowledge): fuzzy name index for terminals, commodities, factions"
```

---

### Task 4: Item tools — `find_item`, `compare_components`

**Files:**
- Create: `sc-knowledge/src/tools_items.py`, `sc-knowledge/src/envelope.py`
- Test: `sc-knowledge/tests/test_tools_items.py`

**Interfaces:**
- Consumes: `WikiClient`, `UexClient`, `TTLCache`, `UpstreamError`.
- Produces:
  - `envelope.error(code: str, detail: str, stale_fallback: bool = False, **extra) -> dict`; `envelope.freshness(res: CacheResult) -> dict` returns `{}` for hit/miss and `{"stale": True, "age_minutes": round(age_s/60)}` for stale.
  - `tools_items.ItemTools(wiki: WikiClient, cache: TTLCache)`.
  - `async ItemTools.find_item(name: str) -> dict` → `{"source": "star-citizen.wiki (+UEX prices)", "game_version": str, "item": {name, type, sub_type, size, grade, class, manufacturer, key_stats: dict}, "where_to_buy": [{"shop": str, "location": str, "system": str, "price_auec": int, "reported_at": str}], "alternatives": [str]}` sorted by `price_auec` ascending; `where_to_buy == []` with `"note": "No player-reported shop listings on UEX"` when empty. Not found → `error("not_found", ..., candidates=[names])`.
  - `async ItemTools.compare_components(type: str, size: int, rank_by: str | None = None, grade: str | None = None, class_: str | None = None, limit: int = 5) -> dict` → `{"source", "game_version", "type", "size", "ranked_by": str, "results": [{"name", "manufacturer", "grade", "class", "stats": dict, "cheapest": {"shop","location","price_auec"} | None}]}`.
  - `COMPONENT_TYPES: dict[str, dict]` mapping friendly type → `{"wiki_type": str, "stat_key": str, "stats": dict[str, str], "default_rank": str}`:
    - `shield`: wiki `Shield`, block `shield`, stats `{"max_health": "max_health", "regen_rate": "regen_rate", "regen_delay_damage_s": "regen_delay.damage"}`, default rank `max_health` (ties broken by `regen_rate`).
    - `power_plant`: wiki `PowerPlant`, block `power_plant`, default rank `power_output` (implementer: read the actual stat key name from a live `vehicle-items?filter[type]=PowerPlant&limit=1` response and record the chosen dotted paths here in code comments).
    - `cooler`: wiki `Cooler`, block `cooler`, default rank `cooling_rate`.
    - `quantum_drive`: wiki `QuantumDrive`, block `quantum_drive`, default rank `speed` (dotted path from live data).
    - `radar`: wiki `Radar`, block `radar`, default rank `detection_lifetime` or the equivalent sensitivity field from live data.
    - `weapon`: wiki `WeaponGun`, block `weapon`, default rank `dps` (dotted path from live data).
    - `missile`: wiki `Missile`, block `missile`, default rank `damage` (dotted path from live data).
    For every type except `shield`, the implementer MUST capture one live sample into `tests/fixtures/wiki_vehicle_items_<type>_sample.json` via `capture_fixtures.py` (add entries) and set the dotted paths from it — do not guess field names.
  - Dotted-path getter `_get(d: dict, path: str)` returning `None` when any segment is missing.
  - Cache keys `wiki:item:<normalised name>` (TTL 43200) and `wiki:vi:<wiki_type>:<size>` (TTL 43200).

- [ ] **Step 1: Write failing tests** — `tests/test_tools_items.py`

```python
from src.cache import TTLCache
from src.config import load
from src.tools_items import ItemTools
from src.wiki import build_wiki
from tests.conftest import fixture_transport


def _tools():
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/v2/items/V801-12": "wiki_item_v801_12.json",
        "/api/v2/items": "wiki_items_search_v801.json",
        "/api/vehicle-items": "wiki_vehicle_items_shield_s2.json",
    }))
    return ItemTools(wiki, TTLCache())


async def test_find_item_v801_12_where_to_buy():
    r = await _tools().find_item("V801-12")
    assert r["item"]["name"] == "V801-12" and r["item"]["type"] == "Radar" and r["item"]["size"] == 2
    top = r["where_to_buy"][0]
    assert top["price_auec"] == 352000 and "New Babbage" in top["location"] and top["reported_at"]
    assert r["game_version"].startswith("4.")


async def test_find_item_falls_back_to_search_and_offers_alternatives():
    r = await _tools().find_item("V801")
    assert "error" in r and r["error"] == "ambiguous"
    assert set(r["candidates"]) >= {"V801-11", "V801-12"}


async def test_compare_size2_shields_ranked_by_health_then_regen():
    r = await _tools().compare_components("shield", 2, limit=5)
    names = [x["name"] for x in r["results"]]
    assert r["ranked_by"] == "max_health"
    assert r["results"][0]["stats"]["max_health"] >= r["results"][-1]["stats"]["max_health"]
    assert names.index("FR-76") < names.index("SecureShield")  # same health, better regen first


async def test_compare_rank_by_regen():
    r = await _tools().compare_components("shield", 2, rank_by="regen_rate", limit=3)
    assert r["results"][0]["name"] == "FR-76"


async def test_compare_unknown_type_is_bad_request():
    r = await _tools().compare_components("banana", 2)
    assert r["error"] == "bad_request" and "shield" in r["detail"]
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/envelope.py`**

```python
"""Uniform result/error envelopes. Tools never raise across the MCP boundary."""
from .cache import CacheResult


def error(code: str, detail: str, stale_fallback: bool = False, **extra) -> dict:
    return {"error": code, "detail": detail, "stale_fallback": stale_fallback, **extra}


def freshness(res: CacheResult) -> dict:
    if res.status == "stale":
        return {"stale": True, "age_minutes": round(res.age_s / 60)}
    return {}
```

- [ ] **Step 4: Implement `src/tools_items.py`**

```python
"""find_item / compare_components over the Star Citizen Wiki API (which embeds UEX shop prices)."""
from .cache import TTLCache
from .envelope import error, freshness
from .http import UpstreamError
from .names import normalise
from .wiki import WikiClient

_TTL = 43200
SOURCE = "star-citizen.wiki (+UEX prices)"

COMPONENT_TYPES: dict[str, dict] = {
    "shield": {"wiki_type": "Shield", "stat_key": "shield",
               "stats": {"max_health": "max_health", "regen_rate": "regen_rate",
                         "regen_delay_damage_s": "regen_delay.damage"},
               "default_rank": "max_health", "tiebreak": "regen_rate"},
    # The entries below MUST have their dotted stat paths confirmed against a
    # captured live sample (tests/fixtures/wiki_vehicle_items_<type>_sample.json).
    "power_plant": {"wiki_type": "PowerPlant", "stat_key": "power_plant", "stats": {}, "default_rank": ""},
    "cooler": {"wiki_type": "Cooler", "stat_key": "cooler", "stats": {}, "default_rank": ""},
    "quantum_drive": {"wiki_type": "QuantumDrive", "stat_key": "quantum_drive", "stats": {}, "default_rank": ""},
    "radar": {"wiki_type": "Radar", "stat_key": "radar", "stats": {}, "default_rank": ""},
    "weapon": {"wiki_type": "WeaponGun", "stat_key": "weapon", "stats": {}, "default_rank": ""},
    "missile": {"wiki_type": "Missile", "stat_key": "missile", "stats": {}, "default_rank": ""},
}


def _get(d, path: str):
    cur = d
    for seg in path.split("."):
        if not isinstance(cur, dict) or seg not in cur:
            return None
        cur = cur[seg]
    return cur


def _shops(item: dict) -> list[dict]:
    out = []
    for p in ((item.get("uex_prices") or {}).get("purchase") or []):
        if not p.get("price_buy"):
            continue
        loc = p.get("starmap_location") or {}
        location = ", ".join(x for x in (loc.get("name"), loc.get("parent_name")) if x)
        out.append({"shop": p.get("terminal_name"), "location": location,
                    "system": loc.get("star_system_name"), "price_auec": int(p["price_buy"]),
                    "reported_at": p.get("date_updated")})
    return sorted(out, key=lambda s: s["price_auec"])


def _summary(item: dict) -> dict:
    mfr = item.get("manufacturer") or {}
    ct = next((c for c in COMPONENT_TYPES.values() if c["wiki_type"] == item.get("type")), None)
    stats = {}
    if ct:
        block = item.get(ct["stat_key"]) or {}
        stats = {k: _get(block, p) for k, p in ct["stats"].items()}
    return {"name": item.get("name"), "type": item.get("type"), "sub_type": item.get("sub_type"),
            "size": item.get("size"), "grade": item.get("grade"), "class": item.get("class"),
            "manufacturer": mfr.get("name"), "key_stats": stats}


class ItemTools:
    def __init__(self, wiki: WikiClient, cache: TTLCache) -> None:
        self._wiki = wiki
        self._cache = cache

    async def find_item(self, name: str) -> dict:
        try:
            res = await self._cache.get_or_fetch(f"wiki:item:{normalise(name)}", _TTL,
                                                 lambda: self._wiki.item(name))
            item = res.value
            if item is None:
                hits = await self._wiki.search_items(name)
                exact = [h for h in hits if normalise(h.get("name", "")) == normalise(name)]
                if len(exact) == 1:
                    item = exact[0]
                elif len(hits) == 1:
                    item = hits[0]
                elif hits:
                    return error("ambiguous", f"'{name}' matches several items",
                                 candidates=[h.get("name") for h in hits[:5]])
                else:
                    return error("not_found", f"no item named '{name}'", candidates=[])
        except UpstreamError as e:
            return error("wiki_unavailable", str(e))
        shops = _shops(item)
        out = {"source": SOURCE, "game_version": item.get("version"),
               "item": _summary(item), "where_to_buy": shops,
               "alternatives": [v.get("name") for v in (item.get("variants") or [])[:3] if isinstance(v, dict)],
               **freshness(res)}
        if not shops:
            out["note"] = "No player-reported shop listings on UEX for this item (it may be loot/craft/pledge-only)."
        return out

    async def compare_components(self, type: str, size: int, rank_by: str | None = None,
                                 grade: str | None = None, class_: str | None = None,
                                 limit: int = 5) -> dict:
        ct = COMPONENT_TYPES.get((type or "").lower().replace(" ", "_"))
        if ct is None:
            return error("bad_request", f"unknown component type '{type}'; use one of {sorted(COMPONENT_TYPES)}")
        rank = rank_by or ct["default_rank"]
        if rank not in ct["stats"]:
            return error("bad_request", f"rank_by must be one of {sorted(ct['stats'])}")
        try:
            res = await self._cache.get_or_fetch(f"wiki:vi:{ct['wiki_type']}:{size}", _TTL,
                                                 lambda: self._wiki.vehicle_items(ct["wiki_type"], size))
        except UpstreamError as e:
            return error("wiki_unavailable", str(e))
        rows = []
        for it in res.value:
            if grade and (it.get("grade") or "").upper() != grade.upper():
                continue
            if class_ and (it.get("class") or "").lower() != class_.lower():
                continue
            block = it.get(ct["stat_key"]) or {}
            stats = {k: _get(block, p) for k, p in ct["stats"].items()}
            if stats.get(rank) is None:
                continue
            shops = _shops(it)
            rows.append({"name": it.get("name"), "manufacturer": (it.get("manufacturer") or {}).get("name"),
                         "grade": it.get("grade"), "class": it.get("class"), "stats": stats,
                         "cheapest": ({k: shops[0][k] for k in ("shop", "location", "price_auec")} if shops else None)})
        tie = ct.get("tiebreak")
        rows.sort(key=lambda r: (r["stats"][rank], (r["stats"].get(tie) or 0) if tie else 0), reverse=True)
        gv = next((it.get("version") for it in res.value if it.get("version")), None)
        return {"source": SOURCE, "game_version": gv, "type": type, "size": size, "ranked_by": rank,
                "results": rows[:max(1, min(limit, 20))], **freshness(res)}
```

- [ ] **Step 5: Complete `COMPONENT_TYPES` for the non-shield types.** For each of `PowerPlant, Cooler, QuantumDrive, Radar, WeaponGun, Missile`: add a capture entry `wiki_vehicle_items_<type>_sample.json` = `vehicle-items?filter[type]=<T>&limit=3` to `scripts/capture_fixtures.py`, run it, open the JSON, and fill `stats` (2–4 dotted paths of the numbers a player compares) and `default_rank` with real keys. Add one test per type asserting `compare_components(<type>, <a size present in the sample>)` returns ≥1 result with a non-None `stats[default_rank]` (use a `fixture_transport` routing `/api/vehicle-items` to that sample). Never leave `default_rank == ""`.

- [ ] **Step 6: Run all tests — expect PASS.**

- [ ] **Step 7: Commit**

```bash
git add sc-knowledge/src/envelope.py sc-knowledge/src/tools_items.py sc-knowledge/tests/test_tools_items.py sc-knowledge/scripts/capture_fixtures.py sc-knowledge/tests/fixtures/
git commit -m "feat(sc-knowledge): sc_find_item and sc_compare_components"
```

---

### Task 5: Mission tool — `faction_missions`

**Files:**
- Create: `sc-knowledge/src/tools_missions.py`
- Test: `sc-knowledge/tests/test_tools_missions.py`

**Interfaces:**
- Consumes: `WikiClient.missions()`, `WikiClient.factions()`, `NameIndex`, `faction_entries`, `TTLCache`, `envelope`.
- Produces: `tools_missions.MissionTools(wiki: WikiClient, cache: TTLCache)`; `async faction_missions(faction: str, current_rank: str | None = None, system: str | None = None, limit: int = 10) -> dict` →
  `{"source": "star-citizen.wiki", "game_version": str, "faction": str, "rank_ladder": [{"name": str, "min_reputation": int}], "current_rank": str | None, "missions": [{"title", "rep_per_minute": float, "reputation_gained": int, "minutes": int, "reward_auec": int | None, "min_rank": str, "max_rank": str, "systems": [str], "cooldown": str | None, "has_prerequisites": bool, "has_chain": bool, "once_only": bool, "legal": bool}], "notes": [str]}`.
  - Faction name resolution: exact/fuzzy over `faction_entries(await wiki.factions())` (cached `wiki:factions`, TTL 43200); pass the resolved canonical name to `wiki.missions()` (cached `wiki:missions:<name>`, TTL 43200).
  - `reputation_gained` source: the mission's `reputation_gained` field if numeric, else `reputation_amount`; skip missions where it is null/≤0 or `time_to_complete_minutes` is null/≤0 (count skipped in a note).
  - Rank ladder: distinct `(min_standing.name, min_standing.min_reputation)` pairs across missions, sorted by `min_reputation`.
  - `current_rank` filter (fuzzy match against ladder names): keep missions with `min_standing.min_reputation <= rank_rep` and (`max_standing` missing or `max_standing.min_reputation >= rank_rep`).
  - `system` filter: case-insensitive membership in `star_systems`.
  - Exclude `not_for_release` / `work_in_progress` missions.
  - De-duplicate by `title` keeping the best rep/min.
  - Sort by `rep_per_minute` desc; `notes` always includes `"rep_per_minute = reputation_gained / time_to_complete_minutes (game-data estimate; real time varies)"`.

- [ ] **Step 1: Write failing tests** — `tests/test_tools_missions.py`

```python
from src.cache import TTLCache
from src.config import load
from src.tools_missions import MissionTools
from src.wiki import build_wiki
from tests.conftest import fixture_transport


def _tools():
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/missions": "wiki_missions_foxwell.json",
        "/api/factions": "wiki_factions.json",
    }))
    return MissionTools(wiki, TTLCache())


async def test_foxwell_sorted_by_rep_per_minute():
    r = await _tools().faction_missions("Foxwell Enforcement", limit=10)
    rpm = [m["rep_per_minute"] for m in r["missions"]]
    assert rpm == sorted(rpm, reverse=True) and len(r["missions"]) <= 10
    assert r["rank_ladder"] and r["rank_ladder"][0]["min_reputation"] <= r["rank_ladder"][-1]["min_reputation"]


async def test_fuzzy_faction_name():
    r = await _tools().faction_missions("foxwell", limit=3)
    assert r["faction"] == "Foxwell Enforcement"


async def test_rank_filter_excludes_higher_rank_missions():
    t = _tools()
    full = await t.faction_missions("Foxwell Enforcement", limit=200)
    low = full["rank_ladder"][0]["name"]
    r = await t.faction_missions("Foxwell Enforcement", current_rank=low, limit=200)
    ladder = {x["name"]: x["min_reputation"] for x in full["rank_ladder"]}
    assert all(ladder[m["min_rank"]] <= ladder[low] for m in r["missions"])


async def test_unknown_faction_not_found():
    r = await _tools().faction_missions("Zzqq Nonexistent Corp")
    assert r["error"] in ("not_found", "ambiguous")
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/tools_missions.py`** following the Interfaces exactly (resolve faction via `NameIndex` built from cached factions; fetch missions; compute; filter; sort; envelope `freshness` of the missions cache result; catch `UpstreamError` → `error("wiki_unavailable", ...)`; resolution `not_found`/`ambiguous` → `error(<status>, ..., candidates=[e.name for e in r.candidates])`).

```python
"""faction_missions: rank ladder + missions ranked by reputation per minute."""
from .cache import TTLCache
from .envelope import error, freshness
from .http import UpstreamError
from .names import NameIndex, faction_entries, normalise
from .wiki import WikiClient

_TTL = 43200
SOURCE = "star-citizen.wiki"
_NOTE = "rep_per_minute = reputation_gained / time_to_complete_minutes (game-data estimate; real time varies)"


def _rep(m: dict):
    for k in ("reputation_gained", "reputation_amount"):
        v = m.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return v
    return None


class MissionTools:
    def __init__(self, wiki: WikiClient, cache: TTLCache) -> None:
        self._wiki = wiki
        self._cache = cache

    async def _resolve_faction(self, faction: str):
        res = await self._cache.get_or_fetch("wiki:factions", _TTL, self._wiki.factions)
        idx = NameIndex()
        for e in faction_entries(res.value):
            idx.add(e)
        return idx.resolve(faction, kind="faction")

    async def faction_missions(self, faction: str, current_rank: str | None = None,
                               system: str | None = None, limit: int = 10) -> dict:
        try:
            r = await self._resolve_faction(faction)
            if r.match is None:
                return error(r.status, f"faction '{faction}' not resolved",
                             candidates=[c.name for c in r.candidates])
            name = r.match.name
            mres = await self._cache.get_or_fetch(f"wiki:missions:{normalise(name)}", _TTL,
                                                  lambda: self._wiki.missions(name))
        except UpstreamError as e:
            return error("wiki_unavailable", str(e))
        missions = [m for m in mres.value if not m.get("not_for_release") and not m.get("work_in_progress")]
        ladder_pairs = {((m.get("min_standing") or {}).get("name"), (m.get("min_standing") or {}).get("min_reputation"))
                        for m in missions}
        ladder = sorted(({"name": n, "min_reputation": int(v)} for n, v in ladder_pairs if n and v is not None),
                        key=lambda x: x["min_reputation"])
        rank_rep, rank_name = None, None
        if current_rank:
            li = NameIndex()
            from .names import Entry
            for step in ladder:
                li.add(Entry("rank", step["name"], step["name"], (step["name"],), step))
            rr = li.resolve(current_rank, kind="rank")
            if rr.match is None:
                return error("not_found", f"rank '{current_rank}' not in ladder",
                             candidates=[s["name"] for s in ladder])
            rank_rep, rank_name = rr.match.data["min_reputation"], rr.match.name
        best: dict[str, dict] = {}
        skipped = 0
        for m in missions:
            rep, mins = _rep(m), m.get("time_to_complete_minutes")
            if not rep or not isinstance(mins, (int, float)) or mins <= 0:
                skipped += 1
                continue
            lo = (m.get("min_standing") or {}).get("min_reputation") or 0
            hi = (m.get("max_standing") or {}).get("min_reputation")
            if rank_rep is not None and (lo > rank_rep or (hi is not None and hi < rank_rep)):
                continue
            if system and system.lower() not in [s.lower() for s in (m.get("star_systems") or [])]:
                continue
            row = {"title": m.get("title"), "rep_per_minute": round(rep / mins, 2),
                   "reputation_gained": int(rep), "minutes": int(mins),
                   "reward_auec": m.get("reward_max") or m.get("reward_min"),
                   "min_rank": (m.get("min_standing") or {}).get("name"),
                   "max_rank": (m.get("max_standing") or {}).get("name"),
                   "systems": m.get("star_systems") or [], "cooldown": m.get("cooldown_label"),
                   "has_prerequisites": bool(m.get("has_prerequisites")), "has_chain": bool(m.get("has_chain")),
                   "once_only": bool(m.get("once_only")), "legal": not m.get("illegal")}
            prev = best.get(row["title"])
            if prev is None or row["rep_per_minute"] > prev["rep_per_minute"]:
                best[row["title"]] = row
        rows = sorted(best.values(), key=lambda x: x["rep_per_minute"], reverse=True)
        notes = [_NOTE]
        if skipped:
            notes.append(f"{skipped} missions omitted (no reputation or duration in game data)")
        gv = next((m.get("game_version") or m.get("version") for m in missions if m.get("game_version") or m.get("version")), None)
        return {"source": SOURCE, "game_version": gv, "faction": name, "rank_ladder": ladder,
                "current_rank": rank_name, "missions": rows[:max(1, min(limit, 50))], "notes": notes,
                **freshness(mres)}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add sc-knowledge/src/tools_missions.py sc-knowledge/tests/test_tools_missions.py
git commit -m "feat(sc-knowledge): sc_faction_missions ranked by reputation per minute"
```

---

### Task 6: Trade tools — `trade_routes`, `commodity_prices`

**Files:**
- Create: `sc-knowledge/src/tools_trade.py`
- Test: `sc-knowledge/tests/test_tools_trade.py`

**Interfaces:**
- Consumes: `UexClient`, `NameIndex`, `terminal_entries`, `commodity_entries`, `TTLCache`, `envelope`.
- Produces: `tools_trade.TradeTools(uex: UexClient, cache: TTLCache)`;
  - `async _index() -> NameIndex` (terminals cached `uex:terminals` TTL 21600, commodities `uex:commodities` TTL 21600).
  - `async trade_routes(origin: str, destination: str | None = None, commodity: str | None = None, cargo_scu: int | None = None, budget_auec: int | None = None, limit: int = 5) -> dict` →
    `{"source": "uexcorp.space (crowd-sourced)", "game_version": str, "origin": str, "routes": [{"commodity", "buy_at", "buy_location", "sell_at", "sell_location", "buy_price", "sell_price", "profit_per_scu", "roi_pct", "scu_traded", "total_profit", "investment", "distance", "lawless": bool, "reported_at": str}], "notes": [str]}`.
    - Origin resolution: resolve `origin` against terminals. If a unique terminal → that id. Else, match `origin` (normalised) against terminal location fields (`space_station_name`, `city_name`, `outpost_name`, `planet_name`, `orbit_name`, `star_system_name` in the terminal dicts) and take ALL terminals whose any location field normalises equal to the query; if none → `error(not_found|ambiguous, candidates=...)`. Only terminals with `type == "commodity"` are used for routes.
    - Fetch `commodities_routes(id_terminal_origin=t)` per origin terminal (cached `uex:routes:<t>` TTL 1800), concatenate, then filter by destination (same resolution → destination terminal id set) and commodity (resolved id against `id_commodity`).
    - Profit math: `profit_per_scu = price_destination - price_origin`; `scu = min(x for x in (cargo_scu, budget_auec // price_origin if budget_auec and price_origin else None, scu_origin (available supply), scu_destination (demand)) if x)`; when none given use the route's own `scu_reachable`/`scu_origin`; `total_profit = profit_per_scu * scu`; `investment = price_origin * scu`; `roi_pct = round(100 * profit_per_scu / price_origin, 1)`.
    - Drop routes with `profit_per_scu <= 0`. Sort by `total_profit` desc. `lawless = "pyro" in (origin_star_system_name + destination_star_system_name).lower()`.
    - `reported_at` = route `date_added` (epoch seconds) → ISO-8601 UTC.
    - Notes always include `"Prices are player-reported to UEX; verify in game."`; add `"Only <commodities> sold at <origin>"` when ≤3 distinct commodities.
  - `async commodity_prices(commodity: str, location: str | None = None, side: str = "sell", limit: int = 5) -> dict` → `{"source", "game_version", "commodity", "side", "terminals": [{"terminal", "location", "system", "price", "scu_stock" | "scu_demand", "reported_at"}]}`; side `buy` = where to buy (lowest `price_buy` > 0 first, `scu_sell_stock` as stock), side `sell` = where to sell (highest `price_sell` > 0 first, `scu_buy` as demand); location filter uses the same location-field normalised equality; cached `uex:cprices:<id>` TTL 1800.

- [ ] **Step 1: Write failing tests** — `tests/test_tools_trade.py`

```python
from src.cache import TTLCache
from src.config import load
from src.tools_trade import TradeTools
from src.uex import build_uex
from tests.conftest import fixture_transport


def _tools():
    uex = build_uex(load(), transport=fixture_transport({
        "/2.0/terminals": "uex_terminals.json",
        "/2.0/commodities_routes": "uex_routes_mic_l5.json",
        "/2.0/commodities_prices": "uex_commodity_prices_79.json",
        "/2.0/commodities": "uex_commodities.json",
    }))
    return TradeTools(uex, TTLCache())


async def test_routes_from_mic_l5_sorted_and_profitable():
    r = await _tools().trade_routes("MIC-L5", limit=5)
    assert r["routes"], r
    totals = [x["total_profit"] for x in r["routes"]]
    assert totals == sorted(totals, reverse=True) and all(x["profit_per_scu"] > 0 for x in r["routes"])
    assert any("UEX" in n for n in r["notes"])


async def test_cargo_and_budget_cap_total_profit():
    t = _tools()
    r = await t.trade_routes("MIC-L5", cargo_scu=10, budget_auec=1_000_000, limit=3)
    for x in r["routes"]:
        assert x["scu_traded"] <= 10
        assert x["investment"] <= 1_000_000
        assert x["total_profit"] == x["profit_per_scu"] * x["scu_traded"]


async def test_lawless_flag_for_pyro():
    r = await _tools().trade_routes("MIC-L5", limit=50)
    pyro = [x for x in r["routes"] if "Pyro" in (x["sell_location"] + x["buy_location"])]
    assert all(x["lawless"] for x in pyro)


async def test_unknown_origin():
    r = await _tools().trade_routes("Zzqq Station")
    assert r["error"] in ("not_found", "ambiguous")


async def test_commodity_prices_sell_side_sorted_desc():
    r = await _tools().commodity_prices(commodity_name_for_79(), side="sell")
    prices = [x["price"] for x in r["terminals"]]
    assert prices == sorted(prices, reverse=True)


def commodity_name_for_79():
    from tests.conftest import load_fixture
    return next(c["name"] for c in load_fixture("uex_commodities.json")["data"] if c["id"] == 79)
```

(If the MIC-L5 fixture has no Pyro-bound routes, `test_lawless_flag_for_pyro` still passes vacuously; additionally assert on a synthetic route dict passed through the module-level `_row()` helper you write, with `destination_star_system_name="Pyro"` → `lawless is True`.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `src/tools_trade.py`** exactly per the Interfaces (module-level pure helper `_row(route: dict, cargo_scu, budget_auec) -> dict | None` does the profit math so it is unit-testable; `datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()` for `reported_at`; `game_version` = `route.get("game_version_origin")` of the first route or `(await uex.game_versions())["live"]` when no routes; catch `UpstreamError` → `error("uex_unavailable", str(e))`).

- [ ] **Step 4: Run all tests — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add sc-knowledge/src/tools_trade.py sc-knowledge/tests/test_tools_trade.py
git commit -m "feat(sc-knowledge): sc_trade_routes and sc_commodity_prices with cargo/budget-capped profit"
```

---

### Task 7: Org guides — `sc_org_guides` + sync script

**Files:**
- Create: `sc-knowledge/src/tools_guides.py`, `scripts/sync-org-guides.sh`
- Test: `sc-knowledge/tests/test_tools_guides.py`, `sc-knowledge/tests/fixtures/guides/` (SYNTHETIC guide text only — never copy real org guide content into the repo; the repo is public)

**Interfaces:**
- Produces:
  - `tools_guides.GuideStore(directory: str, clock=time.monotonic, recheck_s: float = 60.0)`; `sections() -> list[Section]` (reloads when any `*.txt` mtime/set changed, at most every `recheck_s`); `Section(guide: str, version: str | None, heading: str, text: str)`.
  - `tools_guides.GuideTools(store: GuideStore)`; `org_guides(query: str, limit: int = 3) -> dict` → `{"source": "org guide", "sections": [{"guide", "version", "heading", "text", "score"}], "note"?: str}`. Empty/missing dir → `{"source": "org guide", "sections": [], "note": "no org guides loaded"}`. Section `text` capped at 4000 chars (cut at a line boundary, with `"…(truncated)"` appended — this is a tool payload cap, not log truncation).
  - Parsing: file's first non-empty line = guide title (fallback: filename stem). Version = first regex match of `(?i)alpha\s+(\d+\.\d+(?:\.\d+)?)` → `"Alpha x.y.z"`. Section boundaries: a line matching `^\s*\d+\.\s+[A-Z]` (numbered heading) or a line of ≥12 chars that is ≥80% uppercase letters among its letters and has ≥2 words; text before the first heading is a section with heading = title.
  - Ranking: tokenise lowercase `[a-z0-9]+` minus a small stopword set; BM25 (k1=1.5, b=0.75) over sections where heading tokens count twice; return top `limit` with score > 0.
- `scripts/sync-org-guides.sh`: bash, `set -euo pipefail`; for each `OrgGuides/*.pdf` run `pdftotext -layout "$f" "$tmp/<slug>.txt"` (slug = lowercase, non-alnum → `-`, trimmed); `kubectl create configmap sc-org-guides --from-file="$tmp" -n discord-article-bot --dry-run=client -o yaml | kubectl apply -f -`; print the guide count and total bytes; refuse (exit 1) if the ConfigMap would exceed 900 KB. Header comment: PDFs are private, the repo and images are public, never commit them.
- Deployment (Task 8 manifests): volume `org-guides` from ConfigMap `sc-org-guides` (`optional: true`) mounted read-only at `/guides`; env `SC_GUIDES_DIR=/guides`; `Config` gains `guides_dir: str` (env `SC_GUIDES_DIR`, default `/guides`).

- [ ] **Step 1: Create synthetic fixtures** `tests/fixtures/guides/trading.txt` and `tests/fixtures/guides/mining.txt` (invented content in the same layout: title line, `Data verified on LIVE Build: Alpha 4.10.1`, numbered and ALL-CAPS headings, a few paragraphs mentioning e.g. "demand saturation", "inventory refresh ticks", "resource signature", "cluster multiplier").

- [ ] **Step 2: Write failing tests**

```python
import os
import time

from src.tools_guides import GuideStore, GuideTools

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "guides")


def test_parses_title_version_and_sections():
    secs = GuideStore(FIX).sections()
    guides = {s.guide for s in secs}
    assert len(guides) == 2 and all(s.version == "Alpha 4.10.1" for s in secs)
    assert len(secs) >= 4


def test_query_ranks_relevant_section_first():
    r = GuideTools(GuideStore(FIX)).org_guides("why did the terminal refuse my cargo demand saturation")
    assert r["sections"] and "satur" in (r["sections"][0]["heading"] + r["sections"][0]["text"]).lower()
    assert r["source"] == "org guide"


def test_missing_dir_returns_note(tmp_path):
    r = GuideTools(GuideStore(str(tmp_path / "nope"))).org_guides("anything")
    assert r["sections"] == [] and r["note"] == "no org guides loaded"


def test_reloads_when_files_change(tmp_path):
    d = tmp_path / "g"; d.mkdir()
    (d / "a.txt").write_text("GUIDE A\nAlpha 4.10.1\n1. SALVAGE BASICS\nscraper beams\n")
    clk = [0.0]
    store = GuideStore(str(d), clock=lambda: clk[0], recheck_s=60)
    assert len(store.sections()) >= 1
    (d / "b.txt").write_text("GUIDE B\nAlpha 4.10.1\n1. MINING BASICS\nlasers\n")
    os.utime(d / "b.txt", (time.time() + 5, time.time() + 5))
    clk[0] = 61
    assert {s.guide for s in store.sections()} == {"GUIDE A", "GUIDE B"}
```

- [ ] **Step 3: Run — expect FAIL.**
- [ ] **Step 4: Implement** `src/tools_guides.py` and `scripts/sync-org-guides.sh` (chmod +x) per Interfaces; add `guides_dir` to `Config`.
- [ ] **Step 5: Run — expect PASS.** Also run the sync script in dry mode against the real PDFs WITHOUT applying: `pdftotext -layout` each into a temp dir and run a throwaway `python -c` that loads them with `GuideStore` and prints section headings per guide — confirm the heading heuristic splits the three real guides into sensible sections (≥3 each). Do not write that output anywhere in the repo. Adjust the heading heuristic if a guide yields a single giant section.
- [ ] **Step 6: Commit**

```bash
git add sc-knowledge/src/tools_guides.py sc-knowledge/src/config.py sc-knowledge/tests/test_tools_guides.py sc-knowledge/tests/fixtures/guides/ scripts/sync-org-guides.sh
git commit -m "feat(sc-knowledge): sc_org_guides search over privately-synced org guides"
```

---

### Task 8: MCP server, tracing, container, manifests

**Files:**
- Create: `sc-knowledge/src/server.py`, `sc-knowledge/src/tracing.py`, `sc-knowledge/Dockerfile`, `sc-knowledge/README.md`, `k8s/sc-knowledge/deployment.yaml`, `k8s/sc-knowledge/service.yaml`, `k8s/sc-knowledge/networkpolicy.yaml`, `k8s/sc-knowledge/README.md`
- Test: `sc-knowledge/tests/test_server_mcp.py`

**Interfaces:**
- Consumes: all tool classes, `build_uex`, `build_wiki`, `TTLCache`, `Config`.
- Produces:
  - `server.build_app(config: Config, uex_transport=None, wiki_transport=None) -> starlette.applications.Starlette` serving MCP streamable HTTP at `/mcp` and `GET /healthz` → `200 {"ok": true, "version": ..., "game_version": ...}`.
  - MCP tool names (exact): `sc_find_item(name: str)`, `sc_compare_components(type: str, size: int, rank_by: str | None = None, grade: str | None = None, component_class: str | None = None, limit: int = 5)`, `sc_faction_missions(faction: str, current_rank: str | None = None, system: str | None = None, limit: int = 10)`, `sc_trade_routes(origin: str, destination: str | None = None, commodity: str | None = None, cargo_scu: int | None = None, budget_auec: int | None = None, limit: int = 5)`, `sc_commodity_prices(commodity: str, location: str | None = None, side: str = "sell", limit: int = 5)`, `sc_org_guides(query: str, limit: int = 3)` (docstring: curated org guides for mechanics/strategy — mining scan signatures, salvage contracts, trading risk; live data from the other tools wins for prices/stats; cite the guide). `build_app` takes an optional `guides_dir` override (tests pass the synthetic fixtures dir). Each returns the tool's dict (structured content). Each docstring is the model-facing description — write them for an LLM: when to use it, what it returns, that numbers are pre-computed, and "prefer this over memory; the game changes every patch".
  - Every tool body is wrapped so any unexpected exception returns `error("internal", repr(e))` (never raises) and is recorded on an OTel span `sc.tool` with attributes `sc.tool.name`, `sc.result` (`ok`|error code), `sc.cache` (`stale` when the result has `stale`).
  - `tracing.setup(config)` (same shape as voice-sidecar `tracing.py`, service name `sc-knowledge`).
  - `python -m src.server` runs uvicorn on `config.listen_host:listen_port`.

- [ ] **Step 1: Look up the exact FastMCP 2.x streamable-HTTP app API** in the installed package before writing code: `.venv/bin/python -c "import mcp, inspect; from mcp.server.fastmcp import FastMCP; print(mcp.__version__ if hasattr(mcp,'__version__') else ''); print([m for m in dir(FastMCP) if 'http' in m.lower() or 'app' in m.lower()])"` and read `FastMCP.streamable_http_app` / `custom_route` signatures (Context7 MCP `resolve-library-id "mcp python sdk"` → `query-docs "FastMCP streamable_http_app mount starlette custom_route"` if unclear). Use `stateless_http=True` and `json_response=True`. Mount so the MCP endpoint is exactly `/mcp`.

- [ ] **Step 2: Write failing test** — `tests/test_server_mcp.py` (real streamable HTTP over an in-process uvicorn server, real MCP client; mirrors agent-sidecar `tests/test_mcp_v2_compat.py` pattern — read that file first for the server-start helper)

```python
import asyncio
import json
import socket

import pytest
import uvicorn

from src.config import load
from src.server import build_app
from tests.conftest import fixture_transport

EXPECTED = {"sc_find_item", "sc_compare_components", "sc_faction_missions",
            "sc_trade_routes", "sc_commodity_prices", "sc_org_guides"}


def _free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


@pytest.fixture
async def server_url():
    app = build_app(load(),
        uex_transport=fixture_transport({"/2.0/terminals": "uex_terminals.json",
                                         "/2.0/commodities_routes": "uex_routes_mic_l5.json",
                                         "/2.0/commodities": "uex_commodities.json",
                                         "/2.0/game_versions": "uex_game_versions.json"}),
        wiki_transport=fixture_transport({"/api/v2/items/V801-12": "wiki_item_v801_12.json",
                                          "/api/vehicle-items": "wiki_vehicle_items_shield_s2.json",
                                          "/api/missions": "wiki_missions_foxwell.json",
                                          "/api/factions": "wiki_factions.json"}))
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    await task


async def _session(url):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    return streamable_http_client(f"{url}/mcp"), ClientSession


async def test_lists_exactly_the_six_tools(server_url):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with streamable_http_client(f"{server_url}/mcp") as streams:
        async with ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            names = {t.name for t in (await s.list_tools()).tools}
    assert names == EXPECTED


async def test_call_find_item_round_trip(server_url):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with streamable_http_client(f"{server_url}/mcp") as streams:
        async with ClientSession(streams[0], streams[1]) as s:
            await s.initialize()
            res = await s.call_tool("sc_find_item", {"name": "V801-12"})
    assert not res.is_error
    data = res.structured_content or json.loads(res.content[0].text)
    data = data.get("result", data)
    assert data["where_to_buy"][0]["price_auec"] == 352000


async def test_healthz(server_url):
    import httpx
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{server_url}/healthz")
    assert r.status_code == 200 and r.json()["ok"] is True
```

(Adjust the `streamable_http_client` unpacking to the installed mcp 2.x signature — agent-sidecar's `test_mcp_v2_compat.py` shows the working form; delete the unused `_session` helper.)

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement `src/tracing.py`** (copy voice-sidecar's, service name `sc-knowledge`) and `src/server.py`:
  - Build `cache = TTLCache()`, `uex = build_uex(config, uex_transport)`, `wiki = build_wiki(config, wiki_transport)`, tool instances.
  - `mcp = FastMCP("sc-knowledge", stateless_http=True, json_response=True)`; register the six tools with `@mcp.tool()` using the exact names/signatures above; each calls the tool method inside `_guard(name, coro)` which opens the span and converts exceptions.
  - `/healthz` route returns ok + `config.version` + best-known `game_version` (cached `uex:game_versions` TTL 21600; if fetching fails still return `ok: true` with `game_version: null` — health is "process serving", upstream outages are reported per tool).
  - Patch awareness (spec §5): a helper `_patch_note(result_game_version: str | None) -> dict` compares the `major.minor.patch` prefix of the tool result's `game_version` with UEX `game_versions()["live"]` (cached `uex:game_versions` TTL 21600); when both are known and differ, return `{"note_patch": f"Data is from {result} but the live game is {live}; stats may have changed."}` merged into the result by `_guard` (never fails the call if UEX is down). Unit-test `_patch_note` for equal / differing / unknown inputs in `test_server_mcp.py`.
  - Warmup: on startup (lifespan), fire-and-forget prefetch of terminals, commodities, factions (errors logged at WARNING, never fatal).
  - `main()`: `tracing.setup(config)`; `uvicorn.run(build_app(config), host=..., port=...)`.
  - Tool docstrings (model-facing), e.g. for `sc_trade_routes`: `"Profitable Star Citizen commodity trade routes starting at a terminal, station, city, planet or system (fuzzy names like 'MIC-L5' work). Returns routes already ranked by total profit, with profit per SCU, ROI, and total profit capped by cargo_scu and budget_auec when given; flags lawless (Pyro) endpoints and the date each price was reported. Prices are player-reported to UEX and change constantly — prefer this over memory, and mention the data age. Do NOT compute routes yourself or use the sandbox."`

- [ ] **Step 5: Run all tests — expect PASS.**

- [ ] **Step 6: Write `sc-knowledge/Dockerfile`**

```dockerfile
FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ src/
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app
USER 1000
EXPOSE 8080
CMD ["python", "-m", "src.server"]
```

Verify: `docker build -t sc-knowledge-test sc-knowledge/ && docker run --rm -d -p 18080:8080 --name sck sc-knowledge-test && sleep 3 && curl -s localhost:18080/healthz && docker rm -f sck`. Expect `{"ok": true, ...}` (it will reach the real APIs for game_version — fine).

- [ ] **Step 7: Write tracked manifests** (placeholders; the coordinator writes the real deployed copies):
  - `k8s/sc-knowledge/deployment.yaml`: Deployment `sc-knowledge`, labels `app: sc-knowledge`, `strategy: RollingUpdate`, 1 replica, image `mvilliger/sc-knowledge:REPLACE_WITH_SHA`, port 8080 named `http`, env `SC_KNOWLEDGE_VERSION` (`REPLACE_WITH_SHA`), `OTEL_SERVICE_NAME=sc-knowledge`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://telemetry-ingest.dynatrace.svc.cluster.local:4317`, `UEXCORP_BEARER` from Secret `sc-knowledge-secrets` key `UEXCORP_BEARER` (`optional: true`); resources requests `50m/128Mi` limits `500m/384Mi`; readiness + liveness `httpGet /healthz :8080`; `securityContext` `runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities.drop: [ALL]`; `automountServiceAccountToken: false`; volume `org-guides` from ConfigMap `sc-org-guides` (`optional: true`) mounted read-only at `/guides`, env `SC_GUIDES_DIR=/guides`.
  - `k8s/sc-knowledge/service.yaml`: ClusterIP `sc-knowledge`, port 8080 → 8080.
  - `k8s/sc-knowledge/networkpolicy.yaml`: NetworkPolicy `sc-knowledge`, podSelector `app: sc-knowledge`, Ingress from pods `app: discord-article-bot-agent` and `app: discord-article-bot-voice` on TCP 8080; Egress DNS (kube-dns, same block as `k8s/voice/voice-networkpolicy.yaml`), TCP 443 to `0.0.0.0/0` except RFC1918, TCP 4317 to namespace `dynatrace`. (Check the agent pod's actual label in `k8s/sandbox/agent-deployment.yaml` and use it.)
  - `k8s/sc-knowledge/README.md`: build (`docker build -t mvilliger/sc-knowledge:$(git rev-parse --short HEAD) sc-knowledge/`), push, create Secret (`kubectl create secret generic sc-knowledge-secrets --from-literal=UEXCORP_BEARER=... -n discord-article-bot`), apply order (secret → `scripts/sync-org-guides.sh` → deployment/service/networkpolicy from the **deployed overlay**, never these placeholder files), the sidecar NetworkPolicy egress rules needed (Task 9/11), and a `curl` smoke via `kubectl port-forward svc/sc-knowledge 18080:8080`.
  - `sc-knowledge/README.md`: purpose, tools table, env vars, TTLs, run tests, capture fixtures.

- [ ] **Step 8: Commit**

```bash
git add sc-knowledge/src/server.py sc-knowledge/src/config.py sc-knowledge/src/tracing.py sc-knowledge/Dockerfile sc-knowledge/README.md sc-knowledge/tests/test_server_mcp.py k8s/sc-knowledge/
git commit -m "feat(sc-knowledge): FastMCP streamable-HTTP server, healthz, tracing, image and manifests"
```

---

### Task 9: Agent sidecar — SC toolset attach, isolation, prompt, span attrs

**Files:**
- Create: `agent-sidecar/src/sc_tools.py`
- Modify: `agent-sidecar/src/config.py`, `agent-sidecar/src/mcp_registry.py`, `agent-sidecar/src/agent.py` (`TOOL_AVAILABILITY_PREAMBLE`, `AgentChatResult`, `ChannelVoiceAgent.__init__/_compose_instruction/process_chat`), `agent-sidecar/src/server.py` (`serve()` wiring; `Chat` span attrs near line 248), `k8s/sandbox/agent-deployment.yaml`, `k8s/sandbox/agent-networkpolicy.yaml`
- Test: `agent-sidecar/tests/test_sc_tools.py`, additions in existing agent/server tests

**Interfaces:**
- Consumes: sc-knowledge MCP at `SC_KNOWLEDGE_URL` (tool names from Task 8).
- Produces:
  - `Config` fields `sc_knowledge_enabled: bool` (env `SC_KNOWLEDGE_ENABLED`, default false; truthy = `"true"/"1"/"yes"` case-insensitive) and `sc_knowledge_url: str` (env `SC_KNOWLEDGE_URL`, default `http://sc-knowledge.discord-article-bot.svc.cluster.local:8080/mcp`).
  - `mcp_registry._PROFILES["channel_voice"] = [{"name": "sc-knowledge", "url_attr": "sc_knowledge_url", "token_attr": None, "enabled_attr": "sc_knowledge_enabled"}]`. `build_mcp_toolsets`: skip a server whose `enabled_attr` is set and falsy; when `token_attr is None` send no Authorization header; still skip when URL missing or when `token_attr` is set but its value is missing. (Future SC Trade Tools = another entry with `token_attr`.)
  - `sc_tools.ScToolsProvider(toolsets: list, health_url: str | None, probe=None, clock=time.monotonic, ttl_s=30.0)`; `async available() -> bool` (cached for `ttl_s`; probe = GET `health_url` with 2 s timeout returning 200); `toolsets -> list`. `health_url` is derived from the MCP URL by replacing a trailing `/mcp` with `/healthz`. `ScToolsProvider.disabled()` classmethod → no toolsets, `available()` always False.
  - `AgentChatResult` gains `sc_tool_names: list[str]` (default empty) and `sandbox_attempts: int` (default 0).
  - `ChannelVoiceAgent.__init__(..., sc_tools: ScToolsProvider | None = None)`.
  - `TOOL_AVAILABILITY_PREAMBLE` stays; new module constants `SC_TOOLS_PREAMBLE` and `SC_TOOLS_UNAVAILABLE_NOTE`; `_compose_instruction(self, *, system_prompt: str, sc_state: str = "off")` appends `SC_TOOLS_PREAMBLE` when `sc_state == "available"`, `SC_TOOLS_UNAVAILABLE_NOTE` when `"unavailable"`, nothing when `"off"` (byte-identical to today).
  - `process_chat`: determine `sc_state` = `"off"` if provider None/disabled, else `"available"`/`"unavailable"` from `await provider.available()`; agent `tools = [run_in_sandbox] + (provider.toolsets if sc_state == "available" else [])`; count `sc_*` function calls from runner events (`event.get_function_calls()` or `part.function_call.name` — inspect the ADK 2.10 Event API and use what exists) into `sc_tool_names`; `sandbox_attempts = tool.attempts` (Task 10 adds the counter; until then use `len(tool.execution_ids)`).
  - Server `Chat` span: `span.set_attribute("sc.tools.available", sc_state == "available")`, `sc.tool.calls` (int), `sc.tool.names` (comma-joined).
  - Log line at INFO once per turn when `sc_state == "unavailable"`: `"sc_tools=unavailable (probe failed); turn runs without Star Citizen tools"`.

`SC_TOOLS_PREAMBLE` text (verbatim):
```
Star Citizen: you have live-data tools for the game Star Citizen — sc_find_item (item stats + where to buy it, with prices), sc_compare_components (rank ship components of a type and size), sc_faction_missions (a faction's rank ladder and missions ranked by reputation per minute), sc_trade_routes (profitable commodity routes from a location, profit already computed for the cargo/budget), sc_commodity_prices, and sc_org_guides (our org's curated guides on mining, salvage and trading mechanics/strategy — cite them when used; live tool data wins for prices and stats). For ANY Star Citizen question about items, ship components, shops, prices, missions, reputation, or trading, call these tools instead of answering from memory — the game changes every patch. Their numbers are already ranked and computed; never write code or use run_in_sandbox to fetch, compute, or re-rank Star Citizen data. Use web search on top of them only for community strategy or opinions. Mention the data's patch or age when prices or availability matter. If a tool returns an error or candidates, say so or ask which one was meant — do not invent values.
```
`SC_TOOLS_UNAVAILABLE_NOTE` text (verbatim):
```
Star Citizen live-data tools are temporarily unavailable. If asked about Star Citizen items, prices, missions or trade, say live data is unavailable right now and answer only with clearly-labelled general knowledge — do not use run_in_sandbox to fetch Star Citizen data.
```

- [ ] **Step 1: Write failing tests** — `agent-sidecar/tests/test_sc_tools.py`

```python
import pytest

from src import mcp_registry
from src.agent import ChannelVoiceAgent, SC_TOOLS_PREAMBLE, SC_TOOLS_UNAVAILABLE_NOTE, TOOL_AVAILABILITY_PREAMBLE
from src.sc_tools import ScToolsProvider


class Cfg:
    sc_knowledge_enabled = True
    sc_knowledge_url = "http://sc.test:8080/mcp"


class Clock:
    def __init__(self): self.t = 0.0
    def __call__(self): return self.t


def test_registry_builds_authless_sc_toolset_when_enabled():
    ts = mcp_registry.build_mcp_toolsets("channel_voice", Cfg())
    assert len(ts) == 1


def test_registry_skips_sc_toolset_when_disabled():
    class Off(Cfg): sc_knowledge_enabled = False
    assert mcp_registry.build_mcp_toolsets("channel_voice", Off()) == []


async def test_provider_caches_probe_for_ttl():
    calls = []
    async def probe(url):
        calls.append(url); return True
    clk = Clock()
    p = ScToolsProvider(["ts"], "http://sc.test:8080/healthz", probe=probe, clock=clk, ttl_s=30)
    assert await p.available() and await p.available()
    clk.t += 31
    assert await p.available()
    assert len(calls) == 2


async def test_provider_probe_exception_means_unavailable():
    async def probe(url): raise OSError("refused")
    p = ScToolsProvider(["ts"], "http://x/healthz", probe=probe)
    assert await p.available() is False


def test_instruction_off_is_byte_identical_to_today():
    a = ChannelVoiceAgent(config=None, orchestrator=None, base_system_prompt="BASE")
    assert a._compose_instruction(system_prompt="SYS") == f"SYS\n\n{TOOL_AVAILABILITY_PREAMBLE}"
    assert a._compose_instruction(system_prompt="SYS", sc_state="off") == f"SYS\n\n{TOOL_AVAILABILITY_PREAMBLE}"


def test_instruction_available_and_unavailable():
    a = ChannelVoiceAgent(config=None, orchestrator=None, base_system_prompt="BASE")
    assert SC_TOOLS_PREAMBLE in a._compose_instruction(system_prompt="S", sc_state="available")
    assert SC_TOOLS_UNAVAILABLE_NOTE in a._compose_instruction(system_prompt="S", sc_state="unavailable")
```

Add to the existing server/agent test module (find where `Chat` and `ChatCircuitBreaker` are tested — grep `ChatCircuitBreaker` in `agent-sidecar/tests/`) a test that builds `AgentServicer` with a `ChannelVoiceAgent` whose `ScToolsProvider.available()` returns False and a fake runner/model path that succeeds (reuse that module's existing fake-agent pattern), and asserts the `Chat` succeeds and the breaker records success — i.e. an unreachable sc-knowledge never fails `Chat`. Also assert `process_chat` passes only `[run_in_sandbox]` as tools when unavailable (monkeypatch `src.agent.Agent` to capture the `tools=` kwarg).

- [ ] **Step 2: Run — expect FAIL.** `cd agent-sidecar && .venv/bin/python -m pytest tests/test_sc_tools.py -q` (create the venv first if absent: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, or run tests in `python:3.14-slim` docker as in Task 1).

- [ ] **Step 3: Implement** config fields, registry changes, `src/sc_tools.py`:

```python
"""Star Citizen knowledge toolset for the channel-voice agent: built once at
startup, attached per turn only when a cached health probe says the
sc-knowledge server is up — so a dead add-on can never fail Chat."""
import logging
import time
from typing import Awaitable, Callable

import httpx

log = logging.getLogger(__name__)


async def _http_probe(url: str) -> bool:
    async with httpx.AsyncClient(timeout=2.0) as c:
        r = await c.get(url)
        return r.status_code == 200


def health_url_for(mcp_url: str) -> str:
    return mcp_url[: -len("/mcp")] + "/healthz" if mcp_url.endswith("/mcp") else mcp_url.rstrip("/") + "/healthz"


class ScToolsProvider:
    def __init__(self, toolsets: list, health_url: str | None,
                 probe: Callable[[str], Awaitable[bool]] | None = None,
                 clock: Callable[[], float] = time.monotonic, ttl_s: float = 30.0) -> None:
        self.toolsets = toolsets
        self._health_url = health_url
        self._probe = probe or _http_probe
        self._clock = clock
        self._ttl = ttl_s
        self._checked_at: float | None = None
        self._ok = False

    @classmethod
    def disabled(cls) -> "ScToolsProvider":
        return cls([], None)

    @property
    def enabled(self) -> bool:
        return bool(self.toolsets) and bool(self._health_url)

    async def available(self) -> bool:
        if not self.enabled:
            return False
        now = self._clock()
        if self._checked_at is not None and now - self._checked_at < self._ttl:
            return self._ok
        try:
            ok = bool(await self._probe(self._health_url))
        except Exception as e:  # noqa: BLE001
            log.warning("sc-knowledge health probe failed: %s: %s", type(e).__name__, e)
            ok = False
        self._checked_at, self._ok = now, ok
        return ok
```

Then `agent.py` (constants, `AgentChatResult` fields with defaults, `__init__` param, `_compose_instruction(sc_state)`, `process_chat` state/tools/counting) and `server.py serve()`: `sc = ScToolsProvider(build_mcp_toolsets("channel_voice", config), health_url_for(config.sc_knowledge_url)) if config.sc_knowledge_enabled else ScToolsProvider.disabled()`; pass `sc_tools=sc` to `ChannelVoiceAgent`; log at startup `sc_knowledge=enabled url=...` or `sc_knowledge=disabled`. In `Chat`, set the three span attributes from the result (`sc.tools.available` needs the state — add `sc_state: str` to `AgentChatResult` too, default `"off"`).

- [ ] **Step 4: Manifests (tracked):** `k8s/sandbox/agent-deployment.yaml` env add `SC_KNOWLEDGE_ENABLED: "false"` and `SC_KNOWLEDGE_URL` (default value) with a comment "flip to true after sc-knowledge is deployed (see k8s/sc-knowledge/README.md)". `k8s/sandbox/agent-networkpolicy.yaml` egress add: to podSelector `app: sc-knowledge` TCP 8080 (comment why: RFC1918 is excluded from the 443 rule).

- [ ] **Step 5: Run the full agent suite — expect PASS** (≥ 138 + new tests, 0 failures).

- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/src/sc_tools.py agent-sidecar/src/config.py agent-sidecar/src/mcp_registry.py agent-sidecar/src/agent.py agent-sidecar/src/server.py agent-sidecar/tests/ k8s/sandbox/agent-deployment.yaml k8s/sandbox/agent-networkpolicy.yaml
git commit -m "feat(agent): attach sc-knowledge tools to channel-voice agent, isolated behind a health probe"
```

---

### Task 10: Agent sidecar — sandbox backstop for SC hosts + attempts counter

**Files:**
- Modify: `agent-sidecar/src/tools.py` (`RunInSandboxTool`)
- Test: `agent-sidecar/tests/test_tools_sc_backstop.py`

**Interfaces:**
- Produces:
  - `tools.SC_DATA_HOST_PATTERN` — compiled regex, case-insensitive, matching `uexcorp\.(space|uk)`, `star-citizen\.wiki`, `sc-trade\.tools`, `scunpacked`.
  - `RunInSandboxTool.attempts: int` — incremented on EVERY `run()` call (including refusals and budget exhaustion), before any other check.
  - `RunInSandboxTool.run()`: after incrementing `attempts` and BEFORE the budget check and BEFORE `orch.run`, if `SC_DATA_HOST_PATTERN.search(code or "")` or `SC_DATA_HOST_PATTERN.search(stdin or "")`: log INFO `"run_in_sandbox refused: Star Citizen data host in code; use sc_* tools"` and return `{"exit_code": -4, "error": "use_sc_tools", "detail": "Star Citizen data is available through the sc_find_item, sc_compare_components, sc_faction_missions, sc_trade_routes and sc_commodity_prices tools. Do not fetch it in the sandbox.", "execution_id": None}`. Refusals do NOT consume the call budget and do NOT append to `execution_ids`/`results`.
  - `agent.py process_chat` sets `sandbox_attempts=tool.attempts` (replace the Task 9 interim).

- [ ] **Step 1: Write failing tests**

```python
import pytest

from src.tools import RunInSandboxTool, SC_DATA_HOST_PATTERN


class Orch:
    def __init__(self): self.calls = 0
    async def run(self, **kw):
        self.calls += 1
        raise AssertionError("orchestrator must not be called")


@pytest.mark.parametrize("code", [
    "import requests; requests.get('https://api.uexcorp.uk/2.0/commodities_routes')",
    "curl -s https://uexcorp.space/api/2.0/items",
    "fetch('https://api.star-citizen.wiki/api/v2/items/V801-12')",
    "wget https://sc-trade.tools/api/x",
    "git clone https://github.com/StarCitizenWiki/scunpacked-data",
])
async def test_sc_hosts_refused_before_orchestrator(code):
    orch = Orch()
    t = RunInSandboxTool(orch=orch, user_id="u", call_budget=5)
    r = await t.run(language="python", code=code)
    assert r["exit_code"] == -4 and r["error"] == "use_sc_tools"
    assert orch.calls == 0 and t.attempts == 1 and t.execution_ids == []


def test_pattern_does_not_match_unrelated_code():
    assert not SC_DATA_HOST_PATTERN.search("print(sum(range(10)))")
    assert not SC_DATA_HOST_PATTERN.search("curl https://example.com/star-citizen-fan-page")


async def test_refusal_does_not_consume_budget():
    class OkOrch:
        async def run(self, **kw):
            from eval.harness import FakeOrchestrator
            return await FakeOrchestrator().run(**kw)
    t = RunInSandboxTool(orch=OkOrch(), user_id="u", call_budget=1)
    await t.run(language="bash", code="curl https://uexcorp.space")
    r = await t.run(language="bash", code="echo hi")
    assert r["exit_code"] == 0 and t.attempts == 2
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run full agent suite — expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/tools.py agent-sidecar/src/agent.py agent-sidecar/tests/test_tools_sc_backstop.py
git commit -m "feat(agent): refuse sandbox runs that target Star Citizen data hosts, before any pod spins up"
```

---

### Task 11: Agent eval — SC case set with zero-sandbox hard gate

**Files:**
- Create: `agent-sidecar/eval/sc_eval_set.py`, `agent-sidecar/eval/eval_sc.py`
- Modify: `agent-sidecar/eval/README.md`
- Test: `agent-sidecar/tests/test_eval_sc_scoring.py`

**Interfaces:**
- Consumes: `ChannelVoiceAgent(sc_tools=...)`, `AgentChatResult.sc_tool_names`, `AgentChatResult.sandbox_attempts`, `eval.harness.FakeOrchestrator`, `build_mcp_toolsets`, `ScToolsProvider`.
- Produces:
  - `sc_eval_set.SC_EVAL_SET: list[dict]` entries `{"prompt": str, "expect_tool": str | None}` — `expect_tool` is the `sc_*` tool that must be called, or `None` for non-SC control prompts where NO `sc_*` tool may be called. Include at minimum: the four user questions (`"Where can we purchase a V801-12 radar?"`→`sc_find_item`; `"What is the most powerful Size 2 shield generator?"`→`sc_compare_components`; `"What is an optimal way to grind Foxwell Enforcement reputation?"`→`sc_faction_missions`; `"What are some currently profitable trade routes from MIC-L5?"`→`sc_trade_routes`), 8 more SC variants (e.g. "best size 1 quantum drive for speed", "where do I sell Laranite in Stanton", "how much does a FR-76 cost and where", "I have a C2 with 696 SCU and 2M aUEC, best route from Area18", "what rank do I need for Foxwell ship-under-attack missions", "compare size 3 power plants", "where can I buy a Scorpius" (expect `sc_find_item`), "cheapest place to buy Quantanium"→`sc_commodity_prices`), 2 guide prompts ("how do mining scan signatures work for rock clusters"→`sc_org_guides`, "what salvage contract tiers are there and what do they cost"→`sc_org_guides`), and 6 non-SC controls (`expect_tool: None`, e.g. "what's the capital of France", "explain TCP handshakes", "write a haiku about coffee", "what's 17*23", "recommend a sci-fi novel", "what's a good co-op game for four people").
  - `eval_sc.score_sc(records: list[tuple[dict, AgentChatResult]]) -> dict` with keys `sandbox_attempts_total` (int), `tool_hit_rate` (share of SC prompts whose `expect_tool` ∈ `sc_tool_names`), `control_false_sc_calls` (count of control prompts with any `sc_*` call).
  - CLI `python -m eval.eval_sc --runs N --min-hit 0.9` requiring `SC_KNOWLEDGE_URL` reachable (port-forward) + GEAP env like the existing eval; prints per-prompt table; **exits 1 if `sandbox_attempts_total > 0`** (hard gate), or `tool_hit_rate < --min-hit`, or `control_false_sc_calls > 0`.

- [ ] **Step 1: Write failing scoring test** — `tests/test_eval_sc_scoring.py`

```python
from src.agent import AgentChatResult
from eval.eval_sc import score_sc


def _r(tools, sandbox=0):
    return AgentChatResult(message_text="x", execution_ids=[], any_failed=False, fallback_occurred=False,
                           sc_tool_names=tools, sandbox_attempts=sandbox)


def test_score_counts_hits_controls_and_sandbox():
    recs = [({"prompt": "a", "expect_tool": "sc_find_item"}, _r(["sc_find_item"])),
            ({"prompt": "b", "expect_tool": "sc_trade_routes"}, _r([], sandbox=1)),
            ({"prompt": "c", "expect_tool": None}, _r(["sc_find_item"]))]
    s = score_sc(recs)
    assert s == {"sandbox_attempts_total": 1, "tool_hit_rate": 0.5, "control_false_sc_calls": 1}
```

(Adjust the `AgentChatResult` constructor to its actual field order/names after Task 9.)

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `sc_eval_set.py` and `eval_sc.py` (mirror `eval_sandbox_invocation.py`: env defaults incl. `SC_KNOWLEDGE_ENABLED=true`; build provider from `build_mcp_toolsets("channel_voice", load())` + `health_url_for`; `FakeOrchestrator`; run each case `--runs` times; score; print; exit code per gate).
- [ ] **Step 4: README** — add a "Star Citizen tools eval (hard gate)" section: purpose, the port-forward (`kubectl port-forward svc/sc-knowledge 18080:8080 -n discord-article-bot` + `SC_KNOWLEDGE_URL=http://127.0.0.1:18080/mcp`), command, the three gates, and that **any** sandbox attempt on an SC prompt fails the run (spec §6 layer 3).
- [ ] **Step 5: Run agent suite — expect PASS.**
- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/eval/sc_eval_set.py agent-sidecar/eval/eval_sc.py agent-sidecar/eval/README.md agent-sidecar/tests/test_eval_sc_scoring.py
git commit -m "test(agent): Star Citizen eval set with a zero-sandbox hard gate"
```

---

### Task 12: Voice sidecar — Live function calling via sc-knowledge

**Files:**
- Create: `voice-sidecar/src/sc_tools.py`
- Modify: `voice-sidecar/src/config.py`, `voice-sidecar/src/live_bridge.py` (`LiveBridge.__init__`, `_live_config`, `_pump_server`), `voice-sidecar/src/server.py` (`_build_bridge`, `serve`), `voice-sidecar/requirements.txt` (add `mcp>=2.2.0`, `httpx>=0.28.0`), `k8s/voice/voice-deployment.yaml`, `k8s/voice/voice-networkpolicy.yaml`
- Test: `voice-sidecar/tests/test_sc_tools.py`, `voice-sidecar/tests/test_live_bridge_tools.py`; extend `voice-sidecar/tests/test_genai_surface.py`

**Interfaces:**
- Consumes: sc-knowledge MCP tool list/calls (Task 8 names).
- Produces:
  - Config fields `sc_knowledge_enabled: bool` (`SC_KNOWLEDGE_ENABLED`, default false) and `sc_knowledge_url: str` (`SC_KNOWLEDGE_URL`, same default as agent).
  - `sc_tools.ScToolExecutor(url: str, timeout_s: float = 6.0, session_factory=None)`:
    - `async refresh() -> bool` — MCP `list_tools`, keeps only names starting `sc_`, converts each to `google.genai.types.FunctionDeclaration(name, description, parameters_json_schema=tool.inputSchema)` (verify the 2.25 field name for raw JSON schema — `parameters_json_schema` — against `types.FunctionDeclaration` fields; fall back to `parameters=types.Schema(...)` only if absent). Returns True on success; logs WARNING and keeps previous declarations on failure.
    - `declarations: list[types.FunctionDeclaration]` (empty until a successful refresh).
    - `async call(name: str, args: dict) -> dict` — opens an MCP session, `call_tool(name, args)`, bounded by `timeout_s` via `asyncio.wait_for`; returns the tool's structured dict (unwrapping `{"result": ...}` if FastMCP wraps it) or `{"error": "timeout", "detail": f"no answer from Star Citizen data within {timeout_s:g}s"}` / `{"error": "tool_failed", "detail": ...}`. Never raises (except `CancelledError`).
    - `session_factory` default opens `streamable_http_client(url)` + `ClientSession` (same form as Task 8 test); tests inject a fake.
  - `LiveBridge.__init__(..., sc_executor: ScToolExecutor | None = None)`.
  - `_live_config`: `tools=[types.Tool(google_search=types.GoogleSearch())]` + (`[types.Tool(function_declarations=self._sc.declarations)]` if executor present and declarations non-empty). When SC tools are attached, append `SC_VOICE_NOTE` to the system instruction (`(start.system_prompt or "") + "\n\n" + SC_VOICE_NOTE`).
  - `SC_VOICE_NOTE` (verbatim): `"You can look up live Star Citizen data with the sc_* tools (item stats and where to buy, component rankings, faction missions by reputation per minute, trade routes, commodity prices, and our org's curated guides on mining, salvage and trading). Use them for any Star Citizen item, price, mission, reputation or trade question instead of memory. Before a lookup, say a very short natural filler like \"let me check\". When answering, speak only the top two or three results in plain sentences and offer the rest; never read tables or long number lists aloud."`
  - `_pump_server`: for each `msg` with `tool_call` (`msg.tool_call.function_calls`): for each call start `asyncio.create_task(self._answer_tool_call(session, fc))` tracked in a per-session `set` of tasks keyed by `fc.id`; `_answer_tool_call` awaits `self._sc.call(fc.name, dict(fc.args or {}))` then `await session.send_tool_response(function_responses=[types.FunctionResponse(id=fc.id, name=fc.name, response=result)])`; logs INFO `voice: tool_call %s -> %s (%dms)` with name and `"ok"` or the error code. For `msg.tool_call_cancellation` (`.ids`): cancel matching tasks, log INFO. Unknown tool name (not `sc_`) → respond `{"error": "unknown_tool"}`. If no executor is configured but a tool_call arrives, respond with `{"error": "tools_unavailable"}` for each call (never leave the model hanging). On pump exit (session drop/reconnect) cancel all outstanding tool tasks (in-flight calls are dropped, not replayed — spec §7).
  - `_SessionStats` gains `tool_calls: int`, included in the session END log line (find where END is logged and add `tool_calls=%d`).
  - `server._build_bridge`: if `config.sc_knowledge_enabled`: `ex = ScToolExecutor(config.sc_knowledge_url)`; `await ex.refresh()` at startup (in `serve()`'s async `_run` before starting the server; if it fails, log WARNING `sc_knowledge=unreachable at startup; voice runs search-only until refresh succeeds` and start a background task that retries `refresh()` every 60 s until declarations exist). Pass `sc_executor=ex`. Else `None`.

- [ ] **Step 1: Write failing tests** — `voice-sidecar/tests/test_sc_tools.py`

```python
import asyncio

from src.sc_tools import ScToolExecutor


class FakeTool:
    def __init__(self, name):
        self.name = name
        self.description = f"desc {name}"
        self.inputSchema = {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}


class FakeResult:
    def __init__(self, data, is_error=False):
        self.structured_content = data
        self.is_error = is_error
        self.content = []


class FakeSession:
    def __init__(self, delay=0.0):
        self.delay = delay
    async def list_tools(self):
        class R: tools = [FakeTool("sc_find_item"), FakeTool("sc_trade_routes"), FakeTool("other")]
        return R()
    async def call_tool(self, name, args):
        await asyncio.sleep(self.delay)
        return FakeResult({"echo": name, "args": args})


def _factory(delay=0.0):
    class Ctx:
        async def __aenter__(self): return FakeSession(delay)
        async def __aexit__(self, *a): return False
    return lambda: Ctx()


async def test_refresh_keeps_only_sc_tools_as_declarations():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory())
    assert await ex.refresh()
    assert [d.name for d in ex.declarations] == ["sc_find_item", "sc_trade_routes"]


async def test_call_returns_structured_dict():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory())
    assert await ex.call("sc_find_item", {"name": "V801-12"}) == {"echo": "sc_find_item", "args": {"name": "V801-12"}}


async def test_call_timeout_returns_error_not_raise():
    ex = ScToolExecutor("http://x/mcp", timeout_s=0.05, session_factory=_factory(delay=1.0))
    r = await ex.call("sc_find_item", {"name": "x"})
    assert r["error"] == "timeout"


async def test_refresh_failure_keeps_previous_declarations():
    ex = ScToolExecutor("http://x/mcp", session_factory=_factory())
    await ex.refresh()
    def boom():
        raise OSError("down")
    ex._session_factory = boom
    assert await ex.refresh() is False
    assert len(ex.declarations) == 2
```

(`session_factory` returns an async context manager yielding an initialised session — define it that way in the implementation.)

`voice-sidecar/tests/test_live_bridge_tools.py`: using the existing fake-session pattern from the voice tests (read `tests/` for how `_pump_server` is driven with scripted `receive()` messages and a recorded `send_*`), write tests that:
1. A scripted message with `tool_call.function_calls=[FC(id="c1", name="sc_find_item", args={"name":"V801-12"})]` results in exactly one `send_tool_response` whose `function_responses[0].id == "c1"` and `.response == executor result`.
2. Two function calls in one message are answered concurrently (fake executor with 0.2 s delay each; both responses sent within ~0.3 s total) with matching ids.
3. A `tool_call_cancellation(ids=["c1"])` arriving while `c1` is in flight cancels it: no `send_tool_response` for `c1`.
4. With no executor configured, a tool_call gets a `{"error": "tools_unavailable"}` response.
5. `_live_config` with an executor that has declarations includes a `function_declarations` tool AND the google_search tool, and the system instruction ends with `SC_VOICE_NOTE`; without an executor it is identical to today's config (compare `tools` and `system_instruction` to the no-executor bridge).

Extend `tests/test_genai_surface.py`: assert `types.LiveServerMessage` has fields `tool_call` and `tool_call_cancellation`, `types.LiveServerToolCall` has `function_calls`, `types.FunctionCall` has `id`, `name`, `args`, `types.FunctionResponse` has `id`, `name`, `response`, and `AsyncSession` has `send_tool_response` accepting `function_responses`.

- [ ] **Step 2: Run — expect FAIL.** `cd voice-sidecar && .venv/bin/python -m pytest -q` (or docker python:3.14 as in Task 1).
- [ ] **Step 3: Implement** `src/sc_tools.py`, config, bridge, server changes per Interfaces.
- [ ] **Step 4: Manifests (tracked):** `k8s/voice/voice-deployment.yaml` env `SC_KNOWLEDGE_ENABLED: "false"` + `SC_KNOWLEDGE_URL`; `k8s/voice/voice-networkpolicy.yaml` egress to podSelector `app: sc-knowledge` TCP 8080.
- [ ] **Step 5: Run full voice suite — expect PASS** (≥ 65 + new, 0 failures).
- [ ] **Step 6: Commit**

```bash
git add voice-sidecar/src/sc_tools.py voice-sidecar/src/config.py voice-sidecar/src/live_bridge.py voice-sidecar/src/server.py voice-sidecar/requirements.txt voice-sidecar/tests/ k8s/voice/voice-deployment.yaml k8s/voice/voice-networkpolicy.yaml
git commit -m "feat(voice): Gemini Live function calling backed by sc-knowledge"
```

---

### Task 13: Voice smoke test + docs

**Files:**
- Create: `scripts/smoke-voice-sc.js`
- Modify: `scripts/gen-test-voices.js` (only if needed to add the four SC utterances as fixtures), `CLAUDE.md`, `features.md`, `README.md`

**Interfaces:**
- Consumes: the voice sidecar `Converse` gRPC (see `scripts/smoke-voice-identity.js` — copy its connection, session-start, audio streaming, transcript collection and fixture generation approach).
- Produces: `node scripts/smoke-voice-sc.js` — for each of the four questions: synthesize (or reuse cached) speech with the existing TTS fixture generator (single speaker), stream it into one Converse session each (with `audio_stream_end`), collect `output_transcript` text for up to 45 s after the audio ends, and check the transcript (case-insensitive) contains an expected entity: V801 → `"new babbage"` or `"omega"`; shield → `"fr-76"` or `"coverall"` or `"gorgon"`; Foxwell → `"foxwell"` and any of `"rank"`, `"reputation"`, `"mission"`; MIC-L5 → `"scrap"` or `"route"`. Print PASS/FAIL per question and the full transcript. Exit non-zero if any FAIL. Header comment documents the port-forward (`kubectl port-forward svc/discord-article-bot-voice 50051:50051 -n discord-article-bot &`) and that `SC_KNOWLEDGE_ENABLED=true` must be set on the voice sidecar. (Tool-call occurrence itself is verified from sidecar logs `voice: tool_call` by the coordinator; the script prints a reminder.)

- [ ] **Step 1: Write the script** (no unit test — it is a real-model smoke test like `smoke-voice-identity.js`; verify it at least parses: `node --check scripts/smoke-voice-sc.js`).
- [ ] **Step 2: Docs.**
  - `CLAUDE.md`: new `## Star Citizen Knowledge (sc-knowledge)` section after "Agentic Sandbox": what it is (spec link), the six tools, sources (UEX + Wiki API + privately-synced org guides; why no p4k/datap4k/erkul; the guides are NEVER committed or baked into images — repo and images are public — `scripts/sync-org-guides.sh` → ConfigMap `sc-org-guides`), flags (`SC_KNOWLEDGE_ENABLED`, `SC_KNOWLEDGE_URL`) on both sidecars, the `UEXCORP_BEARER` Secret `sc-knowledge-secrets`, cache TTLs + stale-on-error, the isolation guarantee (probe-gated; never fails Chat), the **three-layer sandbox avoidance** (pre-computed results, `use_sc_tools` host backstop in `RunInSandboxTool` returning exit_code -4 before any pod, `eval/eval_sc.py` hard gate + DQL `fetch spans | filter span.name == "agent.chat" and toInt(sc.tool.calls) > 0 and sandbox.invoked == true` should be ~0), voice tool-call plumbing (6 s bound, cancellation, dropped on resumption), how to add SC Trade Tools later (a `channel_voice` registry entry with `token_attr`), and deploy rules (deployed overlay only; RollingUpdate; image SHA-pinned; NetworkPolicy egress rules on both sidecars).
  - `features.md`: "Star Citizen knowledge (text + voice)" feature entry with the four example questions.
  - `README.md`: env vars `SC_KNOWLEDGE_ENABLED`, `SC_KNOWLEDGE_URL`, `UEXCORP_BEARER` in the config table.
- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-voice-sc.js CLAUDE.md features.md README.md
git commit -m "docs+test: Star Citizen knowledge docs and real-model voice smoke test"
```

---

## Coordinator steps (not subagent tasks)

After all tasks pass review: run all three suites; build + push `sc-knowledge`, agent, voice images tagged with the branch HEAD short SHA; create Secret `sc-knowledge-secrets` from `.env` `UEXCORP_BEARER`; run `scripts/sync-org-guides.sh`; write deployed-overlay copies (`k8s/overlays/deployed/sc-knowledge-*.yaml`, update `agent-deployment.yaml`, `voice-deployment.yaml`, `agent-networkpolicy.yaml`, `voice-networkpolicy.yaml`); apply sc-knowledge → verify healthz + a port-forwarded MCP call; flip agent `SC_KNOWLEDGE_ENABLED=true` → verify the four questions via `AgentClient` from the bot pod (check `sc.tool.calls`, zero sandbox); run `eval/eval_sc.py`; flip voice → run `smoke-voice-sc.js`; DQL check; push branch; PR.

---

### Task 14: Ship/vehicle purchases in `sc_find_item` + non-JSON upstream bodies (added after the live eval)

**Why (live-eval evidence, 2026-09-26):** "where can I buy a Scorpius" → `sc_find_item` found nothing (the Wiki items API has no ships), the model called it 3×, then hallucinated inconsistent answers (wrong dealer / 5.7M vs 6.8M; truth per UEX: New Deal, Lorville, 5,171,040 aUEC) and in one eval run fell back to the sandbox. Separately `sc_find_item` raised `JSONDecodeError` on an upstream non-JSON body, surfacing as `internal`.

**Files:**
- Modify: `sc-knowledge/src/http.py` (non-JSON → `UpstreamError`), `sc-knowledge/src/uex.py` (`vehicles()`, `vehicles_purchases_prices(id_vehicle)`), `sc-knowledge/src/names.py` (`vehicle_entries`), `sc-knowledge/src/tools_items.py` (vehicle path), `sc-knowledge/src/server.py` (constructor wiring, `sc_find_item` docstring mentions ships, fix the doubled `sc_sc_` span/log name), `sc-knowledge/scripts/capture_fixtures.py`
- Test: `sc-knowledge/tests/test_tools_items.py`, `sc-knowledge/tests/test_http.py`, fixtures `uex_vehicles.json`, `uex_vehicle_prices_scorpius.json`

**Interfaces:**
- `UpstreamClient._request`: a success-status response whose body is not valid JSON raises `UpstreamError(name, status, "non-JSON response body: <full body>")` (no truncation).
- `UexClient.vehicles() -> list[dict]` (cached `uex:vehicles` TTL 21600); `UexClient.vehicles_purchases_prices(id_vehicle: int) -> list[dict]` (cached `uex:vprices:<id>` TTL 7200).
- `names.vehicle_entries(vehicles) -> list[Entry]` kind `"vehicle"`, aliases `name`, `name_full`, `slug`.
- `ItemTools(wiki, cache, uex=None)`; `find_item(name)`: resolve `name` against the vehicle index FIRST when `uex` is set; an `exact`/`fuzzy` vehicle match returns `{"source": "uexcorp.space (crowd-sourced)", "game_version", "item": {"name": name_full or name, "type": "Vehicle", "manufacturer": company_name, "scu", "crew", "pad_type"}, "where_to_buy": [{"shop": terminal_name, "location": "<city_name or space_station_name or outpost_name>, <planet_name>", "system": star_system_name, "price_auec": int(price_buy), "reported_at": ISO of date_modified}], "alternatives": [other vehicle names sharing the resolved base name, ≤3]}` sorted by price asc, `note` when empty ("No player-reported dealer listings on UEX (may be pledge-store only or not sold in game)."). An `ambiguous` vehicle resolution with no Wiki item match returns `error("ambiguous", ..., candidates=[...])`. Otherwise fall through to the existing Wiki item path unchanged. Any vehicle-path `UpstreamError` falls through to the Wiki path (never raises).
- `server.py` builds `ItemTools(wiki, cache, uex=uex)`.

- [ ] TDD: tests first (Scorpius → New Deal/Lorville price from fixture; "Scorpius Antares" → Antares not base; V801-12 still resolves via Wiki; non-JSON body → UpstreamError; vehicle UpstreamError falls back to Wiki path), implement, full suite, docker build, commit.
