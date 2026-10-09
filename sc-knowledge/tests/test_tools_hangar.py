"""sc_member_hangar / sc_member_fit_check logic against a fake hangar client
and a fake item lookup (no network)."""
import pytest

from src.hangar import HangarError, HangarUnavailable
from src.tools_hangar import HangarTools

AKIRA, MICRO, TWINS, NICK, EMPTY, BROKEN = "111", "222", "333", "444", "555", "666"


def _slot(slot, type_, lo, hi, item=None, source="stock"):
    return {"slot": slot, "type": type_, "sizeMin": lo, "sizeMax": hi,
            "item": ({"uuid": f"uuid-{item}", "name": item} if item else None), "source": source}


def _ship(ship_id, vehicle, loadout, nickname=None):
    return {"shipId": ship_id, "vehicleUuid": f"v-{vehicle}", "vehicleName": vehicle,
            "vehicleClassName": vehicle.upper().replace(" ", "_"), "nickname": nickname,
            "fitted": {}, "loadout": loadout, "loadoutError": None if loadout is not None else "unavailable"}


HARBINGER = _ship("h1", "Vanguard Harbinger", [
    _slot("hardpoint_quantum_drive", "QuantumDrive", 2, 2, "Voyage"),
    _slot("hardpoint_shield_generator_left", "Shield", 2, 2, "FR-66"),
])
TAURUS = _ship("c1", "Constellation Taurus", [
    _slot("hardpoint_quantum_drive", "QuantumDrive", 2, 2, "Bolon"),
    _slot("hardpoint_shield_generator", "Shield", 3, 3, "Stronghold"),
])
HANGARS = {
    AKIRA: {"member": AKIRA, "ships": [HARBINGER, TAURUS]},
    MICRO: {"member": MICRO, "ships": [
        _ship("m1", "Cutlass Black", [_slot("hardpoint_quantum_drive", "QuantumDrive", 1, 1, "Atlas")]),
        _ship("m2", "Aurora MR", [_slot("hardpoint_shield_generator", "Shield", 1, 1, "Palisade")]),
        _ship("m3", "Freelancer", [_slot("hardpoint_quantum_drive", "QuantumDrive", 2, 2, "Hemera"),
                                   _slot("hardpoint_quantum_drive_aux", "QuantumDrive", 2, 2, "Hemera Twin")]),
        _ship("m4", "Gladius", [_slot("hardpoint_quantum_drive", "QuantumDrive", 1, 2, None)]),
    ]},
    TWINS: {"member": TWINS, "ships": [
        TAURUS,
        _ship("c2", "Constellation Andromeda", []),
        _ship("c3", "Cutlass Black", []),
        _ship("c4", "Cutlass Black", []),
    ]},
    NICK: {"member": NICK, "ships": [
        _ship("h9", "Vanguard Harbinger", [], nickname="Connie"),
        TAURUS,
        _ship("b1", "Caterpillar", [], nickname="Big Bertha"),
    ]},
    EMPTY: {"member": EMPTY, "ships": []},
    BROKEN: {"member": BROKEN, "ships": [_ship("x1", "Vanguard Harbinger", None)]},
}


class FakeHangar:
    def __init__(self, raise_exc=None):
        self.raise_exc = raise_exc
        self.calls = []

    async def get_hangar(self, member_id):
        self.calls.append(member_id)
        if self.raise_exc:
            raise self.raise_exc
        if member_id not in HANGARS:
            return {"member": member_id, "ships": []}
        return HANGARS[member_id]


def _qd(name, speed, uuid=None):
    return {"source": "wiki", "game_version": "4.3.1", "uuid": uuid or f"uuid-{name}",
            "item": {"name": name, "type": "QuantumDrive", "sub_type": "UNDEFINED", "size": 2,
                     "grade": "A", "class": "Civilian", "manufacturer": "X",
                     "key_stats": {"speed": speed, "fuel_rate": 1e-8}},
            "where_to_buy": []}


