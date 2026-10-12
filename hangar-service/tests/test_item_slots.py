"""Slots that come from fitted items, items the Wiki list omits (UEX
supplement) and the spviewer import of a ship whose turrets carry the guns --
pinned against recorded F7C Hornet Mk II payloads (vehicle, the Hornet turrets,
the TMSB-5 and four guns; UEX category 35) and the real spviewer export
``spviewer_f7c_mk2.json``. Spec: 2026-10-11-hangar-item-slots-design.md."""
import copy
import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from src.app import create_app
from src.cache import TTLCache
from src.catalog import MAX_SUPPLEMENT_ITEMS, NEGATIVE_TTL_S, Slot, build_catalog
from src.http import UpstreamError
from src.loadout import (MAX_DYNAMIC_DEPTH, MAX_DYNAMIC_LOOKUPS, effective_loadout, prune_descendants,
                         resolve_slots)
from src.lzstring import decompress_from_encoded_uri_component
from src.repository import InMemoryShipRepository
from src.spviewer import TOO_MANY_LOOKUPS, UNTRACKED_SLOT, DecodeBudget, analyze_row
from tests.conftest import F7C_UUID, HARBINGER_UUID, f7c_items, load_fixture, uex_handler, wiki_handler
from tests.lzcompress import compress_to_encoded_uri_component as lz
from tests.test_app import SELF, H, add_ship, cfg, fake_verifier
from tests.test_browser_auth import BROWSER_ENV, ORIGIN, Clock as AuthClock
from tests.test_spviewer import LORICA, SECURESHIELD, _port, row_with, stock_loadout

C5 = "ea532b81-bbe5-4cc1-aede-4566ab44607e"        # C5-173f S5 Hornet Mk II Ball Turret
NOSE_S2 = "8b896a16-2f1f-4c1a-9a91-cad86863004d"   # Anvil Hornet Mk II S2 Nose Turret (size 3)
TMSB = "4b2e4ce4-ac79-4923-bfdd-ccce02129b27"      # TMSB-5 Ball Turret (two-level ports)
TMSB_GIMBAL = "fbccf8e2-2085-48c3-bfa8-00226450636d"
AD4B = "e4afc8b4-da61-4efb-af7e-f003d9900d96"      # AD4B Ballistic Gatling (WeaponGun S4)
MANTIS = "b837397c-47b6-45e7-b409-db290a068b47"    # Mantis GT-220 Gatling (WeaponGun S3)
M4A = "2756f5f1-ef1e-454a-a171-9a5bd40e3a9d"       # M4A Cannon (WeaponGun S2)
REVENANT = "df89e9ca-8a11-477c-8abd-f4837a277dbe"  # Revenant Gatling (WeaponGun S4, wing stock)
CARGO = "d2f911b6-d68c-439e-b862-3ccd736366ab"     # Stor*All Big Box Model H2 (centre stock)
CENTER, NOSE = "hardpoint_weapon_center", "hardpoint_weapon_nose"
RIGHT_WING = "hardpoint_weapon_right_wing/hardpoint_class_2"
LEFT_WING = "hardpoint_weapon_left_wing/hardpoint_class_2"
S3L, S3R = f"{CENTER}/hardpoint_weapon_S3_left", f"{CENTER}/hardpoint_weapon_S3_right"
S1L, S1R = f"{NOSE}/hardpoint_weapon_S1_left", f"{NOSE}/hardpoint_weapon_S1_right"
TL, TR = f"{CENTER}/hardpoint_weapon_left", f"{CENTER}/hardpoint_weapon_right"
WIKI = "https://api.star-citizen.wiki/api"
UEX = "https://api.uexcorp.uk/2.0"


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


async def _nosleep(_):
    return None


def make_catalog(calls=None, fail=None, *, uex=False, uex_calls=None, uex_fail=None, uex_rows=None,
                 clock=None, bearer=None, **wiki_kw):
    kw = {}
    if uex:
        kw = {"uex_base": UEX, "uex_bearer": bearer,
              "uex_transport": httpx.MockTransport(uex_handler(uex_calls, uex_fail, uex_rows))}
    return build_catalog(WIKI, version="test", transport=httpx.MockTransport(wiki_handler(calls, fail, **wiki_kw)),
                         cache=TTLCache(clock=clock) if clock else None, sleep=_nosleep, **kw)


def _item_calls(calls):
    return [c.url.path.rsplit("/", 1)[1] for c in calls if c.url.path.startswith("/api/v2/items/")]


def variant(uuid, name, *, base=TMSB, drop_ports=(), sizes=None) -> dict:
    """A copy of a recorded turret under another uuid/name, optionally without
    some ports or with resized ports -- "the same port names on another item"."""
    rec = copy.deepcopy(f7c_items()[base])
    rec.update(uuid=uuid, name=name, class_name=name.replace(" ", "_"))
    rec["ports"] = [p for p in rec["ports"] if p["name"] not in drop_ports]
    for p in rec["ports"]:
        if sizes and p["name"] in sizes:
            p["sizes"] = {"min": sizes[p["name"]], "max": sizes[p["name"]]}
    return rec


# ---------- catalog.item_slots ----------

async def test_item_slots_of_the_hornet_turrets():
    cat = make_catalog()
    c5 = await cat.item_slots(C5)
    assert [(s.name, s.type, s.size_min, s.size_max, s.stock_item) for s in c5] == [
        ("hardpoint_weapon_S3_left", "WeaponGun", 3, 3, None),
        ("hardpoint_weapon_S3_right", "WeaponGun", 3, 3, None)]
    assert c5[0].compatible_types == [{"type": "WeaponGun", "sub_types": ["Gun"]}]
    nose = await cat.item_slots(NOSE_S2)
    assert [(s.name, s.size_min, s.size_max) for s in nose] == [
        ("hardpoint_weapon_S1_left", 2, 2), ("hardpoint_weapon_S1_right", 2, 2)]


async def test_item_slots_are_walked_at_every_depth_with_the_port_default_as_stock():
    slots = await make_catalog().item_slots(TMSB)
    assert [s.name for s in slots] == [
        "hardpoint_weapon_left", "hardpoint_weapon_left/hardpoint_class_2",
        "hardpoint_weapon_right", "hardpoint_weapon_right/hardpoint_class_2"]
    assert slots[0].stock_item["uuid"] == TMSB_GIMBAL and slots[0].stock_item["name"] == "TMSB-5 Gimbal Mount"
    assert {c["type"] for c in slots[0].compatible_types} == {"WeaponGun", "Turret"}
    assert slots[1].stock_item is None and (slots[1].size_min, slots[1].size_max) == (4, 4)


async def test_item_slots_empty_for_a_gun_and_none_for_an_unknown_item():
    cat = make_catalog()
    assert await cat.item_slots(AD4B) == []          # only non-editable attachment ports
    assert await cat.item_slots("00000000-0000-4000-8000-000000000000") is None


