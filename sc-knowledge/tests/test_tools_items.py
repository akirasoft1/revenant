from src.cache import TTLCache
from src.config import load
from src.tools_items import ItemTools
from src.uex import build_uex
from src.wiki import build_wiki
from tests.conftest import fixture_transport, load_fixture


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


async def test_find_item_vehicle_upstream_error_falls_back_to_wiki_path():
    """Any vehicle-path UpstreamError (e.g. the vehicles list 500s) must fall
    through to the existing Wiki path rather than raising or erroring out."""
    import httpx

    from src.uex import build_uex

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
    import httpx

    from src.uex import build_uex

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
