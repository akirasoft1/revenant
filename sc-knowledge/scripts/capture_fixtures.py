"""Capture real upstream responses into tests/fixtures (run manually; tests never hit the network).

Usage: cd sc-knowledge && UEXCORP_BEARER=... .venv/bin/python scripts/capture_fixtures.py
"""
import json
import os
import pathlib
import urllib.parse
import urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures"
UEX = "https://api.uexcorp.uk/2.0"
WIKI = "https://api.star-citizen.wiki/api"
TOKEN = os.environ.get("UEXCORP_BEARER")

CAPTURES = {
    "uex_game_versions.json": f"{UEX}/game_versions",
    "uex_terminals.json": f"{UEX}/terminals",
    "uex_commodities.json": f"{UEX}/commodities",
    "uex_routes_mic_l5.json": f"{UEX}/commodities_routes?id_terminal_origin=58",
    "uex_commodity_prices_79.json": f"{UEX}/commodities_prices?id_commodity=79",
    "uex_items_prices_5601.json": f"{UEX}/items_prices?id_item=5601",
    "wiki_item_v801_12.json": f"{WIKI}/v2/items/V801-12",
    "wiki_items_search_v801.json": f"{WIKI}/v2/items?" + urllib.parse.urlencode({"filter[name]": "V801", "limit": 10}),
    "wiki_vehicle_items_shield_s2.json": f"{WIKI}/vehicle-items?" + urllib.parse.urlencode({"filter[type]": "Shield", "filter[size]": 2, "limit": 200}),
    "wiki_missions_foxwell.json": f"{WIKI}/missions?" + urllib.parse.urlencode({"filter[mission_giver]": "Foxwell Enforcement", "limit": 200}),
    "wiki_factions.json": f"{WIKI}/factions?limit=200",
}


def fetch(url: str) -> dict:
    headers = {"User-Agent": "revenant-discord-bot/fixture-capture", "Accept": "application/json"}
    if url.startswith(UEX) and TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        return json.load(r)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, url in CAPTURES.items():
        (OUT / name).write_text(json.dumps(fetch(url), indent=1))
        print("wrote", name)