async def test_item_slots_share_the_item_cache_entry_and_return_copies():
    calls = []
    cat = make_catalog(calls)
    assert (await cat.item(C5))["name"] == "C5-173f S5 Hornet Mk II Ball Turret"
    first = await cat.item_slots(C5)
    first.pop()
    assert len(await cat.item_slots(C5)) == 2
    assert _item_calls(calls) == [C5]


# ---------- UEX supplement ----------

async def test_supplement_merges_items_the_wiki_list_omits():
    calls, uex_calls = [], []
    cat = make_catalog(calls, uex=True, uex_calls=uex_calls)
    names = {i["name"] for i in await cat.items("Turret")}
    assert names == {"C5-173f S5 Hornet Mk II Ball Turret", "Anvil Hornet Mk II S2 Nose Turret", "TMSB-5 Ball Turret"}
    assert [(c.url.path, c.url.params["id_category"]) for c in uex_calls] == [("/2.0/items", "35")]
    # every UEX uuid the Wiki list lacks was looked up once (rows without a uuid never)
    uex_uuids = [r["uuid"] for r in load_fixture("uex_items_category_35.json")["data"] if r["uuid"]]
    assert len(uex_uuids) == 31 and sorted(_item_calls(calls)) == sorted(uex_uuids)
    # cached per type: no second UEX call, no more detail calls
    await cat.items("Turret")
    await cat.item_options("Turret", 5)
    assert len(uex_calls) == 1 and len(_item_calls(calls)) == 31
    option = next(i for i in await cat.item_options("Turret") if i["uuid"] == C5)
    assert option["cheapestPrice"]["price"] > 0 and option["subType"] == "BallTurret"


async def test_supplement_is_size_filtered_like_the_wiki_list():
    cat = make_catalog(uex=True)
    assert {i["uuid"] for i in await cat.items("Turret", size=5)} == {C5, TMSB}
    assert {i["uuid"] for i in await cat.items("Turret", size=3)} == {NOSE_S2}
    assert await cat.items("Turret", size=1) == []


async def test_supplement_skips_items_already_in_the_wiki_list():
    calls = []
    listed = f7c_items()[C5]
    cat = make_catalog(calls, uex=True, extra_listed=[listed])
    items = await cat.items("Turret")
    assert [i["uuid"] for i in items].count(C5) == 1
    assert C5 not in _item_calls(calls)


async def test_supplement_drops_items_whose_wiki_type_differs():
    rows = {"35": [{"uuid": C5, "name": "turret"}, {"uuid": AD4B, "name": "a gun filed under turrets"}]}
    cat = make_catalog(uex=True, uex_rows=rows)
    assert [i["uuid"] for i in await cat.items("Turret")] == [C5]


async def test_supplement_only_sends_well_formed_uuids_to_the_wiki():
    calls = []
    rows = {"35": [{"uuid": "../../vehicles"}, {"uuid": 7}, {"uuid": ""}, "junk", {"uuid": C5}, {"uuid": C5.upper()}]}
    cat = make_catalog(calls, uex=True, uex_rows=rows)
    assert [i["uuid"] for i in await cat.items("Turret")] == [C5]
    assert _item_calls(calls) == [C5]


async def test_supplement_is_capped_and_the_count_is_logged(caplog):
    calls = []
    rows = {"35": [{"uuid": f"00000000-0000-4000-8000-{i:012d}"} for i in range(MAX_SUPPLEMENT_ITEMS + 10)]}
    cat = make_catalog(calls, uex=True, uex_rows=rows)
    with caplog.at_level(logging.WARNING, logger="src.catalog"):
        assert await cat.items("Turret") == []
    assert MAX_SUPPLEMENT_ITEMS == 40 and len(_item_calls(calls)) == 40
    assert any("50 Turret items" in r.getMessage() for r in caplog.records)


async def test_types_without_a_uex_category_get_no_supplement():
    uex_calls = []
    cat = make_catalog(uex=True, uex_calls=uex_calls)
    await cat.items("Radar")
    assert uex_calls == []
    await cat.items("Shield")
    assert [c.url.params["id_category"] for c in uex_calls] == ["23"]


async def test_uex_down_serves_the_wiki_list_alone_and_retries_after_the_negative_ttl(caplog):
    clock, uex_calls, down = Clock(), [], [True]
    listed = variant("11111111-1111-4111-8111-111111111111", "Listed Turret")
    cat = make_catalog(uex=True, uex_calls=uex_calls, uex_fail=lambda r: down[0], clock=clock,
                       extra_listed=[listed])
    with caplog.at_level(logging.WARNING, logger="src.catalog"):
        assert [i["name"] for i in await cat.items("Turret")] == ["Listed Turret"]
    assert any("UEX supplement for Turret" in r.getMessage() for r in caplog.records)
    attempts = len(uex_calls)
    assert attempts == 3                      # one request, retried by the upstream client
    clock.t += NEGATIVE_TTL_S - 1             # the failure is remembered for the negative TTL ...
    down[0] = False
    assert [i["name"] for i in await cat.items("Turret")] == ["Listed Turret"]
    assert len(uex_calls) == attempts
    clock.t += 2                              # ... and not for 12h
    assert {i["uuid"] for i in await cat.items("Turret")} >= {C5, NOSE_S2, TMSB}
    assert len(uex_calls) == attempts + 1


async def test_a_failed_refresh_keeps_the_last_good_supplement():
    clock, down = Clock(), [False]
    cat = make_catalog(uex=True, uex_fail=lambda r: down[0], clock=clock)
    assert {i["uuid"] for i in await cat.items("Turret")} == {C5, NOSE_S2, TMSB}
    down[0] = True
    clock.t += 12 * 3600 + 1
    assert {i["uuid"] for i in await cat.items("Turret")} == {C5, NOSE_S2, TMSB}


async def test_wiki_detail_failure_fails_only_the_supplement():
    cat = make_catalog(fail=lambda r: r.url.path.endswith(C5), uex=True,
                       extra_listed=[variant("11111111-1111-4111-8111-111111111111", "Listed Turret")])
    assert [i["name"] for i in await cat.items("Turret")] == ["Listed Turret"]


async def test_uex_bearer_is_sent_but_never_logged(caplog):
    secret = "uex-secret-bearer-token"
    uex_calls = []
    cat = make_catalog(uex=True, uex_calls=uex_calls, uex_fail=lambda r: True, bearer=secret)
    with caplog.at_level(logging.DEBUG):
        assert await cat.items("Turret") == []
    assert uex_calls and all(c.headers["authorization"] == f"Bearer {secret}" for c in uex_calls)
    assert caplog.records and not any(secret in r.getMessage() or secret in str(r.exc_info or "")
                                      for r in caplog.records)
    # no bearer configured -> no Authorization header at all
    plain_calls = []
    await make_catalog(uex=True, uex_calls=plain_calls).items("Turret")
    assert plain_calls and "authorization" not in plain_calls[0].headers


async def test_no_uex_base_means_no_supplement():
    assert await make_catalog().items("Turret") == []


