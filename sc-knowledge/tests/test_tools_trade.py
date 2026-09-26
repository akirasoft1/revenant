import httpx

from src.cache import TTLCache
from src.config import load
from src.tools_trade import MAX_ORIGIN_TERMINALS, TradeTools, _row
from src.uex import build_uex
from tests.conftest import fixture_transport, load_fixture


def _tools():
    uex = build_uex(load(), transport=fixture_transport({
        "/2.0/terminals": "uex_terminals.json",
        "/2.0/commodities_routes": "uex_routes_mic_l5.json",
        "/2.0/commodities_prices": "uex_commodity_prices_79.json",
        "/2.0/commodities": "uex_commodities.json",
        "/2.0/game_versions": "uex_game_versions.json",
    }))
    return TradeTools(uex, TTLCache())


async def test_routes_from_mic_l5_sorted_and_profitable():
    r = await _tools().trade_routes("MIC-L5", limit=5)
    assert r["routes"], r
    totals = [x["total_profit"] for x in r["routes"]]
    assert totals == sorted(totals, reverse=True) and all(x["profit_per_scu"] > 0 for x in r["routes"])
    assert any("UEX" in n for n in r["notes"])


async def test_cargo_and_budget_cap_total_profit():
    t = _tools()
    r = await t.trade_routes("MIC-L5", cargo_scu=10, budget_auec=1_000_000, limit=3)
    for x in r["routes"]:
        assert x["scu_traded"] <= 10
        assert x["investment"] <= 1_000_000
        assert x["total_profit"] == x["profit_per_scu"] * x["scu_traded"]


async def test_lawless_flag_for_pyro():
    r = await _tools().trade_routes("MIC-L5", limit=50)
    pyro = [x for x in r["routes"] if "Pyro" in (x["sell_location"] + x["buy_location"])]
    assert all(x["lawless"] for x in pyro)


def test_row_lawless_flag_synthetic():
    """Module-level _row() unit test (fixture caveat): a synthetic route with a
    Pyro destination must be flagged lawless regardless of whether the MIC-L5
    fixture itself happens to contain a profitable Pyro-bound route."""
    route = {
        "id": 999999,
        "price_origin": 10,
        "price_destination": 20,
        "scu_origin": 100,
        "scu_destination": 100,
        "scu_reachable": 50,
        "distance": 1,
        "date_added": 1700000000,
        "commodity_name": "Test Widget",
        "origin_terminal_name": "Origin Term",
        "origin_planet_name": "Somewhere",
        "origin_star_system_name": "Stanton",
        "destination_terminal_name": "Dest Term",
        "destination_planet_name": "Pyro I",
        "destination_star_system_name": "Pyro",
    }
    row = _row(route, cargo_scu=None, budget_auec=None)
    assert row is not None
    assert row["lawless"] is True


def test_row_drops_non_profitable_route():
    route = {"id": 1, "price_origin": 100, "price_destination": 90, "scu_origin": 5, "scu_destination": 5}
    assert _row(route, None, None) is None


def test_row_uses_scu_reachable_when_no_caps_given():
    route = {
        "id": 1, "price_origin": 10, "price_destination": 20,
        "scu_origin": 500, "scu_destination": 500, "scu_reachable": 3,
        "date_added": 1700000000,
    }
    row = _row(route, cargo_scu=None, budget_auec=None)
    assert row["scu_traded"] == 3
    assert row["total_profit"] == 10 * 3


async def test_unknown_origin():
    r = await _tools().trade_routes("Zzqq Station")
    assert r["error"] in ("not_found", "ambiguous")


async def test_routes_deduped_by_id():
    """fixture_transport routes /2.0/commodities_routes to the MIC-L5 fixture for
    ANY origin id. If origin resolution ever yielded several terminals, the same
    43 routes would repeat unless de-duplicated by route id after concatenation."""
    r = await _tools().trade_routes("MIC-L5", limit=100)
    from tests.conftest import load_fixture
    total_routes = len(load_fixture("uex_routes_mic_l5.json")["data"])
    # Even at limit=100 we must never see more surviving rows than raw routes,
    # and no commodity/buy/sell combination should be duplicated verbatim.
    assert len(r["routes"]) <= total_routes
    seen = set()
    for row in r["routes"]:
        key = (row["commodity"], row["buy_at"], row["sell_at"], row["buy_price"], row["sell_price"])
        assert key not in seen, f"duplicate route surfaced: {key}"
        seen.add(key)


