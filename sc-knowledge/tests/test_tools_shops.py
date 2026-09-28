"""sc_location_shops: what is sold at a place, and what is unique to it.

Small inline UEX fixtures modelled on real shapes (verified 2026-09-28):
a Levski-like city with two LIVE terminals plus the old pre-Nyx
"Dumper's Depot - Levski" (is_available_live == 0) that must be ignored both
for location matching and for exclusivity.
"""
import asyncio

import httpx

from src.cache import TTLCache
from src.config import load
from src.names import token_match
from src.tools_shops import SOURCE, ShopTools
from src.uex import build_uex


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _t(id, name, *, live=1, system="Nyx", city=None, station=None, outpost=None,
       planet=None, moon=None, orbit=None, nickname=None, displayname=None, type="item"):
    return {"id": id, "name": name, "nickname": nickname, "displayname": displayname,
            "type": type, "is_available_live": live, "star_system_name": system,
            "planet_name": planet, "orbit_name": orbit, "moon_name": moon,
            "space_station_name": station, "outpost_name": outpost, "city_name": city,
            "date_modified": 1780000000}


TERMINALS = [
    _t(790, "Teach's Item Shop - Levski", nickname="Teach's Levski", displayname="Levski",
       orbit="Delamar", city="Levski"),
    _t(791, "Garrity Defense - Levski", nickname="Garrity Levski", displayname="Levski",
       orbit="Delamar", city="Levski"),
    # Old pre-Nyx terminal, same city name, no longer in the game.
    _t(116, "Dumper's Depot - Levski", live=0, orbit="Delamar", city="Levski"),
    _t(200, "Dumper's Depot - Area 18", system="Stanton", planet="ArcCorp", city="Area18"),
    _t(201, "Old Shop - Lorville", live=0, system="Stanton", planet="Hurston", city="Lorville"),
    _t(300, "Cargo Deck - Pyro Gateway (Nyx)", station="Pyro Gateway", orbit="Pyro Gateway"),
    # Gateway station in STANTON named after Nyx: token-matches "Nyx" at the
    # station tier, but "Nyx" the system must win (exact whole-field match).
    _t(301, "Admin - Nyx Gateway (Stanton)", system="Stanton", station="Nyx Gateway",
       orbit="Nyx Gateway (Stanton system)"),
    # Same station name on the Pyro side: "Nyx Gateway" spans two systems.
    _t(302, "Admin - Nyx Gateway (Pyro)", system="Pyro", station="Nyx Gateway",
       orbit="Nyx Gateway (Pyro system)"),
    # Outpost named after the planet: token-matches "ArcCorp" at the outpost
    # tier, but "ArcCorp" the planet must win (and include Area 18).
    _t(210, "Admin - ArcCorp Mining Area 045", system="Stanton", planet="ArcCorp",
       outpost="ArcCorp Mining Area 045"),
    # Its NAME token-matches "Levski", but it's in Orison: a city match must win.
    _t(502, "Levski Souvenirs - Orison", system="Stanton", planet="Crusader", city="Orison"),
    # A big system: 30 live shops, for the payload caps.
    *[_t(900 + n, f"Bigsys Shop {n:02d}", system="Bigsys", city=f"Bigcity {n:02d}")
      for n in range(30)],
]

CATEGORIES = [
    {"id": 3, "type": "item", "section": "Armor", "name": "Helmets"},
    {"id": 5, "type": "item", "section": "Armor", "name": "Torso"},
    {"id": 18, "type": "item", "section": "Personal Weapons", "name": "Personal Weapons"},
    {"id": 30, "type": "item", "section": "Utility", "name": "Mining Modules"},
    {"id": 28, "type": "item", "section": "Utility", "name": "Gadgets"},
    {"id": 32, "type": "item", "section": "Vehicle Weapons", "name": "Guns"},
    {"id": 82, "type": "item", "section": "Avionics", "name": "Flight Blade"},
]


