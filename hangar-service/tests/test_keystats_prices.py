"""Key-stat mapping (copied from sc-knowledge) and embedded UEX price parsing."""
import pathlib
import re

import pytest

from src.catalog import ITEM_SUMMARY_KEYS, item_option, item_summary
from src.keystats import KEY_STATS, key_stat
from src.prices import cheapest_price
from tests.conftest import load_fixture


@pytest.mark.parametrize("item,expected", [
    ({"type": "Shield", "shield": {"max_health": 10000, "regen_delay": {"damage": 4.5}}},
     {"name": "max_health", "value": 10000, "lowerIsBetter": False}),
    ({"type": "QuantumDrive", "quantum_drive": {"standard_jump": {"drive_speed": 2.5e8}}},
     {"name": "speed", "value": 2.5e8, "lowerIsBetter": False}),
    ({"type": "Radar", "radar": {"aim_assist": {"distance_max_assignment": 2184}}},
     {"name": "assignment_range_max", "value": 2184, "lowerIsBetter": False}),
    ({"type": "WeaponGun", "vehicle_weapon": {"damage": {"burst": 450}}},
     {"name": "dps", "value": 450, "lowerIsBetter": False}),
    ({"type": "PowerPlant", "power_plant": {"power_segment_generation": 20}},
     {"name": "power_segment_generation", "value": 20, "lowerIsBetter": False}),
    ({"type": "Cooler", "cooler": {"coolant_segment_generation": 46}},
     {"name": "coolant_segment_generation", "value": 46, "lowerIsBetter": False}),
    ({"type": "Cooler"}, {"name": "coolant_segment_generation", "value": None, "lowerIsBetter": False}),
    ({"type": "Shield", "shield": {"max_health": "lots"}}, {"name": "max_health", "value": None, "lowerIsBetter": False}),
    ({"type": "Shield", "shield": {"max_health": True}}, {"name": "max_health", "value": None, "lowerIsBetter": False}),
    ({"type": "Turret"}, None), ({"type": "TractorBeam"}, None), ({}, None),
])
def test_key_stat(item, expected):
    assert key_stat(item) == expected


def test_key_stats_in_sync_with_sc_knowledge():
    """The default rank + stat path per Wiki type must equal sc-knowledge's
    COMPONENT_TYPES (read as text: hangar-service can't import that package)."""
    src = pathlib.Path(__file__).resolve().parents[2] / "sc-knowledge" / "src" / "tools_items.py"
    if not src.exists():
        pytest.skip("sc-knowledge source not present")
    text = src.read_text()
    for wiki_type, spec in KEY_STATS.items():
        m = re.search(r'"wiki_type": "%s", "stat_key": "([a-z_]+)"' % wiki_type, text)
        assert m and m.group(1) == spec["stat_key"], wiki_type
        block = text[m.start(): text.find("rank_synonyms", m.start())]
        rank = re.search(r'"default_rank": "([a-z_0-9]+)"', block).group(1)
        assert rank == spec["default_rank"], wiki_type
        assert f'"{rank}": "{spec["stats"][rank]}"' in block, wiki_type


def test_cheapest_price():
    rows = [{"price_buy": 500, "terminal_name": "B", "starmap_location": {"name": "Area18", "parent_name": "ArcCorp"}},
            {"price_buy": "300", "terminal_name": "A", "starmap_location": None},
            {"price_buy": None}, {"price_buy": -1}, {"price_buy": True}, 7]
    assert cheapest_price({"uex_prices": {"purchase": rows}}) == {"price": 300, "shop": "A", "location": None}
    assert cheapest_price({"uex_prices": {"purchase": rows[:1]}}) == {
        "price": 500, "shop": "B", "location": "Area18, ArcCorp"}
    for bad in (None, {}, {"uex_prices": None}, {"uex_prices": {"purchase": "x"}}, {"uex_prices": []}):
        assert cheapest_price(bad) is None


def test_item_option_extends_summary_and_items_route_shape_is_unchanged():
    raw = load_fixture("wiki_item_hemera.json")["data"]
    opt = item_option(raw)
    assert {k: opt[k] for k in ITEM_SUMMARY_KEYS} == item_summary(raw)
    assert opt["keyStat"]["name"] == "speed" and opt["cheapestPrice"] is None
    assert set(item_summary(raw)) == set(ITEM_SUMMARY_KEYS)
