"""Web-editor data routes: slot options (picker) and the spviewer import
(preview / apply) -- shapes the SPA's src/api/client.ts expects, permissions,
CSRF, caps and the authoritative per-ship reset."""
import copy
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from src.app import create_app
from src.catalog import build_catalog
from src.repository import InMemoryShipRepository
from src.spviewer import MAX_ROWS, MAX_UPLOAD_BYTES
from tests.conftest import HARBINGER_UUID, HEMERA_UUID, TAURUS_UUID, load_fixture, wiki_handler
from tests.test_app import ADMIN, OTHER, SELF, H, cfg, fake_verifier
from tests.test_browser_auth import ADMIN_USER, BROWSER_ENV, ORIGIN, Clock, as_user
from tests.test_spviewer import BRVS, LORICA, NOSE_S2, QD, V801, YEAGER, _port, row_with, stock_loadout

HQD = "hardpoint_quantum_drive"
RADAR = "hardpoint_radar"
SHIELD1 = "hardpoint_shield_generator_001"
REAL_CHANGES = {*NOSE_S2, SHIELD1, "hardpoint_shield_generator_002", RADAR}
WRITE = {"Origin": ORIGIN}


async def _nosleep(_):
    return None


def _catalog(mutate_item=None):
    return build_catalog("https://api.star-citizen.wiki/api", version="test",
                         transport=httpx.MockTransport(wiki_handler(mutate_item=mutate_item)), sleep=_nosleep)


def _make(repo, mutate_item=None, **env):
    return create_app(cfg(**{**BROWSER_ENV, **env}), catalog=_catalog(mutate_item), repository=repo,
                      verifier=fake_verifier, warm=False, clock=Clock())


@pytest.fixture
def repo():
    return InMemoryShipRepository()


@pytest.fixture
def client(repo):
    with TestClient(_make(repo), base_url=ORIGIN, follow_redirects=False) as c:
        yield c


def real_file() -> list:
    return copy.deepcopy(load_fixture("spviewer_harbinger.json"))


def add_ship(c, vehicle="harbinger", member=SELF, nickname=None):
    body = {"vehicle": vehicle, **({"nickname": nickname} if nickname else {})}
    r = c.post(f"/v1/members/{member}/ships", json=body, headers=H(member))
    assert r.status_code == 201, r.text
    return r.json()["ship"]


def fitted_of(c, member, ship_id):
    ships = c.get(f"/v1/members/{member}/hangar", headers=H(None)).json()["ships"]
    return next(s for s in ships if s["shipId"] == ship_id)["fitted"]


# ---------- slot options ----------

def test_slot_options_quantum_drive_sorted_by_key_stat(client):
    as_user(client)
    r = client.get("/api/v1/catalog/slot-options", params={"vehicle": HARBINGER_UUID, "slot": HQD})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 20
    first = items[0]
    assert set(first) == {"uuid", "name", "type", "size", "grade", "class", "keyStat"}   # no price known
    assert first["keyStat"]["name"] == "speed" and first["keyStat"]["lowerIsBetter"] is False
    speeds = [i["keyStat"]["value"] for i in items]
    known = [v for v in speeds if v is not None]
    assert known == sorted(known, reverse=True) and speeds[: len(known)] == known
    assert all(i["type"] == "QuantumDrive" and i["size"] == 2 for i in items)


def test_slot_options_cheapest_price_from_embedded_uex_prices(repo):
    def prices(rec):
        if rec["uuid"] == HEMERA_UUID:
            loc = {"name": "Lorville", "parent_name": "Hurston"}
            rec["uex_prices"] = {"purchase": [
                {"price_buy": 90000, "terminal_name": "Expensive", "starmap_location": loc},
                {"price_buy": 81234, "terminal_name": "Tammany and Sons", "starmap_location": loc},
                {"price_buy": 0, "terminal_name": "Zero is not a price"},
                {"price_buy": "n/a", "terminal_name": "Garbage"},
                "not-a-row"]}
        elif rec["name"] == "Bolon":
            rec["uex_prices"] = {"purchase": "garbage"}
    with TestClient(_make(repo, mutate_item=prices), base_url=ORIGIN) as c:
        items = c.get("/v1/catalog/slot-options", params={"vehicle": HARBINGER_UUID, "slot": HQD},
                      headers=H()).json()["items"]
    hemera = next(i for i in items if i["uuid"] == HEMERA_UUID)
    assert hemera["cheapestPrice"] == {"price": 81234, "shop": "Tammany and Sons", "location": "Lorville, Hurston"}
    assert "cheapestPrice" not in next(i for i in items if i["name"] == "Bolon")


