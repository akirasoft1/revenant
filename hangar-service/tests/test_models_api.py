"""Wireframe model upload / list / delete / serve and slot position matching."""
import hashlib
import logging

import pytest
from fastapi.testclient import TestClient

from src.app import create_app
from src.models import InMemoryModelStore
from src.positions import InMemoryPositionsStore
from src.repository import InMemoryShipRepository, RepositoryError
from tests.conftest import TAURUS_UUID
from tests.swf_helper import make_bundle, node
from tests.test_app import ADMIN, H, SELF, cfg, fake_verifier, make_catalog
from tests.test_browser_auth import ADMIN_USER, BROWSER_ENV, ME, ORIGIN, Clock, as_user

CLASS = "RSI_Constellation_Taurus"
NODES = [node("hardpoint_radar", -1, (1, 2, 3)),
         node("hardpoint_quantum_drive", -1, (4, 5, 6)),
         node("hardpoint_turret_base_upper", -1, (0, 0, 0)),
         node("anything", 2, (0, 1, 0)),
         node("hardpoint_weapon_left", 3, (7, 8, 9)),
         node("HARDPOINT_CLASS_2", 4, (7.5, 8.5, 9.5)),
         node("hardpoint_cooler_left", -1, (0, 0, 1)),
         node("hardpoint_cooler_left", -1, (0, 0, 9))]       # ambiguous
BUNDLE = make_bundle(class_name=CLASS, nodes=NODES, lines=4)
HP = "/api/v1/models"


class FailingModels(InMemoryModelStore):
    def __init__(self, fail_on=()):
        super().__init__()
        self.fail_on = set(fail_on)

    async def put(self, *a, **k):
        if "put" in self.fail_on:
            raise RepositoryError("boom")
        await super().put(*a, **k)

    async def meta_for_vehicle(self, *a, **k):
        if "meta_for_vehicle" in self.fail_on:
            raise RepositoryError("boom")
        if "meta_for_vehicle_unexpected" in self.fail_on:
            raise KeyError("odd")
        return await super().meta_for_vehicle(*a, **k)


def make(models=None, positions=None, bucket="b", env=None):
    e = {**BROWSER_ENV, **(env or {})}
    if bucket:
        e["HANGAR_MODELS_BUCKET"] = bucket
    return create_app(cfg(**e), catalog=make_catalog(), repository=InMemoryShipRepository(),
                      verifier=fake_verifier, warm=False, clock=Clock(),
                      positions=positions if positions is not None else InMemoryPositionsStore(),
                      models=models if models is not None else (InMemoryModelStore() if bucket else None))


def admin(c):
    return as_user(c, ADMIN_USER)


def up(c, data=BUNDLE, origin=ORIGIN):
    return c.post(HP, content=data, headers={"Origin": origin, "Content-Type": "application/octet-stream"})


@pytest.fixture
def parts():
    models, positions = InMemoryModelStore(), InMemoryPositionsStore()
    return models, positions, make(models, positions)


def test_upload_happy_path(parts, caplog):
    models, positions, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        with caplog.at_level(logging.INFO):
            r = up(c)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["kind"] == "vehicle" and j["className"] == CLASS and j["vehicleUuid"] == TAURUS_UUID
        assert j["vehicleName"] == "Constellation Taurus" and j["lines"] == 4
        assert j["bytes"] == len(BUNDLE) and j["sha256"] == hashlib.sha256(BUNDLE).hexdigest()
        assert j["uploadedBy"] == ADMIN and j["uploadedAt"]
        s = j["slots"]
        assert s["matched"] == 3 and s["ambiguous"] == ["hardpoint_cooler_left"]
        assert "hardpoint_gun_laser_top_left" in s["missing"]
        assert models.objects[f"vehicle:{CLASS}"] == BUNDLE
        assert models.metas[f"vehicle:{CLASS}"]["build"]["tool"] == "wireframes/1"
    doc = positions._docs[TAURUS_UUID]
    assert doc["source"] == "extracted" and doc["space"] == "gltf-y-up-m" and doc["className"] == CLASS
    assert doc["updatedBy"] == ADMIN and doc["updatedAt"]
    assert doc["slots"]["hardpoint_radar"] == {"xyz": [1.0, 2.0, 3.0]}
    assert doc["slots"]["hardpoint_turret_base_upper/hardpoint_weapon_left/hardpoint_class_2"] == {
        "xyz": [7.5, 8.5, 9.5]}
    assert "hardpoint_cooler_left" not in doc["slots"]
    msg = next(r.getMessage() for r in caplog.records if "model upload" in r.getMessage())
    assert f"kind=vehicle class={CLASS} vehicle={TAURUS_UUID} lines=4" in msg and f"by={ADMIN}" in msg
    assert "matched=3" in msg and "ambiguous=1" in msg


