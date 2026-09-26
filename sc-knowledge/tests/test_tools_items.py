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


def _tools_for(sample_fixture: str):
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/vehicle-items": sample_fixture,
    }))
    return ItemTools(wiki, TTLCache())


async def test_compare_power_plants_ranked_by_power_segment_generation():
    r = await _tools_for("wiki_vehicle_items_power_plant_sample.json").compare_components("power_plant", 2)
    assert r["ranked_by"] == "power_segment_generation"
    assert len(r["results"]) >= 1
    assert r["results"][0]["stats"]["power_segment_generation"] is not None


async def test_compare_coolers_ranked_by_coolant_segment_generation():
    r = await _tools_for("wiki_vehicle_items_cooler_sample.json").compare_components("cooler", 2)
    assert r["ranked_by"] == "coolant_segment_generation"
    assert len(r["results"]) >= 1
    assert r["results"][0]["stats"]["coolant_segment_generation"] is not None


async def test_compare_quantum_drives_ranked_by_speed():
    r = await _tools_for("wiki_vehicle_items_quantum_drive_sample.json").compare_components("quantum_drive", 2)
    assert r["ranked_by"] == "speed"
    assert len(r["results"]) >= 1
    assert r["results"][0]["stats"]["speed"] is not None


async def test_compare_radars_ranked_by_assignment_range_max():
    r = await _tools_for("wiki_vehicle_items_radar_sample.json").compare_components("radar", 2)
    assert r["ranked_by"] == "assignment_range_max"
    assert len(r["results"]) >= 1
    assert r["results"][0]["stats"]["assignment_range_max"] is not None


async def test_compare_weapons_ranked_by_dps():
    r = await _tools_for("wiki_vehicle_items_weapon_sample.json").compare_components("weapon", 2)
    assert r["ranked_by"] == "dps"
    assert len(r["results"]) >= 1
    assert r["results"][0]["stats"]["dps"] is not None


async def test_compare_missiles_ranked_by_damage():
    r = await _tools_for("wiki_vehicle_items_missile_sample.json").compare_components("missile", 9)
    assert r["ranked_by"] == "damage"
    assert len(r["results"]) >= 1
    assert r["results"][0]["stats"]["damage"] is not None
