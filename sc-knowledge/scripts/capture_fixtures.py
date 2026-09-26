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
    # Live samples for Task 4 compare_components non-shield COMPONENT_TYPES: used to
    # confirm real dotted stat paths (never guessed) and as fixtures for per-type tests.
    #
    # Fix round 1 item 1: these MUST be captured as a single real page (one filtered
    # size, limit=200, verify meta.last_page == 1 on every recapture) -- NOT the
    # original limit=3 samples. `_all_pages` re-requests the same path for every page
    # number up to meta.last_page, and the path-only fixture_transport mock replays
    # page 1 verbatim on every one of those requests, so a limit=3 capture whose real
    # last_page was e.g. 19-58 silently duplicated its 3 items dozens of times when
    # replayed through tests (reviewer-reproduced: compare_components("radar", 2,
    # limit=10) returned 10x "Agrippa"; quantum_drive's "Aither" was crowded out
    # entirely). filter[size]=<one real size> + limit=200 keeps the whole page in one
    # response so `_all_pages` stops after its first request.
    "wiki_vehicle_items_power_plant_sample.json": f"{WIKI}/vehicle-items?" + urllib.parse.urlencode({"filter[type]": "PowerPlant", "filter[size]": 2, "limit": 200}),
    "wiki_vehicle_items_cooler_sample.json": f"{WIKI}/vehicle-items?" + urllib.parse.urlencode({"filter[type]": "Cooler", "filter[size]": 2, "limit": 200}),
    "wiki_vehicle_items_quantum_drive_sample.json": f"{WIKI}/vehicle-items?" + urllib.parse.urlencode({"filter[type]": "QuantumDrive", "filter[size]": 2, "limit": 200}),
    "wiki_vehicle_items_radar_sample.json": f"{WIKI}/vehicle-items?" + urllib.parse.urlencode({"filter[type]": "Radar", "filter[size]": 2, "limit": 200}),
    "wiki_vehicle_items_weapon_sample.json": f"{WIKI}/vehicle-items?" + urllib.parse.urlencode({"filter[type]": "WeaponGun", "filter[size]": 2, "limit": 200}),
    "wiki_vehicle_items_missile_sample.json": f"{WIKI}/vehicle-items?" + urllib.parse.urlencode({"filter[type]": "Missile", "filter[size]": 9, "limit": 200}),
    # wiki_vehicle_items_weapon_damage_types_sample.json is NOT captured live here --
    # it's a hand-picked 3-item subset (one ballistic/physical, one laser/energy, one
    # distortion weapon) copied verbatim from wiki_vehicle_items_weapon_sample.json,
    # isolated so compare_components' 20-row cap doesn't crop the non-ballistic
    # entries out of the fix-round-1-item-4 DPS-formula verification test.
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
