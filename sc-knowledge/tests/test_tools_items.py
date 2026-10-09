import httpx

from src.cache import TTLCache
from src.config import load
from src.tools_items import _VEHICLE_INDEX_TTL, ItemTools
from src.uex import build_uex
from src.wiki import build_wiki
from tests.conftest import fixture_transport, load_fixture

_EMPTY_WIKI_ROUTES = {"/api/v2/items": "wiki_items_search_empty.json"}


class _Clock:
    """Manually-advanceable clock for TTLCache staleness tests (mirrors
    tests/test_cache.py's Clock)."""
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


def _tools():
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/v2/items/V801-12": "wiki_item_v801_12.json",
        "/api/v2/items": "wiki_items_search_v801.json",
        "/api/vehicle-items": "wiki_vehicle_items_shield_s2.json",
    }))
    return ItemTools(wiki, TTLCache())


def _tools_with_uex(wiki_routes=None, uex_routes=None):
    wiki = build_wiki(load(), transport=fixture_transport(wiki_routes if wiki_routes is not None else {
        "/api/v2/items/V801-12": "wiki_item_v801_12.json",
        "/api/v2/items": "wiki_items_search_v801.json",
    }))
    uex = build_uex(load(), transport=fixture_transport({
        # Longest-prefix routing: "/2.0/vehicles_purchases_prices" would
        # otherwise be swallowed by the "/2.0/vehicles" prefix, so both are
        # registered explicitly (task-14 brief).
        "/2.0/vehicles_purchases_prices": "uex_vehicle_prices_scorpius.json",
        "/2.0/vehicles": "uex_vehicles.json",
        **(uex_routes or {}),
    }))
    return ItemTools(wiki, TTLCache(), uex=uex)


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


async def test_find_item_skips_non_numeric_price():
    """Defensive: a malformed upstream price_buy must be skipped, never raise
    across the MCP boundary (controller ruling, fix round 1 item 5)."""
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/v2/items/BadPricer": "wiki_item_bad_price.json",
    }))
    r = await ItemTools(wiki, TTLCache()).find_item("BadPricer")
    assert len(r["where_to_buy"]) == 1
    assert r["where_to_buy"][0]["shop"] == "Good Shop"
    assert r["where_to_buy"][0]["price_auec"] == 5000


async def test_compare_size2_shields_ranked_by_health_then_regen():
    r = await _tools().compare_components("shield", 2, limit=5)
    names = [x["name"] for x in r["results"]]
    assert r["ranked_by"] == "max_health"
    assert r["order"] == "desc"
    assert "excluded_missing_stat" not in r
    assert r["results"][0]["stats"]["max_health"] >= r["results"][-1]["stats"]["max_health"]
    assert names.index("FR-76") < names.index("SecureShield")  # same health, better regen first


async def test_compare_rank_by_regen():
    r = await _tools().compare_components("shield", 2, rank_by="regen_rate", limit=3)
    assert r["results"][0]["name"] == "FR-76"
    assert r["order"] == "desc"


async def test_compare_rank_by_regen_delay_is_ascending_lower_is_better():
    """Controller ruling, fix round 1 item 2: regen_delay_damage_s is
    lower_is_better -- shortest delay (best) ranks first, and the result
    reports order == "asc"."""
    r = await _tools().compare_components("shield", 2, rank_by="regen_delay_damage_s", limit=3)
    assert r["order"] == "asc"
    assert r["results"][0]["name"] == "Umbra"  # 3.21s, the shortest regen delay in the fixture
    assert r["results"][0]["stats"]["regen_delay_damage_s"] <= r["results"][-1]["stats"]["regen_delay_damage_s"]


async def test_compare_excludes_missing_stat_and_reports_count():
    """Controller ruling, fix round 1 item 3: rows lacking the selected rank
    stat are still excluded from ranking, but the count is now surfaced."""
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/vehicle-items": "wiki_vehicle_items_missing_stat_sample.json",
    }))
    r = await ItemTools(wiki, TTLCache()).compare_components("shield", 2)
    names = [x["name"] for x in r["results"]]
    assert names == ["Alpha", "Beta"]  # "Gamma" has no "shield" block at all
    assert r["excluded_missing_stat"] == 1