HEMERA_SPEED = 326_114_300
ITEMS = {
    "Hemera": _qd("Hemera", HEMERA_SPEED),
    "Bolon": _qd("Bolon", 283_000_000),          # Hemera is ~15% faster -> upgrade
    "Voyage": _qd("Voyage", 400_000_000),        # Hemera is slower -> downgrade
    "Hemera Twin": _qd("Hemera Twin", int(HEMERA_SPEED * 1.01)),  # within 2% -> sidegrade
    "Atlas": {**_qd("Atlas", 200_000_000), "item": {**_qd("Atlas", 200_000_000)["item"], "size": 1}},
    "Mystery": {**_qd("Mystery", None)},
    "Ghost Shield": {"source": "wiki", "game_version": "4.3.1", "uuid": "uuid-gs",
                     "item": {"name": "Ghost Shield", "type": "Shield", "size": 2,
                              "key_stats": {"max_health": 5000, "regen_rate": 1,
                                            "regen_delay_damage_s": 2}}, "where_to_buy": []},
}


class FakeItems:
    def __init__(self):
        self.calls = []

    async def component(self, name):
        self.calls.append(name)
        if name.startswith("uuid-"):
            name = name[len("uuid-"):]
        if name == "Ambig":
            return {"error": "ambiguous", "detail": "x", "stale_fallback": False,
                    "candidates": ["Ambig A", "Ambig B"]}
        if name in ITEMS:
            return ITEMS[name]
        return {"error": "not_found", "detail": f"no item named '{name}'", "stale_fallback": False,
                "candidates": []}


def _tools(hangar=None, items=None):
    return HangarTools(hangar if hangar is not None else FakeHangar(), items or FakeItems())


# --- availability / validation ------------------------------------------------

async def test_unconfigured_client_is_unavailable():
    t = HangarTools(None, FakeItems())
    r = await t.member_hangar(AKIRA)
    assert r["error"] == "unavailable" and "HANGAR_API_URL" in r["detail"]
    r = await t.member_fit_check(AKIRA, "Hemera")
    assert r["error"] == "unavailable"


async def test_service_down_is_unavailable_never_raises():
    t = _tools(FakeHangar(HangarUnavailable("hangar-service GET ... timed out after 3.0s")))
    r = await t.member_hangar(AKIRA)
    assert r["error"] == "unavailable" and "timed out" in r["detail"]
    r = await t.member_fit_check(AKIRA, "Hemera")
    assert r["error"] == "unavailable"


async def test_service_error_code_passes_through():
    t = _tools(FakeHangar(HangarError(400, "invalid_request", "bad member id")))
    r = await t.member_hangar(AKIRA)
    assert r["error"] == "invalid_request" and "bad member id" in r["detail"]


@pytest.mark.parametrize("bad", ["Akira", "<@111>", "", "12a"])
async def test_non_numeric_member_id_rejected_without_calling_service(bad):
    hangar = FakeHangar()
    r = await _tools(hangar).member_hangar(bad)
    assert r["error"] == "invalid_request" and "numeric Discord ID" in r["detail"]
    assert hangar.calls == []


async def test_mention_shaped_member_id_with_spaces_is_trimmed():
    r = await _tools().member_hangar(f" {AKIRA} ")
    assert "error" not in r and r["member"] == AKIRA


# --- sc_member_hangar ---------------------------------------------------------

async def test_whole_hangar_compact_loadouts():
    r = await _tools().member_hangar(AKIRA)
    assert r["member"] == AKIRA and r["count"] == 2
    harb = r["ships"][0]
    assert harb["vehicle"] == "Vanguard Harbinger" and harb["shipId"] == "h1"
    qd = harb["loadout"][0]
    assert qd == {"slot": "hardpoint_quantum_drive", "type": "QuantumDrive", "size": "S2",
                  "item": "Voyage", "source": "stock"}


async def test_size_range_rendered():
    r = await _tools().member_hangar(MICRO, "Gladius")
    assert r["ship"]["loadout"][0]["size"] == "S1-2"
    assert r["ship"]["loadout"][0]["item"] is None