async def test_routes_deduped_across_multiple_origin_terminals():
    """Fix-round-1 #2: "MIC-L5" resolves to exactly ONE commodity terminal
    (uniquely, via the primary index), so the dedup-by-id path above is never
    actually exercised across multiple origin terminals. "L1" resolves via the
    R2 location/name fallback to 6 commodity terminals (ARC-L1, CRU-L1, HUR-L1,
    MIC-L1, and two "Platinum Bay - *-L1" shops) -- more than one, but within
    Fix-round-2's MAX_ORIGIN_TERMINALS cap (so this stays a normal dedup case,
    not a too_broad one; "Nyx" (13) and "Stanton" (121) now exceed the cap --
    see the too_broad tests below). fixture_transport serves the SAME 43-route
    MIC-L5 fixture for any origin id, so without de-duplication after
    concatenation, routes would repeat once per origin terminal."""
    total_routes = len(load_fixture("uex_routes_mic_l5.json")["data"])
    r = await _tools().trade_routes("L1", limit=1000)
    assert 1 < r["origin_terminal_count"] <= MAX_ORIGIN_TERMINALS, r
    assert len(r["routes"]) <= total_routes
    seen_ids = set()
    for row in r["routes"]:
        key = (row["commodity"], row["buy_at"], row["sell_at"], row["buy_price"], row["sell_price"])
        assert key not in seen_ids, f"duplicate route surfaced: {key}"
        seen_ids.add(key)