def _p(id, id_item, name, id_category, id_terminal, price_buy, date_modified=1780000000,
       terminal_name=None):
    term = next((t for t in TERMINALS if t["id"] == id_terminal), None)
    return {"id": id, "id_item": id_item, "id_category": id_category, "id_terminal": id_terminal,
            "item_name": name, "item_uuid": f"uuid-{id_item}", "price_buy": price_buy,
            "price_sell": 0, "terminal_name": terminal_name or (term or {}).get("name"),
            "date_added": 1700000000, "date_modified": date_modified}


PRICES = [
    # Only at Levski -> exclusive.
    _p(1, 1, "NN-13 Cannon", 32, 790, 10000, date_modified=1785000000),
    # At Levski AND Area 18 -> not exclusive.
    _p(2, 2, "Omnisky III Cannon", 32, 790, 15000),
    _p(3, 2, "Omnisky III Cannon", 32, 200, 15461),
    # Levski + an UNAVAILABLE Lorville terminal -> still exclusive.
    _p(4, 3, "Strata Helmet", 3, 791, 3000),
    _p(5, 3, "Strata Helmet", 3, 201, 2900),
    # Area 18 only -> never in a Levski result.
    _p(6, 4, "Pembroke Torso", 5, 200, 9000),
    # Sell-only (price_buy 0) at Teach's; buyable at Garrity.
    _p(7, 5, "Drake Flight Blade", 82, 790, 0),
    _p(8, 5, "Drake Flight Blade", 82, 791, 500),
    # Only at the old unavailable Levski terminal -> not sold at Levski now.
    _p(9, 6, "Old Thing", 5, 116, 100),
    # price_buy 0 elsewhere doesn't count against exclusivity.
    _p(10, 7, "Arclight Pistol", 18, 791, 1200),
    _p(11, 7, "Arclight Pistol", 18, 200, 0),
    # Utility section, but a ship part (mining module).
    _p(12, 8, "Rieger-C3 Module", 30, 790, 7000),
    # Utility gadget at Pyro Gateway only.
    _p(13, 9, "Medgun", 28, 300, 800),
]

LEVSKI_ITEMS = {"NN-13 Cannon", "Omnisky III Cannon", "Strata Helmet", "Drake Flight Blade",
                "Arclight Pistol", "Rieger-C3 Module"}