def test_uex_config_env():
    c = cfg()
    assert c.uex_base == "https://api.uexcorp.uk/2.0" and c.uex_bearer == ""
    c = cfg(UEX_BASE="https://uex.example/2.0", UEXCORP_BEARER="s3cret")
    assert c.uex_base == "https://uex.example/2.0" and c.uex_bearer == "s3cret"
    assert "s3cret" not in repr(c)


# ---------- resolve_slots ----------

def _slot(name, type_="Turret", size=5, compat=("Turret", "WeaponGun"), stock=None) -> Slot:
    return Slot(name, type_, None, size, size, [{"type": t, "sub_types": []} for t in compat], stock)


class FakeItems:
    """``item_slots`` / ``item`` from tables; records the uuids looked up."""

    def __init__(self, slots=None, items=None, fail=()):
        self.slots, self.items, self.fail, self.looked_up = slots or {}, items or {}, set(fail), []

    async def item_slots(self, uuid):
        self.looked_up.append(uuid)
        if uuid in self.fail:
            raise UpstreamError("wiki", 503, "down")
        found = self.slots.get(uuid)
        return copy.deepcopy(found) if found is not None else None

    async def item(self, uuid):
        return self.items.get(uuid)


async def _f7c_slots(cat):
    return await cat.slots(F7C_UUID)


def _fit(uuid, name="x"):
    return {"itemUuid": uuid, "itemName": name}


async def test_resolve_without_fittings_is_the_vehicle_list():
    cat = make_catalog()
    vehicle = await _f7c_slots(cat)
    assert [s.name for s in await resolve_slots(cat, vehicle, {})] == [s.name for s in vehicle]
    assert CENTER in [s.name for s in vehicle] and NOSE in [s.name for s in vehicle]
    assert not any(s.name.startswith((CENTER + "/", NOSE + "/")) for s in vehicle)


async def test_a_fitted_turrets_gun_ports_follow_it_as_dynamic_slots():
    cat = make_catalog()
    vehicle = await _f7c_slots(cat)
    slots = await resolve_slots(cat, vehicle, {CENTER: _fit(C5), NOSE: _fit(NOSE_S2)})
    names = [s.name for s in slots]
    i, j = names.index(CENTER), names.index(NOSE)
    assert names[i:i + 3] == [CENTER, S3L, S3R] and names[j:j + 3] == [NOSE, S1L, S1R]
    assert [s.dynamic for s in slots if s.name in (S3L, S3R, S1L, S1R)] == [True] * 4
    assert not any(s.dynamic for s in slots if s.name not in (S3L, S3R, S1L, S1R))
    assert len(slots) == len(vehicle) + 4
    gun = next(s for s in slots if s.name == S3L)
    assert (gun.type, gun.size_min, gun.size_max, gun.stock_item) == ("WeaponGun", 3, 3, None)
    assert gun.to_dict()["dynamic"] is True and "dynamic" not in slots[i].to_dict()


async def test_an_item_fitted_in_a_port_of_a_fitted_item_resolves_too():
    cat = make_catalog()
    vehicle = await _f7c_slots(cat)
    slots = await resolve_slots(cat, vehicle, {CENTER: _fit(TMSB)})
    names = [s.name for s in slots]
    i = names.index(CENTER)
    assert names[i:i + 5] == [CENTER, TL, f"{TL}/hardpoint_class_2", TR, f"{TR}/hardpoint_class_2"]
    assert next(s for s in slots if s.name == TL).stock_item["uuid"] == TMSB_GIMBAL
    # a gun fitted straight into the gimbal's port: the gimbal's own gun port goes
    slots = await resolve_slots(cat, vehicle, {CENTER: _fit(TMSB), TL: _fit(AD4B)})
    names = [s.name for s in slots]
    assert TL in names and f"{TL}/hardpoint_class_2" not in names and f"{TR}/hardpoint_class_2" in names


async def test_refitting_replaces_the_vehicles_own_children():
    vehicle = [_slot("turret"), _slot("turret/gun_a", "WeaponGun", 2, ("WeaponGun",)), _slot("qd", "QuantumDrive", 2,
                                                                                         ("QuantumDrive",))]
    items = FakeItems({"T": [_slot("gun_x", "WeaponGun", 3, ("WeaponGun",))]})
    slots = await resolve_slots(items, vehicle, {"turret": _fit("T")})
    assert [(s.name, s.dynamic) for s in slots] == [("turret", False), ("turret/gun_x", True), ("qd", False)]


async def test_only_slots_that_accept_a_turret_cost_an_item_lookup():
    vehicle = [_slot("turret"), _slot("shield", "Shield", 2, ("Shield",)), _slot("gun", "WeaponGun", 2, ("WeaponGun",))]
    items = FakeItems({"T": []})
    await resolve_slots(items, vehicle, {"turret": _fit("T"), "shield": _fit("S"), "gun": _fit("G")})
    assert items.looked_up == ["T"]


async def test_unknown_or_failed_item_lookup_means_no_children_never_an_error(caplog):
    vehicle = [_slot("a"), _slot("a/old", "WeaponGun", 2, ("WeaponGun",)), _slot("b"), _slot("b/old", "WeaponGun", 2,
                                                                                       ("WeaponGun",))]
    items = FakeItems({}, fail={"DOWN"})
    with caplog.at_level(logging.WARNING, logger="src.loadout"):
        slots = await resolve_slots(items, vehicle, {"a": _fit("GONE"), "b": _fit("DOWN")})
    assert [s.name for s in slots] == ["a", "b"]
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "GONE" in text and "DOWN" in text
    with pytest.raises(UpstreamError):
        await resolve_slots(items, vehicle, {"b": _fit("DOWN")}, strict=True)


async def test_fitted_entries_for_slots_not_in_the_list_are_skipped():
    items = FakeItems({"T": [_slot("gun_x", "WeaponGun", 3, ("WeaponGun",))]})
    slots = await resolve_slots(items, [_slot("turret")], {"nope": _fit("T"), "turret/missing": _fit("T")})
    assert [s.name for s in slots] == ["turret"] and items.looked_up == []


async def test_dynamic_depth_is_bounded(caplog):
    # every item carries one turret port "p": a chain a, a/p, a/p/p, ...
    items = FakeItems({"T": [_slot("p")]})
    fitted = {"/".join(["a"] + ["p"] * n): _fit("T") for n in range(MAX_DYNAMIC_DEPTH + 2)}
    with caplog.at_level(logging.WARNING, logger="src.loadout"):
        slots = await resolve_slots(items, [_slot("a")], fitted)
    assert MAX_DYNAMIC_DEPTH == 4
    assert [s.name.count("/") for s in slots] == [0, 1, 2, 3, 4]      # the 4th level has no children
    assert any("deep" in r.getMessage() for r in caplog.records)