async def test_compare_unknown_type_is_bad_request():
    r = await _tools().compare_components("banana", 2)
    assert r["error"] == "bad_request" and "shield" in r["detail"]


# --- Task 14: ship/vehicle purchases in sc_find_item ------------------------

async def test_find_item_scorpius_resolves_to_base_vehicle_with_uex_price():
    """'Scorpius' must resolve to the base Scorpius (id 174), not 'Scorpius
    Antares' (id 175), and return the real New Deal / Lorville / 5,171,040
    aUEC listing from the captured UEX fixture (live-eval regression)."""
    r = await _tools_with_uex().find_item("Scorpius")
    assert "error" not in r
    assert r["source"] == "uexcorp.space (crowd-sourced)"
    assert r["game_version"] == "4.10.1"
    assert r["item"]["name"] == "RSI Scorpius"
    assert r["item"]["type"] == "Vehicle"
    assert r["item"]["manufacturer"] == "Roberts Space Industries"
    assert r["item"]["crew"] == "2"
    top = r["where_to_buy"][0]
    assert top["shop"] == "New Deal - Teasa Spaceport - Lorville"
    assert top["price_auec"] == 5171040
    assert top["location"] == "Lorville, Hurston"
    assert top["system"] == "Stanton"
    assert top["reported_at"] == "2026-09-11T05:11:36+00:00"
    assert r["alternatives"] == ["Scorpius Antares"]


async def test_find_item_scorpius_antares_resolves_to_antares_not_base():
    r = await _tools_with_uex().find_item("Scorpius Antares")
    assert "error" not in r
    assert r["item"]["name"] == "RSI Scorpius Antares"
    assert r["alternatives"] == ["Scorpius"]


async def test_find_item_v801_12_still_resolves_via_wiki_with_uex_present():
    """A real Wiki-only item name must not be captured by vehicle resolution
    just because a uex client is wired in."""
    r = await _tools_with_uex().find_item("V801-12")
    assert "error" not in r
    assert r["item"]["type"] == "Radar" and r["item"]["size"] == 2
    assert r["source"] == "star-citizen.wiki (+UEX prices)"


async def test_find_item_generic_word_does_not_fuzzy_match_vehicle():
    """A generic word like 'Shield' must not resolve as an exact/fuzzy vehicle
    match against the real 282-vehicle fixture (which would fabricate a wrong
    'Vehicle' result for what is really a component-type query) -- it must
    fall through to the existing Wiki item path, whatever that path returns."""
    from src.names import NameIndex, vehicle_entries

    vehicles = load_fixture("uex_vehicles.json")["data"]
    idx = NameIndex()
    for e in vehicle_entries(vehicles):
        idx.add(e)
    assert idx.resolve("Shield", kind="vehicle").status not in ("exact", "fuzzy")

    r = await _tools_with_uex().find_item("Shield")
    assert r.get("source") != "uexcorp.space (crowd-sourced)"
    assert (r.get("item") or {}).get("type") != "Vehicle"


async def test_find_item_ambiguous_vehicle_with_no_wiki_match_returns_vehicle_ambiguous():
    """Two vehicles sharing a fuzzy-ambiguous alias, with no Wiki match at
    all, surface the vehicle candidates as an 'ambiguous' error rather than a
    plain not_found."""
    uex_routes = {"/2.0/vehicles": "uex_vehicles_ambiguous_pair.json"}
    r = await _tools_with_uex(wiki_routes={
        "/api/v2/items/Freelancer": "wiki_items_search_empty.json",
        "/api/v2/items": "wiki_items_search_empty.json",
    }, uex_routes=uex_routes).find_item("Freelancer")
    assert r["error"] == "ambiguous"
    assert set(r["candidates"]) == {"Freelancer MAX", "Freelancer MIS"}


# --- Fix round 1: reject unrelated fuzzy-ambiguous vehicle noise ------------