def test_slot_options_shield(client):
    items = client.get("/v1/catalog/slot-options", params={"vehicle": HARBINGER_UUID, "slot": SHIELD1},
                       headers=H()).json()["items"]
    assert [i["uuid"] for i in items] == [LORICA]
    assert items[0]["keyStat"] == {"name": "max_health", "value": 10000, "lowerIsBetter": False}


def test_slot_options_apply_the_sub_type_rule(repo):
    def far(rec):
        if rec["uuid"] == V801:
            rec["sub_type"] = "LongRangeRadar"      # the Harbinger radar slot takes Short/Mid only
    with TestClient(_make(repo), base_url=ORIGIN) as c:
        items = c.get("/v1/catalog/slot-options", params={"vehicle": HARBINGER_UUID, "slot": RADAR},
                      headers=H()).json()["items"]
        assert [i["uuid"] for i in items] == [V801]
        assert items[0]["keyStat"]["name"] == "assignment_range_max"
    with TestClient(_make(repo, mutate_item=far), base_url=ORIGIN) as c:
        assert c.get("/v1/catalog/slot-options", params={"vehicle": HARBINGER_UUID, "slot": RADAR},
                     headers=H()).json()["items"] == []


def test_slot_options_size_filter_excludes_wrong_size(client):
    # nose S5 gun slot: the only listed WeaponGun (BRVS) is size 2
    r = client.get("/v1/catalog/slot-options",
                   params={"vehicle": HARBINGER_UUID, "slot": "hardpoint_weapon_gun_nose/hardpoint_class_2"},
                   headers=H())
    assert r.status_code == 200 and r.json() == {"items": []}
    items = client.get("/v1/catalog/slot-options", params={"vehicle": HARBINGER_UUID, "slot": NOSE_S2[0]},
                       headers=H()).json()["items"]
    assert [i["uuid"] for i in items] == [BRVS] and items[0]["keyStat"]["name"] == "dps"


@pytest.mark.parametrize("params,status", [
    ({}, 400), ({"vehicle": HARBINGER_UUID}, 400), ({"slot": HQD}, 400),
    ({"vehicle": "nope", "slot": HQD}, 404), ({"vehicle": HARBINGER_UUID, "slot": "no_such_slot"}, 404),
    ({"vehicle": "x" * 300, "slot": HQD}, 404),
])
def test_slot_options_errors(client, params, status):
    r = client.get("/v1/catalog/slot-options", params=params, headers=H())
    assert r.status_code == status and r.json()["error"] in ("invalid_request", "not_found")


def test_slot_options_requires_auth(client):
    r = client.get("/api/v1/catalog/slot-options", params={"vehicle": HARBINGER_UUID, "slot": HQD})
    assert r.status_code == 401


# ---------- preview ----------

def test_preview_real_export_with_matching_ships(client):
    mine = add_ship(client, nickname="Harby")
    add_ship(client, vehicle=TAURUS_UUID)
    as_user(client)
    r = client.post("/api/v1/import/spviewer/preview", json={"file": real_file()})
    assert r.status_code == 200, r.text
    rows = r.json()["rows"]
    assert len(rows) == 1
    row = rows[0]
    assert set(row) == {"rowIndex", "loadoutName", "vehicle", "patch", "changes", "skipped", "matchingShips"}
    assert row["rowIndex"] == 0 and row["loadoutName"] == "akira-harbinger"
    assert row["vehicle"] == {"uuid": HARBINGER_UUID, "name": "Vanguard Harbinger"}
    assert {c["slot"] for c in row["changes"]} == REAL_CHANGES
    assert all(s["reason"] == "untracked_slot" for s in row["skipped"])
    assert row["matchingShips"] == [{"shipId": mine["shipId"], "label": "Harby (Vanguard Harbinger)"}]
    assert client.get(f"/v1/members/{SELF}/hangar", headers=H()).json()["ships"][0]["fitted"] == {}  # nothing stored