async def test_distinct_item_lookups_per_ship_are_bounded(caplog):
    n = MAX_DYNAMIC_LOOKUPS + 3
    vehicle = [_slot(f"t{i:02d}") for i in range(n)]
    items = FakeItems({f"I{i}": [_slot("gun", "WeaponGun", 2, ("WeaponGun",))] for i in range(n)})
    fitted = {f"t{i:02d}": _fit(f"I{i}") for i in range(n)}
    fitted["t00"] = fitted["t01"] = _fit("I0")         # a repeat of one item is one lookup
    with caplog.at_level(logging.WARNING, logger="src.loadout"):
        slots = await resolve_slots(items, vehicle, fitted)
    assert MAX_DYNAMIC_LOOKUPS == 16 and len(set(items.looked_up)) == 16
    assert sum(1 for s in slots if s.dynamic) == 17     # 16 distinct items, one fitted twice
    assert any("distinct fitted items" in r.getMessage() for r in caplog.records)


# ---------- effective_loadout with resolved slots ----------

async def test_effective_loadout_marks_dynamic_slots_and_keeps_them_under_a_refitted_parent():
    cat = make_catalog()
    fitted = {CENTER: _fit(TMSB, "TMSB-5 Ball Turret"), f"{TR}/hardpoint_class_2": _fit(REVENANT, "Revenant Gatling")}
    loadout = {e["slot"]: e for e in effective_loadout(await resolve_slots(cat, await _f7c_slots(cat), fitted), fitted)}
    assert loadout[CENTER]["source"] == "fitted" and "dynamic" not in loadout[CENTER]
    assert loadout[TL] == {"slot": TL, "type": "WeaponGun", "sizeMin": 4, "sizeMax": 4,
                           "compatibleTypes": [{"type": "WeaponGun", "subTypes": ["Gun"]},
                                               {"type": "Turret", "subTypes": ["GunTurret"]}],
                           "item": {"uuid": TMSB_GIMBAL, "name": "TMSB-5 Gimbal Mount"}, "source": "stock",
                           "dynamic": True}
    assert loadout[f"{TL}/hardpoint_class_2"]["item"] is None
    assert loadout[f"{TR}/hardpoint_class_2"]["item"] == {"uuid": REVENANT, "name": "Revenant Gatling"}
    assert loadout[f"{TR}/hardpoint_class_2"]["source"] == "fitted"
    assert "dynamic" not in loadout[RIGHT_WING]


def test_effective_loadout_ignores_and_logs_entries_for_ports_no_longer_there(caplog):
    with caplog.at_level(logging.WARNING, logger="src.loadout"):
        out = effective_loadout([_slot("turret")], {"turret/gone": _fit("G")})
    assert [e["slot"] for e in out] == ["turret"]
    assert any("turret/gone" in r.getMessage() for r in caplog.records)


# ---------- prune_descendants ----------

async def test_prune_keeps_a_child_whose_port_survives_and_drops_the_rest():
    gun2 = {"uuid": "G2", "name": "Gun 2", "type": "WeaponGun", "size": 2}
    gun3 = {"uuid": "G3", "name": "Gun 3", "type": "WeaponGun", "size": 3}
    new = [_slot("left", "WeaponGun", 2, ("WeaponGun",)), _slot("right", "WeaponGun", 2, ("WeaponGun",))]
    items = FakeItems({"NEW": new}, {"G2": gun2, "G3": gun3})
    after = {"turret": _fit("NEW"), "turret/left": _fit("G2", "Gun 2"), "turret/right": _fit("G3", "Gun 3"),
             "turret/top": _fit("G2", "Gun 2"), "turret/gone": _fit("NOPE", "Mystery"), "other": _fit("G2")}
    dropped = await prune_descendants(items, [_slot("turret"), _slot("other", "WeaponGun", 2, ("WeaponGun",))],
                                      after, ["turret"])
    assert dropped == [
        {"slot": "turret/gone", "item": {"uuid": "NOPE", "name": "Mystery"}, "reason": "slot_removed"},
        {"slot": "turret/right", "item": {"uuid": "G3", "name": "Gun 3"}, "reason": "incompatible"},
        {"slot": "turret/top", "item": {"uuid": "G2", "name": "Gun 2"}, "reason": "slot_removed"}]
    assert "turret/left" in after and "other" in after           # the caller's map is not edited


async def test_prune_drops_grandchildren_of_a_dropped_child_and_unknown_items():
    mount = [_slot("gun", "WeaponGun", 2, ("WeaponGun",))]
    new = [_slot("left", "Turret", 2, ("Turret",))]
    items = FakeItems({"NEW": new, "MOUNT": mount},
                      {"G2": {"uuid": "G2", "name": "Gun 2", "type": "WeaponGun", "size": 2}})
    after = {"turret": _fit("NEW"), "turret/left": _fit("MOUNT", "Mount"), "turret/left/gun": _fit("G2", "Gun 2")}
    dropped = await prune_descendants(items, [_slot("turret")], after, ["turret"])
    # the Wiki no longer knows the mount -> it goes, and its gun's port with it
    assert [(d["slot"], d["reason"]) for d in dropped] == [("turret/left", "unknown_item"),
                                                           ("turret/left/gun", "slot_removed")]


async def test_prune_raises_when_the_catalog_cannot_answer():
    items = FakeItems({}, fail={"DOWN"})
    with pytest.raises(UpstreamError):
        await prune_descendants(items, [_slot("turret")], {"turret": _fit("DOWN"), "turret/x": _fit("G")}, ["turret"])


# ---------- HTTP: hangar read, web fit / reset, chat fit / reset, picker ----------

GUNS = [MANTIS, M4A, AD4B, REVENANT]
NARROW = "22222222-2222-4222-8222-222222222222"     # TMSB-5 without its right port
SMALL = "33333333-3333-4333-8333-333333333333"      # TMSB-5 whose left port is size 3
GIMBAL_X = "44444444-4444-4444-8444-444444444444"   # an S4 gimbal with one S4 gun port
GIMBAL_X_RECORD = {
    "uuid": GIMBAL_X, "name": "Gimbal X", "class_name": "Mount_Gimbal_X", "type": "Turret", "sub_type": "GunTurret",
    "size": 4, "ports": [{"name": "hardpoint_class_2", "type": "WeaponGun", "sub_type": "Gun", "editable": True,
                          "sizes": {"min": 4, "max": 4}, "equipped_item": None, "ports": [],
                          "compatible_types": [{"type": "WeaponGun", "sub_types": ["Gun"]}]}]}


def _app(repo, **catalog_kw):
    catalog_kw.setdefault("extra_listed", [f7c_items()[u] for u in GUNS])
    catalog_kw.setdefault("extra_items", [variant(NARROW, "TMSB-5 Narrow", drop_ports=("hardpoint_weapon_right",)),
                                          variant(SMALL, "TMSB-5 Small", sizes={"hardpoint_weapon_left": 3}),
                                          GIMBAL_X_RECORD])
    return create_app(cfg(), catalog=make_catalog(**catalog_kw), repository=repo, verifier=fake_verifier, warm=False)


@pytest.fixture
def repo():
    return InMemoryShipRepository()


@pytest.fixture
def client(repo):
    with TestClient(_app(repo)) as c:
        yield c