async def test_find_item_nonsense_queries_are_not_found_not_ambiguous_vehicle():
    """Controller ruling, fix round 1: against the REAL 282-vehicle fixture,
    NameIndex's generic WRatio fuzzy scoring calls "asdf", "random nonsense
    zzz" and "CF-227 Badger Repeater" all "ambiguous", each with a handful of
    totally unrelated real ship names (e.g. "asdf" -> Hammerhead/HoverQuad/
    Nomad/Ironclad/Asgard) -- pure string-similarity noise on words that share
    no real token with any of those ships. None of these candidates share a
    whole alphanumeric token (len >= 3) with the query, so with the Wiki path
    also finding nothing, find_item must return an honest not_found, never a
    fabricated "ambiguous" vehicle answer with unrelated ships listed."""
    for query in ("asdf", "random nonsense zzz", "CF-227 Badger Repeater"):
        r = await _tools_with_uex(wiki_routes=_EMPTY_WIKI_ROUTES).find_item(query)
        assert r.get("error") == "not_found", (query, r)


async def test_find_item_hornet_family_ambiguous_with_real_shared_token():
    """Contrast case for the token filter above: "Hornet" is a real
    multi-variant family in the fixture (F7A Hornet Mk I, F7C Hornet Mk II,
    F7C-M Super Hornet Mk I, ...) and every one of NameIndex's ambiguous
    candidates genuinely shares the "hornet" token with the query -- this must
    still surface as an honest ambiguous vehicle answer (with the Wiki path
    also finding nothing), not be swept into not_found by the same filter."""
    r = await _tools_with_uex(wiki_routes=_EMPTY_WIKI_ROUTES).find_item("Hornet")
    assert r["error"] == "ambiguous"
    assert r["candidates"]
    assert all("hornet" in c.lower() for c in r["candidates"])


async def test_find_item_scorpius_shield_v801_unchanged_by_token_filter():
    """The token filter must not disturb any of the already-covered
    resolutions: exact vehicle match, and Wiki-path fallthrough for a generic
    component word or a real Wiki-only item name."""
    r_scorpius = await _tools_with_uex().find_item("Scorpius")
    assert r_scorpius["item"]["name"] == "RSI Scorpius"

    r_antares = await _tools_with_uex().find_item("Scorpius Antares")
    assert r_antares["item"]["name"] == "RSI Scorpius Antares"

    r_shield = await _tools_with_uex().find_item("Shield")
    assert (r_shield.get("item") or {}).get("type") != "Vehicle"

    r_v801 = await _tools_with_uex().find_item("V801-12")
    assert r_v801["item"]["type"] == "Radar"


async def test_find_item_the_and_a_do_not_hijack_into_vehicle():
    """Controller ruling, fix round 2: against the real fixture,
    find_item("the") fuzzy-matched "Vanduul Scythe" (name "Scythe") via
    NameIndex's substring branch -- "the" is a contiguous substring of
    "scythe" but shares no whole word with it. A short, ordinary word must
    never hijack into a fabricated ship answer just because vehicles are
    resolved first."""
    for query in ("the", "a"):
        r = await _tools_with_uex(wiki_routes=_EMPTY_WIKI_ROUTES).find_item(query)
        assert (r.get("item") or {}).get("type") != "Vehicle"
        assert r.get("source") != "uexcorp.space (crowd-sourced)"


async def test_find_item_substring_of_ship_name_is_not_a_different_word_match():
    """"sair" fuzzy-matches "Corsair" via the same substring mechanism as
    "the"/"Scythe" above, but "sair" is not a whole word of any of Corsair's
    aliases (name/name_full/slug) -- it must not resolve to Corsair."""
    r = await _tools_with_uex(wiki_routes=_EMPTY_WIKI_ROUTES).find_item("sair")
    assert (r.get("item") or {}).get("name") != "Corsair"
    assert (r.get("item") or {}).get("type") != "Vehicle"


