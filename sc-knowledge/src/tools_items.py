"""find_item / compare_components over the Star Citizen Wiki API (which embeds UEX shop prices)."""
from datetime import datetime, timezone

from .cache import TTLCache
from .envelope import error, freshness
from .http import UpstreamError
from .names import Entry, NameIndex, normalise, vehicle_entries
from .uex import UexClient
from .wiki import WikiClient

_TTL = 43200
SOURCE = "star-citizen.wiki (+UEX prices)"
_VEHICLE_SOURCE = "uexcorp.space (crowd-sourced)"
_VEHICLE_INDEX_TTL = 21600
_VEHICLE_PRICES_TTL = 7200

# Dotted stat paths below were confirmed against live samples captured via
# scripts/capture_fixtures.py (vehicle-items?filter[type]=<T>&filter[size]=<one
# real size>&limit=200, single real page -- see the fix-round-1 comment on
# CAPTURES in capture_fixtures.py for why a single page is mandatory -- saved
# as tests/fixtures/wiki_vehicle_items_<type>_sample.json), never guessed. Findings:
#   - power_plant: the payload's own "power_output" field is null on every sampled
#     unit; the only populated, comparable figure is "power_segment_generation"
#     (an integer "power segments generated" rating), so that is both the stat key
#     and the default rank.
#   - cooler: same story as power_plant -- "cooling_rate" is null on every sample;
#     "coolant_segment_generation" is the populated comparable figure.
#   - quantum_drive: there is no top-level "speed"; travel speed lives at
#     ["quantum_drive"]["standard_jump"]["drive_speed"] (m/s, the number players
#     compare between drives). Top-level "fuel_rate" is real and kept as a
#     secondary stat (lower is better, not used as default rank).
#   - radar: "detection_lifetime" is null on every sampled radar (including
#     V801-12 in wiki_item_v801_12.json), and "sensitivity.db" is a constant 0
#     across every sample so it can't discriminate anything. The field that
#     actually varies with radar quality is
#     ["radar"]["aim_assist"]["distance_max_assignment"] (max target-assignment
#     range in meters) -- used as default rank in place of detection_lifetime.
#   - weapon: the wiki's actual block key for WeaponGun items is "vehicle_weapon",
#     NOT "weapon" -- item.get("weapon") is always None. There is no scalar "dps"
#     field either; ["vehicle_weapon"]["damage"]["dps"] is itself a dict keyed by
#     damage type (physical/energy/distortion/thermal/biochemical/stun). The
#     DPS-like number players actually compare is
#     ["vehicle_weapon"]["damage"]["burst"] (rate-of-fire x damage-per-shot, i.e.
#     un-throttled DPS before overheat) -- used as default rank. Verified against
#     3 damage families in the live size-2 WeaponGun sample
#     (wiki_vehicle_items_weapon_sample.json, 42 items, a mix of ballistic/laser/
#     distortion/neutron/tachyon/mass-driver weapons): "10-Series Greatsword
#     Cannon" (Ballistic Cannon, physical) burst=304.1 == dps.physical=304.1;
#     "FL-22 Cannon" (Laser Cannon, energy) burst=308.5 == dps.energy=308.5;
#     "EVSD Cannon" (Distortion Cannon) burst=202.5 == dps.distortion=202.5. In
#     every case exactly one dps.<type> entry is non-zero and burst equals it
#     (i.e. burst == sum(dps.values())), so "damage.burst" is a valid
#     damage-type-agnostic DPS figure and no fallback to summing dps.* was
#     needed. ["damage"]["sustained_60s"] (DPS averaged over 60s incl. overheat)
#     is kept as a secondary stat since it is the more "real world" sustained
#     number.
#   - missile: there is no "damage.health" path; the real scalar is the top-level
#     "damage_total" (warhead damage), used as default rank.
#
# `lower_is_better`: stat keys (within a type's `stats`) where a SMALLER value
# ranks first (regen delay, fuel burn, cooldowns/spool times, etc.). Absent from
# a type's dict, or a key not listed, defaults to higher-is-better. Also sets
# the "order" field ("asc"/"desc") on the compare_components result.
COMPONENT_TYPES: dict[str, dict] = {
    "shield": {"wiki_type": "Shield", "stat_key": "shield",
               "stats": {"max_health": "max_health", "regen_rate": "regen_rate",
                         "regen_delay_damage_s": "regen_delay.damage"},
               "default_rank": "max_health", "tiebreak": "regen_rate",
               "lower_is_better": {"regen_delay_damage_s"}},
    "power_plant": {"wiki_type": "PowerPlant", "stat_key": "power_plant",
                     "stats": {"power_segment_generation": "power_segment_generation"},
                     "default_rank": "power_segment_generation"},
    "cooler": {"wiki_type": "Cooler", "stat_key": "cooler",
               "stats": {"coolant_segment_generation": "coolant_segment_generation"},
               "default_rank": "coolant_segment_generation"},
    "quantum_drive": {"wiki_type": "QuantumDrive", "stat_key": "quantum_drive",
                       "stats": {"speed": "standard_jump.drive_speed", "fuel_rate": "fuel_rate"},
                       "default_rank": "speed", "lower_is_better": {"fuel_rate"}},
    "radar": {"wiki_type": "Radar", "stat_key": "radar",
              "stats": {"assignment_range_max": "aim_assist.distance_max_assignment",
                        "detection_lifetime": "detection_lifetime"},
              "default_rank": "assignment_range_max"},
    "weapon": {"wiki_type": "WeaponGun", "stat_key": "vehicle_weapon",
               "stats": {"dps": "damage.burst", "sustained_dps_60s": "damage.sustained_60s",
                         "range": "range"},
               "default_rank": "dps"},
    "missile": {"wiki_type": "Missile", "stat_key": "missile",
                "stats": {"damage": "damage_total", "speed": "speed"},
                "default_rank": "damage"},
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
        price = p.get("price_buy")
        if not price:
            continue
        try:
            # Tools must never raise across the MCP boundary: a malformed/non-numeric
            # upstream price_buy (e.g. a string that isn't a number) is skipped rather
            # than blowing up the whole find_item/compare_components call.
            price_auec = int(price)
        except (TypeError, ValueError):
            continue
        loc = p.get("starmap_location") or {}
        location = ", ".join(x for x in (loc.get("name"), loc.get("parent_name")) if x)
        out.append({"shop": p.get("terminal_name"), "location": location,
                    "system": loc.get("star_system_name"), "price_auec": price_auec,
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


def _iso(epoch) -> str | None:
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _vehicle_summary(v: dict) -> dict:
    return {"name": v.get("name_full") or v.get("name"), "type": "Vehicle",
            "manufacturer": v.get("company_name"), "scu": v.get("scu"),
            "crew": v.get("crew"), "pad_type": v.get("pad_type")}


def _vehicle_shops(prices: list[dict]) -> list[dict]:
    out = []
    for p in prices:
        price = p.get("price_buy")
        if not price:
            continue
        try:
            # Same defensive skip as _shops(): never let a malformed upstream
            # price_buy raise across the MCP boundary.
            price_auec = int(price)
        except (TypeError, ValueError):
            continue
        specific = p.get("city_name") or p.get("space_station_name") or p.get("outpost_name")
        location = ", ".join(x for x in (specific, p.get("planet_name")) if x)
        out.append({"shop": p.get("terminal_name"), "location": location,
                    "system": p.get("star_system_name"), "price_auec": price_auec,
                    "reported_at": _iso(p.get("date_modified"))})
    return sorted(out, key=lambda s: s["price_auec"])


def _vehicle_alternatives(vehicles: list[dict], resolved: dict, limit: int = 3) -> list[str]:
    """Other vehicle names sharing the resolved vehicle's family (grouped by
    id_parent -- a variant's own id_parent points at its base ship, and the
    base ship's id_parent points at itself)."""
    base_id = resolved.get("id_parent") or resolved.get("id")
    out = []
    for v in vehicles:
        if v.get("id") == resolved.get("id"):
            continue
        if (v.get("id_parent") or v.get("id")) == base_id:
            out.append(v.get("name"))
            if len(out) >= limit:
                break
    return out


class ItemTools:
    def __init__(self, wiki: WikiClient, cache: TTLCache, uex: UexClient | None = None) -> None:
        self._wiki = wiki
        self._cache = cache
        self._uex = uex

    async def _vehicle_index(self) -> tuple[NameIndex, list[dict]]:
        res = await self._cache.get_or_fetch("uex:vehicles", _VEHICLE_INDEX_TTL, self._uex.vehicles)
        index = NameIndex()
        for e in vehicle_entries(res.value):
            index.add(e)
        return index, res.value

    async def _vehicle_result(self, entry: Entry, vehicles: list[dict]) -> dict:
        v = entry.data
        pres = await self._cache.get_or_fetch(
            f"uex:vprices:{v['id']}", _VEHICLE_PRICES_TTL,
            lambda: self._uex.vehicles_purchases_prices(v["id"]))
        shops = _vehicle_shops(pres.value)
        out = {"source": _VEHICLE_SOURCE, "game_version": v.get("game_version"),
               "item": _vehicle_summary(v), "where_to_buy": shops,
               "alternatives": _vehicle_alternatives(vehicles, v), **freshness(pres)}
        if not shops:
            out["note"] = ("No player-reported dealer listings on UEX (may be "
                           "pledge-store only or not sold in game).")
        return out

    async def _resolve_vehicle(self, name: str):
        """Returns (resolution, vehicles) on success, or None if the vehicle
        index itself couldn't be fetched (UpstreamError) -- callers treat
        None exactly like "no vehicle path available" and fall through to
        Wiki, per task-14 brief: any vehicle-path UpstreamError falls through,
        never raises."""
        if self._uex is None:
            return None
        try:
            index, vehicles = await self._vehicle_index()
        except UpstreamError:
            return None
        return index.resolve(name, kind="vehicle"), vehicles

    async def find_item(self, name: str) -> dict:
        vehicle_ambiguous: list[str] | None = None
        if self._uex is not None:
            resolved = await self._resolve_vehicle(name)
            if resolved is not None:
                resolution, vehicles = resolved
                if resolution.status in ("exact", "fuzzy"):
                    try:
                        return await self._vehicle_result(resolution.match, vehicles)
                    except UpstreamError:
                        pass  # fall through to the Wiki item path
                elif resolution.status == "ambiguous":
                    vehicle_ambiguous = [c.name for c in resolution.candidates[:5]]

        wiki_result = await self._find_wiki_item(name)
        if vehicle_ambiguous is not None and wiki_result.get("error") == "not_found":
            return error("ambiguous", f"'{name}' matches several vehicles",
                         candidates=vehicle_ambiguous)
        return wiki_result

    async def _find_wiki_item(self, name: str) -> dict:
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
        lower_is_better = rank in ct.get("lower_is_better", ())
        rows = []
        excluded_missing_stat = 0
        seen: set = set()
        for it in res.value:
            if grade and (it.get("grade") or "").upper() != grade.upper():
                continue
            if class_ and (it.get("class") or "").lower() != class_.lower():
                continue
            # Defensive de-dup against genuine upstream duplicates (e.g. a paginated
            # response repeating a row): key by uuid, falling back to name when a row
            # has no uuid. This must NOT collapse distinct items that legitimately
            # share a display name (real data has this -- e.g. two different
            # "CF-227 Badger Repeater" weapon variants with different uuids -- those
            # keep separate rows since their uuids differ).
            key = it.get("uuid") or it.get("name")
            if key is not None:
                if key in seen:
                    continue
                seen.add(key)
            block = it.get(ct["stat_key"]) or {}
            stats = {k: _get(block, p) for k, p in ct["stats"].items()}
            if stats.get(rank) is None:
                excluded_missing_stat += 1
                continue
            shops = _shops(it)
            rows.append({"name": it.get("name"), "manufacturer": (it.get("manufacturer") or {}).get("name"),
                         "grade": it.get("grade"), "class": it.get("class"), "stats": stats,
                         "cheapest": ({k: shops[0][k] for k in ("shop", "location", "price_auec")} if shops else None)})
        # The tiebreak field is only meaningful when ranking by the type's own
        # default_rank (e.g. shield's "break ties in max_health by regen_rate") --
        # it is not applied to an arbitrary caller-chosen rank_by.
        tie = ct.get("tiebreak") if rank == ct.get("default_rank") else None
        rows.sort(key=lambda r: (r["stats"][rank], (r["stats"].get(tie) or 0) if tie else 0),
                  reverse=not lower_is_better)
        gv = next((it.get("version") for it in res.value if it.get("version")), None)
        out = {"source": SOURCE, "game_version": gv, "type": type, "size": size, "ranked_by": rank,
               "order": "asc" if lower_is_better else "desc",
               "results": rows[:max(1, min(limit, 20))], **freshness(res)}
        if excluded_missing_stat:
            out["excluded_missing_stat"] = excluded_missing_stat
        return out
