"""Star Citizen Wiki catalog: vehicles -> editable component slots -> compatible items.

Game data comes from the Star Citizen Wiki API (``api.star-citizen.wiki``, the
same source sc-knowledge uses). Everything is cached in-process for 12h with
stale-on-error (``TTLCache``): a Wiki outage serves the last good copy rather
than failing a hangar read.

Slot rule (see the hangar spec): a vehicle port is a component slot when it is
``editable`` and its ``type`` is in ``SLOT_TYPES``. Nested ports are walked at
every depth and a nested slot's id is the ``/``-joined path of port names from
the top (``hardpoint_gun_laser_top_left/hardpoint_class_2``). The child's OWN
``editable`` flag decides -- the real Wiki payload marks a gimbal's gun
``editable: true`` while the gimbal's ``editable_children`` is ``false`` (e.g.
every Constellation Taurus S5 turret and the Harbinger's nose guns), so gating
on the parent's ``editable_children`` would hide every swappable gun.
"""
import asyncio
import copy
import logging
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import httpx
from rapidfuzz import fuzz

from .cache import RateLimiter, TTLCache
from .http import UpstreamClient, UpstreamError

log = logging.getLogger(__name__)

CATALOG_TTL_S = 12 * 3600
NEGATIVE_TTL_S = 600  # not-found / empty results
MAX_LOOKUP_KEYS = 2000
MAX_LOOKUP_KEY_LEN = 200
DEFAULT_WIKI_BASE = "https://api.star-citizen.wiki/api"
SEARCH_LIMIT_MAX = 25
_INDEX_PAGE_SIZE = 50  # the Wiki caps /vehicles pages at 50
_MAX_PAGES = 40
_SEARCH_MIN_SCORE = 70.0

SLOT_TYPES = frozenset({
    "QuantumDrive", "Shield", "PowerPlant", "Cooler", "Radar", "WeaponGun",
    "Turret", "MissileLauncher", "WeaponMining", "TractorBeam",
})


@dataclass(frozen=True)
class Slot:
    name: str                       # slot id; nested slots are "parent/child"
    type: str
    sub_type: str | None
    size_min: int | None
    size_max: int | None
    compatible_types: list[dict] = field(default_factory=list)   # [{type, sub_types}]
    stock_item: dict | None = None  # {uuid, name, className, type, size} or None

    def to_dict(self) -> dict:
        return {
            "slot": self.name,
            "type": self.type,
            "subType": self.sub_type,
            "sizeMin": self.size_min,
            "sizeMax": self.size_max,
            "compatibleTypes": [{"type": c["type"], "subTypes": list(c.get("sub_types") or [])}
                                for c in self.compatible_types],
            "stockItem": dict(self.stock_item) if self.stock_item else None,
        }


def _stock(equipped: Any) -> dict | None:
    if not isinstance(equipped, dict) or not equipped.get("uuid"):
        return None
    return {"uuid": equipped.get("uuid"), "name": equipped.get("name"),
            "className": equipped.get("class_name"), "type": equipped.get("type"),
            "size": equipped.get("size")}


def _compat(raw: Any) -> list[dict]:
    out = []
    for c in raw or []:
        if isinstance(c, dict) and c.get("type"):
            out.append({"type": c["type"], "sub_types": list(c.get("sub_types") or [])})
    return out


def parse_slots(vehicle: dict) -> list[Slot]:
    """Flatten a Wiki vehicle payload's ``ports`` tree into component slots,
    in payload order (depth-first, parent before child)."""
    slots: list[Slot] = []

    def walk(ports: Any, prefix: str) -> None:
        for p in ports or []:
            if not isinstance(p, dict) or not p.get("name"):
                continue
            path = f"{prefix}/{p['name']}" if prefix else p["name"]
            compat = _compat(p.get("compatible_types"))
            # An editable port that is EMPTY in stock has type "" (the Wiki
            # copies the port type from the equipped item), so fall back to
            # the first allowlisted compatible type.
            slot_type = p.get("type") if p.get("type") in SLOT_TYPES else next(
                (c["type"] for c in compat if c["type"] in SLOT_TYPES), None)
            if p.get("editable") is True and slot_type is not None:
                sizes = p.get("sizes") or {}
                slots.append(Slot(
                    name=path, type=slot_type, sub_type=p.get("sub_type"),
                    size_min=sizes.get("min"), size_max=sizes.get("max"),
                    compatible_types=compat,
                    stock_item=_stock(p.get("equipped_item")),
                ))
            walk(p.get("ports"), path)

    walk(vehicle.get("ports"), "")
    return slots


