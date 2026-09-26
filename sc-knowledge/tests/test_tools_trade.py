from src.cache import TTLCache
from src.config import load
from src.tools_trade import TradeTools, _row
from src.uex import build_uex
from tests.conftest import fixture_transport


def _tools():
    uex = build_uex(load(), transport=fixture_transport({
        "/2.0/terminals": "uex_terminals.json",
        "/2.0/commodities_routes": "uex_routes_mic_l5.json",
        "/2.0/commodities_prices": "uex_commodity_prices_79.json",
        "/2.0/commodities": "uex_commodities.json",
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


def commodity_name_for_79():
    from tests.conftest import load_fixture
    return next(c["name"] for c in load_fixture("uex_commodities.json")["data"] if c["id"] == 79)
