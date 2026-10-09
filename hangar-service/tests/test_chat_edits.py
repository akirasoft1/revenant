"""Chat edits: POST /v1/members/{id}/fit and POST /v1/members/{id}/ships/{shipRef}/reset.

The bot's sidecars call these with free text ("Connie", "Hemera", "left") and
the server does every resolution (ship, item, slot). Fixtures: the recorded
Constellation Taurus and Vanguard Harbinger, Hemera (QD S2), and the spviewer
items (7MA 'Lorica' Shield S2, BRVS Repeater WeaponGun S2) looked up by class
name -- the fake Wiki only knows them by uuid / class name."""
import pytest

from tests.conftest import HARBINGER_UUID, HEMERA_UUID, TAURUS_UUID
from tests.test_app import ADMIN, OTHER, SELF, H, add_ship, client, repo, wiki_calls  # noqa: F401

LORICA = "SHLD_BEHR_S02_7MA_SCItem"
LORICA_UUID = "fb145cc4-2e30-44a0-865d-b9ea0e40fae1"
BRVS = "BEHR_BallisticRepeater_VNG_S2"
QD = "hardpoint_quantum_drive"
SHIELD_1, SHIELD_2 = "hardpoint_shield_generator_001", "hardpoint_shield_generator_002"
NOSE = "hardpoint_weapon_gun_nose_fixed_00{}/hardpoint_class_2"


def fit(client, ship, item, slot=None, member=SELF, acting=None, prefix="/v1"):
    body = {"ship": ship, "item": item}
    if slot is not None:
        body["slot"] = slot
    return client.post(f"{prefix}/members/{member}/fit", json=body, headers=H(acting or member))


def reset(client, ship_ref, slot=None, member=SELF, acting=None):
    body = {} if slot is None else {"slot": slot}
    return client.post(f"/v1/members/{member}/ships/{ship_ref}/reset", json=body, headers=H(acting or member))


def hangar(client, member=SELF):
    return client.get(f"/v1/members/{member}/hangar", headers=H()).json()["ships"]


def fitted(client, ship_id, member=SELF):
    return next(s for s in hangar(client, member) if s["shipId"] == ship_id)["fitted"]


# ---------- fit: resolution + write ----------

def test_fit_single_compatible_slot_by_shorthand(client):
    taurus = add_ship(client, vehicle=TAURUS_UUID)
    add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "my Connie", "Hemera")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ship"] == {"shipId": taurus["shipId"], "label": "Constellation Taurus",
                            "vehicle": "Constellation Taurus"}
    assert body["item"]["name"] == "Hemera" and body["item"]["uuid"] == HEMERA_UUID
    assert body["changes"] == [{"slot": QD, "from": {"name": "Bolon", "uuid": "74cc0d0b-1bf5-436c-a38c-1baf93962b89"},
                                "to": {"name": "Hemera", "uuid": HEMERA_UUID}}]
    assert body["unchanged"] is False
    assert fitted(client, taurus["shipId"]) == {QD: {"itemUuid": HEMERA_UUID, "itemName": "Hemera"}}


def test_fit_already_fitted_is_noop(client):
    taurus = add_ship(client, vehicle=TAURUS_UUID)
    fit(client, "Connie", "Hemera")
    before = hangar(client)[0]["updatedAt"]
    r = fit(client, "Connie", "Hemera")
    assert r.status_code == 200
    assert r.json()["changes"] == [] and r.json()["unchanged"] is True
    assert hangar(client)[0]["updatedAt"] == before
    assert fitted(client, taurus["shipId"]) == {QD: {"itemUuid": HEMERA_UUID, "itemName": "Hemera"}}


def test_fit_by_nickname_and_by_ship_id(client):
    add_ship(client, vehicle=TAURUS_UUID)
    harb = add_ship(client, vehicle=HARBINGER_UUID, nickname="Big Bertha")
    r = fit(client, "big berta", "Hemera")
    assert r.status_code == 200 and r.json()["ship"]["shipId"] == harb["shipId"]
    assert r.json()["ship"]["label"] == "\"Big Bertha\" (Vanguard Harbinger)"
    assert r.json()["changes"][0]["from"]["name"] == "Yeager"
    r = fit(client, harb["shipId"], "Hemera")
    assert r.status_code == 200 and r.json()["ship"]["shipId"] == harb["shipId"]