def _manufacturer_name(m: Any) -> str | None:
    if isinstance(m, dict):
        return m.get("name")
    return m if isinstance(m, str) else None


def vehicle_summary(v: dict) -> dict:
    return {"uuid": v.get("uuid"), "name": v.get("name"), "gameName": v.get("game_name"),
            "slug": v.get("slug"), "className": v.get("class_name"),
            "manufacturer": _manufacturer_name(v.get("manufacturer"))}


def item_summary(i: dict) -> dict:
    return {"uuid": i.get("uuid"), "name": i.get("name"), "className": i.get("class_name"),
            "type": i.get("type"), "subType": i.get("sub_type"), "size": i.get("size"),
            "grade": i.get("grade"), "class": i.get("class"),
            "manufacturer": _manufacturer_name(i.get("manufacturer"))}


def _search_score(q: str, v: dict) -> float:
    """Rank a vehicle summary against a casefolded query: exact > prefix >
    whole-token containment > fuzzy."""
    best = 0.0
    q_tokens = q.split()
    for field_name in ("name", "gameName", "slug", "className"):
        text = (v.get(field_name) or "").casefold()
        if not text:
            continue
        if text == q:
            return 1000.0
        tokens = text.replace("-", " ").replace("_", " ").split()
        if text.startswith(q):
            best = max(best, 500.0 - len(text) / 100)
        elif q_tokens and all(t in tokens for t in q_tokens):
            best = max(best, 300.0 - len(text) / 100)
        elif q_tokens and all(any(tok.startswith(t) for tok in tokens) for t in q_tokens):
            best = max(best, 200.0 - len(text) / 100)
        if field_name in ("name", "gameName"):
            best = max(best, fuzz.WRatio(q, text))
    return best


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, (list, dict)) and not value)


class UnknownItemType(ValueError):
    """An item type outside ``SLOT_TYPES`` (Task 2 maps it to 400/422)."""


def normalize_item_type(type_: Any) -> str:
    """Case-insensitive match against ``SLOT_TYPES`` -> canonical spelling.
    Validated BEFORE the type becomes a cache key or an upstream query."""
    if isinstance(type_, str):
        wanted = type_.strip().casefold()
        for t in SLOT_TYPES:
            if t.casefold() == wanted:
                return t
    raise UnknownItemType(f"unknown item type {type_!r}; expected one of {sorted(SLOT_TYPES)}")


