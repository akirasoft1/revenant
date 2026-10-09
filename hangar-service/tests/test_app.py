"""HTTP API: every route's happy + error paths, auth, and error envelopes."""
import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from src.app import create_app
from src.auth import AuthError, AuthUnavailable
from src.catalog import Slot, build_catalog
from src.config import load
from src.repository import InMemoryShipRepository
from tests.conftest import HARBINGER_UUID, HEMERA_UUID, TAURUS_UUID, wiki_handler

AUD = "https://hangar-service-xyz-uc.a.run.app"
CALLER = "hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com"
SELF, OTHER, ADMIN = "111", "222", "999"
TAURUS_QD = "hardpoint_quantum_drive"


async def _nosleep(_):
    return None


def fake_verifier(token, audience):
    table = {
        "good": {"aud": AUD, "email": CALLER, "email_verified": True},
        "wrong-aud": {"aud": "https://other.run.app", "email": CALLER, "email_verified": True},
        "intruder": {"aud": AUD, "email": "intruder@evil.iam.gserviceaccount.com", "email_verified": True},
        "unverified": {"aud": AUD, "email": CALLER, "email_verified": False},
    }
    if token == "certs-down":
        raise AuthUnavailable("could not fetch Google certs")
    claims = table.get(token)
    if claims is None:
        raise AuthError("invalid token")
    if claims["aud"] != audience:
        raise AuthError(f"wrong audience {claims['aud']!r}")
    return claims


def cfg(**env):
    base = {"HANGAR_AUDIENCE": AUD, "HANGAR_ADMIN_IDS": ADMIN, "HANGAR_ALLOWED_CALLERS": CALLER}
    base.update(env)
    return load(base)


def make_catalog(calls=None, fail=None):
    return build_catalog("https://api.star-citizen.wiki/api", version="test",
                         transport=httpx.MockTransport(wiki_handler(calls, fail)), sleep=_nosleep)


@pytest.fixture
def wiki_calls():
    return []


@pytest.fixture
def repo():
    return InMemoryShipRepository()


@pytest.fixture
def client(repo, wiki_calls):
    app = create_app(cfg(), catalog=make_catalog(wiki_calls), repository=repo,
                     verifier=fake_verifier, warm=False)
    with TestClient(app) as c:
        yield c


def H(acting: str | None = SELF, token: str = "good") -> dict:
    h = {"Authorization": f"Bearer {token}"}
    if acting is not None:
        h["X-Acting-Member"] = acting
    return h


def add_ship(client, vehicle="harbinger", member=SELF, nickname=None, acting=None):
    body = {"vehicle": vehicle}
    if nickname is not None:
        body["nickname"] = nickname
    r = client.post(f"/v1/members/{member}/ships", json=body, headers=H(acting or member))
    assert r.status_code == 201, r.text
    return r.json()["ship"]


# ---------- /healthz ----------

def test_healthz_unauthenticated_and_no_upstream_calls(client, wiki_calls):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["vehicleIndexCached"] is False
    assert "version" in body
    assert wiki_calls == []


# ---------- authentication ----------