def put(c, ship, slot, item, member=SELF):
    return c.put(f"/v1/members/{member}/ships/{ship['shipId']}/slots/{slot}", json={"item": item}, headers=H(member))


def delete(c, ship, slot, member=SELF):
    return c.delete(f"/v1/members/{member}/ships/{ship['shipId']}/slots/{slot}", headers=H(member))


def hangar_ship(c, ship, member=SELF):
    ships = c.get(f"/v1/members/{member}/hangar", headers=H(None)).json()["ships"]
    return next(s for s in ships if s["shipId"] == ship["shipId"])


def loadout_of(view):
    return {e["slot"]: e for e in view["loadout"]}


def hornet_with_c5(c):
    """An F7C with the C5-173f in the centre and a Mantis in each of its gun ports."""
    ship = add_ship(c, vehicle=F7C_UUID)
    for slot, item in ((CENTER, C5), (S3L, MANTIS), (S3R, MANTIS)):
        assert put(c, ship, slot, item).status_code == 200
    return ship


def hornet_with_tmsb(c):
    """An F7C with the TMSB-5: an AD4B straight in the left port, a Revenant in
    the right gimbal's gun port."""
    ship = add_ship(c, vehicle=F7C_UUID)
    for slot, item in ((CENTER, TMSB), (TL, AD4B), (f"{TR}/hardpoint_class_2", REVENANT)):
        r = put(c, ship, slot, item)
        assert r.status_code == 200, r.text
    return ship


def test_stock_f7c_has_no_gun_slots_under_the_centre_or_nose(client):
    lo = loadout_of(add_ship(client, vehicle=F7C_UUID))
    assert lo[CENTER]["item"] == {"uuid": CARGO, "name": "Stor*All Big Box Model H2"}
    assert lo[NOSE]["item"] is None and lo[NOSE]["type"] == "Turret"
    assert not any(k.startswith((CENTER + "/", NOSE + "/")) for k in lo)
    assert not any("dynamic" in e for e in lo.values())


def test_fitting_a_turret_shows_its_gun_slots_and_they_can_be_fitted(client):
    ship = add_ship(client, vehicle=F7C_UUID)
    r = put(client, ship, CENTER, C5)
    assert r.status_code == 200, r.text
    assert r.json()["dropped"] == []
    lo = loadout_of(r.json()["ship"])
    assert lo[S3L] == {"slot": S3L, "type": "WeaponGun", "sizeMin": 3, "sizeMax": 3,
                       "compatibleTypes": [{"type": "WeaponGun", "subTypes": ["Gun"]}],
                       "item": None, "source": "stock", "dynamic": True}
    order = [e["slot"] for e in r.json()["ship"]["loadout"]]
    assert order[order.index(CENTER):order.index(CENTER) + 3] == [CENTER, S3L, S3R]
    # a slot that only exists because of the fitted turret takes a gun of its size ...
    assert put(client, ship, S3L, MANTIS).status_code == 200
    r = put(client, ship, S3R, M4A)                       # ... and refuses a size 2 gun
    assert r.status_code == 422 and "size 2" in r.json()["message"]
    view = hangar_ship(client, ship)
    assert view["fitted"] == {CENTER: {"itemUuid": C5, "itemName": "C5-173f S5 Hornet Mk II Ball Turret"},
                              S3L: {"itemUuid": MANTIS, "itemName": "Mantis GT-220 Gatling"}}
    lo = loadout_of(view)
    assert lo[S3L]["source"] == "fitted" and lo[S3L]["dynamic"] is True and lo[S3R]["item"] is None


def test_a_gun_slot_of_an_unfitted_turret_does_not_exist(client):
    ship = add_ship(client, vehicle=F7C_UUID)
    assert put(client, ship, S3L, MANTIS).status_code == 404


def test_web_fit_of_a_parent_drops_children_whose_port_is_gone_and_reports_them(client):
    ship = hornet_with_c5(client)
    r = put(client, ship, CENTER, TMSB)
    assert r.status_code == 200, r.text
    assert r.json()["dropped"] == [
        {"slot": S3L, "item": {"uuid": MANTIS, "name": "Mantis GT-220 Gatling"}, "reason": "slot_removed"},
        {"slot": S3R, "item": {"uuid": MANTIS, "name": "Mantis GT-220 Gatling"}, "reason": "slot_removed"}]
    view = r.json()["ship"]
    assert view["fitted"] == {CENTER: {"itemUuid": TMSB, "itemName": "TMSB-5 Ball Turret"}}
    lo = loadout_of(view)
    assert S3L not in lo and lo[TL]["dynamic"] is True


def test_web_fit_of_a_parent_keeps_a_child_whose_port_and_fit_survive(client):
    ship = hornet_with_tmsb(client)
    r = put(client, ship, CENTER, NARROW)                 # same left port, no right port
    assert r.status_code == 200, r.text
    assert r.json()["dropped"] == [{"slot": f"{TR}/hardpoint_class_2",
                                    "item": {"uuid": REVENANT, "name": "Revenant Gatling"},
                                    "reason": "slot_removed"}]
    assert r.json()["ship"]["fitted"] == {CENTER: {"itemUuid": NARROW, "itemName": "TMSB-5 Narrow"},
                                          TL: {"itemUuid": AD4B, "itemName": "AD4B Ballistic Gatling"}}
    assert loadout_of(r.json()["ship"])[TL]["item"]["uuid"] == AD4B


def test_web_fit_of_a_parent_drops_a_child_its_port_no_longer_takes(client):
    ship = hornet_with_tmsb(client)
    r = put(client, ship, CENTER, SMALL)                  # left port is now size 3: the S4 AD4B cannot stay
    assert r.status_code == 200, r.text
    assert r.json()["dropped"] == [{"slot": TL, "item": {"uuid": AD4B, "name": "AD4B Ballistic Gatling"},
                                    "reason": "incompatible"}]
    assert set(r.json()["ship"]["fitted"]) == {CENTER, f"{TR}/hardpoint_class_2"}


def test_web_refit_of_the_same_item_drops_nothing(client):
    ship = hornet_with_c5(client)
    r = put(client, ship, CENTER, C5)
    assert r.status_code == 200 and r.json()["dropped"] == []
    assert set(r.json()["ship"]["fitted"]) == {CENTER, S3L, S3R}


def test_web_fit_drops_children_in_the_same_write(client, repo):
    ship = hornet_with_c5(client)
    seen = []
    original = repo.update_slots

    async def spy(member, ship_id, slots, **kw):
        seen.append(dict(slots))
        return await original(member, ship_id, slots, **kw)
    repo.update_slots = spy
    assert put(client, ship, CENTER, TMSB).status_code == 200
    assert seen == [{CENTER: {"itemUuid": TMSB, "itemName": "TMSB-5 Ball Turret"}, S3L: None, S3R: None}]


