"""location_shops: what is sold at a Star Citizen location, and which of those
items are sold ONLY there (per player-reported UEX data).

Built from three UEX endpoints: `terminals` (to resolve the place), `items_prices_all`
(~24k price rows, ~6 MB) and `categories` (section/category names). Only
terminals with is_available_live == 1 count, both for resolving the place and
for deciding exclusivity -- UEX still carries old terminals like the pre-Nyx
"Dumper's Depot - Levski" (is_available_live == 0), and letting those in would
both sweep dead shops into a Levski answer and make a genuinely Levski-only
item look like it's also sold elsewhere.

Location resolution uses the same token-boundary matching as trade routes
(names.token_match -- never raw substring, see the "l1"/"l19" note there),
tier by tier from the most specific kind of place to the least, and stops at
the first tier with any match: "Levski" matches city_name and so never sweeps
in the rest of Nyx, or an unrelated terminal whose NAME merely contains the
word. Terminal names/nicknames are the LAST tier on purpose: a city's
terminals don't all carry the city in their name, so matching names first
would silently drop some of that city's shops.

Latency (voice bounds a whole tool call at 6s): all three datasets are
prefetched at server startup (`warm()`), and an EXPIRED entry is served
immediately (flagged stale) while a single-flight background refresh
re-fetches it -- stale-while-revalidate. TTLCache itself holds its per-key
lock across the fetch, so without this the first caller after expiry would
wait on the whole 6 MB refetch. A cold cache (warm-up failed and nothing ever
cached) still fetches inline; an upstream failure there is `uex_unavailable`.
"""
import asyncio
import logging
import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from rapidfuzz import fuzz, process

from .cache import CacheResult, TTLCache
from .envelope import error
from .http import UpstreamError
from .names import normalise, token_match
from .uex import UexClient

logger = logging.getLogger("sc_knowledge.shops")

SOURCE = "uexcorp.space (crowd-sourced)"

_PRICES_KEY = "uex:items_prices_all"
_CATEGORIES_KEY = "uex:categories"
_PRICES_TTL = 3600
_CATEGORIES_TTL = 3600
# Same key + TTL TradeTools uses, so the two tools share one terminals fetch.
_TERMINALS_KEY = "uex:terminals"
_TERMINALS_TTL = 21600

_MAX_LIMIT = 100

# Most specific kind of place first; the first tier with any live match wins.
_LOCATION_TIERS: tuple[tuple[str, ...], ...] = (
    ("city_name", "space_station_name", "outpost_name"),
    ("moon_name", "planet_name", "orbit_name"),
    ("star_system_name",),
    ("name", "nickname", "displayname"),
)
_ALL_LOCATION_FIELDS = tuple(f for tier in _LOCATION_TIERS for f in tier)

# UEX files these ship parts under the "Utility" section alongside FPS gadgets,
# so the ship/FPS aliases are split per category name, not just per section.
_SHIP_UTILITY_CATEGORIES = frozenset({
    "mining laser heads", "mining modules", "scraper beams", "salvage beams",
    "tractor beams", "docking collars", "external fuel tanks", "fuel nozzle",
})
# (sections, extra category names, excluded category names)
_SHIP_ALIAS = (frozenset({"vehicle weapons", "systems", "avionics", "module", "vehicle",
                          "propulsion"}),
               _SHIP_UTILITY_CATEGORIES, frozenset())
# Tractor beams stay in both: UEX doesn't distinguish ship tractor beams from
# the FPS multitool attachment.
_FPS_ALIAS = (frozenset({"personal weapons", "armor", "utility", "clothing", "undersuits"}),
              frozenset(), _SHIP_UTILITY_CATEGORIES - {"tractor beams"})
_CATEGORY_ALIASES = {
    "ship": _SHIP_ALIAS, "shipparts": _SHIP_ALIAS, "shipcomponents": _SHIP_ALIAS,
    "components": _SHIP_ALIAS,
    "fps": _FPS_ALIAS, "fpsgear": _FPS_ALIAS, "fpsequipment": _FPS_ALIAS,
}
_CATEGORY_SPLIT_RE = re.compile(r",|/|&|\+|;|\bor\b|\band\b", re.IGNORECASE)

_NOTE_CROWD_SOURCED = (
    "Shop stock is player-reported to UEX (crowd-sourced); \"exclusive\" means no OTHER "
    "live terminal has a reported buy price in UEX data -- exclusivity is relative to "
    "player-reported UEX data and may miss shops. Verify in game.")