async def test_find_item_multitoken_fuzzy_match_still_resolves():
    """Contrast case: "Hornet Wildfire" fuzzy-matches "F7C Hornet Wildfire Mk
    I" via the same substring branch, but here EVERY query token ("hornet",
    "wildfire") is a whole token of the matched vehicle's own name/name_full/
    slug -- this is a real, intentional match and must still resolve."""
    r = await _tools_with_uex().find_item("Hornet Wildfire")
    assert "error" not in r
    assert r["item"]["type"] == "Vehicle"
    assert r["item"]["name"] == "Anvil F7C Hornet Wildfire Mk I"


async def test_find_item_scorpius_family_unaffected_by_token_relatedness_guard():
    """Regression: the token-relatedness guard must not disturb the
    already-covered exact vehicle matches."""
    r_scorpius = await _tools_with_uex().find_item("Scorpius")
    assert r_scorpius["item"]["name"] == "RSI Scorpius"

    r_antares = await _tools_with_uex().find_item("Scorpius Antares")
    assert r_antares["item"]["name"] == "RSI Scorpius Antares"


async def test_find_item_malformed_vehicle_record_falls_back_to_wiki():
    """A vehicles fixture with one record missing "id" must not surface as
    error("internal", ...) -- vehicle_entries() raises KeyError building the
    index, the whole vehicle path is treated as unavailable (logged, not
    raised), and the Wiki path still answers for a real Wiki item."""
    r = await _tools_with_uex(uex_routes={
        "/2.0/vehicles": "uex_vehicles_missing_id.json",
    }).find_item("V801-12")
    assert "error" not in r
    assert r["item"]["type"] == "Radar"
    assert r["source"] == "star-citizen.wiki (+UEX prices)"


async def test_find_item_vehicle_result_reports_stale_index_freshness():
    """When the vehicle index refetch fails and TTLCache serves the stale
    entry, the vehicle result must surface that staleness (freshness() is
    normally only applied to the price fetch; it must also cover the index
    fetch feeding the same result)."""
    clk = _Clock()
    cache = TTLCache(clock=clk)
    vehicles = load_fixture("uex_vehicles.json")["data"]
    prices = load_fixture("uex_vehicle_prices_scorpius.json")["data"]

    calls = {"n": 0}

    class _FlakyUex:
        async def vehicles(self):
            calls["n"] += 1
            if calls["n"] > 1:
                raise RuntimeError("uex down")
            return vehicles

        async def vehicles_purchases_prices(self, id_vehicle):
            return prices

    wiki = build_wiki(load(), transport=fixture_transport({}))
    tools = ItemTools(wiki, cache, uex=_FlakyUex())

    r1 = await tools.find_item("Scorpius")
    assert r1.get("stale") is not True

    clk.t += _VEHICLE_INDEX_TTL + 10  # expire both index and price cache entries
    r2 = await tools.find_item("Scorpius")
    assert calls["n"] == 2  # the second vehicles() call is the one that raised
    assert r2["stale"] is True
    assert r2["age_minutes"] == round((_VEHICLE_INDEX_TTL + 10) / 60)


async def test_find_item_vehicle_upstream_error_falls_back_to_wiki_path():
    """Any vehicle-path UpstreamError (e.g. the vehicles list 500s) must fall
    through to the existing Wiki path rather than raising or erroring out."""
    def _500(req):
        return httpx.Response(500, text="boom")

    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/v2/items/V801-12": "wiki_item_v801_12.json",
        "/api/v2/items": "wiki_items_search_v801.json",
    }))
    uex = build_uex(load(), transport=httpx.MockTransport(_500))
    r = await ItemTools(wiki, TTLCache(), uex=uex).find_item("V801-12")
    assert "error" not in r
    assert r["item"]["type"] == "Radar"
    assert r["source"] == "star-citizen.wiki (+UEX prices)"


async def test_find_item_vehicle_price_upstream_error_falls_back_to_wiki_path():
    """A vehicle name resolves, but the per-vehicle price fetch itself 500s --
    must still fall through to Wiki rather than erroring (only V801-12 is a
    real Wiki item here, so a non-fallback result would show a Vehicle type
    or an error, not a Radar)."""
    def handler(req):
        if req.url.path == "/2.0/vehicles":
            return httpx.Response(200, json=load_fixture("uex_vehicles.json"))
        return httpx.Response(500, text="boom")

    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/v2/items/Scorpius": "wiki_items_search_empty.json",
        "/api/v2/items": "wiki_items_search_empty.json",
    }))
    uex = build_uex(load(), transport=httpx.MockTransport(handler))
    r = await ItemTools(wiki, TTLCache(), uex=uex).find_item("Scorpius")
    assert r.get("error") == "not_found"


