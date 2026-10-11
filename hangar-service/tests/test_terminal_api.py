"""Terminal ship view API: item/vehicle enrichment, hardpoint positions read
path, image-error reporting."""
import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from src import client_events
from src.app import create_app
from src.catalog import build_catalog, item_option, vehicle_profile_extra
from src.keystats import all_stats
from src.positions import InMemoryPositionsStore
from src.repository import InMemoryShipRepository
from tests.conftest import HARBINGER_UUID, TAURUS_UUID, wiki_handler
from tests.test_catalog import TAURUS_SLUG
from tests.test_app import SELF, H, _nosleep, cfg, fake_verifier
from tests.test_browser_auth import BROWSER_ENV, ORIGIN, Clock, as_user

IMG = "https://cdn.star-citizen.wiki/images/x.jpg"


# ---------- keystats.all_stats ----------

def test_all_stats_quantum_drive():
    raw = {"type": "QuantumDrive",
           "quantum_drive": {"standard_jump": {"drive_speed": 283000000.0}, "fuel_rate": 0.5}}
    assert all_stats(raw) == [
        {"key": "speed", "label": "Speed", "value": 283000000.0, "unit": "m/s", "lowerIsBetter": False},
        {"key": "fuel_rate", "label": "Fuel rate", "value": 0.5, "unit": None, "lowerIsBetter": True}]


def test_all_stats_skips_missing_and_unknown_type():
    raw = {"type": "QuantumDrive", "quantum_drive": {"fuel_rate": 0.5}}
    assert [s["key"] for s in all_stats(raw)] == ["fuel_rate"]
    assert all_stats({"type": "Turret"}) == []
    assert all_stats({"type": "Shield"}) == []
    assert all_stats(None) == []


# ---------- catalog.item_option ----------

def test_item_option_enrichment():
    raw = {"uuid": "u", "name": "N", "type": "Shield", "manufacturer": {"name": "Gorgon"},
           "images": [{"thumbnail_url": "https://media.starcitizen.tools/thumb/1.webp", "original_url": "https://cdn.star-citizen.wiki/images/1.png"}],
           "description": {"en_EN": "  A shield.  ", "de_DE": "x"},
           "shield": {"max_health": 100}}
    o = item_option(raw)
    assert o["image"] == "https://media.starcitizen.tools/thumb/1.webp"
    assert o["description"] == "A shield."
    assert o["manufacturer"] == "Gorgon"
    assert o["stats"][0]["key"] == "max_health"


def test_item_option_fallbacks_and_omissions():
    o = item_option({"uuid": "u", "type": "Shield", "images": [{"original_url": "https://cdn.star-citizen.wiki/images/1.png"}],
                     "description": "plain"})
    assert o["image"] == "https://cdn.star-citizen.wiki/images/1.png" and o["description"] == "plain"
    bare = item_option({"uuid": "u", "type": "Shield"})
    assert "image" not in bare and "description" not in bare and bare["stats"] == []
    empty = item_option({"uuid": "u", "type": "Shield", "images": [], "description": {"en_EN": " "}})
    assert "image" not in empty and "description" not in empty


# ---------- vehicle profile ----------

def test_vehicle_profile_extra():
    v = {"images": [{"thumbnail_url": "https://media.starcitizen.tools/thumb/t.webp"}],
         "dimension": {"length": 70, "width": 27.75, "height": 15.25},
         "mass": 383801, "crew": {"min": 4, "max": 5, "weapon": 2}}
    assert vehicle_profile_extra(v) == {
        "image": "https://media.starcitizen.tools/thumb/t.webp", "dimension": {"length": 70, "width": 27.75, "height": 15.25},
        "mass": 383801, "crew": {"min": 4, "max": 5}}
    assert vehicle_profile_extra({}) == {}


def _app(*, mutate_vehicle=None, mutate_item=None, positions=None, extra_cfg=None):
    inner = wiki_handler(mutate_item=mutate_item)

    def handler(req):
        resp = inner(req)
        if mutate_vehicle and req.url.path.startswith("/api/vehicles/") and resp.status_code == 200:
            body = json.loads(resp.content)
            mutate_vehicle(body["data"])
            return httpx.Response(200, json=body)
        return resp
    catalog = build_catalog("https://api.star-citizen.wiki/api", version="test",
                            transport=httpx.MockTransport(handler), sleep=_nosleep)
    return create_app(cfg(**(extra_cfg or {})), catalog=catalog, repository=InMemoryShipRepository(),
                      verifier=fake_verifier, warm=False, positions=positions, clock=Clock())


