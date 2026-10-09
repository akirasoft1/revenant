"""Effective-loadout merge, slot compatibility, vehicle resolution."""
from src.catalog import Slot, parse_slots, vehicle_summary
from src.loadout import Resolution, check_compatible, effective_loadout, resolve_vehicle
from tests.conftest import HARBINGER_UUID, TAURUS_UUID, load_fixture


def _taurus_slots():
    return parse_slots(load_fixture("wiki_vehicle_constellation_taurus.json")["data"])


def _slot(name="hp_qd", type_="QuantumDrive", lo=2, hi=2, compat=("QuantumDrive",), stock=None):
    return Slot(name=name, type=type_, sub_type=None, size_min=lo, size_max=hi,
                compatible_types=[{"type": t, "sub_types": []} for t in compat], stock_item=stock)


def _index():
    return [vehicle_summary(v) for v in load_fixture("wiki_vehicles_index.json")["data"]]


# ---------- effective_loadout ----------

def test_all_stock_when_nothing_fitted():
    lo = effective_loadout(_taurus_slots(), {})
    qd = next(e for e in lo if e["slot"] == "hardpoint_quantum_drive")
    assert qd == {"slot": "hardpoint_quantum_drive", "type": "QuantumDrive", "sizeMin": 2, "sizeMax": 2,
                  "item": {"uuid": "74cc0d0b-1bf5-436c-a38c-1baf93962b89", "name": "Bolon"},
                  "source": "stock"}
    assert all(e["source"] == "stock" for e in lo)
    assert len(lo) == len(_taurus_slots())
    assert effective_loadout(_taurus_slots(), None) == lo


def test_fitted_override_applies():
    fitted = {"hardpoint_quantum_drive": {"itemUuid": "3bd1502d-f593-456f-a3a9-14fec5b8c1a5", "itemName": "Hemera"}}
    lo = effective_loadout(_taurus_slots(), fitted)
    qd = next(e for e in lo if e["slot"] == "hardpoint_quantum_drive")
    assert qd["item"] == {"uuid": "3bd1502d-f593-456f-a3a9-14fec5b8c1a5", "name": "Hemera"}
    assert qd["source"] == "fitted"
    sh = next(e for e in lo if e["slot"] == "hardpoint_shield_generator")
    assert sh["source"] == "stock"


def test_order_follows_catalog_slot_order():
    slots = _taurus_slots()
    assert [e["slot"] for e in effective_loadout(slots, {})] == [s.name for s in slots]


def test_fitted_entry_for_unknown_slot_is_ignored():
    lo = effective_loadout(_taurus_slots(), {"hardpoint_gone_in_a_patch": {"itemUuid": "x", "itemName": "X"}})
    assert all(e["slot"] != "hardpoint_gone_in_a_patch" for e in lo)


def test_empty_stock_slot_has_null_item():
    lo = effective_loadout([_slot(stock=None)], {})
    assert lo[0]["item"] is None and lo[0]["source"] == "stock"


def test_refitting_a_parent_drops_its_stock_children():
    # The stock gun lives in the stock gimbal; once the gimbal slot is refitted
    # the stock child no longer describes the ship. A child the member fitted
    # explicitly is kept.
    slots = _taurus_slots()
    parent = "hardpoint_gun_laser_top_left"
    fitted = {parent: {"itemUuid": "g", "itemName": "Some S5 Cannon"}}
    names = [e["slot"] for e in effective_loadout(slots, fitted)]
    assert parent in names and f"{parent}/hardpoint_class_2" not in names
    # untouched sibling turret keeps its stock gun
    assert "hardpoint_gun_laser_top_right/hardpoint_class_2" in names
    fitted[f"{parent}/hardpoint_class_2"] = {"itemUuid": "w", "itemName": "Some Gun"}
    child = next(e for e in effective_loadout(slots, fitted) if e["slot"] == f"{parent}/hardpoint_class_2")
    assert child["source"] == "fitted"


