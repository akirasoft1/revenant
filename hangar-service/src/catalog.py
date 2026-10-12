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

An ITEM's own ``ports`` (``item_slots``) are parsed with the same rule: a
turret's gun ports belong to the turret item, not to the vehicle, so a ship's
actual slot list depends on what is fitted (``loadout.resolve_slots``).

UEX supplement (see ``_supplement``): the Wiki's per-type item LIST omits some
items it does know by uuid (e.g. the Hornet Mk II nose / ball turrets), so the
list is topped up with the UEX item uuids of the matching category, fetched
one by one from the Wiki.
"""
import asyncio
import copy
import logging
import re
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import quote, urlsplit

import httpx
from rapidfuzz import fuzz

from .cache import RateLimiter, TTLCache
from .http import UpstreamClient, UpstreamError
from .keystats import all_stats, key_stat
from .prices import cheapest_price

log = logging.getLogger(__name__)

CATALOG_TTL_S = 12 * 3600
NEGATIVE_TTL_S = 600  # not-found / empty results
DEFAULT_UEX_BASE = "https://api.uexcorp.uk/2.0"
# Wiki item type -> UEX ``id_category`` (types without one get no supplement).
UEX_CATEGORIES = {"Turret": 35, "WeaponGun": 32, "MissileLauncher": 33, "Shield": 23, "Cooler": 19,
                  "PowerPlant": 21, "QuantumDrive": 22, "WeaponMining": 29, "TractorBeam": 67}
# Wiki detail fetches per type per refresh: they go through the Wiki rate
# limiter every hangar read shares, so a UEX category that suddenly lists
# hundreds of unknown uuids must not be able to queue them all.
MAX_SUPPLEMENT_ITEMS = 40
# UEX is optional garnish: ONE attempt, bounded in total (connect + read), and
# never awaited by a request (see ``_supplement``).
UEX_TIMEOUT_S = 4.0
# How long ``warm`` waits for one type's supplement before moving on (the
# refresh keeps running in the background).
WARM_SUPPLEMENT_TIMEOUT_S = 20.0
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
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
    dynamic: bool = False           # the slot is a port of a FITTED item (loadout.resolve_slots)

    def to_dict(self) -> dict:
        out = {
            "slot": self.name,
            "type": self.type,
            "subType": self.sub_type,
            "sizeMin": self.size_min,
            "sizeMax": self.size_max,
            "compatibleTypes": [{"type": c["type"], "subTypes": list(c.get("sub_types") or [])}
                                for c in self.compatible_types],
            "stockItem": dict(self.stock_item) if self.stock_item else None,
        }
        if self.dynamic:
            out["dynamic"] = True
        return out


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
    in payload order (depth-first, parent before child). Also used for a Wiki
    ITEM payload (same ``ports`` shape); its slot ids are relative to the item."""
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


ITEM_SUMMARY_KEYS = ("uuid", "name", "className", "type", "subType", "size", "grade", "class", "manufacturer")


# Image hosts the web editor may load (its CSP ``img-src`` is built from this
# list in static_site.py), in preference order: the two wiki CDNs first, then
# cstone.space, which the Wiki lists FIRST for ~13% of items (62/474 component
# items, 2026-10-11) and which was CSP-blocked until then. Hotlinking cstone was
# checked: 200 with or without a Referer, max-age 7 days.
IMAGE_HOSTS = ("cdn.star-citizen.wiki", "media.starcitizen.tools", "cstone.space")


def _allowed_image_url(url: Any) -> int | None:
    """``IMAGE_HOSTS`` rank of an https URL the editor may load, else None."""
    if not isinstance(url, str) or not url:
        return None
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in IMAGE_HOSTS:
        return None
    return IMAGE_HOSTS.index(parts.hostname)


