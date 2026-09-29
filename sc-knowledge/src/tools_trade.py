"""trade_routes / commodity_prices: player-reported UEX trade route finder and
per-commodity price board.

Controller ruling R2 (binding): resolve origin/destination FIRST against an
index built only from terminals with type == "commodity" (the admin/commodity
shop terminal, not every shop at the station). A unique exact/fuzzy match wins.
If not unique, fall back to a normalised TOKEN-BOUNDARY match against the
terminal's location fields (space_station_name, city_name, outpost_name,
planet_name, orbit_name, star_system_name) or its name/nickname, taking ALL
matching commodity terminals. If still nothing, error out with candidates.

Fix-round-1 (binding): the fallback (and the commodity_prices location filter)
must NOT use raw substring matching -- "l1" is a raw substring of "l19" (from
"Admin - L19 Residences - Metro Center - Lorville"), which would silently
merge an unrelated station into an "L1" query. See _token_match().

Fix-round-2 (binding): a broad origin (e.g. "Stanton" -> 121 commodity
terminals) used to fan out to one commodities_routes call per terminal --
~60s against the 120/min UEX rate limiter, which blows past both the voice
path's 6s tool-call bound and would hang text chat too. If origin resolution
yields more than MAX_ORIGIN_TERMINALS terminals, trade_routes now makes ZERO
route calls and returns error("too_broad", ...) instead. At or under that
cap, the per-terminal fetches run concurrently (asyncio.gather) rather than
sequentially, and a partial failure (some origin terminals error, others
succeed) still returns the successful routes with a notes line, only
failing outright when EVERY origin terminal's fetch fails.
"""
import asyncio
from datetime import datetime, timezone

from .cache import TTLCache
from .envelope import error, freshness
from .http import UpstreamError
from .names import NameIndex, commodity_entries, normalise, terminal_entries, token_match
from .uex import UexClient

_INDEX_TTL = 21600
_ROUTES_TTL = 1800
SOURCE = "uexcorp.space (crowd-sourced)"

# Fix-round-2: above this many resolved origin terminals, trade_routes refuses
# to fan out one commodities_routes call per terminal (that's how "Stanton"
# turned into a ~60s stall against the 120/min UEX rate limiter, well past the
# voice path's 6s tool-call bound) and instead errors "too_broad" up front.
MAX_ORIGIN_TERMINALS = 8

# Fields checked for both the R2 location token-match fallback (terminal dicts:
# name/nickname + location fields) and the commodity_prices location filter
# (price rows: terminal_name + the same location fields). A dict missing a key
# just yields None and is skipped, so one field tuple safely covers both shapes.
_LOCATION_FIELDS = ("space_station_name", "city_name", "outpost_name", "planet_name",
                    "orbit_name", "star_system_name", "name", "nickname", "terminal_name")