async def test_empty_hangar_has_note():
    r = await _tools().member_hangar(EMPTY)
    assert r["ships"] == [] and r["count"] == 0 and "/hangar add" in r["note"]


async def test_connie_resolves_to_only_constellation():
    r = await _tools().member_hangar(AKIRA, "Connie")
    assert "error" not in r
    assert r["ship"]["vehicle"] == "Constellation Taurus" and r["ship"]["shipId"] == "c1"
    assert r["resolved_by"] == "model"


async def test_my_prefix_and_partial_model_name():
    r = await _tools().member_hangar(AKIRA, "my Harbinger")
    assert r["ship"]["shipId"] == "h1"
    r = await _tools().member_hangar(AKIRA, "harb")
    assert r["ship"]["shipId"] == "h1"
    r = await _tools().member_hangar(AKIRA, "constellation taurus")
    assert r["ship"]["shipId"] == "c1"
    r = await _tools().member_hangar(AKIRA, "my Connie's")
    assert r["ship"]["shipId"] == "c1"


async def test_connie_ambiguous_between_two_constellations():
    r = await _tools().member_hangar(TWINS, "Connie")
    assert r["error"] == "ambiguous"
    assert set(r["candidates"]) == {"Constellation Taurus", "Constellation Andromeda"}


async def test_two_unnamed_ships_of_same_model_get_distinct_labels():
    r = await _tools().member_hangar(TWINS, "Cutlass")
    assert r["error"] == "ambiguous"
    assert len(r["candidates"]) == 2 and len(set(r["candidates"])) == 2
    assert all("Cutlass Black" in c for c in r["candidates"])


async def test_nickname_wins_over_model_shorthand():
    r = await _tools().member_hangar(NICK, "Connie")
    assert r["ship"]["shipId"] == "h9" and r["ship"]["nickname"] == "Connie"
    assert r["resolved_by"] == "nickname"


async def test_nickname_fuzzy():
    r = await _tools().member_hangar(NICK, "big berta")
    assert r["ship"]["shipId"] == "b1" and r["resolved_by"] == "nickname_fuzzy"


async def test_unknown_ship_not_found_lists_owned():
    r = await _tools().member_hangar(AKIRA, "Polaris")
    assert r["error"] == "not_found"
    assert set(r["owned"]) == {"Vanguard Harbinger", "Constellation Taurus"}


async def test_other_members_hangar_readable():
    r = await _tools().member_hangar(MICRO)
    assert r["member"] == MICRO and r["count"] == 4


# --- sc_member_fit_check ------------------------------------------------------

def _by_ship(r):
    return {s["shipId"]: s for s in r["ships"]}


async def test_fit_check_upgrade_and_downgrade_on_own_ships():
    r = await _tools().member_fit_check(AKIRA, "Hemera")
    assert "error" not in r
    assert r["item"]["name"] == "Hemera" and r["item"]["type"] == "QuantumDrive"
    assert r["key_stat"] == "speed" and r["order"] == "desc"
    ships = _by_ship(r)
    taurus = ships["c1"]["slots"][0]
    assert taurus["verdict"] == "upgrade"
    assert taurus["current"]["name"] == "Bolon" and taurus["current"]["value"] == 283_000_000
    assert taurus["item_value"] == HEMERA_SPEED and taurus["delta_pct"] > 0
    harb = ships["h1"]["slots"][0]
    assert harb["verdict"] == "downgrade" and harb["delta_pct"] < 0
    # Only the QD slots are compatible -- shield slots never appear.
    assert all(len(s["slots"]) == 1 for s in r["ships"])
    assert r["not_compatible"] == []