def test_unknown_class_stored_without_positions(parts):
    models, positions, app = parts
    data = make_bundle(class_name="ZZZ_Unknown_Ship", nodes=NODES)
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        j = up(c, data).json()
        assert j["vehicleUuid"] is None and j["vehicleName"] is None
        assert j["slots"] == {"matched": 0, "missing": [], "ambiguous": []}
        assert positions._docs == {}
        assert [m["className"] for m in c.get(HP).json()["models"]] == ["ZZZ_Unknown_Ship"]
        assert c.delete(f"{HP}/vehicle/ZZZ_Unknown_Ship", headers={"Origin": ORIGIN}).status_code == 204
        assert c.get(HP).json() == {"models": []}


def test_auth_matrix(parts):
    models, _, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        as_user(c, ME)
        assert up(c).status_code == 403                       # non-admin session
        assert c.get(HP).status_code == 403
        assert c.delete(f"{HP}/vehicle/{CLASS}", headers={"Origin": ORIGIN}).status_code == 403
    with TestClient(app, base_url=ORIGIN) as c:
        r = c.post(HP, content=BUNDLE, headers=H())           # service token
        assert r.status_code == 403
        assert c.get(HP, headers=H()).status_code == 403
        assert c.post("/v1/models", content=BUNDLE, headers=H()).status_code in (404, 405)
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        assert up(c, origin="https://evil.example").status_code == 403
        assert c.post(HP, content=BUNDLE).status_code == 403   # no Origin
    assert models.objects == {}


def test_too_large_413(parts):
    _, _, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        r = up(c, b"x" * (2 * 1024 * 1024 + 1))
        assert r.status_code == 413 and r.json()["error"] == "too_large"


@pytest.mark.parametrize("data", [b"junk", make_bundle(kind="item"), make_bundle(magic=b"NOPE")])
def test_invalid_bundle_400(parts, data):
    models, _, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        r = up(c, data)
        assert r.status_code == 400 and r.json()["error"] == "invalid_request" and r.json()["message"]
    assert models.objects == {}


def test_reupload_replaces_and_invalidates_etag(parts):
    models, positions, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c)
        url = f"{HP}/vehicle/{TAURUS_UUID}/wireframe"
        etag = c.get(url).headers["etag"]
        assert c.get(url, headers={"If-None-Match": etag}).status_code == 304
        newer = make_bundle(class_name=CLASS, nodes=[node("hardpoint_radar", -1, (9, 9, 9))], lines=1)
        j = up(c, newer).json()
        assert j["slots"]["matched"] == 1
        r = c.get(url, headers={"If-None-Match": etag})
        assert r.status_code == 200 and r.content == newer and r.headers["etag"] != etag
        assert len(c.get(HP).json()["models"]) == 1
    assert positions._docs[TAURUS_UUID]["slots"] == {"hardpoint_radar": {"xyz": [9.0, 9.0, 9.0]}}


def test_delete_removes_extracted_positions(parts):
    models, positions, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c)
        assert c.delete(f"{HP}/vehicle/{CLASS}", headers={"Origin": ORIGIN}).status_code == 204
        assert c.delete(f"{HP}/vehicle/{CLASS}", headers={"Origin": ORIGIN}).status_code == 404
        assert c.delete(f"{HP}/vehicle/{CLASS}").status_code == 403         # same-origin required
    assert models.objects == {} and models.metas == {} and positions._docs == {}


def test_delete_keeps_non_extracted_positions():
    models, positions = InMemoryModelStore(), InMemoryPositionsStore()
    app = make(models, positions)
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c)
        manual = {"source": "manual", "slots": {"x": {"view": "top", "x": 0.1, "y": 0.2}}}
        positions._docs[TAURUS_UUID] = manual
        assert c.delete(f"{HP}/vehicle/{CLASS}", headers={"Origin": ORIGIN}).status_code == 204
    assert positions._docs[TAURUS_UUID] == manual


def test_delete_bad_kind_or_class_rejected(parts):
    _, _, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        assert c.delete(f"{HP}/item/{CLASS}", headers={"Origin": ORIGIN}).status_code in (400, 404)
        assert c.delete(f"{HP}/vehicle/bad%20name", headers={"Origin": ORIGIN}).status_code in (400, 404)


def test_serve_headers_and_access(parts):
    _, _, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c)
    url = f"{HP}/vehicle/{TAURUS_UUID}/wireframe"
    sha = hashlib.sha256(BUNDLE).hexdigest()
    with TestClient(app, base_url=ORIGIN) as c:
        as_user(c, ME)                                           # any member
        r = c.get(url)
        assert r.status_code == 200 and r.content == BUNDLE
        assert r.headers["content-type"] == "application/octet-stream"
        assert "content-encoding" not in r.headers
        assert r.headers["etag"] == f'"{sha}"'
        assert r.headers["cache-control"] == "private, max-age=86400"
        assert c.get(url, headers={"If-None-Match": f'"{sha}"'}).status_code == 304
        assert c.get(f"{HP}/vehicle/nope/wireframe").status_code == 404
        assert c.get(f"{HP}/vehicle/d9bc09ce-4c74-4f72-892e-a833c094f4e6/wireframe").status_code == 404
    with TestClient(app, base_url=ORIGIN) as c:
        assert c.get(url, headers=H()).status_code == 200        # service token
        assert c.get(url).status_code == 401