@pytest.mark.parametrize("headers", [
    {},                                                    # missing
    {"Authorization": "Bearer nope"},                      # invalid
    {"Authorization": "Bearer wrong-aud"},                 # wrong audience
    {"Authorization": "Bearer intruder"},                  # email not allow-listed
    {"Authorization": "Bearer unverified"},                # email_verified false
    {"Authorization": "Basic Zm9vOmJhcg=="},               # not a bearer
])
@pytest.mark.parametrize("method,path", [
    ("GET", f"/v1/members/{SELF}/hangar"),
    ("GET", "/v1/catalog/vehicles?q=harbinger"),
    ("GET", f"/v1/catalog/vehicles/{TAURUS_UUID}/slots"),
    ("GET", "/v1/catalog/items?type=QuantumDrive"),
    ("POST", f"/v1/members/{SELF}/ships"),
    ("PATCH", f"/v1/members/{SELF}/ships/abc"),
    ("DELETE", f"/v1/members/{SELF}/ships/abc"),
    ("PUT", f"/v1/members/{SELF}/ships/abc/slots/x"),
    ("DELETE", f"/v1/members/{SELF}/ships/abc/slots/x"),
    ("POST", f"/v1/members/{SELF}/fit"),
    ("POST", f"/v1/members/{SELF}/ships/abc/reset"),
    ("GET", "/v1/members"),
    # the browser aliases (same handlers under /api)
    ("GET", f"/api/v1/members/{SELF}/hangar"),
    ("GET", "/api/v1/catalog/vehicles?q=harbinger"),
    ("GET", f"/api/v1/catalog/vehicles/{TAURUS_UUID}/slots"),
    ("GET", "/api/v1/catalog/items?type=QuantumDrive"),
    ("POST", f"/api/v1/members/{SELF}/ships"),
    ("PATCH", f"/api/v1/members/{SELF}/ships/abc"),
    ("DELETE", f"/api/v1/members/{SELF}/ships/abc"),
    ("PUT", f"/api/v1/members/{SELF}/ships/abc/slots/x"),
    ("DELETE", f"/api/v1/members/{SELF}/ships/abc/slots/x"),
    ("POST", f"/api/v1/members/{SELF}/fit"),
    ("POST", f"/api/v1/members/{SELF}/ships/abc/reset"),
    ("GET", "/api/v1/members"),
])
def test_every_v1_route_requires_auth(client, wiki_calls, headers, method, path):
    r = client.request(method, path, headers={**headers, "X-Acting-Member": SELF}, json={"bogus": 1})
    assert r.status_code == 401, r.text
    assert r.json()["error"] == "unauthenticated"
    assert r.headers["www-authenticate"] == "Bearer"
    assert wiki_calls == []


def test_auth_checked_before_body_validation(client):
    r = client.post(f"/v1/members/{SELF}/ships", content=b"{not json", headers={"X-Acting-Member": SELF})
    assert r.status_code == 401


def test_cert_fetch_failure_is_503_unavailable(client):
    r = client.get(f"/v1/members/{SELF}/hangar", headers=H(token="certs-down"))
    assert r.status_code == 503
    assert r.json()["error"] == "unavailable"


def test_unset_audience_fails_closed(repo):
    app = create_app(cfg(HANGAR_AUDIENCE=""), catalog=make_catalog(), repository=repo,
                     verifier=lambda t, a: {"aud": a, "email": CALLER, "email_verified": True},
                     warm=False)
    with TestClient(app) as c:
        r = c.get(f"/v1/members/{SELF}/hangar", headers=H())
        assert r.status_code == 401
        assert c.get("/healthz").status_code == 200


# ---------- write permission ----------

def test_reads_of_other_members_allowed(client):
    add_ship(client, member=OTHER)
    r = client.get(f"/v1/members/{OTHER}/hangar", headers=H(acting=SELF))
    assert r.status_code == 200
    assert len(r.json()["ships"]) == 1
    # and with no acting member at all
    assert client.get(f"/v1/members/{OTHER}/hangar", headers=H(acting=None)).status_code == 200


def test_write_for_other_member_by_non_admin_forbidden(client, repo):
    r = client.post(f"/v1/members/{OTHER}/ships", json={"vehicle": "harbinger"}, headers=H(acting=SELF))
    assert r.status_code == 403
    assert r.json()["error"] == "forbidden"


def test_write_without_acting_member_forbidden(client):
    r = client.post(f"/v1/members/{SELF}/ships", json={"vehicle": "harbinger"}, headers=H(acting=None))
    assert r.status_code == 403
    assert "X-Acting-Member" in r.json()["message"]


