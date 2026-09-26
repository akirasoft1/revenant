from src.config import load
from src.uex import build_uex
from src.wiki import build_wiki
from tests.conftest import fixture_transport


async def test_uex_parses_data_payloads():
    uex = build_uex(load(), transport=fixture_transport({
        "/2.0/game_versions": "uex_game_versions.json",
        "/2.0/terminals": "uex_terminals.json",
        "/2.0/commodities_routes": "uex_routes_mic_l5.json",
        "/2.0/items_prices": "uex_items_prices_5601.json",
    }))
    assert (await uex.game_versions())["live"]
    terms = await uex.terminals()
    assert any(t["nickname"] == "MIC-L5" or "MIC-L5" in t["name"] for t in terms)
    routes = await uex.commodities_routes(id_terminal_origin=58)
    assert routes and {"commodity_name", "price_origin", "price_destination", "profit"} <= set(routes[0])
    prices = await uex.items_prices(5601)
    assert prices[0]["price_buy"] > 0 and prices[0]["terminal_name"]


async def test_wiki_item_and_404_and_pagination_single_page():
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/v2/items/V801-12": "wiki_item_v801_12.json",
        "/api/vehicle-items": "wiki_vehicle_items_shield_s2.json",
        "/api/missions": "wiki_missions_foxwell.json",
    }))
    item = await wiki.item("V801-12")
    assert item["name"] == "V801-12" and item["type"] == "Radar"
    assert await wiki.item("NoSuchThing-999") is None
    shields = await wiki.vehicle_items("Shield", 2)
    assert len(shields) >= 10 and all(s["size"] == 2 for s in shields)
    missions = await wiki.missions("Foxwell Enforcement")
    assert len(missions) >= 50


async def test_wiki_item_returns_none_when_payload_data_is_a_list():
    """R1: a list `data` payload (e.g. search results routed to a non-existent
    item path) must resolve to None, not be returned as-is."""
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/v2/items": "wiki_items_search_v801.json",
    }))
    assert await wiki.item("V801") is None
