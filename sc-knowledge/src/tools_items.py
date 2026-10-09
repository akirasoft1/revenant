"""find_item / compare_components over the Star Citizen Wiki API (which embeds UEX shop prices)."""
import logging
import re
from datetime import datetime, timezone

from .cache import CacheResult, TTLCache
from .envelope import error, freshness
from .http import UpstreamError
from .names import Entry, NameIndex, normalise, vehicle_entries
from .uex import UexClient
from .wiki import WikiClient

logger = logging.getLogger("sc_knowledge.tools_items")

_TTL = 43200
SOURCE = "star-citizen.wiki (+UEX prices)"
_VEHICLE_SOURCE = "uexcorp.space (crowd-sourced)"
_VEHICLE_INDEX_TTL = 21600
_VEHICLE_PRICES_TTL = 7200
_TOKEN_RE = re.compile(r"[a-z0-9]+")

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
               "lower_is_better": {"regen_delay_damage_s"},
               "rank_synonyms": {
                   "hp": "max_health", "health": "max_health", "shield_hp": "max_health",
                   "strength": "max_health", "capacity": "max_health", "max_hp": "max_health",
                   "pool": "max_health", "most_powerful": "max_health", "power": "max_health",
                   "regen": "regen_rate", "regeneration": "regen_rate", "recharge": "regen_rate",
                   "delay": "regen_delay_damage_s"}},
    "power_plant": {"wiki_type": "PowerPlant", "stat_key": "power_plant",
                     "stats": {"power_segment_generation": "power_segment_generation"},
                     "default_rank": "power_segment_generation",
                     "rank_synonyms": {
                         "power": "power_segment_generation", "output": "power_segment_generation",
                         "generation": "power_segment_generation", "segments": "power_segment_generation",
                         "most_powerful": "power_segment_generation"}},
    "cooler": {"wiki_type": "Cooler", "stat_key": "cooler",
               "stats": {"coolant_segment_generation": "coolant_segment_generation"},
               "default_rank": "coolant_segment_generation",
               "rank_synonyms": {
                   "cooling": "coolant_segment_generation", "coolant": "coolant_segment_generation",
                   "segments": "coolant_segment_generation", "most_powerful": "coolant_segment_generation"}},
    "quantum_drive": {"wiki_type": "QuantumDrive", "stat_key": "quantum_drive",
                       "stats": {"speed": "standard_jump.drive_speed", "fuel_rate": "fuel_rate"},
                       "default_rank": "speed", "lower_is_better": {"fuel_rate"},
                       "rank_synonyms": {
                           "fastest": "speed", "quickest": "speed", "jump_speed": "speed",
                           "drive_speed": "speed", "most_powerful": "speed",
                           "fuel": "fuel_rate", "efficiency": "fuel_rate", "fuel_efficiency": "fuel_rate",
                           "fuel_burn": "fuel_rate"}},
    "radar": {"wiki_type": "Radar", "stat_key": "radar",
              "stats": {"assignment_range_max": "aim_assist.distance_max_assignment",
                        "detection_lifetime": "detection_lifetime"},
              "default_rank": "assignment_range_max",
              "rank_synonyms": {
                  "range": "assignment_range_max", "distance": "assignment_range_max",
                  "max_range": "assignment_range_max", "most_powerful": "assignment_range_max",
                  "lifetime": "detection_lifetime", "detection": "detection_lifetime"}},
    "weapon": {"wiki_type": "WeaponGun", "stat_key": "vehicle_weapon",
               "stats": {"dps": "damage.burst", "sustained_dps_60s": "damage.sustained_60s",
                         "range": "range"},
               "default_rank": "dps",
               "rank_synonyms": {
                   "damage": "dps", "power": "dps", "most_powerful": "dps",
                   "sustained": "sustained_dps_60s", "sustained_dps": "sustained_dps_60s",
                   "dps_60s": "sustained_dps_60s", "distance": "range"}},
    "missile": {"wiki_type": "Missile", "stat_key": "missile",
                "stats": {"damage": "damage_total", "speed": "speed"},
                "default_rank": "damage",
                "rank_synonyms": {
                    "power": "damage", "most_powerful": "damage", "damage_total": "damage",
                    "fastest": "speed"}},
}

