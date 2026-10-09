"""Catalog: Wiki client + 12h stale-on-error cache, against the fake Wiki."""
import httpx
import pytest

from src.cache import TTLCache
from src.catalog import CATALOG_TTL_S, Catalog, build_catalog
from src.http import UpstreamError
from tests.conftest import (HARBINGER_UUID, HEMERA_UUID, TAURUS_SLUG, TAURUS_UUID,
                            wiki_handler)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


async def _nosleep(_):
    return None


def _catalog(calls=None, fail=None, clock=None) -> Catalog:
    cache = TTLCache(clock=clock) if clock else None
    return build_catalog("https://api.star-citizen.wiki/api", version="test",
                         transport=httpx.MockTransport(wiki_handler(calls, fail)),
                         cache=cache, sleep=_nosleep)


def test_ttl_is_12_hours():
    assert CATALOG_TTL_S == 12 * 3600


async def test_vehicle_by_slug_and_uuid():
    c = _catalog()
    by_slug = await c.vehicle(TAURUS_SLUG)
    by_uuid = await c.vehicle(TAURUS_UUID)
    assert by_slug["uuid"] == by_uuid["uuid"] == TAURUS_UUID
    assert by_slug["name"] == "Constellation Taurus"


async def test_unknown_vehicle_is_none():
    c = _catalog()
    assert await c.vehicle("no-such-ship") is None
    assert await c.slots("no-such-ship") is None


async def test_slots_for_vehicle_uuid():
    c = _catalog()
    slots = await c.slots(TAURUS_UUID)
    names = {s.name for s in slots}
    assert "hardpoint_quantum_drive" in names
    assert "hardpoint_gun_laser_top_left/hardpoint_class_2" in names


async def test_vehicle_detail_is_cached():
    calls = []
    c = _catalog(calls)
    await c.vehicle(TAURUS_UUID)
    await c.slots(TAURUS_UUID)
    await c.vehicle(TAURUS_UUID)
    assert sum(1 for r in calls if r.url.path.startswith("/api/vehicles/")) == 1


async def test_vehicle_stale_on_error_after_ttl():
    clk = Clock()
    down = {"on": False}
    c = _catalog(fail=lambda r: down["on"], clock=clk)
    assert (await c.vehicle(TAURUS_UUID))["name"] == "Constellation Taurus"
    clk.t += CATALOG_TTL_S + 1
    down["on"] = True
    assert (await c.vehicle(TAURUS_UUID))["name"] == "Constellation Taurus"  # stale served


async def test_upstream_failure_with_nothing_cached_raises():
    c = _catalog(fail=lambda r: True)
    with pytest.raises(UpstreamError):
        await c.vehicle(TAURUS_UUID)


async def test_vehicle_index_pages_through_all_vehicles_once():
    calls = []
    c = _catalog(calls)
    idx = await c.vehicle_index()
    assert len(idx) == 299
    assert all(set(v) == {"uuid", "name", "gameName", "slug", "className", "manufacturer"} for v in idx)
    await c.vehicle_index()
    assert sum(1 for r in calls if r.url.path == "/api/vehicles") == 6


async def test_search_vehicles_ranks_and_limits():
    c = _catalog()
    res = await c.search_vehicles("constellation")
    names = [v["name"] for v in res]
    assert {"Constellation Taurus", "Constellation Andromeda", "Constellation Aquila"} <= set(names)
    assert all(n.startswith("Constellation") for n in names[:6])
    assert len(await c.search_vehicles("aegis", limit=5)) == 5
    assert len(await c.search_vehicles("", limit=100)) == 25  # capped at 25


async def test_search_vehicles_harbinger_first():
    c = _catalog()
    res = await c.search_vehicles("harbinger")
    assert res[0]["uuid"] == HARBINGER_UUID


async def test_search_vehicles_typo_tolerant():
    c = _catalog()
    res = await c.search_vehicles("constelation taurus")
    assert res[0]["name"] == "Constellation Taurus"


async def test_resolve_vehicle_via_catalog():
    c = _catalog()
    r = await c.resolve_vehicle("Vanguard Harbinger")
    assert r.status == "match" and r.match["uuid"] == HARBINGER_UUID
    r = await c.resolve_vehicle("taurus")
    assert r.status == "ambiguous"
    assert {v["name"] for v in r.candidates} == {"Constellation Taurus", "Constellation Taurus Wikelo War Special"}
    r = await c.resolve_vehicle(TAURUS_UUID)
    assert r.status == "match" and r.match["uuid"] == TAURUS_UUID


async def test_items_by_type_and_size():
    calls = []
    c = _catalog(calls)
    items = await c.items("QuantumDrive", size=2)
    names = [i["name"] for i in items]
    assert "Hemera" in names and "Bolon" in names
    assert names == sorted(names, key=str.casefold)
    assert all(i["type"] == "QuantumDrive" and i["size"] == 2 for i in items)
    req = [r for r in calls if r.url.path == "/api/v2/items"][0]
    assert req.url.params["filter[type]"] == "QuantumDrive" and req.url.params["filter[size]"] == "2"


async def test_items_query_filters_locally_and_shares_cache():
    calls = []
    c = _catalog(calls)
    assert [i["name"] for i in await c.items("QuantumDrive", size=2, q="hem")] == ["Hemera"]
    await c.items("QuantumDrive", size=2, q="bol")
    assert sum(1 for r in calls if r.url.path == "/api/v2/items") == 1


async def test_items_unknown_type_is_empty():
    c = _catalog()
    assert await c.items("Shield", size=9) == []


async def test_item_lookup():
    c = _catalog()
    it = await c.item(HEMERA_UUID)
    assert (it["name"], it["type"], it["size"]) == ("Hemera", "QuantumDrive", 2)
    assert await c.item("nope") is None