async def test_fit_check_same_sidegrade_empty_and_another_member():
    r = await _tools().member_fit_check(MICRO, "Hemera")
    assert r["member"] == MICRO
    ships = _by_ship(r)
    freelancer = {s["slot"]: s for s in ships["m3"]["slots"]}
    assert freelancer["hardpoint_quantum_drive"]["verdict"] == "same"
    assert freelancer["hardpoint_quantum_drive_aux"]["verdict"] == "sidegrade"
    gladius = ships["m4"]["slots"][0]
    assert gladius["verdict"] == "upgrade" and gladius["current"] is None
    assert "empty" in gladius["reason"]


async def test_fit_check_size_mismatch_vs_no_slot():
    r = await _tools().member_fit_check(MICRO, "Hemera")
    nc = {x["shipId"]: x for x in r["not_compatible"]}
    assert nc["m1"]["reason"] == "size_mismatch"
    assert "size 2" in nc["m1"]["detail"] and "S1" in nc["m1"]["detail"]
    assert nc["m2"]["reason"] == "no_slot"
    assert "QuantumDrive" in nc["m2"]["detail"]
    assert "m1" not in _by_ship(r) and "m2" not in _by_ship(r)


async def test_fit_check_loadout_unavailable_listed_separately():
    r = await _tools().member_fit_check(BROKEN, "Hemera")
    assert r["ships"] == []
    assert r["not_compatible"][0]["reason"] == "loadout_unavailable"


async def test_fit_check_current_item_stats_unknown():
    hangars = {**HANGARS, "777": {"member": "777", "ships": [
        _ship("z1", "Zeus", [_slot("hardpoint_quantum_drive", "QuantumDrive", 2, 2, "Mystery")])]}}

    class H(FakeHangar):
        async def get_hangar(self, member_id):
            return hangars[member_id]
    r = await _tools(H()).member_fit_check("777", "Hemera")
    s = r["ships"][0]["slots"][0]
    assert s["verdict"] == "unknown" and s["current"]["name"] == "Mystery"


async def test_fit_check_current_item_looked_up_by_uuid_first():
    items = FakeItems()
    await _tools(items=items).member_fit_check(AKIRA, "Hemera")
    assert "uuid-Bolon" in items.calls and "Bolon" not in items.calls


async def test_fit_check_item_lookup_errors_pass_through():
    r = await _tools().member_fit_check(AKIRA, "Ambig")
    assert r["error"] == "ambiguous" and r["candidates"] == ["Ambig A", "Ambig B"]
    r = await _tools().member_fit_check(AKIRA, "Nonexistium")
    assert r["error"] == "not_found"


async def test_fit_check_shield_matches_shield_slots_only():
    r = await _tools().member_fit_check(AKIRA, "Ghost Shield")
    ships = _by_ship(r)
    assert ships["h1"]["slots"][0]["slot"] == "hardpoint_shield_generator_left"
    nc = {x["shipId"]: x for x in r["not_compatible"]}
    assert nc["c1"]["reason"] == "size_mismatch"  # Taurus shield slot is S3
    assert r["key_stat"] == "max_health"


# --- fix round 1: compatibility parity with hangar-service check_compatible ---
# Loadouts recorded from hangar-service's effective_loadout over the real
# Constellation Taurus Wiki fixture (with compatibleTypes).
import asyncio
import time

from tests.conftest import load_fixture

_TAURUS_LOADOUTS = load_fixture("hangar_taurus_loadouts.json")
TAURUS_MEMBER = "888"


def _taurus_hangar(loadout_key):
    return {"member": TAURUS_MEMBER, "ships": [
        _ship("t1", "Constellation Taurus", _TAURUS_LOADOUTS[loadout_key])]}


class _StaticHangar:
    def __init__(self, body, delay=0.0):
        self.body, self.delay = body, delay

    async def get_hangar(self, member_id):
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.body


def _profile(name, type_, sub_type, size, stats, uuid=None):
    return {"source": "wiki", "game_version": "4.3.1", "uuid": uuid or f"uuid-{name}",
            "item": {"name": name, "type": type_, "sub_type": sub_type, "size": size,
                     "key_stats": stats}, "where_to_buy": []}