class Catalog:
    """Wiki catalog with a 12h cache.

    - Found results live ``ttl_s`` (12h); not-found / empty results only
      ``NEGATIVE_TTL_S`` (10 min), so a newly added ship or item is picked up.
    - The vehicle index and vehicle details are stale-while-revalidate: past
      expiry the stale copy is returned at once and ONE background refresh
      runs per key (a failed refresh is logged and the stale copy kept).
    - Free-text lookup keys (vehicle slug/uuid, item uuid/name) are capped at
      ``MAX_LOOKUP_KEY_LEN`` characters and LRU-bounded at ``max_lookup_keys``
      so arbitrary caller input cannot grow the cache without bound.
    """

    def __init__(self, upstream: UpstreamClient, cache: TTLCache | None = None,
                 ttl_s: float = CATALOG_TTL_S, negative_ttl_s: float = NEGATIVE_TTL_S,
                 spawn: Callable[[Awaitable], "asyncio.Task"] | None = None,
                 max_lookup_keys: int = MAX_LOOKUP_KEYS) -> None:
        self._u = upstream
        self._cache = cache or TTLCache()
        self._ttl = ttl_s
        self._neg_ttl = negative_ttl_s
        self._spawn = spawn or asyncio.create_task
        self._refreshing: dict[str, asyncio.Task] = {}
        self._max_lookup_keys = max_lookup_keys
        self._lookup_keys: OrderedDict[str, None] = OrderedDict()

    # ----- caching -----

    def _ttl_for(self, key: str) -> float:
        peeked = self._cache.peek(key)
        return self._neg_ttl if peeked is not None and _is_empty(peeked.value) else self._ttl

    async def _cached(self, key: str, fetch: Callable[[], Awaitable[Any]]) -> Any:
        res = await self._cache.get_or_fetch(key, self._ttl_for(key), fetch)
        if res.status == "stale":
            log.warning("catalog: serving stale %s (age %.0fs) after a Wiki failure", key, res.age_s)
        return res.value

    async def _refresh(self, key: str, ttl: float, fetch) -> None:
        try:
            await self._cache.get_or_fetch(key, ttl, fetch)
        except Exception:
            log.warning("catalog: background refresh of %s failed; serving stale data", key, exc_info=True)

    async def _swr(self, key: str, fetch: Callable[[], Awaitable[Any]]) -> Any:
        """Stale-while-revalidate for non-empty values; an expired empty
        (not-found) value is re-fetched inline instead."""
        ttl = self._ttl_for(key)
        peeked = self._cache.peek(key, ttl)
        if peeked is not None and peeked.status == "stale" and not _is_empty(peeked.value):
            task = self._refreshing.get(key)
            if task is None or task.done():
                task = self._spawn(self._refresh(key, ttl, fetch))
                self._refreshing[key] = task
                add_cb = getattr(task, "add_done_callback", None)
                if add_cb is not None:
                    add_cb(lambda t, k=key: self._forget_refresh(k, t))
            return peeked.value
        return await self._cached(key, fetch)

    def _forget_refresh(self, key: str, task) -> None:
        # Only drop the entry if it is still THIS task (a newer refresh for
        # the same key may have replaced it).
        if self._refreshing.get(key) is task:
            del self._refreshing[key]

    def pending_refreshes(self) -> int:
        """Background refreshes still tracked (finished ones are pruned)."""
        return len(self._refreshing)

    def vehicle_index_cached(self) -> bool:
        """Whether the vehicle index is in the cache (fresh or stale). Never
        touches the upstream -- safe for /healthz."""
        return self._cache.peek("vehicle_index") is not None

    async def drain_refreshes(self) -> None:
        """Await in-flight background refreshes (tests / shutdown)."""
        tasks = [t for t in self._refreshing.values() if not t.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def aclose(self) -> None:
        """Shutdown: cancel background refreshes and close the HTTP client."""
        for task in list(self._refreshing.values()):
            if not task.done():
                task.cancel()
        await self.drain_refreshes()
        self._refreshing.clear()
        await self._u.aclose()

    def _touch_lookup(self, key: str) -> None:
        self._lookup_keys[key] = None
        self._lookup_keys.move_to_end(key)
        while len(self._lookup_keys) > self._max_lookup_keys:
            old, _ = self._lookup_keys.popitem(last=False)
            self._cache.discard(old)
            # An in-flight refresh would write the evicted key back into the
            # cache behind the LRU's back -- cancel it and stop tracking it.
            task = self._refreshing.pop(old, None)
            if task is not None and not task.done():
                task.cancel()

    def lookup_key_count(self) -> int:
        return len(self._lookup_keys)

    async def warm(self) -> None:
        """Startup prefetch of the vehicle index. Best effort: never raises."""
        try:
            await self.vehicle_index()
        except Exception:
            log.warning("catalog: warm-up of the vehicle index failed", exc_info=True)

    # ----- vehicles -----

    async def _detail(self, uuid_or_slug: str) -> dict | None:
        ident = (uuid_or_slug or "").strip()
        if not ident or len(ident) > MAX_LOOKUP_KEY_LEN:
            return None

        async def fetch():
            try:
                body = await self._u.get_json(f"vehicles/{quote(ident, safe='')}")
            except UpstreamError as e:
                if e.status == 404:
                    return None
                raise
            data = body.get("data") if isinstance(body, dict) else None
            if not isinstance(data, dict) or not data.get("uuid"):
                return None
            return {"summary": vehicle_summary(data), "slots": parse_slots(data)}

        key = f"vehicle:{ident.casefold()}"
        self._touch_lookup(key)
        return await self._swr(key, fetch)

    async def vehicle(self, uuid_or_slug: str) -> dict | None:
        """Vehicle summary ``{uuid, name, gameName, slug, className, manufacturer}``
        or None if the Wiki has no such vehicle. Raises UpstreamError when the
        Wiki is down and nothing is cached."""
        d = await self._detail(uuid_or_slug)
        return dict(d["summary"]) if d else None

    async def slots(self, vehicle_uuid: str) -> list[Slot] | None:
        """Component slots of a vehicle (uuid or slug), None if unknown.
        Deep copies: callers may mutate them without touching the cache."""
        d = await self._detail(vehicle_uuid)
        return copy.deepcopy(d["slots"]) if d else None

    async def vehicle_index(self) -> list[dict]:
        """Every catalog vehicle as a summary dict (all /vehicles pages, cached 12h)."""
        async def fetch():
            out: list[dict] = []
            page = 1
            while page <= _MAX_PAGES:
                body = await self._u.get_json("vehicles", {"limit": _INDEX_PAGE_SIZE, "page": page})
                for v in body.get("data") or []:
                    if isinstance(v, dict) and v.get("uuid"):
                        out.append(vehicle_summary(v))
                last = (body.get("meta") or {}).get("last_page") or 1
                if page >= last:
                    break
                page += 1
            return out
        return [dict(v) for v in await self._swr("vehicle_index", fetch)]

    async def search_vehicles(self, q: str, limit: int = SEARCH_LIMIT_MAX) -> list[dict]:
        """Autocomplete: best matches first, at most ``min(limit, 25)``. An empty
        query returns the first vehicles alphabetically."""
        limit = max(1, min(int(limit), SEARCH_LIMIT_MAX))
        index = await self.vehicle_index()
        query = (q or "").strip().casefold()
        if not query:
            return sorted(index, key=lambda v: (v["name"] or "").casefold())[:limit]
        scored = [(s, v) for v in index if (s := _search_score(query, v)) >= _SEARCH_MIN_SCORE]
        scored.sort(key=lambda sv: (-sv[0], (sv[1]["name"] or "").casefold()))
        return [v for _, v in scored[:limit]]

    async def resolve_vehicle(self, query: str):
        """Resolve free text (name/slug/uuid/class name, fuzzy) to one catalog
        vehicle -> ``loadout.Resolution``."""
        from .loadout import resolve_vehicle
        return resolve_vehicle(query, await self.vehicle_index())

    # ----- items -----

    async def items(self, type_: str, size: int | None = None, q: str | None = None) -> list[dict]:
        """Items of a Wiki type (case-insensitive, must be in ``SLOT_TYPES``
        else ``UnknownItemType``), optionally one size, optionally filtered by
        a case-insensitive name substring; sorted by name."""
        canonical = normalize_item_type(type_)
        if size is not None:
            size = int(size)

        async def fetch():
            out: list[dict] = []
            page = 1
            params: dict = {"filter[type]": canonical, "limit": 200}
            if size is not None:
                params["filter[size]"] = size
            while page <= _MAX_PAGES:
                body = await self._u.get_json("v2/items", {**params, "page": page})
                out.extend(item_summary(i) for i in body.get("data") or [] if isinstance(i, dict))
                last = (body.get("meta") or {}).get("last_page") or 1
                if page >= last:
                    break
                page += 1
            out.sort(key=lambda i: (i["name"] or "").casefold())
            return out

        items = await self._cached(f"items:{canonical}:{size}", fetch)
        if q and q.strip():
            needle = q.strip().casefold()
            items = [i for i in items
                     if needle in (i["name"] or "").casefold() or needle in (i["className"] or "").casefold()]
        return [dict(i) for i in items]

    async def item(self, uuid_or_name: str) -> dict | None:
        """One item summary by uuid (or exact Wiki name), None if unknown."""
        ident = (uuid_or_name or "").strip()
        if not ident or len(ident) > MAX_LOOKUP_KEY_LEN:
            return None

        async def fetch():
            try:
                body = await self._u.get_json(f"v2/items/{quote(ident, safe='')}")
            except UpstreamError as e:
                if e.status == 404:
                    return None
                raise
            data = body.get("data") if isinstance(body, dict) else None
            return item_summary(data) if isinstance(data, dict) and data.get("uuid") else None

        key = f"item:{ident.casefold()}"
        self._touch_lookup(key)
        res = await self._cached(key, fetch)
        return dict(res) if res else None


def build_catalog(wiki_base: str = DEFAULT_WIKI_BASE, version: str = "dev",
                  transport: httpx.AsyncBaseTransport | None = None,
                  cache: TTLCache | None = None,
                  sleep: Callable[[float], Awaitable[None]] | None = None,
                  spawn: Callable[[Awaitable], "asyncio.Task"] | None = None,
                  max_lookup_keys: int = MAX_LOOKUP_KEYS) -> Catalog:
    headers = {"User-Agent": f"revenant-hangar-service/{version}", "Accept": "application/json"}
    kw = {"sleep": sleep} if sleep is not None else {}
    upstream = UpstreamClient("wiki", wiki_base, headers, RateLimiter(60, 60.0), transport=transport, **kw)
    return Catalog(upstream, cache=cache, spawn=spawn, max_lookup_keys=max_lookup_keys)