def test_fit_several_compatible_slots_asks_choose_slot(client, repo):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "Harbinger", LORICA)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["error"] == "choose_slot"
    assert body["ship"]["shipId"] == harb["shipId"]
    assert body["slots"] == [
        {"slot": SHIELD_1, "type": "Shield", "size": "S2", "current": {"name": "SecureShield"}},
        {"slot": SHIELD_2, "type": "Shield", "size": "S2", "current": {"name": "SecureShield"}},
    ]
    assert fitted(client, harb["shipId"]) == {}


def test_fit_all_fills_every_compatible_slot(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "Harbinger", LORICA, slot="all")
    assert r.status_code == 200, r.text
    assert [c["slot"] for c in r.json()["changes"]] == [SHIELD_1, SHIELD_2]
    assert all(c["from"]["name"] == "SecureShield" and c["to"]["name"] == "7MA 'Lorica'"
               for c in r.json()["changes"])
    assert set(fitted(client, harb["shipId"])) == {SHIELD_1, SHIELD_2}


def test_fit_all_skips_slots_already_holding_the_item(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", LORICA, slot="1")
    r = fit(client, "Harbinger", LORICA, slot="both")
    assert r.status_code == 200
    assert [c["slot"] for c in r.json()["changes"]] == [SHIELD_2]
    assert set(fitted(client, harb["shipId"])) == {SHIELD_1, SHIELD_2}


@pytest.mark.parametrize("hint,slot", [("2", SHIELD_2), ("001", SHIELD_1), ("second shield", SHIELD_2),
                                       (SHIELD_2, SHIELD_2), (SHIELD_1.upper(), SHIELD_1)])
def test_fit_slot_hint(client, hint, slot):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "Harbinger", LORICA, slot=hint)
    assert r.status_code == 200, r.text
    assert [c["slot"] for c in r.json()["changes"]] == [slot]
    assert set(fitted(client, harb["shipId"])) == {slot}


def test_fit_numbered_gun_hint_ignores_shared_class_suffix(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "Harbinger", BRVS)
    assert r.status_code == 409 and len(r.json()["slots"]) == 4
    r = fit(client, "Harbinger", BRVS, slot="2")
    assert r.status_code == 200, r.text
    assert [c["slot"] for c in r.json()["changes"]] == [NOSE.format(2)]
    assert r.json()["changes"][0]["from"]["name"] == "CVSA Cannon"
    assert set(fitted(client, harb["shipId"])) == {NOSE.format(2)}


def test_fit_hint_matching_several_or_none_asks_choose_slot(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "Harbinger", BRVS, slot="nose")
    assert r.status_code == 409 and r.json()["error"] == "choose_slot"
    assert len(r.json()["slots"]) == 4
    r = fit(client, "Harbinger", LORICA, slot="tail")
    assert r.status_code == 409 and r.json()["error"] == "choose_slot"
    assert "tail" in r.json()["message"] and len(r.json()["slots"]) == 2
    assert fitted(client, harb["shipId"]) == {}


def test_fit_exact_slot_id_of_incompatible_slot_is_422(client):
    add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "Harbinger", "Hemera", slot=SHIELD_1)
    assert r.status_code == 422 and r.json()["error"] == "incompatible"
    assert "Hemera" in r.json()["message"]


def test_fit_size_mismatch_is_422_size_mismatch(client):
    taurus = add_ship(client, vehicle=TAURUS_UUID)
    r = fit(client, "Connie", LORICA)        # S2 shield, Taurus shield slot is S3
    assert r.status_code == 422
    body = r.json()
    assert body["error"] == "incompatible" and body["reason"] == "size_mismatch"
    assert "size 2" in body["message"] and "S3" in body["message"]
    assert body["slots"] == [{"slot": "hardpoint_shield_generator", "type": "Shield", "size": "S3",
                              "current": {"name": "Stronghold"}}]
    assert fitted(client, taurus["shipId"]) == {}