async def test_find_item_vehicle_with_no_uex_listings_reports_note():
    r = await _tools_with_uex(uex_routes={
        "/2.0/vehicles_purchases_prices": "uex_vehicle_prices_empty.json",
    }).find_item("Scorpius")
    assert r["where_to_buy"] == []
    assert "note" in r


def _tools_for(sample_fixture: str):
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/vehicle-items": sample_fixture,
    }))
    return ItemTools(wiki, TTLCache())


def _distinct_names(fixture: str) -> set[str]:
    return {it["name"] for it in load_fixture(fixture)["data"]}


# --- Non-shield COMPONENT_TYPES: each per-type sample is now captured as a
# single real page (filter[type]=<T>&filter[size]=<size>&limit=200, verified
# meta.last_page == 1 at capture time -- see scripts/capture_fixtures.py and
# task-4-report.md fix-round-1 section) specifically so `_all_pages` cannot
# replay page 1 against the path-only fixture_transport mock and manufacture
# duplicate rows the way the original limit=3 samples did (controller ruling,
# fix round 1 item 1: reviewer reproduced 10x "Agrippa" for radar and
# "Aither" being crowded out for quantum_drive against the old samples).
# Each test below asserts every returned name is distinct and the count
# matches the number of distinct items in the fixture that actually carry the
# ranked stat, up to compare_components' pre-existing 20-row display cap.

async def test_compare_power_plants_ranked_by_power_segment_generation():
    fixture = "wiki_vehicle_items_power_plant_sample.json"
    expected = min(len(_distinct_names(fixture)), 20)
    r = await _tools_for(fixture).compare_components("power_plant", 2, limit=20)
    names = [x["name"] for x in r["results"]]
    assert r["ranked_by"] == "power_segment_generation"
    assert len(names) == len(set(names)) == expected
    assert r["results"][0]["stats"]["power_segment_generation"] is not None
    assert "excluded_missing_stat" not in r


async def test_compare_coolers_ranked_by_coolant_segment_generation():
    fixture = "wiki_vehicle_items_cooler_sample.json"
    expected = min(len(_distinct_names(fixture)), 20)
    r = await _tools_for(fixture).compare_components("cooler", 2, limit=20)
    names = [x["name"] for x in r["results"]]
    assert r["ranked_by"] == "coolant_segment_generation"
    assert len(names) == len(set(names)) == expected
    assert r["results"][0]["stats"]["coolant_segment_generation"] is not None
    assert "excluded_missing_stat" not in r


async def test_compare_quantum_drives_ranked_by_speed():
    fixture = "wiki_vehicle_items_quantum_drive_sample.json"
    expected = min(len(_distinct_names(fixture)), 20)
    r = await _tools_for(fixture).compare_components("quantum_drive", 2, limit=20)
    names = [x["name"] for x in r["results"]]
    assert r["ranked_by"] == "speed"
    assert len(names) == len(set(names)) == expected
    assert "Aither" in names  # was crowded out by the old limit=3/pagination-replay bug
    assert r["results"][0]["stats"]["speed"] is not None


async def test_compare_radars_ranked_by_assignment_range_max():
    fixture = "wiki_vehicle_items_radar_sample.json"
    expected = min(len(_distinct_names(fixture)), 20)
    r = await _tools_for(fixture).compare_components("radar", 2, limit=20)
    names = [x["name"] for x in r["results"]]
    assert r["ranked_by"] == "assignment_range_max"
    assert len(names) == len(set(names)) == expected
    assert names.count("Agrippa") == 1  # was replayed 10x by the old pagination-replay bug
    assert r["results"][0]["stats"]["assignment_range_max"] is not None