def _pick_image(v: Any, keys: tuple[str, ...]) -> str | None:
    """Best ``images[]`` URL on an allowed https host, preferring hosts earlier
    in ``IMAGE_HOSTS`` (then list order). Per entry, the first of ``keys`` whose
    URL is loadable is used. None when no image is loadable by the editor (a
    blocked URL would only produce a CSP violation plus an image-error report)."""
    imgs = v.get("images") if isinstance(v, dict) else None
    if not isinstance(imgs, list):
        return None
    best: tuple[int, str] | None = None
    for img in imgs:
        if not isinstance(img, dict):
            continue
        for key in keys:
            url = img.get(key)
            rank = _allowed_image_url(url)
            if rank is not None:
                if best is None or rank < best[0]:
                    best = (rank, url)
                break
    return best[1] if best else None


def _first_image(v: Any) -> str | None:
    """Item/card image: ``thumbnail_url`` else ``original_url`` (see ``_pick_image``)."""
    return _pick_image(v, ("thumbnail_url", "original_url"))


# The ship panel is ~480px wide (2x for high-DPI); full-size Wiki originals are
# up to 3840x2160 / ~1 MB, the default 600px thumbnails look soft. MediaWiki
# (media.starcitizen.tools) renders any width on request: rewriting the
# thumbnail's "<N>px-" segment to 1280px gives a sharp ~130 KB WebP (checked
# 2026-10-11: Harbinger 1280px = 133 KB vs original 921 KB).
HERO_WIDTH = 1280
_MW_THUMB = re.compile(r"^(https://media\.starcitizen\.tools/thumb/.+/)(\d+)px-([^/]+)$")


def _hero_image(v: Any) -> str | None:
    """Vehicle image for the terminal's ship panel. Same entry choice as
    ``_first_image`` (host filtering/preference); for a MediaWiki thumbnail the
    width is rewritten to ``HERO_WIDTH`` (or the original is used when it is
    smaller than that); elsewhere the full-size ``original_url`` else the
    thumbnail."""
    imgs = v.get("images") if isinstance(v, dict) else None
    if not isinstance(imgs, list):
        return None
    best: tuple[int, str] | None = None
    for img in imgs:
        if not isinstance(img, dict):
            continue
        thumb, orig = img.get("thumbnail_url"), img.get("original_url")
        url = None
        m = _MW_THUMB.match(thumb) if isinstance(thumb, str) else None
        if m and _allowed_image_url(thumb) is not None:
            width = img.get("original_width")
            if isinstance(width, (int, float)) and 0 < width <= HERO_WIDTH and _allowed_image_url(orig) is not None:
                url = orig
            else:
                url = f"{m.group(1)}{HERO_WIDTH}px-{m.group(3)}"
        else:
            for cand in (orig, thumb):
                if _allowed_image_url(cand) is not None:
                    url = cand
                    break
        rank = _allowed_image_url(url) if url else None
        if rank is not None and (best is None or rank < best[0]):
            best = (rank, url)
    return best[1] if best else None


def _description(d: Any) -> str | None:
    """``en_EN`` text of a localised description dict, or a plain string."""
    if isinstance(d, dict):
        d = d.get("en_EN")
    if isinstance(d, str) and d.strip():
        return d.strip()
    return None


def item_option(i: dict) -> dict:
    """``item_summary`` plus the picker extras: ``keyStat`` (or None),
    ``cheapestPrice`` (or None), ``stats`` (list, maybe empty) and, when the
    Wiki has them, ``image`` / ``description`` -- see ``keystats`` / ``prices``."""
    out = {**item_summary(i), "keyStat": key_stat(i), "cheapestPrice": cheapest_price(i),
           "stats": all_stats(i)}
    image, desc = _first_image(i), _description(i.get("description"))
    if image:
        out["image"] = image
    if desc:
        out["description"] = desc
    return out