def test_preview_mixed_rows(client):
    lo = stock_loadout()
    _port(lo, "quantumdrivePorts", QD)["Loadout"] = "QDRV_RSI_S02_Hemera_SCItem"
    bad = row_with(stock_loadout(), loadoutData="%%%")
    unknown = row_with(stock_loadout(), vehicleClassName="NOPE_Ship")
    as_user(client)
    rows = client.post("/api/v1/import/spviewer/preview",
                       json={"file": [row_with(lo), bad, unknown, "junk"]}).json()["rows"]
    assert [r["rowIndex"] for r in rows] == [0, 1, 2, 3]
    assert [c["slot"] for c in rows[0]["changes"]] == [QD]
    assert rows[0]["changes"][0]["from"] == {"uuid": YEAGER, "name": "Yeager"}
    assert [s["reason"] for s in rows[1]["skipped"]] == ["unrecognized_format"]
    assert rows[2]["vehicle"] is None and [s["reason"] for s in rows[2]["skipped"]] == ["unknown_vehicle"]
    assert rows[2]["matchingShips"] == []
    assert rows[3]["vehicle"] is None and rows[3]["skipped"][0]["reason"] == "unrecognized_format"


def test_preview_admin_member_param_and_service_caller(client):
    theirs = add_ship(client, member=OTHER)
    as_user(client, ADMIN_USER)
    r = client.post("/api/v1/import/spviewer/preview", params={"member": OTHER}, json={"file": real_file()})
    assert [m["shipId"] for m in r.json()["rows"][0]["matchingShips"]] == [theirs["shipId"]]
    client.cookies.clear()
    r = client.post("/v1/import/spviewer/preview", json={"file": real_file()}, headers=H(OTHER))
    assert r.status_code == 200 and r.json()["rows"][0]["matchingShips"][0]["shipId"] == theirs["shipId"]
    r = client.post("/v1/import/spviewer/preview", json={"file": real_file()}, headers=H(None))
    assert r.status_code == 400                                # no target member


@pytest.mark.parametrize("body,status,code", [
    ({"file": {"not": "a list"}}, 400, "invalid_request"),
    ({"nofile": []}, 400, "invalid_request"),
    ({"file": [{}] * (MAX_ROWS + 1)}, 413, "too_large"),
    ([1, 2], 400, "invalid_request"),
])
def test_preview_body_validation(client, body, status, code):
    as_user(client)
    r = client.post("/api/v1/import/spviewer/preview", json=body)
    assert r.status_code == status and r.json()["error"] == code


def test_preview_empty_file_and_bad_json(client):
    as_user(client)
    assert client.post("/api/v1/import/spviewer/preview", json={"file": []}).json() == {"rows": []}
    r = client.post("/api/v1/import/spviewer/preview", content=b"{nope", headers={"Content-Type": "application/json"})
    assert r.status_code == 400