def test_admin_may_write_for_other_member(client):
    ship = add_ship(client, member=OTHER, acting=ADMIN)
    assert ship["updatedBy"] == ADMIN


@pytest.mark.parametrize("method,suffix,body", [
    ("PATCH", "", {"nickname": "x"}),
    ("DELETE", "", None),
    ("PUT", f"/slots/{TAURUS_QD}", {"item": HEMERA_UUID}),
    ("DELETE", f"/slots/{TAURUS_QD}", None),
])
def test_all_write_routes_enforce_permission(client, method, suffix, body):
    ship = add_ship(client, vehicle=TAURUS_UUID, member=OTHER, acting=OTHER)
    r = client.request(method, f"/v1/members/{OTHER}/ships/{ship['shipId']}{suffix}",
                       json=body, headers=H(acting=SELF))
    assert r.status_code == 403


def test_invalid_member_id_rejected(client):
    r = client.get("/v1/members/not-a-snowflake/hangar", headers=H())
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_request"


# ---------- GET hangar ----------

def test_empty_hangar(client):
    r = client.get(f"/v1/members/{SELF}/hangar", headers=H())
    assert r.status_code == 200
    assert r.json() == {"member": SELF, "ships": []}


def test_hangar_lists_ships_with_effective_loadout(client):
    add_ship(client, vehicle="harbinger", nickname="Harby")
    add_ship(client, vehicle=TAURUS_UUID)
    r = client.get(f"/v1/members/{SELF}/hangar", headers=H())
    ships = r.json()["ships"]
    assert [s["vehicleName"] for s in ships] == ["Vanguard Harbinger", "Constellation Taurus"]
    harby = ships[0]
    assert harby["nickname"] == "Harby"
    assert harby["vehicleUuid"] == HARBINGER_UUID
    assert harby["loadoutError"] is None
    shields = [s for s in harby["loadout"] if s["type"] == "Shield"]
    assert len(shields) == 2 and all(s["source"] == "stock" for s in shields)
    assert set(shields[0]) == {"slot", "type", "sizeMin", "sizeMax", "compatibleTypes", "item", "source"}
    assert shields[0]["compatibleTypes"] == [{"type": "Shield", "subTypes": []}]
    assert len(ships[1]["loadout"]) == 17


def test_hangar_fetches_ship_slots_concurrently(repo):
    class SlowCatalog:
        def __init__(self):
            self.in_flight = 0
            self.peak = 0

        async def slots(self, vehicle_uuid):
            self.in_flight += 1
            self.peak = max(self.peak, self.in_flight)
            await asyncio.sleep(0.05)
            self.in_flight -= 1
            return [Slot("hardpoint_shield", "Shield", None, 1, 1, [{"type": "Shield", "sub_types": []}],
                         {"uuid": "s", "name": "Stock Shield", "className": "x", "type": "Shield", "size": 1})]

        def vehicle_index_cached(self):
            return True

    cat = SlowCatalog()
    app = create_app(cfg(), catalog=cat, repository=repo, verifier=fake_verifier, warm=False)

    async def seed():
        for i in range(4):
            await repo.create_ship(SELF, vehicle_uuid=f"v{i}", vehicle_name=f"Ship {i}",
                                   vehicle_class_name=None, nickname=None, updated_by=SELF)
    asyncio.run(seed())
    with TestClient(app) as c:
        r = c.get(f"/v1/members/{SELF}/hangar", headers=H())
    assert r.status_code == 200
    assert len(r.json()["ships"]) == 4
    assert cat.peak == 4