def vehicle_profile_extra(v: dict) -> dict:
    """Optional vehicle fields for the terminal view; absent ones omitted.
    ``image`` is the full-size hero image (``_hero_image``)."""
    out: dict = {}
    image = _hero_image(v)
    if image:
        out["image"] = image
    dim = v.get("dimension")
    if isinstance(dim, dict) and all(isinstance(dim.get(k), (int, float)) for k in ("length", "width", "height")):
        out["dimension"] = {k: dim[k] for k in ("length", "width", "height")}
    mass = v.get("mass")
    if isinstance(mass, (int, float)) and not isinstance(mass, bool):
        out["mass"] = mass
    crew = v.get("crew")
    if isinstance(crew, dict) and all(isinstance(crew.get(k), int) for k in ("min", "max")):
        out["crew"] = {"min": crew["min"], "max": crew["max"]}
    return out


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
                 max_lookup_keys: int = MAX_LOOKUP_KEYS,
                 uex: UpstreamClient | None = None) -> None:
        self._u = upstream
        self._uex = uex    # None = no UEX supplement (Wiki item lists only)
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
        if self._uex is not None:
            await self._uex.aclose()

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
        """Startup prefetch of the vehicle index, then the per-type item lists
        (``items:<type>:None``, the keys chat-edit fuzzy item resolution reads
        via ``items(type)``) and their UEX supplements, one type at a time so the Wiki's rate limit isn't
        hit with a burst. Best effort: each step is isolated and logged; never
        raises."""
        try:
            await self.vehicle_index()
        except Exception:
            log.warning("catalog: warm-up of the vehicle index failed", exc_info=True)
        for type_ in sorted(SLOT_TYPES):
            try:
                await self._item_records(type_, None)
                # Requests never wait for the UEX supplement; warm-up does,
                # for a bounded time, so the first picker usually has it.
                task = self._refreshing.get(f"items_supplement:{type_}")
                if isinstance(task, asyncio.Future) and not task.done():
                    await asyncio.wait_for(asyncio.shield(task), WARM_SUPPLEMENT_TIMEOUT_S)
            except asyncio.TimeoutError:
                log.warning("catalog: the UEX supplement for %s items is still loading after %.0fs; "
                            "continuing in the background", type_, WARM_SUPPLEMENT_TIMEOUT_S)
            except Exception:
                log.warning("catalog: warm-up of the %s item list failed", type_, exc_info=True)

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
            return {"summary": vehicle_summary(data), "slots": parse_slots(data),
                    "extra": vehicle_profile_extra(data)}

        key = f"vehicle:{ident.casefold()}"
        self._touch_lookup(key)
        return await self._swr(key, fetch)

    async def vehicle(self, uuid_or_slug: str) -> dict | None:
        """Vehicle summary ``{uuid, name, gameName, slug, className, manufacturer}``
        or None if the Wiki has no such vehicle. Raises UpstreamError when the
        Wiki is down and nothing is cached."""
        d = await self._detail(uuid_or_slug)
        return dict(d["summary"]) if d else None

    async def vehicle_profile(self, uuid_or_slug: str) -> dict | None:
        """``vehicle`` plus the optional terminal-view fields (``image``,
        ``dimension``, ``mass``, ``crew``) and ``portCounts`` (editable slots
        per type). None if unknown."""
        d = await self._detail(uuid_or_slug)
        if not d:
            return None
        counts = Counter(s.type for s in d["slots"])
        return {**d["summary"], **copy.deepcopy(d.get("extra") or {}), "portCounts": dict(counts)}

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

    async def vehicle_by_class_name(self, class_name: str) -> dict | None:
        """The catalog vehicle whose game ``className`` equals ``class_name``
        (case-insensitive; e.g. spviewer's ``vehicleClassName``), or None."""
        wanted = (class_name or "").strip().casefold()
        if not wanted:
            return None
        return next((v for v in await self.vehicle_index()
                     if (v.get("className") or "").casefold() == wanted), None)

    async def resolve_vehicle(self, query: str):
        """Resolve free text (name/slug/uuid/class name, fuzzy) to one catalog
        vehicle -> ``loadout.Resolution``."""
        from .loadout import resolve_vehicle
        return resolve_vehicle(query, await self.vehicle_index())

    # ----- items -----

    async def _wiki_items(self, canonical: str, size: int | None) -> list[dict]:
        """Cached ``item_option`` records of the Wiki's own list for one type
        (+ optional size), by name."""
        async def fetch():
            out: list[dict] = []
            page = 1
            params: dict = {"filter[type]": canonical, "limit": 200}
            if size is not None:
                params["filter[size]"] = size
            while page <= _MAX_PAGES:
                body = await self._u.get_json("v2/items", {**params, "page": page})
                out.extend(item_option(i) for i in body.get("data") or [] if isinstance(i, dict))
                last = (body.get("meta") or {}).get("last_page") or 1
                if page >= last:
                    break
                page += 1
            out.sort(key=lambda i: (i["name"] or "").casefold())
            return out

        return await self._cached(f"items:{canonical}:{size}", fetch)

    async def _fetch_supplement(self, canonical: str, category: int) -> list[dict]:
        body = await asyncio.wait_for(self._uex.get_json("items", {"id_category": category}), UEX_TIMEOUT_S)
        rows = body.get("data") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            raise UpstreamError("uex", None, f"items?id_category={category}: 'data' is not a list")
        seen = {(i.get("uuid") or "").casefold() for i in await self._wiki_items(canonical, None)}
        missing: list[str] = []
        for row in rows:
            uuid = row.get("uuid") if isinstance(row, dict) else None
            # Only well-formed uuids ever become a Wiki path segment.
            if isinstance(uuid, str) and _UUID_RE.match(uuid) and uuid.casefold() not in seen:
                seen.add(uuid.casefold())
                missing.append(uuid)
        if len(missing) > MAX_SUPPLEMENT_ITEMS:
            log.warning("catalog: UEX lists %d %s items the Wiki list omits; only the first %d are looked up",
                        len(missing), canonical, MAX_SUPPLEMENT_ITEMS)
            missing = missing[:MAX_SUPPLEMENT_ITEMS]
        out: list[dict] = []
        for uuid in missing:
            try:
                detail = await self._u.get_json(f"v2/items/{quote(uuid, safe='')}")
            except UpstreamError as e:
                if e.status == 404:
                    continue                       # UEX knows it, the Wiki does not
                raise
            data = detail.get("data") if isinstance(detail, dict) else None
            if isinstance(data, dict) and data.get("uuid") and data.get("type") == canonical:
                out.append(item_option(data))
        return out

    def _supplement(self, canonical: str) -> list[dict]:
        """``item_option`` records of items the Wiki list for this type omits
        but UEX lists (same uuids) and the Wiki knows by uuid -- every size.

        NEVER awaited by a request: returns what is cached right now (the last
        good supplement, or ``[]`` before the first one lands) and, when that
        is missing or expired, starts ONE background refresh per type
        (``_spawn``, tracked like ``_swr`` refreshes). So a UEX that accepts
        the connection and goes silent cannot stall a picker or a chat edit.

        A refresh is one UEX call + at most ``MAX_SUPPLEMENT_ITEMS`` Wiki
        detail calls, good for 12h. Any UEX / detail failure is logged, keeps
        the last good supplement and is retried after the negative TTL (10
        min) rather than cached for 12h."""
        category = UEX_CATEGORIES.get(canonical)
        if self._uex is None or category is None:
            return []
        key = f"items_supplement:{canonical}"
        peeked = self._cache.peek(key)
        previous = peeked.value["items"] if peeked is not None else []
        ttl = self._neg_ttl if peeked is not None and not peeked.value["ok"] else self._ttl
        if peeked is not None and peeked.age_s < ttl:
            return previous
        task = self._refreshing.get(key)
        if task is None or task.done():
            async def fetch():
                try:
                    return {"ok": True, "items": await self._fetch_supplement(canonical, category)}
                except Exception as e:
                    log.warning("catalog: UEX supplement for %s items failed (%s: %s); serving the Wiki list%s "
                                "and retrying in %.0fs", canonical, type(e).__name__, e,
                                f" plus the last good supplement ({len(previous)} items)" if previous else " alone",
                                self._neg_ttl)
                    return {"ok": False, "items": previous}

            task = self._spawn(self._refresh(key, ttl, fetch))
            self._refreshing[key] = task
            add_cb = getattr(task, "add_done_callback", None)
            if add_cb is not None:
                add_cb(lambda t, k=key: self._forget_refresh(k, t))
        return previous

    async def _item_records(self, type_: str, size: int | None) -> list[dict]:
        """Cached ``item_option`` records of one type (+ optional size), by
        name: the Wiki list plus whatever UEX supplement is cached right now
        (``_supplement`` -- never waited for)."""
        canonical = normalize_item_type(type_)
        if size is not None:
            size = int(size)
        records = await self._wiki_items(canonical, size)
        seen = {r.get("uuid") for r in records}
        extra = [r for r in self._supplement(canonical)
                 if r.get("uuid") not in seen and (size is None or r.get("size") == size)]
        if not extra:
            return records
        return sorted(records + extra, key=lambda i: (i["name"] or "").casefold())

    async def items(self, type_: str, size: int | None = None, q: str | None = None) -> list[dict]:
        """Items of a Wiki type (case-insensitive, must be in ``SLOT_TYPES``
        else ``UnknownItemType``), optionally one size, optionally filtered by
        a case-insensitive name substring; sorted by name."""
        items = await self._item_records(type_, size)
        if q and q.strip():
            needle = q.strip().casefold()
            items = [i for i in items
                     if needle in (i["name"] or "").casefold() or needle in (i["className"] or "").casefold()]
        return [{k: i.get(k) for k in ITEM_SUMMARY_KEYS} for i in items]

    async def item_options(self, type_: str, size: int | None = None) -> list[dict]:
        """Like ``items`` (same cache entry, so no extra Wiki call) but each item
        also carries ``keyStat`` and ``cheapestPrice`` for the web editor's picker."""
        return copy.deepcopy(await self._item_records(type_, size))

    async def _item_detail(self, uuid_or_name: str) -> dict | None:
        """``{summary, slots}`` of one item (one cache entry per key, shared
        by ``item`` and ``item_slots``), None if unknown."""
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
            if not isinstance(data, dict) or not data.get("uuid"):
                return None
            return {"summary": item_summary(data), "slots": parse_slots(data)}

        key = f"item:{ident.casefold()}"
        self._touch_lookup(key)
        return await self._cached(key, fetch)

    async def item(self, uuid_or_name: str) -> dict | None:
        """One item summary by uuid (or exact Wiki name), None if unknown."""
        d = await self._item_detail(uuid_or_name)
        return dict(d["summary"]) if d else None

    async def item_slots(self, item_uuid: str) -> list[Slot] | None:
        """Component slots an ITEM carries (its own ``ports``, same rule as
        vehicle ports; slot ids relative to the item, ``stock_item`` = the
        port's default item), None if the item is unknown. Deep copies. Shares
        ``item``'s cache entry (12h, 10 min negative)."""
        d = await self._item_detail(item_uuid)
        return copy.deepcopy(d["slots"]) if d else None