async def test_compare_weapons_ranked_by_dps():
    # The live size-2 WeaponGun sample (42 items) genuinely contains re-skinned
    # variants sharing a display name but with distinct uuids (e.g. two real,
    # separate "CF-227 Badger Repeater" items) -- confirmed by inspecting the
    # captured fixture directly. Asserting name-uniqueness here would fail
    # against real upstream data, so distinctness is checked by uuid (what
    # compare_components' de-dup actually keys on), matching controller ruling
    # item 1's intent (defend against genuine duplicate rows, not collapse
    # legitimately distinct items). One item ("SureGrip TH2 Tractor Beam") has
    # no vehicle_weapon.damage.burst and is correctly excluded.
    fixture = "wiki_vehicle_items_weapon_sample.json"
    data = load_fixture(fixture)["data"]
    have_stat_uuids = {it["uuid"] for it in data if (it.get("vehicle_weapon") or {}).get("damage", {}).get("burst") is not None}
    expected = min(len(have_stat_uuids), 20)
    r = await _tools_for(fixture).compare_components("weapon", 2, limit=20)
    assert r["ranked_by"] == "dps"
    assert len(r["results"]) == expected
    assert r["excluded_missing_stat"] == len(data) - len(have_stat_uuids)
    assert r["results"][0]["stats"]["dps"] is not None


async def test_compare_weapons_dps_matches_across_damage_types():
    """Controller ruling, fix round 1 item 4: verify damage.burst is a valid
    damage-type-agnostic DPS figure, not just for ballistic weapons. Checked
    against a real laser (energy) and a real distortion weapon, pulled from the
    same live size-2 WeaponGun capture as the ballistic sample (both of them
    rank below the top-20 cap in the full 42-item file, so this test uses a
    3-item subset -- same real records, just isolated so the cap doesn't crop
    them out of the comparison)."""
    fixture = "wiki_vehicle_items_weapon_damage_types_sample.json"
    data = load_fixture(fixture)["data"]
    by_name = {it["name"]: it for it in data}
    ballistic = by_name["10-Series Greatsword Cannon"]["vehicle_weapon"]
    laser = by_name["FL-22 Cannon"]["vehicle_weapon"]
    distortion = by_name["EVSD Cannon"]["vehicle_weapon"]
    for w in (ballistic, laser, distortion):
        assert w["damage"]["burst"] == sum(w["damage"]["dps"].values())

    r = await _tools_for(fixture).compare_components("weapon", 2, limit=20)
    stats_by_name = {x["name"]: x["stats"] for x in r["results"]}
    assert stats_by_name["10-Series Greatsword Cannon"]["dps"] == ballistic["damage"]["burst"] == 304.1
    assert stats_by_name["FL-22 Cannon"]["dps"] == laser["damage"]["burst"] == 308.5
    assert stats_by_name["EVSD Cannon"]["dps"] == distortion["damage"]["burst"] == 202.5


async def test_compare_missiles_ranked_by_damage():
    fixture = "wiki_vehicle_items_missile_sample.json"
    expected = min(len(_distinct_names(fixture)), 20)
    r = await _tools_for(fixture).compare_components("missile", 9, limit=20)
    names = [x["name"] for x in r["results"]]
    assert r["ranked_by"] == "damage"
    assert len(names) == len(set(names)) == expected
    assert r["results"][0]["stats"]["damage"] is not None


# --- Task 15: voice-tolerant tool inputs -------------------------------------

async def test_compare_components_type_synonym_shield_generator():
    """'shield generator' (a spoken phrase, space/hyphen/case-insensitive) must
    resolve to the "shield" component type."""
    r = await _tools().compare_components("shield generator", 2, limit=5)
    assert "error" not in r
    assert r["results"]


async def test_compare_components_rank_by_synonym_shield_hp_ranks_by_max_health():
    """Live voice smoke-test regression: the model guessed rank_by="shield_hp"
    for "most powerful Size 2 shield" and got bad_request. "shield_hp" must
    now resolve to the real stat key "max_health", carry an explanatory note,
    and rank identically to an explicit rank_by="max_health" (FR-76 first,
    tied with SecureShield on health but ahead on regen)."""
    r = await _tools().compare_components("shield generator", 2, rank_by="shield_hp", limit=5)
    assert "error" not in r
    assert r["ranked_by"] == "max_health"
    assert r["results"][0]["name"] == "FR-76"
    assert "note" in r and "shield_hp" in r["note"] and "max_health" in r["note"]