class _DictItems:
    def __init__(self, profiles, delays=None):
        self.profiles, self.delays = profiles, delays or {}
        self.calls = []

    async def component(self, key):
        self.calls.append(key)
        if key in self.delays:
            await asyncio.sleep(self.delays[key])
        for p in self.profiles.values():
            if key in (p["uuid"], p["item"]["name"]):
                return p
        return {"error": "not_found", "detail": key, "stale_fallback": False, "candidates": []}


_S5_GUN = _profile("Fixed S5 Cannon", "WeaponGun", "Gun", 5, {"dps": 900}, uuid="uuid-fixed-s5")
_GALDEREEN = _profile("CF-557 Galdereen Repeater", "WeaponGun", "Gun", 5, {"dps": 800},
                      uuid="81e0d1d4-0000-0000-0000-000000000000")
_ROCKET = _profile("Rocket Pod S3", "WeaponGun", "Rocket", 3, {"dps": 300})
_HEMERA = _profile("Hemera", "QuantumDrive", "UNDEFINED", 2, {"speed": 326_114_300})
_SHIELD_S3 = _profile("Big Shield", "Shield", "UNDEFINED", 3, {"max_health": 99_999})
_MISSILE = _profile("Ignite II", "Missile", "Missile", 2, {"damage": 1000})


def _gun_tools(loadout_key, extra=None):
    profiles = {"gun": _S5_GUN, "rocket": _ROCKET, "hemera": _HEMERA, "shield": _SHIELD_S3,
                "missile": _MISSILE, **(extra or {})}
    return HangarTools(_StaticHangar(_taurus_hangar(loadout_key)), _DictItems(profiles))


async def test_fixed_gun_reported_on_gimbal_children_not_the_turret_parent():
    r = await _gun_tools("stock").member_fit_check(TAURUS_MEMBER, "Fixed S5 Cannon")
    slots = {s["slot"] for s in r["ships"][0]["slots"]}
    assert slots == {f"hardpoint_gun_laser_{p}/hardpoint_class_2"
                     for p in ("top_left", "top_right", "bottom_left", "bottom_right")}


async def test_fixed_gun_fits_a_refitted_gimbal_hardpoint():
    """The member put a fixed gun straight on a gimbal hardpoint (a Turret
    slot whose compatibleTypes include WeaponGun): its stock children are
    hidden, and the parent itself is the reported slot."""
    r = await _gun_tools("fixed_gun_on_gimbal_hardpoint").member_fit_check(TAURUS_MEMBER, "Fixed S5 Cannon")
    slots = {s["slot"]: s for s in r["ships"][0]["slots"]}
    parent = slots["hardpoint_gun_laser_top_left"]
    assert parent["verdict"] == "same"  # identical item, by uuid
    assert "hardpoint_gun_laser_top_right/hardpoint_class_2" in slots
    assert not any(k.startswith("hardpoint_gun_laser_top_left/") for k in slots)


async def test_turret_parent_holding_a_gimbal_is_not_reported():
    # A different-type item (a gimbal mount) on the parent with no visible
    # children: the gun goes in the gimbal, which we can't see -> not offered.
    loadout = [dict(e) for e in _TAURUS_LOADOUTS["fixed_gun_on_gimbal_hardpoint"]]
    for e in loadout:
        if e["slot"] == "hardpoint_gun_laser_top_left":
            e["item"] = {"uuid": "uuid-gimbal", "name": "Gimbal Mount S5"}
    gimbal = _profile("Gimbal Mount S5", "Turret", "GunTurret", 5, {})
    tools = HangarTools(_StaticHangar({"member": TAURUS_MEMBER, "ships": [_ship("t1", "Constellation Taurus", loadout)]}),
                        _DictItems({"gun": _S5_GUN, "gimbal": gimbal}))
    r = await tools.member_fit_check(TAURUS_MEMBER, "Fixed S5 Cannon")
    assert "hardpoint_gun_laser_top_left" not in {s["slot"] for s in r["ships"][0]["slots"]}