def _transport(fail: set[str] | None = None, calls: list | None = None,
               gate: asyncio.Event | None = None, prices: list | None = None):
    fail = fail if fail is not None else set()
    data = {"/2.0/terminals": TERMINALS, "/2.0/categories": CATEGORIES,
            "/2.0/items_prices_all": PRICES if prices is None else prices}

    async def handler(req: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(req.url.path)
        for path, rows in data.items():
            if req.url.path == path:
                if gate is not None and path == "/2.0/items_prices_all":
                    await gate.wait()
                if path in fail:
                    return httpx.Response(404, json={"status": "not_found"})
                return httpx.Response(200, json={"status": "ok", "data": rows})
        return httpx.Response(404, json={"status": "not_found"})
    return httpx.MockTransport(handler)


def _tools(fail=None, calls=None, clock=None, gate=None, prices=None):
    uex = build_uex(load(), transport=_transport(fail, calls, gate, prices))
    cache = TTLCache(clock=clock) if clock else TTLCache()
    return ShopTools(uex, cache)


def _by_name(out):
    return {i["name"]: i for i in out["items"]}


def test_token_match_shared_from_names():
    assert token_match("Admin - ARC-L1", "l1")
    assert not token_match("Admin - L19 Residences - Metro Center - Lorville", "l1")


async def test_levski_items_and_exclusivity():
    out = await _tools().location_shops("Levski")
    assert "error" not in out
    assert out["source"] == SOURCE == "uexcorp.space (crowd-sourced)"
    assert out["location"] == "Levski"
    assert sorted(out["terminals"]) == ["Garrity Defense - Levski", "Teach's Item Shop - Levski"]
    items = _by_name(out)
    assert set(items) == LEVSKI_ITEMS
    assert "Old Thing" not in items and "Pembroke Torso" not in items
    assert items["NN-13 Cannon"]["exclusive"] is True
    assert items["Omnisky III Cannon"]["exclusive"] is False
    assert items["Strata Helmet"]["exclusive"] is True  # other seller is unavailable
    assert items["Arclight Pistol"]["exclusive"] is True  # other terminal price_buy 0
    assert items["Drake Flight Blade"]["exclusive"] is True
    assert out["total_items"] == 6
    assert out["exclusive_count"] == 5
    assert out["truncated"] is False


async def test_item_shape_section_category_and_terminals():
    out = await _tools().location_shops("Levski")
    items = _by_name(out)
    nn = items["NN-13 Cannon"]
    assert nn["section"] == "Vehicle Weapons"
    assert nn["category"] == "Guns"
    assert [(t["terminal"], t["price_buy"]) for t in nn["terminals"]] == [
        ("Teach's Item Shop - Levski", 10000)]
    # Only the matched location's terminals are listed; sell-only rows dropped.
    blade = items["Drake Flight Blade"]
    assert [t["terminal"] for t in blade["terminals"]] == ["Garrity Defense - Levski"]
    omni = items["Omnisky III Cannon"]
    assert [t["terminal"] for t in omni["terminals"]] == ["Teach's Item Shop - Levski"]


async def test_sorted_exclusive_first_then_section_then_name():
    out = await _tools().location_shops("Levski")
    keys = [(not i["exclusive"], i["section"], i["name"]) for i in out["items"]]
    assert keys == sorted(keys)
    assert out["items"][-1]["name"] == "Omnisky III Cannon"


async def test_notes_state_crowd_sourced_and_may_miss_shops():
    out = await _tools().location_shops("Levski")
    joined = " ".join(out["notes"]).lower()
    assert "player-reported" in joined
    assert "may miss" in joined


async def test_freshness_reports_newest_date_modified():
    out = await _tools().location_shops("Levski")
    assert out["latest_report"].startswith("2026-07-25")  # 1785000000
    assert "stale" not in out


async def test_city_match_beats_terminal_name_match():
    out = await _tools().location_shops("Levski")
    assert "Levski Souvenirs - Orison" not in out["terminals"]


async def test_nickname_resolves_single_terminal():
    out = await _tools().location_shops("Teach's Levski")
    assert out["terminals"] == ["Teach's Item Shop - Levski"]
    assert "Strata Helmet" not in _by_name(out)


async def test_system_query_covers_whole_system_live_only():
    out = await _tools().location_shops("Nyx")
    assert sorted(out["terminals"]) == ["Cargo Deck - Pyro Gateway (Nyx)", "Garrity Defense - Levski",
                                        "Teach's Item Shop - Levski"]
    assert "Medgun" in _by_name(out)


async def test_orbit_query_resolves():
    out = await _tools().location_shops("Delamar")
    assert sorted(out["terminals"]) == ["Garrity Defense - Levski", "Teach's Item Shop - Levski"]


async def test_not_found_has_candidates():
    out = await _tools().location_shops("Levsky")
    assert out["error"] == "not_found"
    assert "Levski" in out["candidates"]
    assert len(out["candidates"]) <= 5


async def test_unavailable_only_location_is_not_found():
    out = await _tools().location_shops("Lorville")
    assert out["error"] == "not_found"


async def test_category_alias_ship_parts():
    out = await _tools().location_shops("Levski", category="ship parts")
    assert set(_by_name(out)) == {"NN-13 Cannon", "Omnisky III Cannon", "Drake Flight Blade",
                                  "Rieger-C3 Module"}
    assert out["total_items"] == 4


async def test_category_alias_fps():
    out = await _tools().location_shops("Levski", category="FPS equipment")
    assert set(_by_name(out)) == {"Strata Helmet", "Arclight Pistol"}


async def test_category_matches_section_or_category_name():
    out = await _tools().location_shops("Levski", category="helmets")
    assert set(_by_name(out)) == {"Strata Helmet"}
    out = await _tools().location_shops("Levski", category="vehicle weapons")
    assert set(_by_name(out)) == {"NN-13 Cannon", "Omnisky III Cannon"}


async def test_category_combined_with_or():
    out = await _tools().location_shops("Levski", category="ship parts or fps equipment")
    assert set(_by_name(out)) == LEVSKI_ITEMS


async def test_unknown_category_no_filter_with_note():
    out = await _tools().location_shops("Levski", category="bananas")
    assert "error" not in out
    assert set(_by_name(out)) == LEVSKI_ITEMS
    assert any("bananas" in n for n in out["notes"])


async def test_exclusive_only():
    out = await _tools().location_shops("Levski", exclusive_only=True)
    assert "Omnisky III Cannon" not in _by_name(out)
    assert all(i["exclusive"] for i in out["items"])
    assert out["total_items"] == 5
    assert out["exclusive_count"] == 5


async def test_limit_truncates_and_clamps():
    out = await _tools().location_shops("Levski", limit=2)
    assert len(out["items"]) == 2
    assert out["truncated"] is True
    assert out["total_items"] == 6
    out = await _tools().location_shops("Levski", limit=0)
    assert len(out["items"]) == 1
    out = await _tools().location_shops("Levski", limit=1000)
    assert len(out["items"]) == 6 and out["truncated"] is False


async def test_upstream_down_cold_cache_is_uex_unavailable():
    out = await _tools(fail={"/2.0/items_prices_all"}).location_shops("Levski")
    assert out["error"] == "uex_unavailable"


async def test_stale_on_error_serves_cached_with_stale_flag():
    clk = Clock()
    fail: set[str] = set()
    tools = _tools(fail=fail, clock=clk)
    first = await tools.location_shops("Levski")
    assert "stale" not in first
    clk.t += 3600 * 10  # everything expired
    fail.update({"/2.0/items_prices_all", "/2.0/categories", "/2.0/terminals"})
    out = await tools.location_shops("Levski")
    await tools.drain_refreshes()
    assert "error" not in out
    assert out["stale"] is True
    assert set(_by_name(out)) == LEVSKI_ITEMS
    # Still stale (refresh failed) on the next call too.
    again = await tools.location_shops("Levski")
    assert again["stale"] is True


async def test_expired_entry_served_immediately_while_refresh_in_flight():
    """Stale-while-revalidate: an expired items_prices_all entry must not make
    the caller wait on the (6 MB) refetch -- the voice path bounds a tool call
    at 6s."""
    clk = Clock()
    gate = asyncio.Event()
    gate.set()
    calls: list = []
    tools = _tools(clock=clk, gate=gate, calls=calls)
    await tools.location_shops("Levski")
    clk.t += 3601
    gate.clear()  # the refetch now hangs
    out = await asyncio.wait_for(tools.location_shops("Levski"), 1.0)
    assert out["stale"] is True
    # A second call while the refresh is in flight doesn't start another one.
    await asyncio.wait_for(tools.location_shops("Levski"), 1.0)
    for _ in range(50):
        if calls.count("/2.0/items_prices_all") >= 2:
            break
        await asyncio.sleep(0.01)
    assert calls.count("/2.0/items_prices_all") == 2
    gate.set()
    await tools.drain_refreshes()
    fresh = await tools.location_shops("Levski")
    assert "stale" not in fresh


async def test_warm_populates_cache_and_swallows_failures():
    calls: list = []
    tools = _tools(calls=calls)
    await tools.warm()
    assert {"/2.0/items_prices_all", "/2.0/categories", "/2.0/terminals"} <= set(calls)
    n = len(calls)
    await tools.location_shops("Levski")
    assert len(calls) == n  # served from cache

    broken = _tools(fail={"/2.0/items_prices_all", "/2.0/categories", "/2.0/terminals"})
    await broken.warm()  # must not raise


# --- Fix round 1 -------------------------------------------------------------

async def test_system_exact_match_beats_gateway_station_token_match():
    out = await _tools().location_shops("Nyx")
    assert "Admin - Nyx Gateway (Stanton)" not in out["terminals"]
    assert "Teach's Item Shop - Levski" in out["terminals"]
    assert out["location"] == "Nyx"


async def test_planet_exact_match_beats_outpost_token_match():
    out = await _tools().location_shops("ArcCorp")
    assert sorted(out["terminals"]) == ["Admin - ArcCorp Mining Area 045",
                                        "Dumper's Depot - Area 18"]
    assert out["location"] == "ArcCorp"


async def test_station_exact_name_still_resolves():
    out = await _tools().location_shops("Nyx Gateway")
    assert sorted(out["terminals"]) == ["Admin - Nyx Gateway (Pyro)",
                                        "Admin - Nyx Gateway (Stanton)"]


async def test_connector_words_are_ignored():
    for q in ("Teach's in Levski", "Teach's at Levski", "the Teach's Levski"):
        out = await _tools().location_shops(q)
        assert out.get("terminals") == ["Teach's Item Shop - Levski"], q


EXTRA_ARMOR = [_p(100 + n, 100 + n, f"Armor Piece {n}", 3, 791, 1000 + n) for n in range(4)]


async def test_truncation_round_robins_across_sections():
    """Section-sorted truncation would return only Armor (5 exclusive armor
    items sort first); round-robin must represent every section."""
    out = await _tools(prices=PRICES + EXTRA_ARMOR).location_shops("Levski", limit=5)
    assert out["truncated"] is True
    assert out["total_items"] == 10
    sections = {i["section"] for i in out["items"]}
    assert sections == {"Armor", "Avionics", "Personal Weapons", "Utility", "Vehicle Weapons"}
    # Within a section exclusive first: NN-13 (exclusive) over Omnisky.
    assert "NN-13 Cannon" in _by_name(out)
    keys = [(not i["exclusive"], i["section"], i["name"]) for i in out["items"]]
    assert keys == sorted(keys)


async def test_section_counts_cover_full_filtered_set():
    out = await _tools(prices=PRICES + EXTRA_ARMOR).location_shops("Levski", limit=2)
    assert out["section_counts"] == {
        "Armor": {"total": 5, "exclusive": 5},
        "Avionics": {"total": 1, "exclusive": 1},
        "Personal Weapons": {"total": 1, "exclusive": 1},
        "Utility": {"total": 1, "exclusive": 1},
        "Vehicle Weapons": {"total": 2, "exclusive": 1},
    }
    out = await _tools().location_shops("Levski", category="helmets")
    assert out["section_counts"] == {"Armor": {"total": 1, "exclusive": 1}}


# --- Fix round 2 -------------------------------------------------------------

BIG_PRICES = PRICES + [_p(2000 + n, 500, "Everywhere Gadget", 28, 900 + n, 100 + n)
                       for n in range(30)]


async def test_many_terminals_are_capped_with_count_and_note():
    out = await _tools(prices=BIG_PRICES).location_shops("Bigsys")
    assert out["terminal_count"] == 30
    assert out["terminals"] == [f"Bigsys Shop {n:02d}" for n in range(25)]
    assert any("30" in n and "terminal" in n.lower() for n in out["notes"])


async def test_few_terminals_are_not_capped():
    out = await _tools().location_shops("Levski")
    assert out["terminal_count"] == 2
    assert len(out["terminals"]) == 2
    assert not any("showing 25" in n.lower() for n in out["notes"])


async def test_item_terminals_capped_to_cheapest_three():
    out = await _tools(prices=BIG_PRICES).location_shops("Bigsys")
    item = _by_name(out)["Everywhere Gadget"]
    assert [t["price_buy"] for t in item["terminals"]] == [100, 101, 102]
    assert item["terminal_count"] == 30
    # Broad (capped) queries drop per-shop dates; latest_report stays.
    assert all("reported_at" not in t for t in item["terminals"])
    assert out["latest_report"]
    # An item at only a few terminals carries no terminal_count.
    lev = _by_name(await _tools().location_shops("Levski"))["NN-13 Cannon"]
    assert "terminal_count" not in lev
    assert lev["terminals"][0]["reported_at"]


async def test_multi_system_match_gets_a_note():
    out = await _tools().location_shops("Nyx Gateway")
    joined = " ".join(out["notes"])
    assert "Pyro" in joined and "Stanton" in joined
    single = await _tools().location_shops("Levski")
    assert not any("star systems" in n for n in single["notes"])