def test_has_wireframe_flag(parts):
    _, _, app = parts
    slots_url = f"/api/v1/catalog/vehicles/{TAURUS_UUID}/slots"
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        assert c.get(slots_url).json()["vehicle"]["hasWireframe"] is False
        up(c)
        assert c.get(slots_url).json()["vehicle"]["hasWireframe"] is True
        assert c.get(f"/v1/catalog/vehicles/{TAURUS_UUID}/slots", headers=H()).json()["vehicle"]["hasWireframe"] is True


def test_has_wireframe_false_when_store_errors():
    models = FailingModels()
    app = make(models)
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c)
        models.fail_on = {"meta_for_vehicle"}
        r = c.get(f"/api/v1/catalog/vehicles/{TAURUS_UUID}/slots")
        assert r.status_code == 200 and r.json()["vehicle"]["hasWireframe"] is False


def test_bucket_unset_503_on_model_routes_only():
    app = make(bucket="")
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        assert up(c).status_code == 503 and up(c).json()["error"] == "unavailable"
        assert c.get(HP).status_code == 503
        assert c.delete(f"{HP}/vehicle/{CLASS}", headers={"Origin": ORIGIN}).status_code == 503
        assert c.get(f"{HP}/vehicle/{TAURUS_UUID}/wireframe").status_code == 503
        r = c.get(f"/api/v1/catalog/vehicles/{TAURUS_UUID}/slots")
        assert r.status_code == 200 and r.json()["vehicle"]["hasWireframe"] is False
        assert c.get(f"/api/v1/catalog/vehicles/{TAURUS_UUID}/positions").status_code == 200


def test_storage_failure_503_nothing_written():
    models = FailingModels({"put"})
    positions = InMemoryPositionsStore()
    app = make(models, positions)
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        r = up(c)
        assert r.status_code == 503 and r.json()["error"] == "unavailable"
    assert models.objects == {} and positions._docs == {}


def test_delete_logs(parts, caplog):
    _, _, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c)
        with caplog.at_level(logging.INFO):
            c.delete(f"{HP}/vehicle/{CLASS}", headers={"Origin": ORIGIN})
    assert any(f"model delete kind=vehicle class={CLASS}" in r.getMessage() and f"by={ADMIN}" in r.getMessage()
               for r in caplog.records)


def test_class_name_casing_one_model(parts):
    models, positions, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c, make_bundle(class_name=CLASS.upper(), nodes=NODES, lines=4))
        j = up(c, make_bundle(class_name=CLASS.lower(), nodes=NODES, lines=2)).json()
        assert j["className"] == CLASS
        ms = c.get(HP).json()["models"]
        assert [m["className"] for m in ms] == [CLASS] and ms[0]["lines"] == 2
    assert list(models.objects) == [f"vehicle:{CLASS}"]
    assert positions._docs[TAURUS_UUID]["className"] == CLASS


def test_delete_keeps_positions_written_by_other_model(parts):
    models, positions, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c)
        positions._docs[TAURUS_UUID]["className"] = "OTHER_Model"
        assert c.delete(f"{HP}/vehicle/{CLASS}", headers={"Origin": ORIGIN}).status_code == 204
    assert TAURUS_UUID in positions._docs


def test_delete_failure_leaves_listed_model_with_bytes():
    models, positions = InMemoryModelStore(), InMemoryPositionsStore()

    class BadPositions(InMemoryPositionsStore):
        async def delete(self, *a):
            raise RepositoryError("boom")
    bad = BadPositions()
    app = make(models, bad)
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        up(c)
        assert c.delete(f"{HP}/vehicle/{CLASS}", headers={"Origin": ORIGIN}).status_code == 503
        assert len(c.get(HP).json()["models"]) == 1
    assert models.objects and models.metas


def test_has_wireframe_survives_unexpected_exception(caplog):
    models = FailingModels()
    app = make(models)
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        models.fail_on = {"meta_for_vehicle_unexpected"}
        with caplog.at_level(logging.WARNING):
            r = c.get(f"/api/v1/catalog/vehicles/{TAURUS_UUID}/slots")
    assert r.status_code == 200 and r.json()["vehicle"]["hasWireframe"] is False
    assert any("wireframe lookup failed" in x.getMessage() for x in caplog.records)


def test_cycle_upload_400(parts):
    _, _, app = parts
    with TestClient(app, base_url=ORIGIN) as c:
        admin(c)
        r = up(c, make_bundle(class_name=CLASS, nodes=[node("a", 0)]))
        assert r.status_code == 400 and "cycle" in r.json()["message"]