def build_catalog(wiki_base: str = DEFAULT_WIKI_BASE, version: str = "dev",
                  transport: httpx.AsyncBaseTransport | None = None,
                  cache: TTLCache | None = None,
                  sleep: Callable[[float], Awaitable[None]] | None = None,
                  spawn: Callable[[Awaitable], "asyncio.Task"] | None = None,
                  max_lookup_keys: int = MAX_LOOKUP_KEYS,
                  uex_base: str | None = None, uex_bearer: str | None = None,
                  uex_transport: httpx.AsyncBaseTransport | None = None) -> Catalog:
    """``uex_base`` unset/empty = no UEX supplement (tests; the service passes
    ``Config.uex_base``). ``uex_bearer`` is optional and only ever sent as the
    UEX ``Authorization`` header -- never logged."""
    headers = {"User-Agent": f"revenant-hangar-service/{version}", "Accept": "application/json"}
    kw = {"sleep": sleep} if sleep is not None else {}
    upstream = UpstreamClient("wiki", wiki_base, headers, RateLimiter(60, 60.0), transport=transport, **kw)
    uex = None
    if uex_base:
        uex_headers = dict(headers)
        if uex_bearer:
            uex_headers["Authorization"] = f"Bearer {uex_bearer}"
        uex = UpstreamClient("uex", uex_base, uex_headers, RateLimiter(60, 60.0), transport=uex_transport,
                             timeout=httpx.Timeout(UEX_TIMEOUT_S, connect=2.0), max_attempts=1, **kw)
    return Catalog(upstream, cache=cache, spawn=spawn, max_lookup_keys=max_lookup_keys, uex=uex)