def test_hangar_ship_whose_vehicle_details_cannot_be_fetched(repo):
    async def seed():
        await repo.create_ship(SELF, vehicle_uuid=HARBINGER_UUID, vehicle_name="Vanguard Harbinger",
                               vehicle_class_name=None, nickname=None, updated_by=SELF)
        await repo.create_ship(SELF, vehicle_uuid="gone-from-wiki", vehicle_name="Old Ship",
                               vehicle_class_name=None, nickname=None, updated_by=SELF)
    asyncio.run(seed())
    app = create_app(cfg(), catalog=make_catalog(fail=lambda r: HARBINGER_UUID in r.url.path),
                     repository=repo, verifier=fake_verifier, warm=False)
    with TestClient(app) as c:
        r = c.get(f"/v1/members/{SELF}/hangar", headers=H())
    assert r.status_code == 200
    harby, old = r.json()["ships"]
    assert harby["loadout"] is None and harby["loadoutError"] == "unavailable"
    assert old["loadout"] is None and old["loadoutError"] == "not_found"


def test_hangar_repository_failure_is_503(client, repo):
    repo.fail_with = RuntimeError("firestore down")
    r = client.get(f"/v1/members/{SELF}/hangar", headers=H())
    assert r.status_code == 503
    assert r.json()["error"] == "unavailable"


# ---------- POST ships ----------

def test_add_ship_resolves_vehicle(client):
    ship = add_ship(client, vehicle="harbinger", nickname="  Harby  ")
    assert ship["vehicleUuid"] == HARBINGER_UUID
    assert ship["vehicleName"] == "Vanguard Harbinger"
    assert ship["vehicleClassName"]
    assert ship["nickname"] == "Harby"
    assert ship["fitted"] == {}
    assert ship["updatedBy"] == SELF
    assert ship["shipId"] and ship["createdAt"] and ship["updatedAt"]
    assert ship["loadout"] and ship["loadoutError"] is None


def test_add_same_model_twice_gives_distinct_ships(client):
    a = add_ship(client, vehicle="harbinger")
    b = add_ship(client, vehicle="harbinger")
    assert a["shipId"] != b["shipId"]


def test_add_ship_ambiguous_is_409_with_candidates(client, repo):
    r = client.post(f"/v1/members/{SELF}/ships", json={"vehicle": "cutlass"}, headers=H())
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "ambiguous"
    assert len(body["candidates"]) >= 2
    for cand in body["candidates"]:
        assert {"uuid", "name", "label", "slug"} <= set(cand)
    assert asyncio.run(repo.list_ships(SELF)) == []


def test_add_ship_unknown_is_404(client):
    r = client.post(f"/v1/members/{SELF}/ships", json={"vehicle": "zzqx definitely not a ship"}, headers=H())
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


@pytest.mark.parametrize("body", [{}, {"vehicle": ""}, {"vehicle": "   "}, {"vehicle": 5},
                                  {"vehicle": "harbinger", "nickname": 7},
                                  {"vehicle": "harbinger", "nickname": "x" * 65}, [1, 2]])
def test_add_ship_bad_body_is_400(client, body):
    r = client.post(f"/v1/members/{SELF}/ships", json=body, headers=H())
    assert r.status_code == 400, r.text
    assert r.json()["error"] == "invalid_request"


def test_add_ship_invalid_json_is_400(client):
    r = client.post(f"/v1/members/{SELF}/ships", content=b"{nope",
                    headers={**H(), "Content-Type": "application/json"})
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_request"


def test_add_ship_catalog_down_cold_is_503(repo):
    app = create_app(cfg(), catalog=make_catalog(fail=lambda r: True), repository=repo,
                     verifier=fake_verifier, warm=False)
    with TestClient(app) as c:
        r = c.post(f"/v1/members/{SELF}/ships", json={"vehicle": "harbinger"}, headers=H())
    assert r.status_code == 503
    assert r.json()["error"] == "unavailable"


# ---------- PATCH / DELETE ship ----------

def test_rename_and_clear_nickname(client):
    ship = add_ship(client)
    url = f"/v1/members/{SELF}/ships/{ship['shipId']}"
    r = client.patch(url, json={"nickname": "Harby"}, headers=H())
    assert r.status_code == 200
    assert r.json()["ship"]["nickname"] == "Harby"
    r = client.patch(url, json={"nickname": None}, headers=H())
    assert r.json()["ship"]["nickname"] is None
    r = client.patch(url, json={"nickname": "   "}, headers=H())
    assert r.json()["ship"]["nickname"] is None


