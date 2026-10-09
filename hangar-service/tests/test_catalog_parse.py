"""Slot parsing from recorded Wiki vehicle payloads (pure functions, no I/O)."""
from src.catalog import SLOT_TYPES, Slot, item_summary, parse_slots, vehicle_summary
from tests.conftest import HARBINGER_UUID, TAURUS_UUID, load_fixture


def _taurus():
    return load_fixture("wiki_vehicle_constellation_taurus.json")["data"]


def _harbinger():
    return load_fixture("wiki_vehicle_vanguard_harbinger.json")["data"]


def _by_name(slots):
    return {s.name: s for s in slots}


def test_allowlist_is_exactly_the_spec_component_types():
    assert SLOT_TYPES == frozenset({
        "QuantumDrive", "Shield", "PowerPlant", "Cooler", "Radar", "WeaponGun",
        "Turret", "MissileLauncher", "WeaponMining", "TractorBeam"})


def test_taurus_top_level_component_slots():
    s = _by_name(parse_slots(_taurus()))
    qd = s["hardpoint_quantum_drive"]
    assert (qd.type, qd.size_min, qd.size_max) == ("QuantumDrive", 2, 2)
    assert qd.stock_item["name"] == "Bolon"
    assert qd.stock_item["uuid"] == "74cc0d0b-1bf5-436c-a38c-1baf93962b89"
    sh = s["hardpoint_shield_generator"]
    assert (sh.type, sh.size_min, sh.size_max, sh.stock_item["name"]) == ("Shield", 3, 3, "Stronghold")
    for side in ("left", "right"):
        pp = s[f"hardpoint_powerplant_{side}"]
        assert (pp.type, pp.size_min, pp.size_max, pp.stock_item["name"]) == ("PowerPlant", 2, 2, "Diligence")
        co = s[f"hardpoint_cooler_{side}"]
        assert (co.type, co.size_min, co.size_max, co.stock_item["name"]) == ("Cooler", 1, 2, "CoolCore")
    rd = s["hardpoint_radar"]
    assert (rd.type, rd.size_min, rd.size_max, rd.stock_item["name"]) == ("Radar", 1, 2, "Surveyor")


def test_taurus_four_s5_turrets_with_nested_weapons_flattened_parent_child():
    s = _by_name(parse_slots(_taurus()))
    for pos in ("top_right", "top_left", "bottom_right", "bottom_left"):
        t = s[f"hardpoint_gun_laser_{pos}"]
        assert (t.type, t.size_min, t.size_max) == ("Turret", 5, 5)
        assert t.stock_item["name"] == "VariPuck S5 Gimbal Mount"
        assert {c["type"] for c in t.compatible_types} == {"Turret", "WeaponGun"}
        gun = s[f"hardpoint_gun_laser_{pos}/hardpoint_class_2"]
        assert (gun.type, gun.size_min, gun.size_max) == ("WeaponGun", 5, 5)
        assert gun.stock_item["name"] == "CF-557 Galdereen Repeater"


def test_nested_editable_child_under_non_editable_parent_is_a_slot():
    # The manned upper turret: the turret base and the S3 gimbals are not
    # editable, but the guns inside them are -- the real Wiki payload marks the
    # gun `editable` while its parent's `editable_children` is false, so the
    # child's own flag decides. The slot id is the full parent/child path.
    s = _by_name(parse_slots(_taurus()))
    gun = s["hardpoint_turret_base_upper/hardpoint_weapon_left/hardpoint_class_2"]
    assert (gun.type, gun.size_min, gun.stock_item["name"]) == ("WeaponGun", 3, "CF-337 Panther Repeater")
    assert "hardpoint_turret_base_upper/hardpoint_weapon_left" not in s  # gimbal not editable


def test_taurus_excludes_non_component_and_non_editable_ports():
    slots = parse_slots(_taurus())
    names = {s.name for s in slots}
    assert all(s.type in SLOT_TYPES for s in slots)
    # paint / flair are editable but not component types
    assert "hardpoint_paint" not in names
    assert "hardpoint_cockpit_flair" not in names
    # jump drive (editable child of the QD) is not an allowlisted type
    assert not any("Jump_Drive" in n for n in names)
    # missile racks are not editable; missiles are not an allowlisted type
    assert not any("missilerack" in n for n in names)
    # the lower turret's tractor beam is not editable
    assert not any("turret_base_lower" in n for n in names)