def test_preview_upload_cap_413(client):
    as_user(client)
    big = json.dumps({"file": [{"pad": "x" * (MAX_UPLOAD_BYTES + 70 * 1024)}]}).encode()
    r = client.post("/api/v1/import/spviewer/preview", content=big, headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and r.json()["error"] == "too_large"

    def chunks():       # no Content-Length: the streaming cap must still hold
        for _ in range(40):
            yield b" " * (64 * 1024)
    r = client.post("/api/v1/import/spviewer/preview", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_preview_requires_auth(client):
    assert client.post("/api/v1/import/spviewer/preview", json={"file": []}).status_code == 401


# ---------- apply ----------

def _apply(c, rows, file=None, params=None, headers=WRITE):
    return c.post("/api/v1/import/spviewer/apply", params=params, headers=headers,
                  json={"rows": rows, "file": real_file() if file is None else file})


def test_apply_new_ship_from_real_export(client, repo):
    as_user(client)
    assert client.get("/api/v1/members").json()["members"] == []          # primes the directory cache
    r = _apply(client, [{"rowIndex": 0, "mode": "new"}])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["errors"] == []
    (ship,) = body["ships"]
    assert ship["vehicleUuid"] == HARBINGER_UUID and ship["nickname"] == "akira-harbinger"
    assert ship["ownerName"] == "Akira" and ship["updatedBy"] == SELF
    assert set(ship["fitted"]) == REAL_CHANGES
    assert ship["fitted"][RADAR] == {"itemUuid": V801, "itemName": "V801-12"}
    by_slot = {e["slot"]: e for e in ship["loadout"]}
    assert by_slot[SHIELD1]["item"] == {"uuid": LORICA, "name": "7MA 'Lorica'"}
    assert by_slot[SHIELD1]["source"] == "fitted" and by_slot[HQD]["source"] == "stock"
    # directory invalidated by the create
    assert client.get("/api/v1/members").json()["members"][0]["shipCount"] == 1


def test_apply_new_with_nickname(client):
    as_user(client)
    ship = _apply(client, [{"rowIndex": 0, "mode": "new", "nickname": "  Harby  "}]).json()["ships"][0]
    assert ship["nickname"] == "Harby"


def test_apply_existing_is_authoritative(client):
    ship = add_ship(client)
    sid = ship["shipId"]
    r = client.put(f"/v1/members/{SELF}/ships/{sid}/slots/{HQD}", json={"item": HEMERA_UUID}, headers=H())
    assert r.status_code == 200 and HQD in r.json()["ship"]["fitted"]
    as_user(client)
    r = _apply(client, [{"rowIndex": 0, "mode": "existing", "shipId": sid, "changes": [{"slot": HQD}]}])
    assert r.status_code == 200, r.text
    (out,) = r.json()["ships"]
    assert out["shipId"] == sid
    assert set(out["fitted"]) == REAL_CHANGES            # QD reset to stock; client "changes" ignored
    assert set(fitted_of(client, SELF, sid)) == REAL_CHANGES
    assert len(client.get(f"/v1/members/{SELF}/hangar", headers=H()).json()["ships"]) == 1


def test_apply_all_stock_row_resets_existing_ship(client):
    ship = add_ship(client)
    client.put(f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/{HQD}", json={"item": HEMERA_UUID}, headers=H())
    as_user(client)
    r = _apply(client, [{"rowIndex": 0, "mode": "existing", "shipId": ship["shipId"]}],
               file=[row_with(stock_loadout())])
    assert r.json()["ships"][0]["fitted"] == {}


def test_apply_row_errors_do_not_block_other_rows(client):
    taurus = add_ship(client, vehicle=TAURUS_UUID)
    as_user(client)
    file = [real_file()[0], row_with(stock_loadout(), loadoutData="%%%"),
            row_with(stock_loadout(), vehicleClassName="NOPE_Ship"), real_file()[0], real_file()[0]]
    r = _apply(client, [{"rowIndex": 0, "mode": "new"}, {"rowIndex": 1, "mode": "new"},
                        {"rowIndex": 2, "mode": "new"},
                        {"rowIndex": 3, "mode": "existing", "shipId": taurus["shipId"]},
                        {"rowIndex": 4, "mode": "existing", "shipId": "doesnotexist"}], file=file)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["ships"]) == 1
    assert {(e["rowIndex"], e["error"]) for e in body["errors"]} == {
        (1, "unrecognized_format"), (2, "unknown_vehicle"), (3, "vehicle_mismatch"), (4, "not_found")}
    assert all(e["message"] for e in body["errors"])
    assert fitted_of(client, SELF, taurus["shipId"]) == {}


def test_apply_ship_cap(repo):
    with TestClient(_make(repo, HANGAR_MAX_SHIPS_PER_MEMBER="2"), base_url=ORIGIN) as c:
        add_ship(c)
        as_user(c)
        r = _apply(c, [{"rowIndex": 0, "mode": "new"}, {"rowIndex": 1, "mode": "new"}],
                   file=real_file() * 2)
        assert r.status_code == 409
        body = r.json()
        assert (body["error"], body["limit"], body["shipCount"]) == ("limit", 2, 1)
        assert len(c.get(f"/v1/members/{SELF}/hangar", headers=H()).json()["ships"]) == 1
        # existing-mode rows add no ship -> not capped
        sid = c.get(f"/v1/members/{SELF}/hangar", headers=H()).json()["ships"][0]["shipId"]
        assert _apply(c, [{"rowIndex": 0, "mode": "existing", "shipId": sid}]).status_code == 200


@pytest.mark.parametrize("headers", [{}, {"Origin": "https://evil.example"}, {"Referer": "https://evil.example/x"}])
def test_apply_csrf_same_origin_required(client, headers):
    as_user(client)
    r = _apply(client, [{"rowIndex": 0, "mode": "new"}], headers=headers)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    assert client.get(f"/v1/members/{SELF}/hangar", headers=H()).json()["ships"] == []


def test_apply_other_member_forbidden_for_non_admin(client):
    as_user(client)
    r = _apply(client, [{"rowIndex": 0, "mode": "new"}], params={"member": OTHER})
    assert r.status_code == 403
    assert client.get(f"/v1/members/{OTHER}/hangar", headers=H()).json()["ships"] == []


def test_apply_admin_member_param(client):
    as_user(client, ADMIN_USER)
    r = _apply(client, [{"rowIndex": 0, "mode": "new"}], params={"member": OTHER})
    assert r.status_code == 200, r.text
    ship = r.json()["ships"][0]
    assert ship["ownerName"] is None and ship["updatedBy"] == ADMIN       # admin edit leaves ownerName
    assert [s["shipId"] for s in client.get(f"/v1/members/{OTHER}/hangar", headers=H()).json()["ships"]] \
        == [ship["shipId"]]


def test_apply_service_caller(client):
    r = client.post("/v1/import/spviewer/apply", headers=H(SELF),
                    json={"rows": [{"rowIndex": 0, "mode": "new"}], "file": real_file()})
    assert r.status_code == 200 and r.json()["ships"][0]["ownerName"] is None
    r = client.post("/v1/import/spviewer/apply", headers=H(SELF), params={"member": OTHER},
                    json={"rows": [{"rowIndex": 0, "mode": "new"}], "file": real_file()})
    assert r.status_code == 403


@pytest.mark.parametrize("rows", [
    [], "x", [{"rowIndex": 5, "mode": "new"}], [{"rowIndex": -1, "mode": "new"}],
    [{"rowIndex": True, "mode": "new"}], [{"rowIndex": 0, "mode": "merge"}],
    [{"rowIndex": 0, "mode": "existing"}], [{"rowIndex": 0, "mode": "existing", "shipId": "../x"}],
    [{"rowIndex": 0, "mode": "new"}, {"rowIndex": 0, "mode": "new"}],
    [{"rowIndex": 0, "mode": "new", "nickname": "n" * 65}], ["notanobject"],
])
def test_apply_validation(client, rows):
    as_user(client)
    r = _apply(client, rows)
    assert r.status_code == 400 and r.json()["error"] == "invalid_request"
    assert client.get(f"/v1/members/{SELF}/hangar", headers=H()).json()["ships"] == []


def test_apply_requires_auth(client):
    assert _apply(client, [{"rowIndex": 0, "mode": "new"}]).status_code == 401


def test_apply_long_loadout_name_default_nickname_is_capped(client):
    as_user(client)
    row = real_file()[0]
    row["loadoutName"] = "L" * 150
    ship = _apply(client, [{"rowIndex": 0, "mode": "new"}], file=[row]).json()["ships"][0]
    assert ship["nickname"] == "L" * 64


def test_import_routes_on_both_prefixes(client):
    for prefix in ("/v1", "/api/v1"):
        r = client.post(f"{prefix}/import/spviewer/preview", json={"file": []}, headers=H())
        assert r.status_code == 200


# ---------- fix round 1 ----------

def _counting_client(repo, calls):
    # The production 60/min limiter would really wait past 60 calls; the test
    # counts calls instead, so the limiter is effectively unlimited.
    from src.cache import RateLimiter
    from src.catalog import Catalog
    from src.http import UpstreamClient
    upstream = UpstreamClient("wiki", "https://api.star-citizen.wiki/api", {},
                              RateLimiter(1_000_000, 60.0),
                              transport=httpx.MockTransport(wiki_handler(calls)), sleep=_nosleep)
    catalog = Catalog(upstream)
    return TestClient(create_app(cfg(**BROWSER_ENV), catalog=catalog, repository=repo, verifier=fake_verifier,
                                 warm=False, clock=Clock()), base_url=ORIGIN)


def test_item_lookup_budget_fits_inside_the_shared_wiki_rate_limit():
    """The Wiki client's ONE 60/min limiter is shared with every hangar read
    (bot, sc-knowledge, editor): a maximal import must leave headroom, so the
    per-request budget is 32 (about half a minute of the limiter)."""
    from src.spviewer import MAX_ITEM_LOOKUPS
    assert MAX_ITEM_LOOKUPS == 32


def test_upload_cannot_amplify_wiki_item_lookups(repo):
    """100 rows x 12 tracked slots, every one a different random uuid, plus a
    row of 3000 duplicate ports: at most MAX_ITEM_LOOKUPS distinct item calls."""
    from src.spviewer import MAX_ITEM_LOOKUPS
    tracked = [("quantumdrivePorts", QD), ("shieldPorts", SHIELD1), ("radarPorts", RADAR),
               *[("pilotWeaponsPorts", p) for p in NOSE_S2]]
    file, n = [], 0
    for _ in range(MAX_ROWS - 1):
        lo = stock_loadout()
        for cat, path in tracked:
            _port(lo, cat, path)["Loadout"] = f"00000000-0000-4000-8000-{n:012d}"
            n += 1
        file.append(row_with(lo))
    dup = stock_loadout()
    dup["quantumdrivePorts"] = [{"PortName": QD, "Loadout": f"10000000-0000-4000-8000-{i:012d}"}
                                for i in range(3000)]
    file.append(row_with(dup))
    calls = []
    with _counting_client(repo, calls) as c:
        as_user(c)
        r = c.post("/api/v1/import/spviewer/preview", json={"file": file})
    assert r.status_code == 200, r.text
    item_calls = {q.url.path for q in calls if q.url.path.startswith("/api/v2/items/")}
    assert len(item_calls) <= MAX_ITEM_LOOKUPS
    rows = r.json()["rows"]
    reasons = [s["reason"] for row in rows for s in row["skipped"]]
    assert reasons.count("too_many_lookups") == n - MAX_ITEM_LOOKUPS
    assert rows[-1]["skipped"][0]["reason"] == "unrecognized_format"


def test_import_busy_when_concurrency_slots_are_taken(client):
    import asyncio
    sem = client.app.state.import_slots
    taken = 0
    while not sem.locked():                     # occupy every slot (sync access is fine: no waiters)
        sem._value -= 1
        taken += 1
    try:
        as_user(client)
        r = client.post("/api/v1/import/spviewer/preview", json={"file": []})
        assert r.status_code == 503 and r.json()["error"] == "busy"
        r = _apply(client, [{"rowIndex": 0, "mode": "new"}])
        assert r.status_code == 503 and r.json()["error"] == "busy"
    finally:
        sem._value += taken
    assert taken == 2 and isinstance(sem, asyncio.Semaphore)
    assert client.post("/api/v1/import/spviewer/preview", json={"file": []}).status_code == 200
    # a request that failed inside the slot releases it
    assert client.post("/api/v1/import/spviewer/preview", json={"file": "x"}).status_code == 400
    assert not sem.locked() and sem._value == 2


def test_deeply_nested_body_is_400(client):
    as_user(client)
    deep = b'{"file": ' + b"[" * 100_000 + b"]" * 100_000 + b"}"
    r = client.post("/api/v1/import/spviewer/preview", content=deep, headers={"Content-Type": "application/json"})
    assert r.status_code == 400 and r.json()["error"] == "invalid_request"


# ---------- security re-review: never write a partially analysed row ----------

def _random_tracked(n0: int) -> tuple[dict, int]:
    """A stock loadout whose 7 tracked ports each hold a distinct random uuid."""
    lo, n = stock_loadout(), n0
    for cat, path in [("quantumdrivePorts", QD), ("shieldPorts", SHIELD1), ("radarPorts", RADAR),
                      *[("pilotWeaponsPorts", p) for p in NOSE_S2]]:
        _port(lo, cat, path)["Loadout"] = f"20000000-0000-4000-8000-{n:012d}"
        n += 1
    return lo, n


def test_apply_row_over_the_lookup_budget_is_not_written(client):
    """Authoritative replace_fitted would reset the un-looked-up slots to stock
    and wipe the ship's existing fittings: such a row is an error instead."""
    from src.spviewer import MAX_ITEM_LOOKUPS
    ship = add_ship(client)
    sid = ship["shipId"]
    client.put(f"/v1/members/{SELF}/ships/{sid}/slots/{HQD}", json={"item": HEMERA_UUID}, headers=H())
    before = fitted_of(client, SELF, sid)
    assert HQD in before
    file, n = [], 0
    while n <= MAX_ITEM_LOOKUPS:            # enough rows to spend the budget before the last one
        lo, n = _random_tracked(n)
        file.append(row_with(lo))
    file.append(real_file()[0])            # needs 3 more lookups -> over budget
    as_user(client)
    rows = [{"rowIndex": i, "mode": "new"} for i in range(len(file) - 1)]
    rows.append({"rowIndex": len(file) - 1, "mode": "existing", "shipId": sid})
    r = _apply(client, rows, file=file)
    assert r.status_code == 200, r.text
    errs = {e["rowIndex"]: e for e in r.json()["errors"]}
    last = errs[len(file) - 1]
    assert last == {"rowIndex": len(file) - 1, "error": "too_many_lookups",
                    "message": "Too many different items across this import — apply fewer loadouts at once"}
    assert fitted_of(client, SELF, sid) == before            # existing fittings intact
    assert sid not in {s["shipId"] for s in r.json()["ships"]}


def test_apply_row_with_an_unknown_selection_category_is_not_written(client):
    ship = add_ship(client)
    sid = ship["shipId"]
    client.put(f"/v1/members/{SELF}/ships/{sid}/slots/{HQD}", json={"item": HEMERA_UUID}, headers=H())
    before = fitted_of(client, SELF, sid)
    lo = stock_loadout()
    lo["selectedWarpCores"] = {"0-hardpoint_warp": {"className": "X", "reference": YEAGER}}
    as_user(client)
    pv = client.post("/api/v1/import/spviewer/preview", json={"file": [row_with(lo)]}).json()["rows"][0]
    assert {"reason": "unrecognized_format",
            "detail": "unknown selection category selectedWarpCores"} in pv["skipped"]
    r = _apply(client, [{"rowIndex": 0, "mode": "existing", "shipId": sid}], file=[row_with(lo)])
    assert r.status_code == 200, r.text
    assert r.json()["ships"] == []
    assert r.json()["errors"][0]["error"] == "unrecognized_format"
    assert fitted_of(client, SELF, sid) == before


def test_import_body_is_read_before_taking_a_concurrency_slot(client):
    """A slow upload must not hold an import slot: the body is read (and
    capped) first, so with every slot taken an oversized or malformed body
    gets its own error rather than ``busy``."""
    sem = client.app.state.import_slots
    taken = 0
    while not sem.locked():
        sem._value -= 1
        taken += 1
    try:
        as_user(client)
        big = b'{"file": "' + b"x" * (MAX_UPLOAD_BYTES + 128 * 1024) + b'"}'
        r = client.post("/api/v1/import/spviewer/preview", content=big,
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 413
        r = client.post("/api/v1/import/spviewer/apply", content=b"{nope", headers={**WRITE,
                        "Content-Type": "application/json"})
        assert r.status_code == 400
        assert client.post("/api/v1/import/spviewer/preview", json={"file": []}).json()["error"] == "busy"
    finally:
        sem._value += taken