async def test_compare_components_rank_by_most_powerful_phrase_normalised():
    """A spoken phrase like "most powerful" (space, not underscore) must be
    normalised (lowercase, space/hyphen -> underscore) before the synonym
    lookup."""
    r = await _tools().compare_components("shield", 2, rank_by="most powerful", limit=5)
    assert "error" not in r
    assert r["ranked_by"] == "max_health"
    assert "note" in r


async def test_compare_components_rank_by_unknown_never_errors_falls_back_to_default():
    """An unrecognised rank_by (not a canonical stat key or a known synonym)
    must never bad_request -- it ranks by the type's default and explains why
    via a note listing the valid options."""
    r = await _tools().compare_components("shield", 2, rank_by="bogus_stat", limit=5)
    assert "error" not in r
    assert r["ranked_by"] == "max_health"  # shield's default_rank
    assert "note" in r
    assert "bogus_stat" in r["note"] and "not recognised" in r["note"]
    assert "max_health" in r["note"]


async def test_compare_components_rank_by_literal_canonical_key_no_note():
    """Existing behaviour preserved: an already-canonical rank_by (e.g.
    "regen_rate") must not produce a note."""
    r = await _tools().compare_components("shield", 2, rank_by="regen_rate", limit=3)
    assert r["results"][0]["name"] == "FR-76"
    assert "note" not in r


async def test_compare_components_no_rank_by_no_note():
    """Existing behaviour preserved: omitting rank_by entirely uses the
    type's default with no note."""
    r = await _tools().compare_components("shield", 2, limit=5)
    assert "note" not in r


async def test_find_item_asr_letter_o_adjacent_to_digit_retried_as_zero():
    """Gemini Live's ASR heard "V801-12" as "v8o1-12" (or, matching a
    real-world mixed-case transcript and the fixture's exact casing,
    "V8O1-12"): the stray letter O sitting between two digits is retried as
    a literal 0 and the real V801-12 radar is returned with an interpretation
    note. A dedicated exact-path transport is used (not the shared
    longest-prefix fixture_transport) because "V801-12" is a literal string
    prefix of "V8O1-12"'s two possible normalisations, and prefix-based
    routing would otherwise mask whether the retry path actually ran."""
    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/api/v2/items/V801-12":
            return httpx.Response(200, json=load_fixture("wiki_item_v801_12.json"))
        if path == "/api/v2/items":
            return httpx.Response(200, json=load_fixture("wiki_items_search_empty.json"))
        return httpx.Response(404, json={"status": "not_found"})

    wiki = build_wiki(load(), transport=httpx.MockTransport(handler))
    r = await ItemTools(wiki, TTLCache()).find_item("V8O1-12")
    assert "error" not in r
    assert r["item"]["name"] == "V801-12" and r["item"]["type"] == "Radar"
    assert r["note"] == "Interpreted 'V8O1-12' as 'V801-12'."


async def test_find_item_trailing_category_word_stripped_and_retried():
    """"V801-12 radar" (the model adding a generic category word that isn't
    part of the real item name) is retried with that trailing word stripped.
    Same dedicated exact-path transport rationale as above: "V801-12" is a
    literal prefix of "V801-12 radar", so the shared prefix-based
    fixture_transport would accidentally satisfy the direct (unstripped)
    lookup and never exercise the retry path at all."""
    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/api/v2/items/V801-12":
            return httpx.Response(200, json=load_fixture("wiki_item_v801_12.json"))
        if path == "/api/v2/items":
            return httpx.Response(200, json=load_fixture("wiki_items_search_empty.json"))
        return httpx.Response(404, json={"status": "not_found"})

    wiki = build_wiki(load(), transport=httpx.MockTransport(handler))
    r = await ItemTools(wiki, TTLCache()).find_item("V801-12 radar")
    assert "error" not in r
    assert r["item"]["name"] == "V801-12" and r["item"]["type"] == "Radar"
    assert r["note"] == "Interpreted 'V801-12 radar' as 'V801-12'."


