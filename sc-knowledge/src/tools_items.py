"""find_item / compare_components over the Star Citizen Wiki API (which embeds UEX shop prices)."""
from .cache import TTLCache
from .envelope import error, freshness
from .http import UpstreamError
from .names import normalise
from .wiki import WikiClient

_TTL = 43200
SOURCE = "star-citizen.wiki (+UEX prices)"

# Dotted stat paths below were confirmed against live samples captured via
# scripts/capture_fixtures.py (vehicle-items?filter[type]=<T>&limit=3, saved as
# tests/fixtures/wiki_vehicle_items_<type>_sample.json), never guessed. Findings:
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
#     damage type (physical/energy/...). The DPS-like number players actually
#     compare is ["vehicle_weapon"]["damage"]["burst"] (rate-of-fire x
#     damage-per-shot, i.e. un-throttled DPS before overheat) -- confirmed equal
#     to damage.dps.physical for the sampled ballistic cannons -- used as default
#     rank. ["damage"]["sustained_60s"] (DPS averaged over 60s incl. overheat) is
#     kept as a secondary stat since it is the more "real world" sustained number.
#   - missile: there is no "damage.health" path; the real scalar is the top-level
#     "damage_total" (warhead damage), used as default rank.
COMPONENT_TYPES: dict[str, dict] = {
    "shield": {"wiki_type": "Shield", "stat_key": "shield",
               "stats": {"max_health": "max_health", "regen_rate": "regen_rate",
                         "regen_delay_damage_s": "regen_delay.damage"},
               "default_rank": "max_health", "tiebreak": "regen_rate"},
    "power_plant": {"wiki_type": "PowerPlant", "stat_key": "power_plant",
                     "stats": {"power_segment_generation": "power_segment_generation"},
                     "default_rank": "power_segment_generation"},
    "cooler": {"wiki_type": "Cooler", "stat_key": "cooler",
               "stats": {"coolant_segment_generation": "coolant_segment_generation"},
               "default_rank": "coolant_segment_generation"},
    "quantum_drive": {"wiki_type": "QuantumDrive", "stat_key": "quantum_drive",
                       "stats": {"speed": "standard_jump.drive_speed", "fuel_rate": "fuel_rate"},
                       "default_rank": "speed"},
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
