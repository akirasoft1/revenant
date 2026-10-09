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


# ---------- fix round 1 ----------
import asyncio  # noqa: E402

from src.catalog import NEGATIVE_TTL_S, UnknownItemType, normalize_item_type  # noqa: E402
from tests.conftest import TAURUS_UUID as _T  # noqa: E402,F401


def _cat_spawn(calls=None, fail=None, clock=None, spawned=None, **kw):
    cache = TTLCache(clock=clock) if clock else None
    def spawn(coro):
        t = asyncio.ensure_future(coro)
        if spawned is not None:
            spawned.append(t)
        return t
    return build_catalog("https://api.star-citizen.wiki/api", version="test",
                         transport=httpx.MockTransport(wiki_handler(calls, fail)),
                         cache=cache, sleep=_nosleep, spawn=spawn, **kw)


def _n(calls, pred):
    return sum(1 for r in calls if pred(r))


async def test_not_found_vehicle_cached_only_short_ttl():
    clk, calls = Clock(), []
    c = _cat_spawn(calls, clock=clk)
    is_q = lambda r: r.url.path == "/api/vehicles/no-such-ship"  # noqa: E731
    assert await c.vehicle("no-such-ship") is None
    clk.t += NEGATIVE_TTL_S - 1
    assert await c.vehicle("no-such-ship") is None
    assert _n(calls, is_q) == 1
    clk.t += 2
    assert await c.vehicle("no-such-ship") is None
    assert _n(calls, is_q) == 2


async def test_not_found_item_and_empty_item_list_use_short_ttl():
    clk, calls = Clock(), []
    c = _cat_spawn(calls, clock=clk)
    assert await c.item("nope") is None
    assert await c.items("Shield", size=9) == []
    clk.t += NEGATIVE_TTL_S + 1
    await c.item("nope")
    await c.items("Shield", size=9)
    assert _n(calls, lambda r: r.url.path == "/api/v2/items/nope") == 2
    assert _n(calls, lambda r: r.url.path == "/api/v2/items") == 2


async def test_found_results_keep_long_ttl():
    clk, calls = Clock(), []
    c = _cat_spawn(calls, clock=clk)
    await c.item(HEMERA_UUID)
    await c.items("QuantumDrive", size=2)
    clk.t += NEGATIVE_TTL_S + 1
    await c.item(HEMERA_UUID)
    await c.items("QuantumDrive", size=2)
    assert _n(calls, lambda r: r.url.path.startswith("/api/v2/items")) == 2


def test_negative_ttl_is_ten_minutes():
    assert NEGATIVE_TTL_S == 600


def test_normalize_item_type():
    assert normalize_item_type("quantumdrive") == "QuantumDrive"
    assert normalize_item_type(" SHIELD ") == "Shield"
    for bad in ("Paints", "", "QuantumDrive; drop", None):
        with pytest.raises(UnknownItemType):
            normalize_item_type(bad)


async def test_items_normalises_type_and_shares_cache_key():
    calls = []
    c = _cat_spawn(calls)
    a = await c.items("quantumdrive", size=2)
    b = await c.items("QuantumDrive", size=2)
    assert a == b and len(a) == 20
    assert _n(calls, lambda r: r.url.path == "/api/v2/items") == 1
    req = [r for r in calls if r.url.path == "/api/v2/items"][0]
    assert req.url.params["filter[type]"] == "QuantumDrive"


async def test_items_unknown_type_raises_without_upstream_call():
    calls = []
    c = _cat_spawn(calls)
    with pytest.raises(UnknownItemType):
        await c.items("Paints")
    assert calls == []
    assert issubclass(UnknownItemType, ValueError)


async def test_overlong_free_text_keys_do_not_reach_upstream():
    calls = []
    c = _cat_spawn(calls)
    assert await c.item("x" * 500) is None
    assert await c.vehicle("y" * 500) is None
    assert calls == []


async def test_free_text_lookup_keys_are_lru_bounded():
    calls = []
    c = _cat_spawn(calls, max_lookup_keys=3)
    for k in ("a", "b", "c", "d"):
        await c.item(k)
    await c.item("d")      # still cached
    await c.item("a")      # evicted -> refetched
    assert _n(calls, lambda r: r.url.path == "/api/v2/items/d") == 1
    assert _n(calls, lambda r: r.url.path == "/api/v2/items/a") == 2
    assert c.lookup_key_count() <= 3