def _num(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _is_live(t: dict) -> bool:
    return _num(t.get("is_available_live")) == 1


def _iso(epoch) -> str | None:
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _section_key(s: str | None) -> str:
    # "Vehicle" (as named in the alias spec) vs UEX's actual "Vehicles".
    return normalise(s).rstrip("s")


def _merge_freshness(*results: CacheResult) -> dict:
    stale = [r for r in results if r.status == "stale"]
    if not stale:
        return {}
    worst = max(stale, key=lambda r: r.age_s)
    return {"stale": True, "age_minutes": round(worst.age_s / 60)}


def resolve_location(query: str, terminals: list[dict]) -> tuple[list[dict], str]:
    """(matched LIVE terminals, label). Empty list when nothing matches."""
    q = normalise(query)
    live = [t for t in terminals if _is_live(t)]
    if len(q) < 2:
        return [], query
    for tier in _LOCATION_TIERS:
        matched: list[dict] = []
        values: set[str] = set()
        for t in live:
            hit = False
            for f in tier:
                v = t.get(f)
                if v and token_match(str(v), q):
                    values.add(str(v))
                    hit = True
            if hit:
                matched.append(t)
        if matched:
            label = next(iter(values)) if len(values) == 1 else query
            return matched, label
    return [], query


def location_candidates(query: str, terminals: list[dict], limit: int = 5) -> list[str]:
    choices = sorted({str(t.get(f)) for t in terminals if _is_live(t)
                      for f in _ALL_LOCATION_FIELDS if t.get(f)})
    if not choices:
        return []
    scored = process.extract(query, choices, scorer=fuzz.WRatio, limit=limit, score_cutoff=50)
    return [c for c, _score, _i in scored]


def _category_matches(part_norm: str, cat: dict) -> bool:
    variants = {part_norm, part_norm + "s", part_norm.rstrip("s")}
    for field in ("section", "name"):
        v = cat.get(field)
        if v and any(token_match(str(v), x) for x in variants if x):
            return True
    return False


def resolve_categories(category: str | None,
                       categories: list[dict]) -> tuple[set | None, list[str]]:
    """(allowed id_category set, or None for no filter; notes)."""
    if not category or not category.strip():
        return None, []
    parts = [p.strip() for p in _CATEGORY_SPLIT_RE.split(category) if p and p.strip()]
    allowed: set = set()
    unknown: list[str] = []
    for part in parts:
        key = normalise(part)
        ids: set = set()
        alias = _CATEGORY_ALIASES.get(key)
        if alias is not None:
            sections, extra, excluded = alias
            section_keys = {_section_key(s) for s in sections}
            for c in categories:
                name = (c.get("name") or "").lower()
                if name in excluded:
                    continue
                if _section_key(c.get("section")) in section_keys or name in extra:
                    ids.add(c.get("id"))
        elif key:
            ids = {c.get("id") for c in categories if _category_matches(key, c)}
        if ids:
            allowed |= ids
        else:
            unknown.append(part)
    if not allowed:
        return None, [f"Category '{category}' not recognised; showing all categories."]
    notes = [f"Category '{p}' not recognised; ignored." for p in unknown]
    return allowed, notes


class ShopTools:
    def __init__(self, uex: UexClient, cache: TTLCache,
                 spawn: Callable[[Awaitable], asyncio.Task] | None = None) -> None:
        self._uex = uex
        self._cache = cache
        self._spawn = spawn or asyncio.create_task
        self._refreshing: dict[str, asyncio.Task] = {}

    # --- caching ---------------------------------------------------------

    async def _refresh(self, key: str, ttl: float, fetch) -> None:
        try:
            await self._cache.get_or_fetch(key, ttl, fetch)
        except Exception:
            logger.warning("background refresh of %s failed; serving stale data", key,
                           exc_info=True)

    def _start_refresh(self, key: str, ttl: float, fetch) -> None:
        task = self._refreshing.get(key)
        if task is not None and not task.done():
            return
        task = self._spawn(self._refresh(key, ttl, fetch))
        self._refreshing[key] = task  # also the strong reference asyncio needs

    async def _get(self, key: str, ttl: float, fetch) -> CacheResult:
        """Stale-while-revalidate over TTLCache: an expired entry is returned
        at once (status "stale") and refreshed in the background."""
        peeked = self._cache.peek(key, ttl)
        if peeked is not None and peeked.status == "stale":
            self._start_refresh(key, ttl, fetch)
            return peeked
        return await self._cache.get_or_fetch(key, ttl, fetch)

    async def drain_refreshes(self) -> None:
        tasks = [t for t in self._refreshing.values() if not t.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def warm(self) -> None:
        """Startup prefetch of every dataset location_shops needs. Best
        effort: a failure is logged, never raised."""
        for key, ttl, fetch in (
            (_TERMINALS_KEY, _TERMINALS_TTL, self._uex.terminals),
            (_CATEGORIES_KEY, _CATEGORIES_TTL, self._uex.categories),
            (_PRICES_KEY, _PRICES_TTL, self._uex.items_prices_all),
        ):
            try:
                await self._cache.get_or_fetch(key, ttl, fetch)
            except Exception:
                logger.warning("warmup prefetch of %s failed", key, exc_info=True)

    # --- tool ------------------------------------------------------------

    async def location_shops(self, location: str, category: str | None = None,
                             exclusive_only: bool = False, limit: int = 40) -> dict:
        try:
            terms_res = await self._get(_TERMINALS_KEY, _TERMINALS_TTL, self._uex.terminals)
            prices_res = await self._get(_PRICES_KEY, _PRICES_TTL, self._uex.items_prices_all)
            cats_res = await self._get(_CATEGORIES_KEY, _CATEGORIES_TTL, self._uex.categories)
        except UpstreamError as e:
            return error("uex_unavailable", str(e))

        terminals = terms_res.value or []
        prices = prices_res.value or []
        categories = cats_res.value or []

        matched, label = resolve_location(location, terminals)
        if not matched:
            return error("not_found",
                         f"No live UEX shop terminals found at '{location}'.",
                         candidates=location_candidates(location, terminals))

        matched_ids = {t.get("id") for t in matched}
        live_ids = {t.get("id") for t in terminals if _is_live(t)}
        term_names = {t.get("id"): t.get("name") for t in terminals}
        cat_by_id = {c.get("id"): c for c in categories}
        allowed_cats, notes = resolve_categories(category, categories)

        # Every LIVE terminal with a buy price, per item -- the exclusivity basis.
        sellers: dict = {}
        for r in prices:
            if _num(r.get("price_buy")) > 0 and r.get("id_terminal") in live_ids:
                sellers.setdefault(r.get("id_item"), set()).add(r.get("id_terminal"))

        items: dict = {}
        latest = 0
        for r in prices:
            tid = r.get("id_terminal")
            if tid not in matched_ids or _num(r.get("price_buy")) <= 0:
                continue
            if allowed_cats is not None and r.get("id_category") not in allowed_cats:
                continue
            latest = max(latest, int(_num(r.get("date_modified"))))
            iid = r.get("id_item")
            item = items.get(iid)
            if item is None:
                cat = cat_by_id.get(r.get("id_category")) or {}
                item = items[iid] = {
                    "name": r.get("item_name"),
                    "section": cat.get("section"),
                    "category": cat.get("name"),
                    "terminals": [],
                    "exclusive": sellers.get(iid, set()) <= matched_ids,
                }
            item["terminals"].append({
                "terminal": term_names.get(tid) or r.get("terminal_name"),
                "price_buy": r.get("price_buy"),
                "reported_at": _iso(r.get("date_modified")),
            })

        rows = list(items.values())
        if exclusive_only:
            rows = [i for i in rows if i["exclusive"]]
        for i in rows:
            i["terminals"].sort(key=lambda t: (_num(t["price_buy"]), t["terminal"] or ""))
        rows.sort(key=lambda i: (not i["exclusive"], i["section"] or "~", i["name"] or ""))

        cap = max(1, min(int(limit or 0), _MAX_LIMIT))
        notes = [_NOTE_CROWD_SOURCED, *notes]
        if not rows:
            notes.append(f"No player-reported item sales match at {label}.")

        return {
            "source": SOURCE,
            "location": label,
            "terminals": sorted(t.get("name") or "" for t in matched),
            "total_items": len(rows),
            "exclusive_count": sum(1 for i in rows if i["exclusive"]),
            "items": rows[:cap],
            "truncated": len(rows) > cap,
            "notes": notes,
            "latest_report": _iso(latest),
            **_merge_freshness(terms_res, prices_res, cats_res),
        }