def test_rename_missing_ship_404(client):
    r = client.patch(f"/v1/members/{SELF}/ships/doesnotexist", json={"nickname": "x"}, headers=H())
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


def test_rename_other_members_ship_id_is_404(client):
    theirs = add_ship(client, member=OTHER)
    r = client.patch(f"/v1/members/{SELF}/ships/{theirs['shipId']}", json={"nickname": "x"}, headers=H())
    assert r.status_code == 404


@pytest.mark.parametrize("body", [{}, {"nick": "x"}, {"nickname": 3}, {"nickname": "y" * 65}])
def test_rename_bad_body_400(client, body):
    ship = add_ship(client)
    r = client.patch(f"/v1/members/{SELF}/ships/{ship['shipId']}", json=body, headers=H())
    assert r.status_code == 400


def test_delete_ship(client):
    ship = add_ship(client)
    url = f"/v1/members/{SELF}/ships/{ship['shipId']}"
    r = client.delete(url, headers=H())
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "shipId": ship["shipId"]}
    assert client.delete(url, headers=H()).status_code == 404
    assert client.get(f"/v1/members/{SELF}/hangar", headers=H()).json()["ships"] == []


def test_invalid_ship_id_is_404(client):
    r = client.delete(f"/v1/members/{SELF}/ships/..", headers=H())
    assert r.status_code == 404
    r = client.patch(f"/v1/members/{SELF}/ships/{'x' * 200}", json={"nickname": "a"}, headers=H())
    assert r.status_code == 404


# ---------- slots ----------

def _slot(ship, name):
    return next(s for s in ship["loadout"] if s["slot"] == name)


def test_fit_compatible_item(client):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    r = client.put(f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/{TAURUS_QD}",
                   json={"item": HEMERA_UUID}, headers=H())
    assert r.status_code == 200, r.text
    out = r.json()["ship"]
    assert out["fitted"] == {TAURUS_QD: {"itemUuid": HEMERA_UUID, "itemName": "Hemera"}}
    qd = _slot(out, TAURUS_QD)
    assert qd["source"] == "fitted" and qd["item"] == {"uuid": HEMERA_UUID, "name": "Hemera"}


def test_fit_by_exact_item_name(client):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    r = client.put(f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/{TAURUS_QD}",
                   json={"item": "Hemera"}, headers=H())
    assert r.status_code == 200


def test_fit_incompatible_type_is_422(client):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    shield = next(s["slot"] for s in ship["loadout"] if s["type"] == "Shield")
    r = client.put(f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/{shield}",
                   json={"item": HEMERA_UUID}, headers=H())
    assert r.status_code == 422
    body = r.json()
    assert body["error"] == "incompatible"
    assert "Hemera" in body["message"] and "QuantumDrive" in body["message"]


def test_fit_into_nested_slot_path_routes(client):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    nested = next(s["slot"] for s in ship["loadout"] if s["slot"].count("/") >= 1)
    base = f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/"
    r = client.put(base + nested, json={"item": HEMERA_UUID}, headers=H())
    assert r.status_code == 422          # reached the slot: it's a gun slot, Hemera is a QD
    r = client.put(base + nested.replace("/", "%2F"), json={"item": HEMERA_UUID}, headers=H())
    assert r.status_code == 422