def test_fit_no_slot_of_that_type_is_422_no_slot(client):
    add_ship(client, vehicle=TAURUS_UUID)

    async def tractor(_ident):
        return {"uuid": "tb-1", "name": "Grav Tractor", "type": "TractorBeam", "subType": None, "size": 1}
    client.app.state.catalog.item = tractor
    r = fit(client, "Connie", "Grav Tractor")
    assert r.status_code == 422
    assert r.json()["error"] == "incompatible" and r.json()["reason"] == "no_slot"
    assert "TractorBeam" in r.json()["message"]


def test_fit_gun_skips_mount_slots_that_have_a_gun_child(client):
    add_ship(client, vehicle=TAURUS_UUID)

    async def s5_gun(_ident):
        return {"uuid": "g5", "name": "Big Gun", "type": "WeaponGun", "subType": "Gun", "size": 5}
    client.app.state.catalog.item = s5_gun
    r = fit(client, "Connie", "Big Gun")
    assert r.status_code == 409
    slots = [s["slot"] for s in r.json()["slots"]]
    assert len(slots) == 4 and all(s.endswith("/hardpoint_class_2") for s in slots)


def test_fit_fitting_stock_item_back_clears_the_override(client):
    taurus = add_ship(client, vehicle=TAURUS_UUID)
    fit(client, "Connie", "Hemera")
    stock = "74cc0d0b-1bf5-436c-a38c-1baf93962b89"

    async def bolon(_ident):
        return {"uuid": stock, "name": "Bolon", "type": "QuantumDrive", "subType": "UNDEFINED", "size": 2}
    client.app.state.catalog.item = bolon
    r = fit(client, "Connie", "Bolon")
    assert r.status_code == 200
    assert r.json()["changes"] == [{"slot": QD, "from": {"name": "Hemera", "uuid": HEMERA_UUID},
                                    "to": {"name": "Bolon", "uuid": stock}}]
    assert fitted(client, taurus["shipId"]) == {}


# ---------- fit: resolution errors never write ----------

def test_fit_unknown_ship_404_lists_owned(client):
    add_ship(client, vehicle=TAURUS_UUID)
    add_ship(client, vehicle=HARBINGER_UUID, nickname="Big Bertha")
    r = fit(client, "Polaris", "Hemera")
    assert r.status_code == 404
    body = r.json()
    assert body["error"] == "not_found" and "Polaris" in body["message"]
    assert [o["label"] for o in body["owned"]] == ["Constellation Taurus", "\"Big Bertha\" (Vanguard Harbinger)"]


def test_fit_empty_hangar_404(client):
    r = fit(client, "Connie", "Hemera")
    assert r.status_code == 404 and r.json()["owned"] == []


def test_fit_ambiguous_ship_409_with_candidates(client):
    a = add_ship(client, vehicle=TAURUS_UUID)
    b = add_ship(client, vehicle=TAURUS_UUID)
    r = fit(client, "Connie", "Hemera")
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "ambiguous"
    assert body["candidates"] == [
        {"shipId": a["shipId"], "label": f"Constellation Taurus (ship {a['shipId']})"},
        {"shipId": b["shipId"], "label": f"Constellation Taurus (ship {b['shipId']})"},
    ]
    assert all(s["fitted"] == {} for s in hangar(client))


def test_fit_unknown_item_404_writes_nothing(client):
    taurus = add_ship(client, vehicle=TAURUS_UUID)
    r = fit(client, "Connie", "No Such Drive")
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    assert "No Such Drive" in r.json()["message"]
    assert fitted(client, taurus["shipId"]) == {}


@pytest.mark.parametrize("body", [{}, {"ship": "Connie"}, {"item": "Hemera"}, {"ship": "", "item": "x"},
                                  {"ship": "Connie", "item": 3}, {"ship": "Connie", "item": "Hemera", "slot": 2},
                                  {"ship": "x" * 201, "item": "Hemera"}])