async def test_too_broad_origin_makes_no_route_calls():
    """Fix-round-2: "Stanton" resolves to 121 commodity terminals -- well over
    MAX_ORIGIN_TERMINALS. trade_routes must refuse before making a single
    commodities_routes call (that fan-out is exactly what stalled ~60s against
    the UEX rate limiter), returning "too_broad" with candidate location names
    instead."""
    calls = {"routes": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path.startswith("/2.0/commodities_routes"):
            calls["routes"] += 1
            return httpx.Response(200, json=load_fixture("uex_routes_mic_l5.json"))
        if path.startswith("/2.0/terminals"):
            return httpx.Response(200, json=load_fixture("uex_terminals.json"))
        if path.startswith("/2.0/commodities"):
            return httpx.Response(200, json=load_fixture("uex_commodities.json"))
        return httpx.Response(404, json={"status": "not_found"})

    uex = build_uex(load(), transport=httpx.MockTransport(handler))
    t = TradeTools(uex, TTLCache())
    r = await t.trade_routes("Stanton", limit=5)
    assert r.get("error") == "too_broad", r
    assert r["candidates"], r
    assert len(r["candidates"]) <= 10
    assert calls["routes"] == 0


async def test_partial_origin_failure_returns_routes_and_note():
    """Fix-round-2: one of "L1"'s 6 resolved origin terminals fails upstream
    (simulated 503); the others still succeed, so trade_routes must return
    the successful routes plus a notes line naming the failure count, not
    fail the whole call."""
    fail_id = 1  # "Admin - ARC-L1", one of the "L1" fallback matches

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path.startswith("/2.0/commodities_routes"):
            if req.url.params.get("id_terminal_origin") == str(fail_id):
                return httpx.Response(503, json={"status": "error"})
            return httpx.Response(200, json=load_fixture("uex_routes_mic_l5.json"))
        if path.startswith("/2.0/terminals"):
            return httpx.Response(200, json=load_fixture("uex_terminals.json"))
        if path.startswith("/2.0/commodities"):
            return httpx.Response(200, json=load_fixture("uex_commodities.json"))
        return httpx.Response(404, json={"status": "not_found"})

    uex = build_uex(load(), transport=httpx.MockTransport(handler))
    t = TradeTools(uex, TTLCache())
    r = await t.trade_routes("L1", limit=50)
    assert r["routes"], r
    assert any("1" in n and "failed" in n.lower() for n in r["notes"]), r["notes"]


async def test_all_origins_failing_is_uex_unavailable():
    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path.startswith("/2.0/commodities_routes"):
            return httpx.Response(503, json={"status": "error"})
        if path.startswith("/2.0/terminals"):
            return httpx.Response(200, json=load_fixture("uex_terminals.json"))
        if path.startswith("/2.0/commodities"):
            return httpx.Response(200, json=load_fixture("uex_commodities.json"))
        return httpx.Response(404, json={"status": "not_found"})

    uex = build_uex(load(), transport=httpx.MockTransport(handler))
    t = TradeTools(uex, TTLCache())
    r = await t.trade_routes("L1", limit=50)
    assert r.get("error") == "uex_unavailable", r


async def test_l1_fallback_excludes_l19_residences():
    """Fix-round-1 #1: raw substring matching let "l1" match "l19" (from "Admin
    - L19 Residences - Metro Center - Lorville") because "l1" is literally a
    substring of "l19". Token-boundary matching must not do that."""
    t = _tools()
    idx = await t._index()
    commodity_terminals = [x for x in await t._terminals() if x.get("type") == "commodity"]
    terminals, label, err, cands = t._resolve_terminal("L1", idx, commodity_terminals)
    assert terminals is not None, (label, err, cands)
    names = {x.get("name") for x in terminals}
    assert not any("L19" in n for n in names), names
    assert names & {"Admin - ARC-L1", "Admin - CRU-L1", "Admin - HUR-L1", "Admin - MIC-L1"}


async def test_micl5_still_resolves_to_terminal_58():
    t = _tools()
    idx = await t._index()
    commodity_terminals = [x for x in await t._terminals() if x.get("type") == "commodity"]
    terminals, label, err, cands = t._resolve_terminal("micl5", idx, commodity_terminals)
    assert terminals is not None, (label, err, cands)
    assert any(x.get("id") == 58 for x in terminals)


async def test_commodity_prices_sell_side_sorted_desc():
    r = await _tools().commodity_prices(commodity_name_for_79(), side="sell")
    prices = [x["price"] for x in r["terminals"]]
    assert prices == sorted(prices, reverse=True)
    assert r["terminals"], r
    assert "scu_demand" in r["terminals"][0]


async def test_commodity_prices_buy_side_sorted_asc():
    r = await _tools().commodity_prices(commodity_name_for_79(), side="buy")
    prices = [x["price"] for x in r["terminals"]]
    assert prices == sorted(prices)
    assert r["terminals"], r
    assert "scu_stock" in r["terminals"][0]


async def test_commodity_prices_unknown_commodity():
    r = await _tools().commodity_prices("Zzqq Not A Commodity")
    assert r["error"] in ("not_found", "ambiguous")


async def test_commodity_prices_location_filter():
    """Fix-round-1 #4."""
    from tests.conftest import load_fixture
    rows = load_fixture("uex_commodity_prices_79.json")["data"]
    planet = next(r["planet_name"] for r in rows if r.get("planet_name"))
    expected = {r["terminal_name"] for r in rows if r.get("planet_name") == planet}

    r = await _tools().commodity_prices(commodity_name_for_79(), location=planet, side="sell", limit=50)
    assert r["terminals"], r
    assert {t["terminal"] for t in r["terminals"]} <= expected
    assert all(t["price"] > 0 for t in r["terminals"])


async def test_commodity_prices_location_filter_game_version_fallback():
    """Fix-round-1 #3: a location filter that empties an otherwise non-empty
    result must not leave game_version as None -- fall back to
    game_versions()['live']."""
    r = await _tools().commodity_prices(commodity_name_for_79(), location="Zzqq Nowhere Place")
    assert r["terminals"] == []
    assert r["game_version"] == "4.10.1"


def commodity_name_for_79():
    from tests.conftest import load_fixture
    return next(c["name"] for c in load_fixture("uex_commodities.json")["data"] if c["id"] == 79)