def test_fit_stock_item_resets_to_stock(client):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    stock_uuid = _slot(ship, TAURUS_QD)["item"]["uuid"]
    url = f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/{TAURUS_QD}"
    client.put(url, json={"item": HEMERA_UUID}, headers=H())
    # The fake Wiki only knows Hemera by id, so teach the catalog the stock Bolon.
    # Fitting the stock item back is "reset to stock": fitted holds only changes.
    app_catalog = client.app.state.catalog

    async def stock_item(_ident):
        return {"uuid": stock_uuid, "name": "Bolon", "type": "QuantumDrive", "subType": "UNDEFINED", "size": 2}
    app_catalog.item = stock_item
    r = client.put(url, json={"item": stock_uuid}, headers=H())
    assert r.status_code == 200
    out = r.json()["ship"]
    assert out["fitted"] == {}
    assert _slot(out, TAURUS_QD)["source"] == "stock"


def test_fit_unknown_slot_item_ship_404(client):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    base = f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/"
    r = client.put(base + "hardpoint_nope", json={"item": HEMERA_UUID}, headers=H())
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    r = client.put(base + TAURUS_QD, json={"item": "No Such Drive"}, headers=H())
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    r = client.put(f"/v1/members/{SELF}/ships/nosuchship/slots/{TAURUS_QD}",
                   json={"item": HEMERA_UUID}, headers=H())
    assert r.status_code == 404