async def test_find_item_asr_retry_gives_up_cleanly_when_nothing_resolves():
    """When none of the ASR-normalised variants resolve either, the original
    not_found is returned unchanged (no note, no crash) -- existing
    not_found behaviour for genuinely unknown names must be unaffected."""
    r = await _tools_with_uex(wiki_routes=_EMPTY_WIKI_ROUTES).find_item("totally unknown zzz radar")
    assert r.get("error") == "not_found"
    assert "note" not in r


async def test_find_item_asr_retry_not_attempted_when_vehicle_ambiguous():
    """The retry-with-variants path only kicks in when the vehicle path also
    found nothing at all; a genuine ambiguous-vehicle result must still win
    over any Wiki-side variant retry."""
    uex_routes = {"/2.0/vehicles": "uex_vehicles_ambiguous_pair.json"}
    r = await _tools_with_uex(wiki_routes={
        "/api/v2/items/Freelancer": "wiki_items_search_empty.json",
        "/api/v2/items": "wiki_items_search_empty.json",
    }, uex_routes=uex_routes).find_item("Freelancer")
    assert r["error"] == "ambiguous"
    assert set(r["candidates"]) == {"Freelancer MAX", "Freelancer MIS"}


# --- purchasable_only (member hangar UC1) -----------------------------------
# The shield S2 fixture has 7 shields with no UEX shop buy price at all.
_UNPRICED_S2_SHIELDS = {"CoverAll", "FR-76", "FullStop", "SecureShield", "Sheut", "Sukoran", "Umbra"}


async def test_compare_purchasable_only_excludes_items_without_a_shop_price():
    r = await _tools().compare_components("shield", 2, purchasable_only=True, limit=20)
    names = {x["name"] for x in r["results"]}
    assert names and not (names & _UNPRICED_S2_SHIELDS)
    assert all(x["cheapest"] and x["cheapest"]["price_auec"] > 0 for x in r["results"])
    assert r["excluded_not_purchasable"] == len(_UNPRICED_S2_SHIELDS)
    assert r["purchasable_only"] is True


async def test_compare_default_still_includes_unpurchasable_items():
    r = await _tools().compare_components("shield", 2, limit=20)
    names = {x["name"] for x in r["results"]}
    # The unpriced 10560-HP shields outrank every priced one by default.
    assert "CoverAll" in names
    assert "excluded_not_purchasable" not in r
    assert r["results"][0]["cheapest"] is None


async def test_compare_purchasable_only_ranking_unchanged_among_purchasable():
    all_rows = (await _tools().compare_components("shield", 2, limit=20))["results"]
    expected = [x["name"] for x in all_rows if x["cheapest"]]
    got = [x["name"] for x in (await _tools().compare_components(
        "shield", 2, purchasable_only=True, limit=20))["results"]]
    # The unfiltered list is capped at 20 of 22 rows, so it can stop short
    # of the filtered one; the order must agree over the shared prefix.
    assert got[:len(expected)] == expected and len(got) > len(expected)


# --- component(): item profile for the hangar fit-check -----------------------

async def test_component_returns_type_size_key_stats_and_uuid():
    r = await _tools().component("V801-12")
    assert "error" not in r
    assert r["item"]["name"] == "V801-12"
    assert r["item"]["type"] == "Radar" and r["item"]["size"] == 2
    assert "assignment_range_max" in r["item"]["key_stats"]
    assert r["uuid"]


async def test_component_ambiguous_passes_through():
    r = await _tools().component("V801")
    assert r["error"] == "ambiguous" and "V801-12" in r["candidates"]


async def test_component_not_found():
    wiki = build_wiki(load(), transport=fixture_transport(_EMPTY_WIKI_ROUTES))
    r = await ItemTools(wiki, TTLCache()).component("Nonexistium")
    assert r["error"] == "not_found"