# compare_components' `type` param accepts these spoken/typed synonyms
# (case/space/hyphen-insensitive, see _normalise_token) in place of a
# COMPONENT_TYPES key -- task-15: Gemini Live's voice path hears phrases like
# "shield generator" or "power" rather than the canonical "shield"/
# "power_plant" keys. Entries that already normalise to a literal
# COMPONENT_TYPES key (e.g. "shields" -> not needed, "power plant" ->
# "power_plant" already matches) are omitted; only genuinely different
# spellings need a mapping.
_TYPE_SYNONYMS: dict[str, str] = {
    "shields": "shield", "shield_generator": "shield", "shield_generators": "shield",
    "powerplant": "power_plant", "power": "power_plant",
    "coolers": "cooler", "cooling": "cooler",
    "quantum": "quantum_drive", "qd": "quantum_drive", "qt_drive": "quantum_drive",
    "radars": "radar", "scanner": "radar",
    "weapons": "weapon", "gun": "weapon", "guns": "weapon", "cannon": "weapon", "repeater": "weapon",
    "missiles": "missile",
}

_ASR_CATEGORY_WORDS = ("shield generator", "power plant", "quantum drive", "radar", "shield",
                       "cooler", "drive", "gun", "cannon", "missile", "ship")
_O_DIGIT_RE = re.compile(r"(?<=\d)[oO]|[oO](?=\d)")


def _normalise_token(s: str) -> str:
    """Lowercase and collapse spaces/hyphens to underscores, for matching
    against COMPONENT_TYPES keys, _TYPE_SYNONYMS and each type's
    rank_synonyms -- voice/ASR input arrives as phrases ("shield generator",
    "most powerful") rather than the canonical snake_case keys."""
    return re.sub(r"[\s-]+", "_", (s or "").strip().lower())


def _strip_category_word(name: str) -> str:
    """Strip one trailing generic category word/phrase (task-15 variant 2):
    a model transcribing a spoken item lookup sometimes tacks on a category
    word that isn't part of the item's real name (e.g. "V801-12 radar").
    Checked longest-phrase-first so "quantum drive" strips as a whole phrase
    rather than leaving "quantum" behind via the standalone "drive" entry.
    Only strips on a real word boundary (a preceding space) -- never returns
    an empty/no-op result silently."""
    stripped = name.rstrip()
    lower = stripped.lower()
    for word in _ASR_CATEGORY_WORDS:
        suffix = " " + word
        if lower.endswith(suffix):
            return stripped[: -len(suffix)].rstrip()
    return name


def _asr_variants(name: str) -> list[str]:
    """ASR-tolerant retry variants for a Wiki item name that failed to
    resolve (task-15), tried in order until one resolves: (1) a stray letter
    o/O sitting next to a digit, almost always a misheard '0' (e.g.
    "v8o1-12"); (2) a trailing generic category word the model added that
    isn't part of the real item name ("V801-12 radar"); (3) both together.
    No-op transforms (and duplicate variants) are skipped."""
    letter_fixed = _O_DIGIT_RE.sub("0", name)
    stripped = _strip_category_word(name)
    both = _O_DIGIT_RE.sub("0", stripped)
    variants: list[str] = []
    for v in (letter_fixed, stripped, both):
        if v != name and v not in variants:
            variants.append(v)
    return variants


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


def _tokens(s: str) -> set[str]:
    """Whole lowercased alphanumeric tokens of length >= 3. Used to reject
    NameIndex's generic WRatio fuzzy-ambiguous vehicle candidates that share
    no real word with the query (fix round 1: "asdf" was matching
    ['Hammerhead', 'HoverQuad', ...] on pure string-similarity noise -- a
    plainly unrelated set of ships for an unrecognised name, which is the
    opposite of this task's anti-hallucination goal)."""
    return {t for t in _TOKEN_RE.findall((s or "").lower()) if len(t) >= 3}


def _vehicle_match_accepted(status: str, query: str, entry: Entry) -> bool:
    """Fix round 2: NameIndex's "fuzzy" status covers both its substring
    branch and its WRatio scoring branch, neither of which requires the query
    to share a whole WORD with the match -- against the real fixture,
    find_item("the") fuzzy-matched "Vanduul Scythe" (an entry whose name is
    literally "Scythe") purely because "the" is a contiguous substring of
    "scythe", and find_item("sair") fuzzy-matched "Corsair" the same way.
    Because vehicles are resolved FIRST, that would hijack an ordinary
    item/component query into a fabricated ship answer. `exact` is always
    trusted (already a full alias-normalised equality, not a substring test).
    A `fuzzy` match is only trusted when EVERY query token (len >= 3) is a
    WHOLE token of one of the matched vehicle's aliases -- not merely
    contained within one. Anything else is treated as no match at all (not
    even surfaced as an ambiguous candidate) and falls through to Wiki."""
    if status == "exact":
        return True
    if status != "fuzzy":
        return False
    query_tokens = _tokens(query)
    if not query_tokens:
        return False
    alias_tokens: set[str] = set()
    for a in entry.aliases:
        alias_tokens |= _tokens(a)
    return query_tokens <= alias_tokens