@pytest.mark.parametrize("body", [{}, {"item": ""}, {"item": 3}])
def test_fit_bad_body_400(client, body):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    r = client.put(f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/{TAURUS_QD}", json=body, headers=H())
    assert r.status_code == 400


def test_reset_slot_to_stock(client):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    url = f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/{TAURUS_QD}"
    client.put(url, json={"item": HEMERA_UUID}, headers=H())
    r = client.delete(url, headers=H())
    assert r.status_code == 200
    out = r.json()["ship"]
    assert out["fitted"] == {}
    assert _slot(out, TAURUS_QD)["source"] == "stock"
    # already stock: still a success
    assert client.delete(url, headers=H()).status_code == 200


def test_reset_nested_and_orphaned_slot_needs_no_catalog_match(client):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    r = client.delete(f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/renamed_in_patch/child",
                      headers=H())
    assert r.status_code == 200


def test_reset_slot_missing_ship_404(client):
    r = client.delete(f"/v1/members/{SELF}/ships/nosuchship/slots/{TAURUS_QD}", headers=H())
    assert r.status_code == 404


def test_slot_write_repository_failure_503(client, repo):
    ship = add_ship(client, vehicle=TAURUS_UUID)
    repo.fail_with = RuntimeError("down")
    r = client.put(f"/v1/members/{SELF}/ships/{ship['shipId']}/slots/{TAURUS_QD}",
                   json={"item": HEMERA_UUID}, headers=H())
    assert r.status_code == 503


# ---------- catalog ----------

def test_catalog_vehicle_search(client):
    r = client.get("/v1/catalog/vehicles", params={"q": "harbinger"}, headers=H(acting=None))
    assert r.status_code == 200
    vs = r.json()["vehicles"]
    assert vs[0]["uuid"] == HARBINGER_UUID
    assert set(vs[0]) >= {"uuid", "name", "slug", "className"}


def test_catalog_vehicle_search_limit(client):
    assert len(client.get("/v1/catalog/vehicles", headers=H()).json()["vehicles"]) == 25
    assert len(client.get("/v1/catalog/vehicles?limit=5", headers=H()).json()["vehicles"]) == 5
    assert len(client.get("/v1/catalog/vehicles?limit=500", headers=H()).json()["vehicles"]) == 25
    assert client.get("/v1/catalog/vehicles?limit=abc", headers=H()).status_code == 400


def test_catalog_vehicle_search_unavailable(repo):
    app = create_app(cfg(), catalog=make_catalog(fail=lambda r: True), repository=repo,
                     verifier=fake_verifier, warm=False)
    with TestClient(app) as c:
        r = c.get("/v1/catalog/vehicles?q=x", headers=H())
    assert r.status_code == 503 and r.json()["error"] == "unavailable"


def test_catalog_slots(client):
    r = client.get(f"/v1/catalog/vehicles/{TAURUS_UUID}/slots", headers=H())
    assert r.status_code == 200
    body = r.json()
    assert body["vehicle"]["uuid"] == TAURUS_UUID
    assert len(body["slots"]) == 17
    qd = next(s for s in body["slots"] if s["slot"] == TAURUS_QD)
    assert set(qd) == {"slot", "type", "subType", "sizeMin", "sizeMax", "compatibleTypes", "stockItem"}
    assert client.get("/v1/catalog/vehicles/nope/slots", headers=H()).status_code == 404


def test_catalog_items(client):
    r = client.get("/v1/catalog/items", params={"type": "quantumdrive", "size": 2}, headers=H())
    assert r.status_code == 200
    assert len(r.json()["items"]) == 20
    # picker extras (keyStat / cheapestPrice) stay out of this route's shape
    assert set(r.json()["items"][0]) == {"uuid", "name", "className", "type", "subType", "size", "grade",
                                         "class", "manufacturer"}
    r = client.get("/v1/catalog/items", params={"type": "QuantumDrive", "size": 2, "q": "hem"}, headers=H())
    assert [i["name"] for i in r.json()["items"]] == ["Hemera"]


@pytest.mark.parametrize("qs", ["", "?type=Paints", "?type=QuantumDrive&size=big", "?type=QuantumDrive&size=-1"])
def test_catalog_items_bad_params_400(client, qs):
    r = client.get("/v1/catalog/items" + qs, headers=H())
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_request"


# ---------- misc ----------

def test_unknown_route_404_envelope(client):
    r = client.get("/v1/nope", headers=H())
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


def test_method_not_allowed_envelope(client):
    r = client.post("/healthz")
    assert r.status_code == 405
    assert r.json()["error"] == "invalid_request"


def test_startup_warms_catalog_in_background(repo):
    class WarmCatalog:
        def __init__(self):
            self.warmed = asyncio.Event()

        async def warm(self):
            self.warmed.set()

        def vehicle_index_cached(self):
            return self.warmed.is_set()

    cat = WarmCatalog()
    app = create_app(cfg(), catalog=cat, repository=repo, verifier=fake_verifier, warm=True)
    with TestClient(app) as c:
        for _ in range(50):
            if c.get("/healthz").json()["vehicleIndexCached"]:
                break
        assert cat.warmed.is_set()


def test_startup_does_not_wait_for_a_slow_warm(repo):
    class SlowWarm:
        async def warm(self):
            await asyncio.sleep(3600)

        def vehicle_index_cached(self):
            return False

    app = create_app(cfg(), catalog=SlowWarm(), repository=repo, verifier=fake_verifier, warm=True)
    with TestClient(app) as c:     # startup must not block; shutdown must cancel the warm task
        assert c.get("/healthz").status_code == 200


# ---------- fix round 1 ----------

@pytest.mark.parametrize("path", ["/health", "/healthz"])
def test_health_paths_unauthenticated_no_upstream(client, wiki_calls, path):
    # Cloud Run's front end reserves paths ending in "z": /healthz 404s in prod.
    r = client.get(path)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert wiki_calls == []


def test_unexpected_exception_is_500_unavailable_with_full_stack_logged(repo, caplog):
    class BrokenCatalog:
        async def search_vehicles(self, q, limit=25):
            raise RuntimeError("boom " + "x" * 5000)

        def vehicle_index_cached(self):
            return False

    app = create_app(cfg(), catalog=BrokenCatalog(), repository=repo, verifier=fake_verifier, warm=False)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/v1/catalog/vehicles?q=x", headers=H())
    assert r.status_code == 500
    assert r.json()["error"] == "unavailable"
    rec = next(r for r in caplog.records if r.levelname == "ERROR" and "500" in r.getMessage())
    assert rec.exc_info is not None
    assert "x" * 5000 in rec.getMessage() or "x" * 5000 in str(rec.exc_info[1])