def test_slot_name_prefix_is_not_mistaken_for_parent():
    slots = [_slot(name="hp_a"), _slot(name="hp_ab")]
    lo = effective_loadout(slots, {"hp_a": {"itemUuid": "x", "itemName": "X"}})
    assert [e["slot"] for e in lo] == ["hp_a", "hp_ab"]


# ---------- check_compatible ----------

def test_compatible_item_returns_none():
    assert check_compatible(_slot(), {"name": "Hemera", "type": "QuantumDrive", "size": 2}) is None


def test_wrong_type_reason():
    r = check_compatible(_slot(), {"name": "Stronghold", "type": "Shield", "size": 2})
    assert r is not None and "Shield" in r and "QuantumDrive" in r


def test_size_out_of_range_reason():
    r = check_compatible(_slot(lo=1, hi=2), {"name": "Big", "type": "QuantumDrive", "size": 3})
    assert r is not None and "size 3" in r and "1-2" in r
    r = check_compatible(_slot(lo=2, hi=2), {"name": "Small", "type": "QuantumDrive", "size": 1})
    assert r is not None and "size 1" in r


def test_size_range_inclusive():
    s = _slot(lo=1, hi=2, compat=("Cooler",), type_="Cooler")
    assert check_compatible(s, {"name": "a", "type": "Cooler", "size": 1}) is None
    assert check_compatible(s, {"name": "b", "type": "Cooler", "size": 2}) is None


def test_turret_slot_accepts_turret_or_gun():
    t = next(s for s in _taurus_slots() if s.name == "hardpoint_gun_laser_top_left")
    assert check_compatible(t, {"name": "Gun", "type": "WeaponGun", "size": 5}) is None
    assert check_compatible(t, {"name": "Gimbal", "type": "Turret", "size": 5}) is None
    assert check_compatible(t, {"name": "Shield", "type": "Shield", "size": 5}) is not None


def test_item_missing_size_is_incompatible():
    assert check_compatible(_slot(), {"name": "?", "type": "QuantumDrive", "size": None}) is not None


def test_slot_without_compatible_types_falls_back_to_slot_type():
    s = Slot(name="x", type="Shield", sub_type=None, size_min=1, size_max=1, compatible_types=[], stock_item=None)
    assert check_compatible(s, {"name": "a", "type": "Shield", "size": 1}) is None


# ---------- resolve_vehicle ----------

def test_resolve_exact_name_case_insensitive():
    r = resolve_vehicle("constellation taurus", _index())
    assert isinstance(r, Resolution)
    assert r.status == "match" and r.match["uuid"] == TAURUS_UUID and r.candidates == []


def test_resolve_by_uuid_slug_class_name_game_name():
    idx = _index()
    for q in (TAURUS_UUID, "rsi-constellation-taurus", "RSI_Constellation_Taurus", "RSI Constellation Taurus"):
        r = resolve_vehicle(q, idx)
        assert r.status == "match" and r.match["uuid"] == TAURUS_UUID, q


def test_resolve_single_token_match():
    r = resolve_vehicle("harbinger", _index())
    assert r.status == "match" and r.match["uuid"] == HARBINGER_UUID


def test_resolve_ambiguous_token_match_lists_candidates():
    r = resolve_vehicle("constellation", _index())
    assert r.status == "ambiguous" and r.match is None
    names = {c["name"] for c in r.candidates}
    assert {"Constellation Taurus", "Constellation Andromeda", "Constellation Aquila"} <= names


def test_resolve_duplicate_exact_name_collapses_to_base_edition():
    # The Wiki lists special editions under the same display name as the base
    # ship ("Carrack" = anvl-carrack and anvl-carrack-bis2950). The base
    # edition's slug prefixes the others', so it is the match.
    idx = _index()
    for name, slug in (("Eclipse", "aegs-eclipse"), ("Carrack", "anvl-carrack"),
                       ("cutlass black", "drak-cutlass-black"), ("Idris-P", "aegs-idris-p"),
                       ("Hammerhead", "aegs-hammerhead"), ("Polaris", "rsi-polaris")):
        r = resolve_vehicle(name, idx)
        assert r.status == "match" and r.match["slug"] == slug, name