def test_taurus_exact_slot_set():
    names = sorted(s.name for s in parse_slots(_taurus()))
    expected = sorted([
        "hardpoint_radar", "hardpoint_quantum_drive", "hardpoint_shield_generator",
        "hardpoint_powerplant_right", "hardpoint_powerplant_left",
        "hardpoint_cooler_right", "hardpoint_cooler_left",
        *[f"hardpoint_gun_laser_{p}" for p in ("top_right", "top_left", "bottom_right", "bottom_left")],
        *[f"hardpoint_gun_laser_{p}/hardpoint_class_2" for p in ("top_right", "top_left", "bottom_right", "bottom_left")],
        "hardpoint_turret_base_upper/hardpoint_weapon_left/hardpoint_class_2",
        "hardpoint_turret_base_upper/hardpoint_weapon_right/hardpoint_class_2",
    ])
    assert names == expected


def test_harbinger_slots():
    s = _by_name(parse_slots(_harbinger()))
    assert [n for n in s if n.startswith("hardpoint_shield")] == [
        "hardpoint_shield_generator_001", "hardpoint_shield_generator_002"]
    assert s["hardpoint_shield_generator_001"].stock_item["name"] == "SecureShield"
    assert s["hardpoint_shield_generator_001"].size_min == 2
    assert s["hardpoint_quantum_drive"].stock_item["name"] == "Yeager"
    nose = s["hardpoint_weapon_gun_nose/hardpoint_class_2"]
    assert (nose.type, nose.size_min, nose.stock_item["name"]) == ("WeaponGun", 5, "Deadbolt V Cannon")
    # the remote turret's guns are not editable
    assert not any(n.startswith("hardpoint_turret/") for n in s)


def test_port_with_no_equipped_item_has_none_stock_and_missing_sizes_default():
    v = {"ports": [
        {"name": "hp_qd", "type": "QuantumDrive", "editable": True, "sizes": {"min": 1, "max": 1},
         "compatible_types": [{"type": "QuantumDrive", "sub_types": []}], "equipped_item": None, "ports": None},
        {"name": "hp_odd", "type": "Shield", "editable": True, "sizes": None,
         "compatible_types": None, "equipped_item": {"uuid": "u", "name": "N", "size": 1}},
    ]}
    s = _by_name(parse_slots(v))
    assert s["hp_qd"].stock_item is None
    assert (s["hp_odd"].size_min, s["hp_odd"].size_max, s["hp_odd"].compatible_types) == (None, None, [])


def test_parse_slots_tolerates_missing_ports():
    assert parse_slots({}) == []
    assert parse_slots({"ports": None}) == []


def test_slot_to_dict_shape():
    s = _by_name(parse_slots(_taurus()))["hardpoint_quantum_drive"]
    d = s.to_dict()
    assert d == {
        "slot": "hardpoint_quantum_drive", "type": "QuantumDrive", "subType": s.sub_type,
        "sizeMin": 2, "sizeMax": 2,
        "compatibleTypes": [{"type": "QuantumDrive", "subTypes": ["QDrive"]}],
        "stockItem": {"uuid": "74cc0d0b-1bf5-436c-a38c-1baf93962b89", "name": "Bolon",
                      "className": s.stock_item["className"], "type": "QuantumDrive", "size": 2},
    }
    assert isinstance(s, Slot)


def test_vehicle_and_item_summaries():
    v = vehicle_summary(_taurus())
    assert v == {"uuid": TAURUS_UUID, "name": "Constellation Taurus", "gameName": "RSI Constellation Taurus",
                 "slug": "rsi-constellation-taurus", "className": "RSI_Constellation_Taurus",
                 "manufacturer": "Roberts Space Industries"}
    assert vehicle_summary(_harbinger())["uuid"] == HARBINGER_UUID
    i = item_summary(load_fixture("wiki_item_hemera.json")["data"])
    assert {k: i[k] for k in ("uuid", "name", "type", "size")} == {
        "uuid": "3bd1502d-f593-456f-a3a9-14fec5b8c1a5", "name": "Hemera", "type": "QuantumDrive", "size": 2}
    assert set(i) == {"uuid", "name", "className", "type", "subType", "size", "grade", "class", "manufacturer"}