def _merge_freshness(*results: CacheResult) -> dict:
    """Like freshness(), but across several CacheResults feeding one output
    (the vehicle index fetch and the per-vehicle price fetch) -- stale if
    EITHER was stale, reporting the older age."""
    stale = [r for r in results if r.status == "stale"]
    if not stale:
        return {}
    worst = max(stale, key=lambda r: r.age_s)
    return {"stale": True, "age_minutes": round(worst.age_s / 60)}


class ItemTools:
    def __init__(self, wiki: WikiClient, cache: TTLCache, uex: UexClient | None = None) -> None:
        self._wiki = wiki
        self._cache = cache
        self._uex = uex

    async def _vehicle_index(self) -> tuple[NameIndex, list[dict], CacheResult]:
        res = await self._cache.get_or_fetch("uex:vehicles", _VEHICLE_INDEX_TTL, self._uex.vehicles)
        index = NameIndex()
        for e in vehicle_entries(res.value):
            index.add(e)
        return index, res.value, res

    async def _vehicle_result(self, entry: Entry, vehicles: list[dict], index_res: CacheResult) -> dict:
        v = entry.data
        pres = await self._cache.get_or_fetch(
            f"uex:vprices:{v['id']}", _VEHICLE_PRICES_TTL,
            lambda: self._uex.vehicles_purchases_prices(v["id"]))
        shops = _vehicle_shops(pres.value)
        out = {"source": _VEHICLE_SOURCE, "game_version": v.get("game_version"),
               "item": _vehicle_summary(v), "where_to_buy": shops,
               "alternatives": _vehicle_alternatives(vehicles, v),
               **_merge_freshness(index_res, pres)}
        if not shops:
            out["note"] = ("No player-reported dealer listings on UEX (may be "
                           "pledge-store only or not sold in game).")
        return out

    async def _resolve_vehicle(self, name: str):
        """Returns (resolution, vehicles, index_res) on success, or None if
        the vehicle path can't be used at all -- callers treat None exactly
        like "no vehicle path available" and fall through to Wiki. Per
        task-14 brief this must never raise: any exception (an UpstreamError
        from the fetch, or e.g. a KeyError from a malformed record missing
        "id" inside vehicle_entries()) is caught and logged, not just
        UpstreamError -- a bad vehicle record must not surface as sc_find_item
        returning error("internal", ...) when the Wiki path could still
        answer."""
        if self._uex is None:
            return None
        try:
            index, vehicles, index_res = await self._vehicle_index()
        except Exception:
            logger.warning("vehicle index unavailable for '%s'; falling back to Wiki path",
                           name, exc_info=True)
            return None
        return index.resolve(name, kind="vehicle"), vehicles, index_res

    async def find_item(self, name: str) -> dict:
        vehicle_ambiguous: list[str] | None = None
        if self._uex is not None:
            resolved = await self._resolve_vehicle(name)
            if resolved is not None:
                resolution, vehicles, index_res = resolved
                if (resolution.status in ("exact", "fuzzy")
                        and _vehicle_match_accepted(resolution.status, name, resolution.match)):
                    try:
                        return await self._vehicle_result(resolution.match, vehicles, index_res)
                    except Exception:
                        # Any failure building the vehicle result (price fetch
                        # UpstreamError, or a malformed record) falls through
                        # to the Wiki item path rather than raising.
                        logger.warning("vehicle result failed for '%s'; falling back to Wiki path",
                                       name, exc_info=True)
                elif resolution.status == "ambiguous":
                    # Fix round 1: NameIndex's generic WRatio fuzzy scoring
                    # returns "ambiguous" for practically any input once
                    # nothing scores high enough to be unique -- against the
                    # real 282-vehicle fixture, "asdf" and "random nonsense
                    # zzz" both come back "ambiguous" with a handful of
                    # totally unrelated ship names. Only keep candidates that
                    # share a whole token with the query; a genuinely unknown
                    # name is left with NO vehicle candidates and falls
                    # through to the Wiki path's own not_found/ambiguous,
                    # rather than fabricating an "ambiguous vehicle" answer.
                    query_tokens = _tokens(name)
                    matched = [c.name for c in resolution.candidates
                              if query_tokens & _tokens(c.name)]
                    if matched:
                        vehicle_ambiguous = matched[:5]

        wiki_result = await self._find_wiki_item(name)
        if vehicle_ambiguous is not None and wiki_result.get("error") == "not_found":
            return error("ambiguous", f"'{name}' matches several vehicles",
                         candidates=vehicle_ambiguous)
        if wiki_result.get("error") == "not_found" and vehicle_ambiguous is None:
            # Task-15: the vehicle path found nothing at all either, so this
            # is a genuine miss, not a real ambiguity -- worth one retry pass
            # with ASR-normalised variants before giving up.
            for variant in _asr_variants(name):
                retried = await self._find_wiki_item(variant)
                if "error" not in retried:
                    return {**retried, "note": f"Interpreted '{name}' as '{variant}'."}
        return wiki_result

    async def _wiki_item_raw(self, name: str) -> tuple[dict | None, CacheResult | None, dict | None]:
        """(raw Wiki item, its cache result, None) on success, or
        (None, None, error envelope) for not_found / ambiguous / wiki_unavailable."""
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
                    return None, None, error("ambiguous", f"'{name}' matches several items",
                                             candidates=[h.get("name") for h in hits[:5]])
                else:
                    return None, None, error("not_found", f"no item named '{name}'", candidates=[])
        except UpstreamError as e:
            return None, None, error("wiki_unavailable", str(e))
        return item, res, None

    async def _find_wiki_item(self, name: str) -> dict:
        item, res, err = await self._wiki_item_raw(name)
        if err is not None:
            return err
        shops = _shops(item)
        out = {"source": SOURCE, "game_version": item.get("version"),
               "item": _summary(item), "where_to_buy": shops,
               "alternatives": [v.get("name") for v in (item.get("variants") or [])[:3] if isinstance(v, dict)],
               **freshness(res)}
        if not shops:
            out["note"] = "No player-reported shop listings on UEX for this item (it may be loot/craft/pledge-only)."
        return out

    async def component(self, name_or_uuid: str) -> dict:
        """Item profile for the member-hangar fit-check: the same summary
        sc_find_item reports (type, size, key_stats keyed like
        compare_components' stats) plus the Wiki uuid and shop listings.
        Wiki items only -- no vehicle path -- with the same ASR-tolerant
        retry as find_item. Never raises; errors are envelopes."""
        item, res, err = await self._wiki_item_raw(name_or_uuid)
        note = None
        if err is not None and err.get("error") == "not_found":
            for variant in _asr_variants(name_or_uuid):
                item, res, retry_err = await self._wiki_item_raw(variant)
                if retry_err is None:
                    err, note = None, f"Interpreted '{name_or_uuid}' as '{variant}'."
                    break
        if err is not None:
            return err
        out = {"source": SOURCE, "game_version": item.get("version"), "uuid": item.get("uuid"),
               "item": _summary(item), "where_to_buy": _shops(item), **freshness(res)}
        if note:
            out["note"] = note
        return out

    async def compare_components(self, type: str, size: int, rank_by: str | None = None,
                                 grade: str | None = None, class_: str | None = None,
                                 limit: int = 5, purchasable_only: bool = False) -> dict:
        norm_type = _normalise_token(type)
        ct = COMPONENT_TYPES.get(_TYPE_SYNONYMS.get(norm_type, norm_type))
        if ct is None:
            return error("bad_request", f"unknown component type '{type}'; use one of {sorted(COMPONENT_TYPES)}")
        rank_note: str | None = None
        if rank_by is None:
            rank = ct["default_rank"]
        else:
            norm_rank = _normalise_token(rank_by)
            if norm_rank in ct["stats"]:
                rank = norm_rank
            else:
                synonym = ct.get("rank_synonyms", {}).get(norm_rank)
                if synonym is not None:
                    rank = synonym
                    rank_note = f"rank_by '{rank_by}' interpreted as '{rank}'."
                else:
                    # Task-15: an unrecognised rank_by NEVER errors -- rank by
                    # the type's default and explain the substitution, rather
                    # than bad_request'ing a voice/ASR guess (e.g. the model
                    # guessing rank_by="shield_hp" or worse for "most
                    # powerful shield").
                    rank = ct["default_rank"]
                    rank_note = (f"rank_by '{rank_by}' not recognised; ranked by {rank}. "
                                f"Options: {sorted(ct['stats'])}")
        try:
            res = await self._cache.get_or_fetch(f"wiki:vi:{ct['wiki_type']}:{size}", _TTL,
                                                 lambda: self._wiki.vehicle_items(ct["wiki_type"], size))
        except UpstreamError as e:
            return error("wiki_unavailable", str(e))
        lower_is_better = rank in ct.get("lower_is_better", ())
        rows = []
        excluded_missing_stat = 0
        excluded_not_purchasable = 0
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
            # "Purchasable" = at least one current player-reported UEX shop
            # buy price (the same listings `cheapest` is taken from).
            if purchasable_only and not shops:
                excluded_not_purchasable += 1
                continue
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
        if purchasable_only:
            out["purchasable_only"] = True
            out["excluded_not_purchasable"] = excluded_not_purchasable
        if rank_note:
            out["note"] = rank_note
        return out