def test_web_fit_of_the_stock_item_clears_the_override_and_its_children(client):
    ship = hornet_with_c5(client)

    # The fake Wiki has no record of the stock cargo module: teach the catalog.
    catalog = client.app.state.catalog
    real_item = catalog.item

    async def item(ident):
        if ident == CARGO:
            return {"uuid": CARGO, "name": "Stor*All Big Box Model H2", "type": "Module", "subType": "UNDEFINED",
                    "size": 5}
        return await real_item(ident)
    catalog.item = item
    r = put(client, ship, CENTER, CARGO)
    assert r.status_code == 200, r.text
    assert [d["slot"] for d in r.json()["dropped"]] == [S3L, S3R]
    assert r.json()["ship"]["fitted"] == {}
    assert S3L not in loadout_of(r.json()["ship"])


def test_web_reset_of_a_parent_drops_its_children_and_reports_them(client):
    ship = hornet_with_c5(client)
    assert put(client, ship, RIGHT_WING, AD4B).status_code == 200
    r = delete(client, ship, CENTER)
    assert r.status_code == 200, r.text
    assert r.json()["dropped"] == [
        {"slot": S3L, "item": {"uuid": MANTIS, "name": "Mantis GT-220 Gatling"}, "reason": "slot_removed"},
        {"slot": S3R, "item": {"uuid": MANTIS, "name": "Mantis GT-220 Gatling"}, "reason": "slot_removed"}]
    view = r.json()["ship"]
    assert set(view["fitted"]) == {RIGHT_WING}
    lo = loadout_of(view)
    assert lo[CENTER]["source"] == "stock" and S3L not in lo


def test_web_reset_of_a_child_or_a_childless_slot_reports_nothing(client):
    ship = hornet_with_c5(client)
    r = delete(client, ship, S3L)
    assert r.status_code == 200 and r.json()["dropped"] == []
    assert set(r.json()["ship"]["fitted"]) == {CENTER, S3R}
    assert delete(client, ship, "renamed_in_patch/child").json()["dropped"] == []


def test_web_reset_keeps_a_child_the_stock_item_still_takes(client):
    # Another gimbal over the TMSB-5's stock one, with a gun in its gun port:
    # resetting the gimbal brings the stock gimbal back, which has the same
    # gun port (hardpoint_class_2, S4) -> the gun stays.
    ship = add_ship(client, vehicle=F7C_UUID)
    gun_port = f"{TL}/hardpoint_class_2"
    for slot, item in ((CENTER, TMSB), (TL, GIMBAL_X), (gun_port, REVENANT)):
        r = put(client, ship, slot, item)
        assert r.status_code == 200, r.text
    r = delete(client, ship, TL)
    assert r.status_code == 200, r.text
    assert r.json()["dropped"] == []
    assert set(r.json()["ship"]["fitted"]) == {CENTER, gun_port}
    lo = loadout_of(r.json()["ship"])
    assert lo[TL]["item"]["uuid"] == TMSB_GIMBAL and lo[gun_port]["item"]["uuid"] == REVENANT


def test_a_parent_change_fails_before_writing_when_the_catalog_cannot_check_the_children(client):
    ship = hornet_with_tmsb(client)
    real_item = client.app.state.catalog.item

    async def ad4b_down(ident):
        if ident == AD4B:                      # the child whose fit must be re-checked
            raise UpstreamError("wiki", 503, "down")
        return await real_item(ident)
    client.app.state.catalog.item = ad4b_down
    assert put(client, ship, CENTER, NARROW).status_code == 503
    assert chat_fit(client, "hornet", NARROW).status_code == 503
    client.app.state.catalog.item = real_item
    assert hangar_ship(client, ship)["fitted"][CENTER]["itemUuid"] == TMSB
    assert set(hangar_ship(client, ship)["fitted"]) == {CENTER, TL, f"{TR}/hardpoint_class_2"}


def chat_fit(c, ship_text, item, slot=None, member=SELF):
    body = {"ship": ship_text, "item": item, **({"slot": slot} if slot else {})}
    return c.post(f"/v1/members/{member}/fit", json=body, headers=H(member))


def chat_reset(c, ship_ref, slot=None, member=SELF):
    return c.post(f"/v1/members/{member}/ships/{ship_ref}/reset", json={"slot": slot} if slot else {},
                  headers=H(member))


def test_chat_fit_reaches_a_fitted_turrets_gun_slots(client):
    ship = add_ship(client, vehicle=F7C_UUID)
    assert put(client, ship, CENTER, C5).status_code == 200
    r = chat_fit(client, "hornet", MANTIS)
    assert r.status_code == 409 and r.json()["error"] == "choose_slot"
    assert [s["slot"] for s in r.json()["slots"]] == [S3L, S3R]
    r = chat_fit(client, "hornet", MANTIS, slot="all")
    assert r.status_code == 200, r.text
    assert [c["slot"] for c in r.json()["changes"]] == [S3L, S3R] and r.json()["dropped"] == []
    assert set(hangar_ship(client, ship)["fitted"]) == {CENTER, S3L, S3R}


def test_chat_fit_of_a_parent_drops_children_and_lists_them_in_changes(client, caplog):
    ship = hornet_with_c5(client)
    with caplog.at_level(logging.INFO, logger="src.app"):
        r = chat_fit(client, "hornet", TMSB)
    assert r.status_code == 200, r.text
    body = r.json()
    gone = {"name": None, "uuid": None}
    mantis = {"name": "Mantis GT-220 Gatling", "uuid": MANTIS}
    assert body["changes"] == [
        {"slot": CENTER, "from": {"name": "C5-173f S5 Hornet Mk II Ball Turret", "uuid": C5},
         "to": {"name": "TMSB-5 Ball Turret", "uuid": TMSB}},
        {"slot": S3L, "from": mantis, "to": gone, "dropped": True, "reason": "slot_removed"},
        {"slot": S3R, "from": mantis, "to": gone, "dropped": True, "reason": "slot_removed"}]
    assert body["dropped"] == [
        {"slot": S3L, "item": {"uuid": MANTIS, "name": "Mantis GT-220 Gatling"}, "reason": "slot_removed"},
        {"slot": S3R, "item": {"uuid": MANTIS, "name": "Mantis GT-220 Gatling"}, "reason": "slot_removed"}]
    assert body["unchanged"] is False
    assert hangar_ship(client, ship)["fitted"] == {CENTER: {"itemUuid": TMSB, "itemName": "TMSB-5 Ball Turret"}}
    dropped_logs = [r.getMessage() for r in caplog.records if "dropped with its parent's change" in r.getMessage()]
    assert len(dropped_logs) == 2 and S3L in dropped_logs[0] and "Mantis GT-220 Gatling" in dropped_logs[0]


def test_chat_fit_of_a_parent_keeps_a_child_that_still_fits_and_is_one_write(client, repo):
    ship = hornet_with_tmsb(client)
    seen = []
    original = repo.update_slots

    async def spy(member, ship_id, slots, **kw):
        seen.append(dict(slots))
        return await original(member, ship_id, slots, **kw)
    repo.update_slots = spy
    r = chat_fit(client, "hornet", NARROW)
    assert r.status_code == 200, r.text
    assert [(c["slot"], c.get("dropped", False)) for c in r.json()["changes"]] == [
        (CENTER, False), (f"{TR}/hardpoint_class_2", True)]
    assert seen == [{CENTER: {"itemUuid": NARROW, "itemName": "TMSB-5 Narrow"}, f"{TR}/hardpoint_class_2": None}]
    assert set(hangar_ship(client, ship)["fitted"]) == {CENTER, TL}