async def test_vehicle_index_stale_while_revalidate_single_flight():
    clk, calls, spawned = Clock(), [], []
    c = _cat_spawn(calls, clock=clk, spawned=spawned)
    await c.vehicle_index()
    clk.t += CATALOG_TTL_S + 1
    a = await c.vehicle_index()   # stale served immediately
    b = await c.vehicle_index()   # refresh already in flight -> not spawned again
    assert len(a) == len(b) == 299
    assert len(spawned) == 1
    await c.drain_refreshes()
    assert _n(calls, lambda r: r.url.path == "/api/vehicles") == 12  # 6 pages x 2
    await c.vehicle_index()       # fresh again: no new refresh
    assert len(spawned) == 1


async def test_vehicle_detail_stale_while_revalidate_and_refresh_failure_keeps_stale():
    clk, spawned = Clock(), []
    down = {"on": False}
    c = _cat_spawn(fail=lambda r: down["on"], clock=clk, spawned=spawned)
    await c.vehicle(TAURUS_UUID)
    clk.t += CATALOG_TTL_S + 1
    down["on"] = True
    assert (await c.vehicle(TAURUS_UUID))["name"] == "Constellation Taurus"
    await c.drain_refreshes()   # background refresh failed; logged, not raised
    assert (await c.vehicle(TAURUS_UUID))["name"] == "Constellation Taurus"


async def test_warm_loads_index_and_never_raises():
    calls = []
    c = _cat_spawn(calls)
    await c.warm()
    assert _n(calls, lambda r: r.url.path == "/api/vehicles") == 6
    broken = _cat_spawn(fail=lambda r: True)
    await broken.warm()  # logged, not raised


async def test_slots_returned_are_copies():
    c = _cat_spawn()
    s1 = await c.slots(TAURUS_UUID)
    s1[0].compatible_types.append({"type": "Junk", "sub_types": []})
    s1[0].stock_item["name"] = "corrupted"
    s1.clear()
    s2 = await c.slots(TAURUS_UUID)
    assert len(s2) == 17
    assert all(ct["type"] != "Junk" for ct in s2[0].compatible_types)
    assert s2[0].stock_item["name"] != "corrupted"


# ---------- task 2: background-refresh bookkeeping is pruned ----------

async def test_finished_background_refresh_is_pruned():
    clk, spawned = Clock(), []
    c = _cat_spawn(clock=clk, spawned=spawned)
    await c.vehicle_index()
    await c.vehicle(TAURUS_UUID)
    clk.t += CATALOG_TTL_S + 1
    await c.vehicle_index()
    await c.vehicle(TAURUS_UUID)
    assert c.pending_refreshes() == 2
    await c.drain_refreshes()
    assert c.pending_refreshes() == 0


async def test_failed_background_refresh_is_pruned_too():
    clk = Clock()
    down = {"on": False}
    c = _cat_spawn(fail=lambda r: down["on"], clock=clk)
    await c.vehicle(TAURUS_UUID)
    clk.t += CATALOG_TTL_S + 1
    down["on"] = True
    await c.vehicle(TAURUS_UUID)
    assert c.pending_refreshes() == 1
    await c.drain_refreshes()
    assert c.pending_refreshes() == 0


async def test_lru_eviction_drops_and_cancels_the_keys_refresh():
    from tests.conftest import HARBINGER_UUID
    clk, spawned = Clock(), []
    c = _cat_spawn(clock=clk, spawned=spawned, max_lookup_keys=1)
    await c.vehicle(TAURUS_UUID)
    clk.t += CATALOG_TTL_S + 1
    await c.vehicle(TAURUS_UUID)          # stale -> refresh spawned, not yet run
    assert c.pending_refreshes() == 1
    await c.vehicle(HARBINGER_UUID)       # evicts the Taurus key
    assert c.pending_refreshes() == 0
    await asyncio.sleep(0)
    assert spawned[0].cancelled()
    assert c.lookup_key_count() == 1


def test_index_cached_flag_is_a_pure_peek():
    c = _cat_spawn()
    assert c.vehicle_index_cached() is False


async def test_index_cached_flag_true_after_warm():
    c = _cat_spawn()
    await c.warm()
    assert c.vehicle_index_cached() is True