@pytest.mark.parametrize("prefix", ["/v1", "/api/v1"])
def test_vehicle_slots_profile(prefix):
    def mut(d):
        d["images"] = [{"thumbnail_url": "https://media.starcitizen.tools/thumb/t.webp"}]
        d["dimension"] = {"length": 70, "width": 27.75, "height": 15.25}
        d["mass"] = 100
        d["crew"] = {"min": 1, "max": 2}
    with TestClient(_app(mutate_vehicle=mut)) as c:
        r = c.get(f"{prefix}/catalog/vehicles/{TAURUS_UUID}/slots", headers=H())
    assert r.status_code == 200
    v = r.json()["vehicle"]
    assert v["image"] == "https://media.starcitizen.tools/thumb/t.webp" and v["mass"] == 100 and v["crew"] == {"min": 1, "max": 2}
    assert v["dimension"]["length"] == 70
    expected: dict = {}
    for s in r.json()["slots"]:
        expected[s["type"]] = expected.get(s["type"], 0) + 1
    assert v["portCounts"] == expected and v["portCounts"]
    assert v["name"] == "Constellation Taurus"


def test_vehicle_slots_profile_absent_fields_omitted():
    def mut(d):
        for k in ("images", "dimension", "mass", "crew"):
            d.pop(k, None)
    with TestClient(_app(mutate_vehicle=mut)) as c:
        v = c.get(f"/v1/catalog/vehicles/{TAURUS_UUID}/slots", headers=H()).json()["vehicle"]
    for k in ("image", "dimension", "mass", "crew"):
        assert k not in v
    assert "portCounts" in v


def test_vehicle_slots_unknown_404():
    with TestClient(_app()) as c:
        assert c.get("/v1/catalog/vehicles/nope/slots", headers=H()).status_code == 404


def test_slot_options_carry_enrichment_and_sort():
    def mut(rec):
        rec["images"] = [{"thumbnail_url": "https://cdn.star-citizen.wiki/t.webp"}]
        rec["description"] = {"en_EN": "desc"}
    with TestClient(_app(mutate_item=mut)) as c:
        slots = c.get(f"/v1/catalog/vehicles/{HARBINGER_UUID}/slots", headers=H()).json()["slots"]
        qd = next(s for s in slots if s["type"] == "QuantumDrive")
        items = c.get("/v1/catalog/slot-options", params={"vehicle": HARBINGER_UUID, "slot": qd["slot"]},
                      headers=H()).json()["items"]
    assert items
    assert all(i["image"] == "https://cdn.star-citizen.wiki/t.webp" and i["description"] == "desc"
               for i in items)
    assert all("stats" in i for i in items)
    assert any(i["stats"] for i in items)
    vals = [i["keyStat"]["value"] for i in items if i["keyStat"]["value"] is not None]
    assert vals == sorted(vals, reverse=True)


# ---------- positions ----------

DOC = {"views": {"top": {"imageUrl": "https://x/top.png", "width": 1600, "height": 900}},
       "slots": {"hardpoint_quantum_drive": {"view": "top", "x": 0.52, "y": 0.61}},
       "source": "manual", "gameVersion": "4.3.1"}


@pytest.mark.parametrize("prefix", ["/v1", "/api/v1"])
def test_positions(prefix):
    store = InMemoryPositionsStore({HARBINGER_UUID: DOC})
    with TestClient(_app(positions=store)) as c:
        r = c.get(f"{prefix}/catalog/vehicles/{HARBINGER_UUID}/positions", headers=H())
        assert r.status_code == 200 and r.json() == DOC
        r = c.get(f"{prefix}/catalog/vehicles/{TAURUS_UUID}/positions", headers=H())
        assert r.status_code == 200 and r.json() == {}
        r = c.get(f"{prefix}/catalog/vehicles/nope/positions", headers=H())
        assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_positions_default_store_is_in_memory_for_memory_repo():
    with TestClient(_app()) as c:
        assert c.get(f"/v1/catalog/vehicles/{TAURUS_UUID}/positions", headers=H()).json() == {}


# ---------- image-error ----------

def _browser_app():
    return _app(extra_cfg=BROWSER_ENV)


def _post(c, body, origin=ORIGIN):
    headers = {"Origin": origin} if origin else {}
    return c.post("/api/v1/client-events/image-error", json=body, headers=headers)


def test_image_error_service_principal_forbidden():
    with TestClient(_app()) as c:
        r = c.post("/api/v1/client-events/image-error", json={"url": IMG}, headers=H())
    assert r.status_code == 403 and r.json()["error"] == "forbidden"


def test_image_error_cross_origin_forbidden():
    with TestClient(_browser_app(), base_url=ORIGIN) as c:
        as_user(c)
        assert _post(c, {"url": IMG}, origin="https://evil.example").status_code == 403
        assert _post(c, {"url": IMG}, origin=None).status_code == 403


def test_image_error_logs_one_warning(caplog):
    with TestClient(_browser_app(), base_url=ORIGIN) as c:
        as_user(c)
        with caplog.at_level(logging.WARNING):
            r = _post(c, {"url": IMG, "context": "card"})
    assert r.status_code == 204 and r.content == b""
    hits = [x for x in caplog.records if "image load failed" in x.getMessage()]
    assert len(hits) == 1 and hits[0].levelno == logging.WARNING
    assert f"host=cdn.star-citizen.wiki url={IMG} context=card member={SELF}" in hits[0].getMessage()