def test_fit_bad_body_400(client, body):
    add_ship(client, vehicle=TAURUS_UUID)
    r = client.post(f"/v1/members/{SELF}/fit", json=body, headers=H())
    assert r.status_code == 400 and r.json()["error"] == "invalid_request"


def test_fit_catalog_down_is_503(client):
    add_ship(client, vehicle=TAURUS_UUID)
    from src.http import UpstreamError

    async def down(_ident):
        raise UpstreamError("wiki", 503, "down")
    client.app.state.catalog.item = down
    r = fit(client, "Connie", "Hemera")
    assert r.status_code == 503 and r.json()["error"] == "unavailable"


# ---------- permissions ----------

def test_fit_for_other_member_forbidden_and_writes_nothing(client):
    taurus = add_ship(client, vehicle=TAURUS_UUID, member=OTHER)
    r = fit(client, "Connie", "Hemera", member=OTHER, acting=SELF)
    assert r.status_code == 403 and r.json()["error"] == "forbidden"
    assert fitted(client, taurus["shipId"], member=OTHER) == {}
    r = client.post(f"/v1/members/{SELF}/fit", json={"ship": "Connie", "item": "Hemera"}, headers=H(acting=None))
    assert r.status_code == 403


def test_reset_for_other_member_forbidden(client):
    add_ship(client, vehicle=TAURUS_UUID, member=OTHER)
    fit(client, "Connie", "Hemera", member=OTHER)
    r = reset(client, "Connie", "all", member=OTHER, acting=SELF)
    assert r.status_code == 403
    assert hangar(client, OTHER)[0]["fitted"] != {}


def test_admin_may_fit_and_reset_for_other_member(client):
    add_ship(client, vehicle=TAURUS_UUID, member=OTHER)
    assert fit(client, "Connie", "Hemera", member=OTHER, acting=ADMIN).status_code == 200
    assert hangar(client, OTHER)[0]["updatedBy"] == ADMIN
    assert reset(client, "Connie", "all", member=OTHER, acting=ADMIN).status_code == 200


def test_routes_served_under_api_prefix_too(client):
    add_ship(client, vehicle=TAURUS_UUID)
    assert fit(client, "Connie", "Hemera", prefix="/api/v1").status_code == 200
    r = client.post(f"/api/v1/members/{SELF}/ships/Connie/reset", json={"slot": "all"}, headers=H())
    assert r.status_code == 200 and len(r.json()["changes"]) == 1


# ---------- reset ----------