def test_resolve_duplicate_exact_name_without_base_is_ambiguous():
    r = resolve_vehicle("Cutlass Black PYAM Exec", _index())
    assert r.status == "ambiguous"
    assert {c["slug"] for c in r.candidates} == {"drak-cutlass-black-exec-military",
                                                 "drak-cutlass-black-exec-stealth"}


def test_resolve_fuzzy_typo():
    r = resolve_vehicle("Constelation Taurus", _index())
    assert r.status == "match" and r.match["uuid"] == TAURUS_UUID


def test_resolve_not_found():
    r = resolve_vehicle("zzqx flibbertigibbet", _index())
    assert r.status == "not_found" and r.match is None and r.candidates == []
    assert resolve_vehicle("   ", _index()).status == "not_found"


def test_resolve_candidates_are_capped():
    r = resolve_vehicle("aegis", _index(), max_candidates=5)
    assert r.status == "ambiguous" and len(r.candidates) == 5


def test_resolution_to_dict():
    r = resolve_vehicle("taurus", _index())
    d = r.to_dict()
    assert d["status"] == "ambiguous" and d["match"] is None and len(d["candidates"]) == 2


# ---------- fix round 1 ----------

def _radar_slot():
    return Slot(name="hp_radar", type="Radar", sub_type="MidRangeRadar", size_min=1, size_max=2,
                compatible_types=[{"type": "Radar", "sub_types": ["ShortRangeRadar", "MidRangeRadar"]}],
                stock_item=None)


def test_sub_type_enforced_when_slot_lists_some():
    r = check_compatible(_radar_slot(), {"name": "Far Eye", "type": "Radar", "subType": "LongRangeRadar", "size": 2})
    assert r is not None and "LongRangeRadar" in r
    assert check_compatible(_radar_slot(), {"name": "Mid", "type": "Radar", "subType": "MidRangeRadar",
                                            "size": 2}) is None


def test_undefined_or_missing_item_sub_type_is_accepted():
    qd = next(s for s in _taurus_slots() if s.name == "hardpoint_quantum_drive")
    assert [c["sub_types"] for c in qd.compatible_types] == [["QDrive"]]
    assert check_compatible(qd, {"name": "Hemera", "type": "QuantumDrive", "subType": "UNDEFINED", "size": 2}) is None
    assert check_compatible(qd, {"name": "Hemera", "type": "QuantumDrive", "size": 2}) is None
    # raw Wiki items carry snake_case sub_type
    assert check_compatible(_radar_slot(), {"name": "x", "type": "Radar", "sub_type": "LongRangeRadar",
                                            "size": 1}) is not None


def test_slot_without_sub_types_accepts_any_sub_type():
    assert check_compatible(_slot(), {"name": "a", "type": "QuantumDrive", "subType": "Whatever", "size": 2}) is None


def test_ambiguous_candidates_collapse_editions_and_label_collisions():
    r = resolve_vehicle("cutlass", _index(), max_candidates=50)
    assert r.status == "ambiguous"
    slugs = [c["slug"] for c in r.candidates]
    # the BIS2950 editions collapse into their base ships
    assert "drak-cutlass-black" in slugs and "drak-cutlass-black-bis2950" not in slugs
    assert "drak-cutlass-red-bis2950" not in slugs
    labels = [c["label"] for c in r.candidates]
    assert "Cutlass Black" in labels
    # names that still collide (no base edition) are labelled with their slug
    pyam = [c for c in r.candidates if c["name"] == "Cutlass Black PYAM Exec"]
    assert len(pyam) == 2
    assert {c["label"] for c in pyam} == {"Cutlass Black PYAM Exec (drak-cutlass-black-exec-military)",
                                          "Cutlass Black PYAM Exec (drak-cutlass-black-exec-stealth)"}
    assert len(labels) == len(set(labels))


def test_match_carries_label_too():
    r = resolve_vehicle("harbinger", _index())
    assert r.match["label"] == "Vanguard Harbinger"