def _row(route: dict, cargo_scu: int | None, budget_auec: int | None) -> dict | None:
    """Pure profit math for one UEX commodities_routes row (unit-testable in
    isolation). Returns None when the route isn't profitable or there's no
    tradeable scu at all.

    When the caller gives no cargo_scu and no budget_auec, scu = the route's own
    scu_reachable (falling back to scu_origin if that's unset) -- UEX's own
    precomputed reachable amount, which already factors in origin supply vs.
    destination demand. When either cap IS given, scu = min() over whichever of
    (cargo_scu, budget_auec // price_origin, scu_origin, scu_destination) are
    truthy, falling back to scu_reachable/scu_origin if none of those apply.
    """
    price_origin = route.get("price_origin")
    price_destination = route.get("price_destination")
    if not price_origin or price_destination is None:
        return None
    profit_per_scu = price_destination - price_origin
    if profit_per_scu <= 0:
        return None
    if cargo_scu is None and budget_auec is None:
        # No caller-supplied caps: trust UEX's own precomputed reachable amount
        # (which already accounts for origin supply vs. destination demand)
        # rather than re-deriving it from scu_origin/scu_destination ourselves.
        scu = route.get("scu_reachable") or route.get("scu_origin")
    else:
        candidates = [x for x in (
            cargo_scu,
            (budget_auec // price_origin) if (budget_auec and price_origin) else None,
            route.get("scu_origin"),
            route.get("scu_destination"),
        ) if x]
        scu = min(candidates) if candidates else (route.get("scu_reachable") or route.get("scu_origin"))
    if not scu:
        return None
    total_profit = profit_per_scu * scu
    investment = price_origin * scu
    roi_pct = round(100 * profit_per_scu / price_origin, 1)
    origin_sys = route.get("origin_star_system_name") or ""
    dest_sys = route.get("destination_star_system_name") or ""
    lawless = "pyro" in (origin_sys + dest_sys).lower()
    date_added = route.get("date_added")
    reported_at = (datetime.fromtimestamp(date_added, tz=timezone.utc).isoformat()
                   if date_added else None)
    return {
        "commodity": route.get("commodity_name"),
        "buy_at": route.get("origin_terminal_name"),
        "buy_location": _side_location(route, "origin"),
        "sell_at": route.get("destination_terminal_name"),
        "sell_location": _side_location(route, "destination"),
        "buy_price": price_origin,
        "sell_price": price_destination,
        "profit_per_scu": profit_per_scu,
        "roi_pct": roi_pct,
        "scu_traded": scu,
        "total_profit": total_profit,
        "investment": investment,
        "distance": route.get("distance"),
        "lawless": lawless,
        "reported_at": reported_at,
    }


def _side_location(route: dict, side: str) -> str:
    # Deliberately planet_name + star_system_name ONLY, never orbit_name or
    # terminal_name: real UEX data has jump-point terminals/orbits named after
    # the *other* system they connect to (e.g. "Admin - Pyro Gateway (Nyx)" /
    # orbit "Pyro Gateway (Nyx system)" for a terminal physically in Nyx), so
    # including those would leak the string "Pyro" into a route that is not
    # actually lawless -- the exact false positive lawless() must avoid.
    place = route.get(f"{side}_planet_name") or ""
    system = route.get(f"{side}_star_system_name") or ""
    return ", ".join(p for p in (place, system) if p)


def _place(row: dict) -> str:
    specific = row.get("space_station_name") or row.get("outpost_name") or row.get("city_name")
    parts = [p for p in (specific, row.get("planet_name")) if p]
    out: list[str] = []
    for p in parts:
        if p not in out:
            out.append(p)
    return ", ".join(out)


# Token-boundary matching lives in names.py (shared with tools_shops); the
# "l1" vs "l19" rationale is documented on names.token_match.
_token_match = token_match


def _field_matches(fields: dict, query_norm: str) -> bool:
    for f in _LOCATION_FIELDS:
        v = fields.get(f)
        if v and _token_match(v, query_norm):
            return True
    return False


def _shared_label(terminals: list[dict], fallback: str) -> str:
    for field in _LOCATION_FIELDS[:6]:  # location fields only, not name/nickname/terminal_name
        vals = {t.get(field) for t in terminals if t.get(field)}
        if len(vals) == 1:
            return next(iter(vals))
    return fallback


def _location_names(terminals: list[dict], limit: int = 10) -> list[str]:
    """Up to `limit` distinct, sorted location names for a too_broad error's
    candidates: space_station_name / city_name / outpost_name, falling back to
    the terminal's own name when none of those are set."""
    seen: set = set()
    for t in terminals:
        label = t.get("space_station_name") or t.get("city_name") or t.get("outpost_name") or t.get("name")
        if label:
            seen.add(label)
    return sorted(seen)[:limit]


class TradeTools:
    def __init__(self, uex: UexClient, cache: TTLCache) -> None:
        self._uex = uex
        self._cache = cache

    async def _terminals(self) -> list[dict]:
        res = await self._cache.get_or_fetch("uex:terminals", _INDEX_TTL, self._uex.terminals)
        return res.value

    async def _commodities(self) -> list[dict]:
        res = await self._cache.get_or_fetch("uex:commodities", _INDEX_TTL, self._uex.commodities)
        return res.value

    async def _index(self) -> NameIndex:
        terminals = await self._terminals()
        commodities = await self._commodities()
        idx = NameIndex()
        for e in terminal_entries([t for t in terminals if t.get("type") == "commodity"]):
            idx.add(e)
        for e in commodity_entries(commodities):
            idx.add(e)
        return idx

    def _resolve_terminal(self, query: str, idx: NameIndex, commodity_terminals: list[dict]):
        """Returns (terminals, label, error_code, candidate_names). `terminals`
        is None on failure, in which case error_code is 'not_found'/'ambiguous'."""
        r = idx.resolve(query, kind="terminal")
        if r.match is not None:
            label = r.match.data.get("nickname") or r.match.name
            return [r.match.data], label, None, []
        q = normalise(query)
        if len(q) >= 2:
            matches = [t for t in commodity_terminals if _field_matches(t, q)]
            if matches:
                return matches, _shared_label(matches, query), None, []
        return None, None, r.status, [c.name for c in r.candidates]

    async def trade_routes(self, origin: str, destination: str | None = None,
                           commodity: str | None = None, cargo_scu: int | None = None,
                           budget_auec: int | None = None, limit: int = 5) -> dict:
        try:
            idx = await self._index()
            commodity_terminals = [t for t in await self._terminals() if t.get("type") == "commodity"]
        except UpstreamError as e:
            return error("uex_unavailable", str(e))

        origin_terminals, origin_label, origin_err, origin_cands = self._resolve_terminal(
            origin, idx, commodity_terminals)
        if origin_terminals is None:
            return error(origin_err, f"origin '{origin}' not resolved", candidates=origin_cands)

        if len(origin_terminals) > MAX_ORIGIN_TERMINALS:
            return error(
                "too_broad",
                f"Origin '{origin}' matches {len(origin_terminals)} trade terminals; "
                "name a specific station, city, outpost or planet.",
                candidates=_location_names(origin_terminals))

        dest_ids = None
        if destination:
            dest_terminals, _dest_label, dest_err, dest_cands = self._resolve_terminal(
                destination, idx, commodity_terminals)
            if dest_terminals is None:
                return error(dest_err, f"destination '{destination}' not resolved", candidates=dest_cands)
            dest_ids = {t["id"] for t in dest_terminals}

        commodity_id = None
        if commodity:
            cr = idx.resolve(commodity, kind="commodity")
            if cr.match is None:
                return error(cr.status, f"commodity '{commodity}' not resolved",
                             candidates=[c.name for c in cr.candidates])
            commodity_id = cr.match.id

        async def _fetch_one(tid: int):
            try:
                res = await self._cache.get_or_fetch(
                    f"uex:routes:{tid}", _ROUTES_TTL,
                    lambda tid=tid: self._uex.commodities_routes(id_terminal_origin=tid))
                return res.value, None
            except UpstreamError as e:
                return None, e

        # At most MAX_ORIGIN_TERMINALS fetches, run concurrently: sequential
        # awaits here is exactly what turned a several-terminal origin into a
        # multi-second (or, pre-cap, multi-minute) stall against the voice
        # path's 6s tool-call bound.
        fetch_results = await asyncio.gather(*(_fetch_one(t["id"]) for t in origin_terminals))

        all_routes: list[dict] = []
        seen_ids: set = set()
        failed = 0
        last_error: UpstreamError | None = None
        for value, err in fetch_results:
            if err is not None:
                failed += 1
                last_error = err
                continue
            for rt in value:
                rid = rt.get("id", rt.get("code"))
                if rid in seen_ids:
                    continue
                seen_ids.add(rid)
                all_routes.append(rt)

        if failed == len(origin_terminals):
            return error("uex_unavailable", str(last_error))

        try:
            if all_routes:
                game_version = all_routes[0].get("game_version_origin")
            else:
                gv = await self._uex.game_versions()
                game_version = (gv or {}).get("live")
        except UpstreamError as e:
            return error("uex_unavailable", str(e))

        filtered = all_routes
        if dest_ids is not None:
            filtered = [rt for rt in filtered if rt.get("id_terminal_destination") in dest_ids]
        if commodity_id is not None:
            filtered = [rt for rt in filtered if rt.get("id_commodity") == commodity_id]

        rows = [x for x in (_row(rt, cargo_scu, budget_auec) for rt in filtered) if x is not None]
        rows.sort(key=lambda x: x["total_profit"], reverse=True)
        rows = rows[:max(1, limit)]

        notes = ["Prices are player-reported to UEX; verify in game."]
        if failed:
            notes.append(f"{failed} of {len(origin_terminals)} origin terminal(s) failed to fetch "
                         "routes (uex_unavailable); results may be incomplete.")
        origin_commodities = sorted({rt.get("commodity_name") for rt in all_routes if rt.get("commodity_name")})
        if 0 < len(origin_commodities) <= 3:
            notes.append(f"Only {', '.join(origin_commodities)} sold at {origin_label}")

        return {"source": SOURCE, "game_version": game_version, "origin": origin_label,
                "origin_terminal_count": len(origin_terminals), "routes": rows, "notes": notes}

    async def commodity_prices(self, commodity: str, location: str | None = None,
                               side: str = "sell", limit: int = 5) -> dict:
        try:
            idx = await self._index()
        except UpstreamError as e:
            return error("uex_unavailable", str(e))

        cr = idx.resolve(commodity, kind="commodity")
        if cr.match is None:
            return error(cr.status, f"commodity '{commodity}' not resolved",
                         candidates=[c.name for c in cr.candidates])
        commodity_id = cr.match.id

        try:
            res = await self._cache.get_or_fetch(
                f"uex:cprices:{commodity_id}", _ROUTES_TTL,
                lambda: self._uex.commodities_prices(commodity_id))
        except UpstreamError as e:
            return error("uex_unavailable", str(e))

        rows = res.value
        if location:
            q = normalise(location)
            rows = [r for r in rows if _field_matches(r, q)]

        buy_side = side == "buy"
        price_key = "price_buy" if buy_side else "price_sell"
        stock_key = "scu_sell_stock" if buy_side else "scu_buy"
        out_key = "scu_stock" if buy_side else "scu_demand"
        rows = [r for r in rows if (r.get(price_key) or 0) > 0]
        rows.sort(key=lambda r: r[price_key], reverse=not buy_side)
        rows = rows[:max(1, limit)]

        # Fix-round-1 #3: fall back to game_versions()["live"] whenever
        # game_version is still None -- not just when the pre-filter result was
        # empty. A location filter that empties an otherwise non-empty result
        # (or a commodity's rows that all lack "game_version") must not surface
        # game_version: None when the live version is discoverable another way.
        game_version = rows[0].get("game_version") if rows else None
        if game_version is None:
            try:
                gv = await self._uex.game_versions()
                game_version = (gv or {}).get("live")
            except UpstreamError:
                pass  # best-effort fallback; don't fail an otherwise-good result over it

        terminals = []
        for r in rows:
            ts = r.get("date_modified") or r.get("date_added")
            terminals.append({
                "terminal": r.get("terminal_name"),
                "location": _place(r),
                "system": r.get("star_system_name"),
                "price": r.get(price_key),
                out_key: r.get(stock_key),
                "reported_at": (datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else None),
            })

        return {"source": SOURCE, "game_version": game_version, "commodity": cr.match.name,
                "side": side, "terminals": terminals, **freshness(res)}