def test_reset_one_slot_by_hint(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", LORICA, slot="all")
    fit(client, "Harbinger", "Hemera")
    r = reset(client, "harb", "shield 2")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ship"]["shipId"] == harb["shipId"]
    assert body["changes"] == [{"slot": SHIELD_2, "from": {"name": "7MA 'Lorica'", "uuid": LORICA_UUID},
                                "to": {"name": "SecureShield", "uuid": "c8b42a1b-2000-4d7e-8888-208480c739b6"}}]
    assert set(fitted(client, harb["shipId"])) == {SHIELD_1, QD}


def test_reset_plural_type_hint_resets_every_fitted_slot_of_that_type(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", LORICA, slot="all")
    fit(client, "Harbinger", "Hemera")
    r = reset(client, "Harbinger", "shields")
    assert r.status_code == 200
    assert [c["slot"] for c in r.json()["changes"]] == [SHIELD_1, SHIELD_2]
    assert set(fitted(client, harb["shipId"])) == {QD}


def test_reset_singular_hint_narrows_to_the_refitted_slot(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", LORICA, slot="1")
    r = reset(client, "Harbinger", "shield")         # two shield slots, only one refitted
    assert r.status_code == 200
    assert [c["slot"] for c in r.json()["changes"]] == [SHIELD_1]
    assert fitted(client, harb["shipId"]) == {}


def test_reset_singular_hint_with_several_refitted_asks_choose_slot(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", LORICA, slot="all")
    r = reset(client, "Harbinger", "shield")
    assert r.status_code == 409 and r.json()["error"] == "choose_slot"
    assert [s["slot"] for s in r.json()["slots"]] == [SHIELD_1, SHIELD_2]
    assert r.json()["slots"][0]["current"] == {"name": "7MA 'Lorica'"}
    assert len(fitted(client, harb["shipId"])) == 2


def test_reset_all(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", LORICA, slot="all")
    fit(client, "Harbinger", "Hemera")
    r = reset(client, "Harbinger", "all")
    assert r.status_code == 200
    assert {c["slot"] for c in r.json()["changes"]} == {SHIELD_1, SHIELD_2, QD}
    qd = next(c for c in r.json()["changes"] if c["slot"] == QD)
    assert qd["to"]["name"] == "Yeager"
    assert fitted(client, harb["shipId"]) == {}


def test_reset_already_stock_is_noop(client):
    add_ship(client, vehicle=HARBINGER_UUID)
    for slot in ("all", "shield 1", None):
        r = reset(client, "Harbinger", slot)
        assert r.status_code == 200, r.text
        assert r.json()["changes"] == [] and r.json()["unchanged"] is True


def test_reset_hint_on_stock_slot_is_noop(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", "Hemera")
    r = reset(client, "Harbinger", "shield 1")
    assert r.status_code == 200 and r.json()["unchanged"] is True
    assert set(fitted(client, harb["shipId"])) == {QD}


def test_reset_without_slot(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", "Hemera")
    r = reset(client, "Harbinger")                    # exactly one refitted slot -> it
    assert r.status_code == 200 and [c["slot"] for c in r.json()["changes"]] == [QD]
    fit(client, "Harbinger", "Hemera")
    fit(client, "Harbinger", LORICA, slot="1")
    r = reset(client, "Harbinger")                    # several -> ask
    assert r.status_code == 409 and r.json()["error"] == "choose_slot"
    assert {s["slot"] for s in r.json()["slots"]} == {QD, SHIELD_1}
    assert len(fitted(client, harb["shipId"])) == 2


def test_reset_hint_matching_nothing_asks_choose_slot(client):
    add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", "Hemera")
    r = reset(client, "Harbinger", "tail")
    assert r.status_code == 409 and r.json()["error"] == "choose_slot"
    assert [s["slot"] for s in r.json()["slots"]] == [QD]


def test_reset_orphaned_slot_by_exact_id(client, repo):
    import asyncio
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    asyncio.run(repo.set_slot(SELF, harb["shipId"], "renamed_in_patch", item_uuid="u", item_name="Old",
                              updated_by=SELF))
    r = reset(client, "Harbinger", "renamed_in_patch")
    assert r.status_code == 200
    assert r.json()["changes"] == [{"slot": "renamed_in_patch", "from": {"name": "Old", "uuid": "u"},
                                    "to": {"name": None, "uuid": None}}]
    assert fitted(client, harb["shipId"]) == {}


def test_reset_unknown_and_ambiguous_ship(client):
    add_ship(client, vehicle=TAURUS_UUID)
    add_ship(client, vehicle=TAURUS_UUID)
    r = reset(client, "Polaris", "all")
    assert r.status_code == 404 and r.json()["error"] == "not_found" and len(r.json()["owned"]) == 2
    r = reset(client, "Connie", "all")
    assert r.status_code == 409 and r.json()["error"] == "ambiguous" and len(r.json()["candidates"]) == 2


def test_reset_ship_ref_with_spaces_url_encoded(client):
    add_ship(client, vehicle=HARBINGER_UUID, nickname="Big Bertha")
    fit(client, "Big Bertha", "Hemera")
    r = client.post(f"/v1/members/{SELF}/ships/Big%20Bertha/reset", json={"slot": "all"}, headers=H())
    assert r.status_code == 200 and len(r.json()["changes"]) == 1


def test_reset_empty_body_allowed(client):
    add_ship(client, vehicle=HARBINGER_UUID)
    r = client.post(f"/v1/members/{SELF}/ships/Harbinger/reset", headers=H())
    assert r.status_code == 200 and r.json()["unchanged"] is True


def test_fit_and_reset_log_each_write(client, caplog):
    import logging
    add_ship(client, vehicle=TAURUS_UUID)
    with caplog.at_level(logging.INFO, logger="src.app"):
        fit(client, "Connie", "Hemera")
        reset(client, "Connie", "all")
    msgs = [r.getMessage() for r in caplog.records]
    assert any("chat fit" in m and QD in m and "Bolon -> Hemera" in m and f"member {SELF}" in m for m in msgs)
    assert any("chat reset" in m and QD in m and "Hemera -> Bolon" in m for m in msgs)


def test_fit_exact_slot_id_of_too_small_slot_is_size_mismatch(client):
    add_ship(client, vehicle=TAURUS_UUID)
    r = fit(client, "Connie", LORICA, slot="hardpoint_shield_generator")
    assert r.status_code == 422 and r.json()["reason"] == "size_mismatch"


# ---------- fix round 1: one atomic write per request ----------

class WriteSpy:
    def __init__(self, repo):
        self.repo, self.calls = repo, []
        for name in ("set_slot", "clear_slot", "replace_fitted"):
            setattr(repo, name, self._forbidden(name))
        self._orig = repo.update_slots
        repo.update_slots = self._update
        self.before = None

    def _forbidden(self, name):
        async def f(*a, **k):
            raise AssertionError(f"chat edits must not call {name}")
        return f

    async def _update(self, member, ship_id, slots, **kw):
        self.calls.append(dict(slots))
        if self.before is not None:
            await self.before(member, ship_id)
        return await self._orig(member, ship_id, slots, **kw)


def test_fit_all_is_one_update_slots_write(client, repo):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    spy = WriteSpy(repo)
    r = fit(client, "Harbinger", LORICA, slot="all")
    assert r.status_code == 200
    assert spy.calls == [{SHIELD_1: {"itemUuid": LORICA_UUID, "itemName": "7MA 'Lorica'"},
                          SHIELD_2: {"itemUuid": LORICA_UUID, "itemName": "7MA 'Lorica'"}}]
    assert set(fitted(client, harb["shipId"])) == {SHIELD_1, SHIELD_2}


def test_fit_noop_does_not_write(client, repo):
    add_ship(client, vehicle=TAURUS_UUID)
    fit(client, "Connie", "Hemera")
    spy = WriteSpy(repo)
    assert fit(client, "Connie", "Hemera").json()["unchanged"] is True
    assert spy.calls == []


def test_reset_all_deletes_exactly_the_slots_read(client, repo):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", LORICA, slot="all")
    fit(client, "Harbinger", "Hemera")
    spy = WriteSpy(repo)
    orig_set = type(repo).set_slot

    async def concurrent_editor(member, ship_id):   # lands between the read and the write
        await orig_set(repo, member, ship_id, "hardpoint_radar", item_uuid="rad", item_name="New Radar",
                       updated_by=member)
    spy.before = concurrent_editor
    r = reset(client, "Harbinger", "all")
    assert r.status_code == 200
    assert spy.calls == [{SHIELD_1: None, SHIELD_2: None, QD: None}]
    assert {c["slot"] for c in r.json()["changes"]} == {SHIELD_1, SHIELD_2, QD}
    assert fitted(client, harb["shipId"]) == {"hardpoint_radar": {"itemUuid": "rad", "itemName": "New Radar"}}


def test_partial_reset_is_one_write(client, repo):
    add_ship(client, vehicle=HARBINGER_UUID)
    fit(client, "Harbinger", LORICA, slot="all")
    fit(client, "Harbinger", "Hemera")
    spy = WriteSpy(repo)
    r = reset(client, "Harbinger", "shields")
    assert r.status_code == 200 and spy.calls == [{SHIELD_1: None, SHIELD_2: None}]


def test_failed_write_is_503_and_logs_no_change(client, repo, caplog):
    import logging
    from src.repository import RepositoryError
    add_ship(client, vehicle=HARBINGER_UUID)

    async def boom(*a, **k):
        raise RepositoryError("firestore down")
    repo.update_slots = boom
    with caplog.at_level(logging.INFO, logger="src.app"):
        r = fit(client, "Harbinger", LORICA, slot="all")
    assert r.status_code == 503
    assert not any("chat fit" in rec.getMessage() for rec in caplog.records)


def test_reset_with_vehicle_gone_from_catalog(client, repo):
    import asyncio as _a
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    _a.run(repo.update_slots(SELF, harb["shipId"], {"a": {"itemUuid": "1", "itemName": "A"},
                                                     "b": {"itemUuid": "2", "itemName": "B"}}, updated_by=SELF))

    async def gone(_uuid):
        return None
    client.app.state.catalog.slots = gone
    r = reset(client, "Harbinger", "a")
    assert r.status_code == 200
    assert r.json()["changes"] == [{"slot": "a", "from": {"name": "A", "uuid": "1"},
                                    "to": {"name": None, "uuid": None}}]
    r = reset(client, "Harbinger", "all")
    assert r.status_code == 200 and [c["slot"] for c in r.json()["changes"]] == ["b"]
    assert fitted(client, harb["shipId"]) == {}


def test_both_with_more_than_two_slots_asks(client):
    harb = add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "Harbinger", BRVS, slot="both")
    assert r.status_code == 409 and r.json()["error"] == "choose_slot" and len(r.json()["slots"]) == 4
    assert fit(client, "Harbinger", BRVS, slot="all").status_code == 200
    r = reset(client, "Harbinger", "both")
    assert r.status_code == 409 and r.json()["error"] == "choose_slot"
    assert len(fitted(client, harb["shipId"])) == 4
    r = fit(client, "Harbinger", LORICA, slot="both")
    assert r.status_code == 200 and len(r.json()["changes"]) == 2


# ---------- fix round 1: fuzzy item resolution ----------

@pytest.mark.parametrize("text,by", [("Hemera", "exact"), ("hemera qd", "exact"),
                                     ("the hemera quantum drive", "exact"), ("hemra", "fuzzy")])
def test_fit_spoken_item_names(client, text, by):
    taurus = add_ship(client, vehicle=TAURUS_UUID)
    r = fit(client, "Connie", text)
    assert r.status_code == 200, r.text
    assert r.json()["item"]["name"] == "Hemera" and r.json()["item"]["matchedBy"] == by
    assert fitted(client, taurus["shipId"]) == {QD: {"itemUuid": HEMERA_UUID, "itemName": "Hemera"}}


def test_fit_lorica_shields(client):
    add_ship(client, vehicle=HARBINGER_UUID)
    r = fit(client, "Harbinger", "lorica shields", slot="1")
    assert r.status_code == 200, r.text
    assert r.json()["item"] == {"uuid": LORICA_UUID, "name": "7MA 'Lorica'", "type": "Shield", "size": 2,
                                "matchedBy": "fuzzy"}


def test_fit_ambiguous_item_409_field_item(client):
    taurus = add_ship(client, vehicle=TAURUS_UUID)
    r = fit(client, "Connie", "bol")
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "ambiguous" and body["field"] == "item"
    assert [c["name"] for c in body["candidates"]] == ["Bolon", "Bolt"]
    assert set(body["candidates"][0]) == {"uuid", "name", "type", "size"}
    assert fitted(client, taurus["shipId"]) == {}


def test_fit_unknown_item_has_field_and_suggestions(client):
    add_ship(client, vehicle=TAURUS_UUID)
    r = fit(client, "Connie", "Hemeroid quantum drive")
    assert r.status_code == 404
    body = r.json()
    assert body["error"] == "not_found" and body["field"] == "item"
    assert isinstance(body["suggestions"], list) and len(body["suggestions"]) <= 3


def test_ship_errors_carry_field_ship(client):
    add_ship(client, vehicle=TAURUS_UUID)
    add_ship(client, vehicle=TAURUS_UUID)
    assert fit(client, "Connie", "Hemera").json()["field"] == "ship"
    assert fit(client, "Polaris", "Hemera").json()["field"] == "ship"