async def test_rocket_subtype_rejected_from_gun_only_slots():
    r = await _gun_tools("stock").member_fit_check(TAURUS_MEMBER, "Rocket Pod S3")
    assert r["ships"] == []
    nc = r["not_compatible"][0]
    assert nc["reason"] == "no_slot" and "Rocket" in nc["detail"] and "Gun" in nc["detail"]


async def test_qd_and_shield_unaffected_by_subtype_rules():
    r = await _gun_tools("stock").member_fit_check(TAURUS_MEMBER, "Hemera")
    assert [s["slot"] for s in r["ships"][0]["slots"]] == ["hardpoint_quantum_drive"]
    r = await _gun_tools("stock").member_fit_check(TAURUS_MEMBER, "Big Shield")
    assert [s["slot"] for s in r["ships"][0]["slots"]] == ["hardpoint_shield_generator"]


async def test_missiles_are_not_tracked():
    r = await _gun_tools("stock").member_fit_check(TAURUS_MEMBER, "Ignite II")
    assert r["error"] == "not_tracked" and "missiles" in r["detail"].lower()


async def test_same_verdict_by_uuid_when_names_collide():
    twin = _profile("CF-557 Galdereen Repeater", "WeaponGun", "Gun", 5, {"dps": 800}, uuid="uuid-other-galdereen")
    r = await _gun_tools("stock", {"twin": twin}).member_fit_check(TAURUS_MEMBER, "uuid-other-galdereen")
    verdicts = {s["verdict"] for s in r["ships"][0]["slots"]}
    assert "same" not in verdicts


# --- fix round 1: overall deadline (voice bounds a whole tool call at 6s) ---

def _fast_tools(hangar, items):
    return HangarTools(hangar, items, deadline_s=0.5, item_timeout_s=0.25, lookup_timeout_s=0.4)


async def test_hangar_fetch_and_item_lookup_run_concurrently():
    items = _DictItems({"h": _HEMERA}, delays={"Hemera": 0.2})
    t0 = time.monotonic()
    r = await _fast_tools(_StaticHangar(_taurus_hangar("stock"), delay=0.2), items).member_fit_check(
        TAURUS_MEMBER, "Hemera")
    assert "error" not in r
    assert time.monotonic() - t0 < 0.35


async def test_slow_target_lookup_is_bounded():
    items = _DictItems({"h": _HEMERA}, delays={"Hemera": 5})
    t0 = time.monotonic()
    r = await _fast_tools(_StaticHangar(_taurus_hangar("stock")), items).member_fit_check(TAURUS_MEMBER, "Hemera")
    assert r["error"] == "wiki_unavailable" and "timed out" in r["detail"]
    assert time.monotonic() - t0 < 0.4


async def test_slow_current_item_lookups_get_only_remaining_budget():
    bolon = _profile("Bolon", "QuantumDrive", "UNDEFINED", 2, {"speed": 283_000_000},
                     uuid="74cc0d0b-1bf5-436c-a38c-1baf93962b89")
    items = _DictItems({"h": _HEMERA, "b": bolon},
                       delays={"Hemera": 0.2, "74cc0d0b-1bf5-436c-a38c-1baf93962b89": 5})
    t0 = time.monotonic()
    r = await _fast_tools(_StaticHangar(_taurus_hangar("stock")), items).member_fit_check(TAURUS_MEMBER, "Hemera")
    elapsed = time.monotonic() - t0
    assert elapsed < 0.6
    s = r["ships"][0]["slots"][0]
    assert s["verdict"] == "unknown" and "time" in s["reason"]


async def test_member_hangar_bounded_by_deadline():
    t0 = time.monotonic()
    r = await _fast_tools(_StaticHangar(_taurus_hangar("stock"), delay=5), _DictItems({})).member_hangar(
        TAURUS_MEMBER)
    assert r["error"] == "unavailable" and "timed out" in r["detail"]
    assert time.monotonic() - t0 < 0.6