def test_chat_reset_of_a_parent_drops_children_and_lists_them_in_changes(client):
    ship = hornet_with_c5(client)
    r = chat_reset(client, "hornet", slot=CENTER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changes"][0] == {"slot": CENTER, "from": {"name": "C5-173f S5 Hornet Mk II Ball Turret", "uuid": C5},
                                  "to": {"name": "Stor*All Big Box Model H2", "uuid": CARGO}}
    assert [(c["slot"], c["dropped"], c["reason"]) for c in body["changes"][1:]] == [
        (S3L, True, "slot_removed"), (S3R, True, "slot_removed")]
    assert [d["slot"] for d in body["dropped"]] == [S3L, S3R]
    assert hangar_ship(client, ship)["fitted"] == {}


def test_chat_reset_of_one_gun_slot_and_of_everything(client):
    ship = hornet_with_c5(client)
    r = chat_reset(client, "hornet", slot=S3L)
    assert r.status_code == 200 and [c["slot"] for c in r.json()["changes"]] == [S3L]
    assert r.json()["changes"][0]["to"] == {"name": None, "uuid": None} and r.json()["dropped"] == []
    r = chat_reset(client, "hornet", slot="all")
    assert r.status_code == 200 and sorted(c["slot"] for c in r.json()["changes"]) == [CENTER, S3R]
    assert r.json()["dropped"] == [] and hangar_ship(client, ship)["fitted"] == {}


def options(c, **params):
    return c.get("/v1/catalog/slot-options", params=params, headers=H(None))


def test_slot_options_for_a_dynamic_slot_need_member_and_ship(client):
    ship = hornet_with_c5(client)
    r = options(client, member=SELF, ship=ship["shipId"], slot=S3L)
    assert r.status_code == 200, r.text
    assert [i["name"] for i in r.json()["items"]] == ["Mantis GT-220 Gatling"]      # the one listed S3 gun
    # `vehicle` may ride along; the ship's own vehicle is what counts
    assert options(client, member=SELF, ship=ship["shipId"], slot=S3L, vehicle=HARBINGER_UUID).status_code == 200
    # without them: the stock lookup, where the turret's gun port does not exist
    assert options(client, vehicle=F7C_UUID, slot=S3L).status_code == 404
    assert options(client, vehicle=F7C_UUID, slot=CENTER).status_code == 200
    # another member may read it (like the hangar read)
    r = client.get("/api/v1/catalog/slot-options", params={"member": SELF, "ship": ship["shipId"], "slot": S3R},
                   headers=H("222"))
    assert r.status_code == 200 and len(r.json()["items"]) == 1


@pytest.mark.parametrize("params,status,code", [
    ({"member": SELF, "slot": S3L}, 400, "invalid_request"),
    ({"ship": "abc", "slot": S3L}, 400, "invalid_request"),
    ({"member": SELF, "ship": "abc"}, 400, "invalid_request"),
    ({"member": "not-an-id", "ship": "abc", "slot": S3L}, 400, "invalid_request"),
    ({"member": SELF, "ship": "nosuchship", "slot": S3L}, 404, "not_found"),
    ({"member": SELF, "ship": "bad ship id!", "slot": S3L}, 404, "not_found"),
])
def test_slot_options_ship_param_errors(client, params, status, code):
    r = options(client, **params)
    assert r.status_code == status and r.json()["error"] == code


def test_slot_options_unknown_slot_on_a_ship_is_404_and_auth_is_required(client):
    ship = add_ship(client, vehicle=F7C_UUID)
    assert options(client, member=SELF, ship=ship["shipId"], slot=S3L).status_code == 404
    assert client.get("/v1/catalog/slot-options", params={"member": SELF, "ship": ship["shipId"],
                                                          "slot": CENTER}).status_code == 401


def test_the_nose_slot_picker_offers_the_turrets_the_wiki_list_omits(repo):
    with TestClient(_app(repo, uex=True)) as c:
        ship = add_ship(c, vehicle=F7C_UUID)
        r = options(c, vehicle=F7C_UUID, slot=NOSE)
        assert r.status_code == 200, r.text
        assert [(i["uuid"], i["name"], i["size"]) for i in r.json()["items"]] == [
            (NOSE_S2, "Anvil Hornet Mk II S2 Nose Turret", 3)]
        assert r.json()["items"][0]["cheapestPrice"]["price"] > 0
        centre = {i["uuid"] for i in options(c, vehicle=F7C_UUID, slot=CENTER).json()["items"]}
        assert centre == {C5, TMSB}                       # BallTurret only: the nose turret is a CanardTurret
        assert put(c, ship, NOSE, NOSE_S2).status_code == 200
        assert S1L in loadout_of(hangar_ship(c, ship))


# ---------- spviewer import ----------

def f7c_row() -> dict:
    return copy.deepcopy(load_fixture("spviewer_f7c_mk2.json")[0])


def f7c_loadout() -> dict:
    return json.loads(decompress_from_encoded_uri_component(f7c_row()["loadoutData"]))


def f7c_row_with(loadout: dict) -> dict:
    return {**f7c_row(), "loadoutData": lz(json.dumps(loadout))}


F7C_FITTED = {
    RIGHT_WING: {"itemUuid": AD4B, "itemName": "AD4B Ballistic Gatling"},
    CENTER: {"itemUuid": C5, "itemName": "C5-173f S5 Hornet Mk II Ball Turret"},
    S3L: {"itemUuid": MANTIS, "itemName": "Mantis GT-220 Gatling"},
    S3R: {"itemUuid": MANTIS, "itemName": "Mantis GT-220 Gatling"},
    NOSE: {"itemUuid": NOSE_S2, "itemName": "Anvil Hornet Mk II S2 Nose Turret"},
    S1L: {"itemUuid": M4A, "itemName": "M4A Cannon"},
    S1R: {"itemUuid": M4A, "itemName": "M4A Cannon"},
}
MISSILES = [f"hardpoint_missile_rack_{side}/missile_0{n}_attach" for side in ("right", "left") for n in range(1, 5)]


