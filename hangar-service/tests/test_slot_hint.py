"""Friendly slot hints ("left", "1", "nose", "shields", "all") -> slot ids."""
import pytest

from src.slot_hint import match_slots

HARB_GUNS = [
    ("hardpoint_weapon_gun_nose_fixed_001/hardpoint_class_2", "WeaponGun"),
    ("hardpoint_weapon_gun_nose_fixed_002/hardpoint_class_2", "WeaponGun"),
    ("hardpoint_weapon_gun_nose_fixed_003/hardpoint_class_2", "WeaponGun"),
    ("hardpoint_weapon_gun_nose_fixed_004/hardpoint_class_2", "WeaponGun"),
]
HARB_SHIELDS = [("hardpoint_shield_generator_001", "Shield"), ("hardpoint_shield_generator_002", "Shield")]
TAURUS = [
    ("hardpoint_turret_base_upper/hardpoint_weapon_left/hardpoint_class_2", "WeaponGun"),
    ("hardpoint_turret_base_upper/hardpoint_weapon_right/hardpoint_class_2", "WeaponGun"),
    ("hardpoint_radar", "Radar"),
    ("hardpoint_quantum_drive", "QuantumDrive"),
    ("hardpoint_shield_generator", "Shield"),
    ("hardpoint_powerplant_right", "PowerPlant"),
    ("hardpoint_powerplant_left", "PowerPlant"),
    ("hardpoint_cooler_right", "Cooler"),
    ("hardpoint_cooler_left", "Cooler"),
]
COOLERS = [s for s in TAURUS if s[1] == "Cooler"]


@pytest.mark.parametrize("hint", ["all", "ALL", " both ", "every"])
def test_all_selects_every_slot(hint):
    assert match_slots(hint, HARB_SHIELDS) == ("match", [s for s, _ in HARB_SHIELDS])


def test_exact_slot_id_case_insensitive():
    assert match_slots("HARDPOINT_COOLER_LEFT", COOLERS) == ("match", ["hardpoint_cooler_left"])


@pytest.mark.parametrize("hint,expected", [
    ("left", "hardpoint_cooler_left"), ("the right one", "hardpoint_cooler_right"),
    ("left cooler", "hardpoint_cooler_left"), ("R", "hardpoint_cooler_right"),
])
def test_side_hints(hint, expected):
    assert match_slots(hint, COOLERS) == ("match", [expected])


@pytest.mark.parametrize("hint,expected", [
    ("1", HARB_SHIELDS[0][0]), ("001", HARB_SHIELDS[0][0]), ("2", HARB_SHIELDS[1][0]),
    ("second", HARB_SHIELDS[1][0]), ("shield 2", HARB_SHIELDS[1][0]),
])
def test_numbered_hints(hint, expected):
    assert match_slots(hint, HARB_SHIELDS) == ("match", [expected])


def test_number_shared_by_every_slot_is_not_distinguishing():
    # every gun slot ends in hardpoint_class_2: "2" means fixed_002, not all four
    assert match_slots("2", HARB_GUNS) == ("match", [HARB_GUNS[1][0]])
    assert match_slots("4", HARB_GUNS) == ("match", [HARB_GUNS[3][0]])


def test_hint_matching_every_slot_is_ambiguous():
    assert match_slots("nose", HARB_GUNS) == ("ambiguous", [s for s, _ in HARB_GUNS])


def test_plural_hint_selects_every_matching_slot():
    assert match_slots("nose guns", HARB_GUNS) == ("match", [s for s, _ in HARB_GUNS])
    assert match_slots("shields", HARB_SHIELDS) == ("match", [s for s, _ in HARB_SHIELDS])
    assert match_slots("both coolers", TAURUS) == ("match", [s for s, _ in COOLERS])


def test_type_word_filters():
    assert match_slots("quantum drive", TAURUS) == ("match", ["hardpoint_quantum_drive"])
    assert match_slots("qd", TAURUS) == ("match", ["hardpoint_quantum_drive"])
    assert match_slots("shield", TAURUS) == ("match", ["hardpoint_shield_generator"])
    assert match_slots("cooler", TAURUS) == ("ambiguous", [s for s, _ in COOLERS])
    assert match_slots("left power plant", TAURUS) == ("match", ["hardpoint_powerplant_left"])


def test_upper_turret_guns():
    assert match_slots("upper left", TAURUS) == ("match", [TAURUS[0][0]])


@pytest.mark.parametrize("hint", ["tail", "7", "missile rack", "", "   "])
def test_no_match(hint):
    assert match_slots(hint, TAURUS)[0] == "none"