def test_image_error_rate_limited():
    with TestClient(_browser_app(), base_url=ORIGIN) as c:
        as_user(c)
        for _ in range(20):
            assert _post(c, {"url": IMG}).status_code == 204
        r = _post(c, {"url": IMG})
    assert r.status_code == 429 and r.json()["error"] == "rate_limited"


@pytest.mark.parametrize("body", [
    {"url": "https://h/" + "a" * 2048}, {}, {"url": ""}, {"url": 5}, {"url": "ftp://h/x"},
    {"url": IMG, "context": "c" * 201}, {"url": IMG, "context": 3}, {"url": "http://["},
    {"url": IMG, "context": "card member=999"}, {"url": IMG, "context": "Card"},
    {"url": IMG, "context": "c" * 41}])
def test_image_error_bad_body(body):
    with TestClient(_browser_app(), base_url=ORIGIN) as c:
        as_user(c)
        r = _post(c, body)
    assert r.status_code == 400 and r.json()["error"] == "invalid_request"


def test_image_error_oversize_content_length_rejected():
    with TestClient(_browser_app(), base_url=ORIGIN) as c:
        as_user(c)
        r = c.post("/api/v1/client-events/image-error", content=b'{"url": "' + b"a" * 5000 + b'"}',
                   headers={"Origin": ORIGIN, "Content-Type": "application/json"})
        assert r.status_code == 400 and r.json()["error"] == "invalid_request"
        r = c.post("/api/v1/client-events/image-error", content=b"{}",
                   headers={"Origin": ORIGIN, "Content-Type": "application/json", "Content-Length": "abc"})
    assert r.status_code == 400


def test_image_error_invalid_bodies_are_rate_limited():
    with TestClient(_browser_app(), base_url=ORIGIN) as c:
        as_user(c)
        for _ in range(20):
            assert _post(c, {}).status_code == 400
        assert _post(c, {}).status_code == 429


@pytest.mark.parametrize("ctx", ["card", "compare", "hero", "positions-view"])
def test_image_error_editor_contexts_accepted(ctx):
    with TestClient(_browser_app(), base_url=ORIGIN) as c:
        as_user(c)
        assert _post(c, {"url": IMG, "context": ctx}).status_code == 204


def test_positions_by_slug_uses_resolved_uuid():
    store = InMemoryPositionsStore({TAURUS_UUID: DOC})
    with TestClient(_app(positions=store)) as c:
        r = c.get(f"/v1/catalog/vehicles/{TAURUS_SLUG}/positions", headers=H())
    assert r.status_code == 200 and r.json() == DOC


def test_limiter_window_and_key_cap():
    t = [0.0]
    lim = client_events.SlidingWindowLimiter(limit=2, window_s=60, clock=lambda: t[0])
    assert lim.allow("a") and lim.allow("a") and not lim.allow("a")
    assert lim.allow("b")
    t[0] = 61
    assert lim.allow("a")
    small = client_events.SlidingWindowLimiter(limit=1, window_s=60, clock=lambda: t[0], max_keys=3)
    for k in "abcd":
        small.allow(k)
    assert small.tracked_keys() == 3


# --- image host preference (2026-10-11: cstone.space images were CSP-blocked) ---

def _img(url):
    return {"source": "x", "thumbnail_url": url, "original_url": url}


def test_first_image_prefers_wiki_cdns_over_cstone():
    from src.catalog import _first_image
    v = {"images": [_img("https://cstone.space/uifimages/a.png"),
                    _img("https://media.starcitizen.tools/thumb/b.jpg")]}
    assert _first_image(v) == "https://media.starcitizen.tools/thumb/b.jpg"
    v = {"images": [_img("https://cstone.space/uifimages/a.png"),
                    _img("https://cdn.star-citizen.wiki/images/c.jpg")]}
    assert _first_image(v) == "https://cdn.star-citizen.wiki/images/c.jpg"


def test_first_image_falls_back_to_cstone_when_it_is_the_only_one():
    from src.catalog import _first_image
    assert _first_image({"images": [_img("https://cstone.space/uifimages/a.png")]}) == \
        "https://cstone.space/uifimages/a.png"


def test_first_image_drops_hosts_the_editor_cannot_load():
    # a host outside the CSP would only produce a blocked request + an image-error report
    from src.catalog import _first_image
    assert _first_image({"images": [_img("https://evil.example/x.png")]}) is None
    assert _first_image({"images": [_img("http://cdn.star-citizen.wiki/images/c.jpg")]}) is None  # not https


def test_csp_image_hosts_come_from_the_catalog_list():
    from src.catalog import IMAGE_HOSTS
    from src.static_site import IMAGE_ORIGINS
    assert IMAGE_ORIGINS == tuple(f"https://{h}" for h in IMAGE_HOSTS)