async def test_f7c_export_imports_both_turrets_and_their_guns():
    calls = []
    budget = DecodeBudget()
    res = await analyze_row(make_catalog(calls), 0, f7c_row(), budget=budget)
    assert res.error is None and res.blocking() is None
    assert res.vehicle["uuid"] == F7C_UUID and res.loadout_name == "my_f7c"
    assert res.fitted == F7C_FITTED                      # the left wing gun is stock: not in the map
    assert LEFT_WING not in res.fitted
    changes = {c["slot"]: c for c in res.changes}
    assert set(changes) == set(F7C_FITTED)
    assert changes[CENTER]["from"] == {"uuid": CARGO, "name": "Stor*All Big Box Model H2"}
    assert changes[NOSE]["from"] is None and changes[S3L]["from"] is None
    assert changes[RIGHT_WING]["from"] == {"uuid": REVENANT, "name": "Revenant Gatling"}
    # the missiles (not tracked) are reported; nothing else is skipped
    assert sorted(s["slot"] for s in res.skipped) == sorted(MISSILES)
    assert {s["reason"] for s in res.skipped} == {UNTRACKED_SLOT}
    assert all("MISL_S01_EM_BEHR_Pioneer" in s["detail"] for s in res.skipped)
    # one Wiki lookup per distinct item; a turret's slots come from the same record
    assert sorted(_item_calls(calls)) == sorted([AD4B, C5, MANTIS, NOSE_S2, M4A])
    assert len(budget.looked_up) == 5


async def test_base_loadout_equal_to_current_is_a_change_when_the_wiki_stock_differs():
    # spviewer claims the Lorica is this port's stock (BaseLoadout) AND current;
    # the Wiki's stock is the SecureShield -> the Lorica is a change.
    lo = stock_loadout()
    port = _port(lo, "shieldPorts", "hardpoint_shield_generator_001")
    port["Loadout"] = "SHLD_BEHR_S02_7MA_SCItem"
    port["BaseLoadout"] = {**port["BaseLoadout"], "ClassName": "SHLD_BEHR_S02_7MA_SCItem", "Name": "7MA 'Lorica'"}
    res = await analyze_row(make_catalog(), 0, row_with(lo), budget=DecodeBudget())
    assert res.changes == [{"slot": "hardpoint_shield_generator_001",
                            "from": {"uuid": SECURESHIELD, "name": "SecureShield"},
                            "to": {"uuid": LORICA, "name": "7MA 'Lorica'"}}]
    assert res.skipped == []


async def test_current_equal_to_the_wiki_stock_is_unchanged_whatever_base_loadout_says():
    lo = stock_loadout()
    port = _port(lo, "shieldPorts", "hardpoint_shield_generator_001")
    port["BaseLoadout"] = {**port["BaseLoadout"], "ClassName": "SHLD_BEHR_S02_7MA_SCItem"}
    res = await analyze_row(make_catalog(), 0, row_with(lo), budget=DecodeBudget())
    assert res.changes == [] and res.skipped == []


async def test_a_gun_port_naming_no_item_under_a_changed_turret_is_unchanged():
    lo = f7c_loadout()
    sel = lo["selectedPilotWeapons"]
    centre = next(k for k in sel if k.endswith("-hardpoint_weapon_center"))
    sel[centre] = {"className": "ANVL_Hornet_F7CM_Mk2_Ball_Turret_Bespoke", "reference": TMSB}
    for k in [k for k in sel if "hardpoint_weapon_center" in k and k != centre]:
        del sel[k]
    # spviewer's rewritten tree for the TMSB-5: two ports, each with a gun port, none naming an item
    _port(lo, "pilotWeaponsPorts", CENTER)["Ports"] = [
        {"PortName": n, "Loadout": None, "Ports": [{"PortName": "hardpoint_class_2", "Loadout": None}]}
        for n in ("hardpoint_weapon_left", "hardpoint_weapon_right")]
    res = await analyze_row(make_catalog(), 0, f7c_row_with(lo), budget=DecodeBudget())
    assert res.fitted[CENTER] == {"itemUuid": TMSB, "itemName": "TMSB-5 Ball Turret"}
    # the left/right ports hold the TMSB gimbal by default: empty in spviewer is NOT "emptied"
    assert not any(k.startswith(CENTER + "/") for k in res.fitted)
    assert {s["reason"] for s in res.skipped} == {UNTRACKED_SLOT} and len(res.skipped) == 8


async def test_item_slot_lookups_of_fitted_parents_count_against_the_lookup_budget():
    # Selected by class name only: the item costs one lookup (class name) and
    # its slots another (uuid). With room for the first only, the row is incomplete.
    lo = f7c_loadout()
    sel = lo["selectedPilotWeapons"]
    for k in [k for k in sel if "hardpoint_weapon_center" not in k or not k.endswith("hardpoint_weapon_center")]:
        del sel[k]
    for k in sel:
        del sel[k]["reference"]
    lo["selectedMissilesRacks"] = {}
    calls = []
    budget = DecodeBudget(max_lookups=1)
    res = await analyze_row(make_catalog(calls), 0, f7c_row_with(lo), budget=budget)
    assert _item_calls(calls) == ["ANVL_Hornet_F7A_Ball_Turret"]
    assert [(s["slot"], s["reason"]) for s in res.skipped] == [(CENTER, TOO_MANY_LOOKUPS)]
    assert "C5-173f S5 Hornet Mk II Ball Turret" in res.skipped[0]["detail"]
    assert res.blocking() is not None and res.blocking()[0] == TOO_MANY_LOOKUPS
    # with room for both, the same row is complete
    res = await analyze_row(make_catalog(), 0, f7c_row_with(lo), budget=DecodeBudget(max_lookups=2))
    assert res.blocking() is None and set(res.fitted) == {CENTER}


async def test_the_lookup_budget_still_bounds_an_f7c_import():
    budget = DecodeBudget(max_lookups=3)
    calls = []
    res = await analyze_row(make_catalog(calls), 0, f7c_row(), budget=budget)
    assert len(set(_item_calls(calls))) == 3 and len(budget.looked_up) == 3
    assert TOO_MANY_LOOKUPS in {s["reason"] for s in res.skipped}
    assert res.blocking()[0] == TOO_MANY_LOOKUPS


def test_f7c_export_previews_and_applies_through_the_api():
    repo = InMemoryShipRepository()
    app = create_app(cfg(**BROWSER_ENV), catalog=make_catalog(), repository=repo, verifier=fake_verifier,
                     warm=False, clock=AuthClock())
    with TestClient(app, base_url=ORIGIN, follow_redirects=False) as c:
        file = [f7c_row()]
        r = c.post("/v1/import/spviewer/preview", json={"file": file}, headers=H())
        assert r.status_code == 200, r.text
        row = r.json()["rows"][0]
        assert row["vehicle"] == {"uuid": F7C_UUID, "name": "F7C Hornet Mk II"}
        assert {ch["slot"] for ch in row["changes"]} == set(F7C_FITTED) and len(row["skipped"]) == 8
        r = c.post("/v1/import/spviewer/apply", json={"file": file, "rows": [{"rowIndex": 0, "mode": "new"}]},
                   headers=H())
        assert r.status_code == 200, r.text
        ship = c.get(f"/v1/members/{SELF}/hangar", headers=H(None)).json()["ships"][0]
        assert ship["fitted"] == F7C_FITTED
        lo = loadout_of(ship)
        assert lo[S1L]["item"] == {"uuid": M4A, "name": "M4A Cannon"} and lo[S1L]["dynamic"] is True
        assert lo[S3R]["item"]["name"] == "Mantis GT-220 Gatling" and lo[LEFT_WING]["source"] == "stock"
