"""spviewer import: the vendored LZ-string decoder, port walking and the diff
against stock -- pinned against the REAL Harbinger export fixture plus
synthetic loadouts built from it."""
import copy
import json

import httpx
import pytest

from src.catalog import build_catalog
from src.lzstring import LZStringError, decompress_from_encoded_uri_component
from src.spviewer import (EMPTY_SLOT, INCOMPATIBLE, MAX_PORTS_PER_ROW, MAX_ROW_DECODED_CHARS,
                          TOO_LARGE, TOO_MANY_LOOKUPS, UNKNOWN_ITEM, UNKNOWN_VEHICLE, UNRECOGNIZED_FORMAT,
                          UNTRACKED_SLOT, DecodeBudget, FormatError, analyze_row, decode_loadout, walk_ports)
from tests.conftest import HARBINGER_UUID, HEMERA_UUID, load_fixture, wiki_handler
from tests.lzcompress import compress_to_encoded_uri_component as lz

LORICA = "fb145cc4-2e30-44a0-865d-b9ea0e40fae1"         # 7MA 'Lorica' (Shield S2)
V801 = "69b8ba78-889f-4547-97eb-1d477002fedc"           # V801-12 (Radar S2, MidRangeRadar)
BRVS = "a4f4afa6-aa15-46e4-9327-c27250c3ea83"           # BRVS Repeater (WeaponGun S2)
SECURESHIELD = "c8b42a1b-2000-4d7e-8888-208480c739b6"   # Harbinger stock shield
CHERNYKH = "5b0d1308-b34a-4b55-94f5-7270e03ca82a"       # Harbinger stock radar
CVSA = "8115a034-92bf-4766-b0ce-408398ddc7e7"           # Harbinger stock nose S2 gun
YEAGER = "903b3f33-f3de-412f-8804-19090436c525"         # Harbinger stock QD
DEADBOLT = "76775574-fcf2-493d-859e-337f1267a7ef"       # Harbinger stock nose S5 gun
NOSE_S2 = [f"hardpoint_weapon_gun_nose_fixed_00{i}/hardpoint_class_2" for i in range(1, 5)]
QD = "hardpoint_quantum_drive"
NOSE_S5 = "hardpoint_weapon_gun_nose/hardpoint_class_2"

# JS lz-string 1.5 compressToEncodedURIComponent of _VECTOR_PLAIN (BMP accents,
# a non-BMP emoji = surrogate pair, a long repetition, JSON).
_VECTOR_PLAIN = "héllo 😀 wörld " + "abc" * 500 + json.dumps({"a": [1, 2, 3]}, separators=(",", ":"))
_VECTOR_JS = ("BYS4NmD2AEi8G4AHvQO4DeBOYAm0CGAjAY3yMOLNIpKvOspvrsduYZadY-a7Z89+76CBw-qKFiR4qZJkS50+bIXKlqxe"
              "pUa1mndr1aDuw-qOmT545bNWL1u7Yc2n9545fu3n1974BvAEQ4-gBcANoAjAA0AEyRAMwAugC+QA")


async def _nosleep(_):
    return None


def make_catalog(calls=None):
    return build_catalog("https://api.star-citizen.wiki/api", version="test",
                         transport=httpx.MockTransport(wiki_handler(calls)), sleep=_nosleep)


def real_row() -> dict:
    return copy.deepcopy(load_fixture("spviewer_harbinger.json")[0])


def real_loadout() -> dict:
    return json.loads(decompress_from_encoded_uri_component(real_row()["loadoutData"]))


def row_with(loadout: dict, **fields) -> dict:
    row = real_row()
    row["loadoutData"] = lz(json.dumps(loadout))
    row.update(fields)
    return row


def stock_loadout() -> dict:
    """The real export with every selected* entry removed: each port's current
    item is then its Loadout -- all stock (the older/fallback export shape)."""
    lo = real_loadout()
    for k in list(lo):
        if k.startswith("selected"):
            lo[k] = {}
    return lo


def _port(lo: dict, category: str, path: str) -> dict:
    names = path.split("/")
    ports = lo[category]
    node = None
    for n in names:
        node = next(p for p in ports if p["PortName"] == n)
        ports = node.get("Ports") or []
    return node


# ---------- LZ-string decoder ----------

def test_decoder_matches_js_reference_vector():
    assert decompress_from_encoded_uri_component(_VECTOR_JS) == _VECTOR_PLAIN


def test_decoder_real_fixture_and_round_trip():
    text = decompress_from_encoded_uri_component(real_row()["loadoutData"])
    assert len(text) == 142351 and json.loads(text)["shieldPorts"]
    assert lz(text) == real_row()["loadoutData"]       # the test compressor is byte-exact with JS


def test_decoder_empty_and_space_as_plus():
    assert decompress_from_encoded_uri_component("") == ""
    assert decompress_from_encoded_uri_component(lz("")) == ""
    enc = lz("a+b?" * 20)
    assert "+" in enc or "-" in enc
    assert decompress_from_encoded_uri_component(enc.replace("+", " ")) == "a+b?" * 20


@pytest.mark.parametrize("bad", ["not lz!", "%%%%", "abc\x00"])
def test_decoder_rejects_characters_outside_the_alphabet(bad):
    with pytest.raises(LZStringError):
        decompress_from_encoded_uri_component(bad)


def test_decoder_rejects_truncated_stream():
    enc = lz("hello world " * 50)
    with pytest.raises(LZStringError):
        decompress_from_encoded_uri_component(enc[: len(enc) // 2])


def test_decoder_output_cap_stops_a_decompression_bomb():
    bomb = lz("A" * 200_000)
    assert len(bomb) < 2000
    with pytest.raises(LZStringError, match="exceeds"):
        decompress_from_encoded_uri_component(bomb, max_chars=100_000)
    assert len(decompress_from_encoded_uri_component(bomb, max_chars=200_000)) == 200_000


# ---------- decode_loadout ----------

def test_decode_loadout_shape_errors():
    for data, reason in ((None, UNRECOGNIZED_FORMAT), ("", UNRECOGNIZED_FORMAT), ("###", UNRECOGNIZED_FORMAT),
                         (lz("not json"), UNRECOGNIZED_FORMAT), (lz("[1,2]"), UNRECOGNIZED_FORMAT),
                         (lz('{"selectedShields": {}}'), UNRECOGNIZED_FORMAT)):
        with pytest.raises(FormatError) as ei:
            decode_loadout(data)
        assert ei.value.reason == reason


def test_decode_loadout_per_row_cap_and_request_budget():
    big = lz(json.dumps({"shieldPorts": [], "pad": "x" * (MAX_ROW_DECODED_CHARS + 10)}))
    with pytest.raises(FormatError) as ei:
        decode_loadout(big)
    assert ei.value.reason == TOO_LARGE
    budget = DecodeBudget(200_000)
    text = real_row()["loadoutData"]
    decode_loadout(text, budget=budget)               # 142351 chars
    assert budget.remaining == 200_000 - 142351
    with pytest.raises(FormatError) as ei:
        decode_loadout(text, budget=budget)           # second copy no longer fits
    assert ei.value.reason == TOO_LARGE and "budget" in ei.value.detail


# ---------- port walking ----------

def test_walk_ports_builds_slash_slot_ids_and_reads_selected_maps():
    ports = {p.slot: p for p in walk_ports(real_loadout())}
    assert {"hardpoint_quantum_drive", "hardpoint_quantum_drive/hardpoint_Jump_Drive",
            NOSE_S5, *NOSE_S2, "hardpoint_shield_generator_001", "hardpoint_paint"} <= set(ports)
    shield = ports["hardpoint_shield_generator_001"]
    assert (shield.selected_ref, shield.selected_class) == (LORICA, "SHLD_BEHR_S02_7MA_SCItem")
    assert shield.loadout_ref == shield.base_class == "SHLD_GODI_S02_SecureShield_SCItem"
    # selected key "1-hardpoint_weapon_gun_nose_fixed_001hardpoint_class_2" (no separator)
    assert ports[NOSE_S2[0]].selected_ref == BRVS and ports[NOSE_S2[0]].loadout_ref == CVSA
    assert not ports["hardpoint_paint"].has_selected and ports["hardpoint_paint"].loadout_ref is None


def test_every_selected_map_of_the_real_export_pairs_with_its_ports_array():
    lo = real_loadout()
    ports = walk_ports(lo)
    used = {p.category for p in ports if p.has_selected}
    with_entries = {k for k, v in lo.items() if k.startswith("selected") and v}
    assert len(used) == len(with_entries) == 10      # every non-empty selected* map is used


def test_walk_ports_without_selected_uses_loadout():
    ports = {p.slot: p for p in walk_ports(stock_loadout())}
    assert not ports[NOSE_S2[0]].has_selected and ports[NOSE_S2[0]].loadout_ref == CVSA


# ---------- analyze_row ----------

async def test_real_fixture_resolves_harbinger_and_imports_the_selected_loadout():
    # The real export: *Ports Loadout fields are stock, the member's choices live in
    # the selected* maps (spviewer's own loadoutPerfs agree with selected*).
    res = await analyze_row(make_catalog(), 0, real_row(), budget=DecodeBudget())
    assert res.error is None
    assert res.vehicle["uuid"] == HARBINGER_UUID and res.vehicle["name"] == "Vanguard Harbinger"
    p = res.to_preview()
    assert p["loadoutName"] == "akira-harbinger" and p["patch"] == "4.10.1.12660092"
    assert p["vehicle"] == {"uuid": HARBINGER_UUID, "name": "Vanguard Harbinger"}
    changes = {c["slot"]: c for c in p["changes"]}
    assert set(changes) == {*NOSE_S2, "hardpoint_shield_generator_001", "hardpoint_shield_generator_002",
                            "hardpoint_radar"}
    assert changes["hardpoint_shield_generator_001"] == {
        "slot": "hardpoint_shield_generator_001",
        "from": {"uuid": SECURESHIELD, "name": "SecureShield"},
        "to": {"uuid": LORICA, "name": "7MA 'Lorica'"}}
    assert changes["hardpoint_radar"]["to"] == {"uuid": V801, "name": "V801-12"}
    assert changes[NOSE_S2[3]]["from"] == {"uuid": CVSA, "name": "CVSA Cannon"}
    assert changes[NOSE_S2[3]]["to"] == {"uuid": BRVS, "name": "BRVS Repeater"}
    assert res.fitted["hardpoint_radar"] == {"itemUuid": V801, "itemName": "V801-12"}
    assert set(res.fitted) == set(changes)
    # torpedoes / missiles are not tracked by the hangar -> reported, never dropped
    assert {s["reason"] for s in p["skipped"]} == {UNTRACKED_SLOT}
    assert len(p["skipped"]) == 11
    torp = next(s for s in p["skipped"] if s["slot"].endswith("torpedo_tray_01_attach_node"))
    assert "MISL_S05_EM_TALN_Reaper" in torp["detail"]


async def test_all_stock_loadout_has_zero_changes_and_no_item_lookups():
    calls = []
    res = await analyze_row(make_catalog(calls), 0, row_with(stock_loadout()), budget=DecodeBudget())
    assert res.changes == [] and res.skipped == [] and res.fitted == {} and res.error is None
    # uuid Loadouts naming the stock item are matched against the Wiki stock uuid
    # without any per-item lookup.
    assert not [c for c in calls if c.url.path.startswith("/api/v2/items/")]


async def test_synthetic_loadout_qd_change_gun_by_uuid_missile_and_unknown_item():
    lo = stock_loadout()
    _port(lo, "quantumdrivePorts", QD)["Loadout"] = "QDRV_RSI_S02_Hemera_SCItem"     # class name
    _port(lo, "pilotWeaponsPorts", NOSE_S2[0])["Loadout"] = BRVS                       # Wiki uuid
    _port(lo, "missilesRackPorts",
          "hardpoint_weapon_missilerack_left_inner/missile_01_attach")["Loadout"] = "MISL_S02_IR_TALN_Other"
    _port(lo, "coolerPorts", "hardpoint_cooler_left")["Loadout"] = "COOL_NOPE_S02_Imaginary_SCItem"
    res = await analyze_row(make_catalog(), 3, row_with(lo, loadoutName="custom"), budget=DecodeBudget())
    p = res.to_preview()
    assert p["rowIndex"] == 3 and p["loadoutName"] == "custom"
    assert {c["slot"]: c["to"]["uuid"] for c in p["changes"]} == {QD: HEMERA_UUID, NOSE_S2[0]: BRVS}
    qd = next(c for c in p["changes"] if c["slot"] == QD)
    assert qd["from"] == {"uuid": YEAGER, "name": "Yeager"} and qd["to"]["name"] == "Hemera"
    skipped = {s["slot"]: s for s in p["skipped"]}
    assert skipped["hardpoint_weapon_missilerack_left_inner/missile_01_attach"]["reason"] == UNTRACKED_SLOT
    assert skipped["hardpoint_cooler_left"]["reason"] == UNKNOWN_ITEM
    assert "COOL_NOPE_S02_Imaginary_SCItem" in skipped["hardpoint_cooler_left"]["detail"]
    assert set(res.fitted) == {QD, NOSE_S2[0]}


async def test_uuid_loadout_for_the_stock_item_is_not_a_change():
    lo = stock_loadout()
    _port(lo, "pilotWeaponsPorts", NOSE_S5)["Loadout"] = DEADBOLT                 # stock, as uuid
    _port(lo, "shieldPorts", "hardpoint_shield_generator_001")["Loadout"] = SECURESHIELD   # stock, as uuid
    res = await analyze_row(make_catalog(), 0, row_with(lo), budget=DecodeBudget())
    assert res.changes == [] and res.skipped == []


async def test_incompatible_item_is_skipped():
    lo = stock_loadout()
    _port(lo, "pilotWeaponsPorts", NOSE_S5)["Loadout"] = BRVS            # S2 gun in an S5 slot
    _port(lo, "radarPorts", "hardpoint_radar")["Loadout"] = LORICA       # a shield in the radar slot
    res = await analyze_row(make_catalog(), 0, row_with(lo), budget=DecodeBudget())
    assert res.changes == []
    skipped = {s["slot"]: s for s in res.skipped}
    assert skipped[NOSE_S5]["reason"] == INCOMPATIBLE and "size 2" in skipped[NOSE_S5]["detail"]
    assert skipped["hardpoint_radar"]["reason"] == INCOMPATIBLE


async def test_tracked_slot_emptied_is_reported():
    lo = stock_loadout()
    _port(lo, "quantumdrivePorts", QD)["Loadout"] = None
    res = await analyze_row(make_catalog(), 0, row_with(lo), budget=DecodeBudget())
    assert res.changes == []
    assert [(s["slot"], s["reason"]) for s in res.skipped] == [(QD, EMPTY_SLOT)]


async def test_unknown_vehicle_row():
    row = row_with(stock_loadout(), vehicleClassName="NOPE_Imaginary_Ship", vehicleName="Imaginary Ship")
    res = await analyze_row(make_catalog(), 2, row, budget=DecodeBudget())
    p = res.to_preview()
    assert p["vehicle"] is None and p["changes"] == [] and res.error == UNKNOWN_VEHICLE
    assert p["skipped"] == [{"reason": UNKNOWN_VEHICLE,
                             "detail": "Imaginary Ship (NOPE_Imaginary_Ship) is not in the Star Citizen Wiki catalog"}]


@pytest.mark.parametrize("mutate", [
    lambda r: r.__setitem__("loadoutData", "%%% not lz %%%"),
    lambda r: r.__setitem__("loadoutData", lz("{not json")),
    lambda r: r.__setitem__("loadoutData", lz('{"foo": 1}')),
    lambda r: r.pop("loadoutData"),
    lambda r: r.__setitem__("loadoutData", 12),
])
async def test_undecodable_row_is_unrecognized_format(mutate):
    row = real_row()
    mutate(row)
    res = await analyze_row(make_catalog(), 0, row, budget=DecodeBudget())
    p = res.to_preview()
    assert p["vehicle"] == {"uuid": HARBINGER_UUID, "name": "Vanguard Harbinger"}   # still resolved
    assert p["changes"] == [] and res.error == UNRECOGNIZED_FORMAT
    assert [s["reason"] for s in p["skipped"]] == [UNRECOGNIZED_FORMAT]


@pytest.mark.parametrize("row", [None, 5, "x", [], {"loadoutData": "x"}, {"vehicleClassName": 7}])
async def test_malformed_row_is_unrecognized_format(row):
    res = await analyze_row(make_catalog(), 0, row, budget=DecodeBudget())
    assert res.error == UNRECOGNIZED_FORMAT and res.to_preview()["vehicle"] is None


# ---------- fix round 1: lookup amplification, recursion, Loadout vs selected, key pairing ----------

def _item_calls(calls):
    return [c for c in calls if c.url.path.startswith("/api/v2/items/")]


async def test_duplicate_port_paths_are_unrecognized_format_without_any_lookup():
    lo = stock_loadout()
    # same (tracked) slot path 3000 times, a different uuid each
    lo["quantumdrivePorts"] = [{"PortName": QD, "Loadout": f"00000000-0000-4000-8000-{i:012d}"}
                               for i in range(3000)]
    calls = []
    res = await analyze_row(make_catalog(calls), 0, row_with(lo), budget=DecodeBudget())
    assert res.error == UNRECOGNIZED_FORMAT and "more than once" in res.error_message
    assert _item_calls(calls) == []


async def test_too_many_ports_is_too_large():
    lo = stock_loadout()
    lo["flairPorts"] = [{"PortName": f"flair_{i}", "Loadout": None} for i in range(MAX_PORTS_PER_ROW + 1)]
    res = await analyze_row(make_catalog(), 0, row_with(lo), budget=DecodeBudget())
    assert res.error == TOO_LARGE and str(MAX_PORTS_PER_ROW) in res.error_message


async def test_distinct_lookup_budget_is_per_request_and_reported():
    calls = []
    catalog = make_catalog(calls)
    budget = DecodeBudget(max_lookups=3)
    results = []
    for r in range(3):                       # each row: QD + 2 shields + radar -> 4 distinct random uuids
        lo = stock_loadout()
        for k, (cat, path) in enumerate((("quantumdrivePorts", QD), ("shieldPorts", "hardpoint_shield_generator_001"),
                                         ("shieldPorts", "hardpoint_shield_generator_002"),
                                         ("radarPorts", "hardpoint_radar"))):
            _port(lo, cat, path)["Loadout"] = f"00000000-0000-4000-8000-{r * 10 + k:012d}"
        results.append(await analyze_row(catalog, r, row_with(lo), budget=budget))
    looked = {c.url.path for c in _item_calls(calls)}
    assert len(looked) <= 3
    reasons = [s["reason"] for res in results for s in res.skipped]
    assert (reasons.count(UNKNOWN_ITEM), reasons.count(TOO_MANY_LOOKUPS)) == (3, 9)
    # a repeat of an already-looked-up key is free
    assert budget.admit_lookup(next(iter(budget.looked_up))) is True


async def test_repeated_item_across_rows_costs_one_lookup():
    budget = DecodeBudget(max_lookups=1)
    calls = []
    catalog = make_catalog(calls)
    for r in range(5):
        res = await analyze_row(catalog, r, real_row(), budget=budget)   # BRVS, 7MA, V801 by uuid
        if r == 0:
            assert {s["reason"] for s in res.skipped} >= {TOO_MANY_LOOKUPS}
    assert len(budget.looked_up) == 1


@pytest.mark.parametrize("bad_ref", ["COOL with spaces", "../../etc/passwd", "x" * 101, "QDRV-Hemera", "é_item"])
async def test_malformed_item_keys_are_never_sent_to_the_wiki(bad_ref):
    lo = stock_loadout()
    _port(lo, "coolerPorts", "hardpoint_cooler_left")["Loadout"] = bad_ref
    calls = []
    res = await analyze_row(make_catalog(calls), 0, row_with(lo), budget=DecodeBudget())
    assert [(s["slot"], s["reason"]) for s in res.skipped] == [("hardpoint_cooler_left", UNKNOWN_ITEM)]
    assert _item_calls(calls) == []


def test_deeply_nested_json_is_unrecognized_format():
    with pytest.raises(FormatError) as ei:
        decode_loadout(lz("[" * 200_000 + "]" * 200_000))
    assert ei.value.reason == UNRECOGNIZED_FORMAT


async def test_loadout_differing_from_stock_is_a_change_even_with_a_stock_selected_entry():
    lo = real_loadout()
    # selected says stock SecureShield, but the port's Loadout says 7MA
    lo["selectedShields"]["0-hardpoint_shield_generator_001"].update(
        {"className": "SHLD_GODI_S02_SecureShield_SCItem", "reference": SECURESHIELD})
    _port(lo, "shieldPorts", "hardpoint_shield_generator_001")["Loadout"] = "SHLD_BEHR_S02_7MA_SCItem"
    # no selected entry at all, Loadout a non-stock uuid
    del lo["selectedQuantumDrive"]["0-hardpoint_quantum_drive"]
    _port(lo, "quantumdrivePorts", QD)["Loadout"] = HEMERA_UUID
    res = await analyze_row(make_catalog(), 0, row_with(lo), budget=DecodeBudget())
    changes = {c["slot"]: c["to"]["uuid"] for c in res.changes}
    assert changes["hardpoint_shield_generator_001"] == LORICA
    assert changes[QD] == HEMERA_UUID


async def test_non_stock_selected_entry_wins_over_a_non_stock_loadout():
    lo = real_loadout()          # selected: 7MA
    _port(lo, "shieldPorts", "hardpoint_shield_generator_001")["Loadout"] = "QDRV_RSI_S02_Hemera_SCItem"
    res = await analyze_row(make_catalog(), 0, row_with(lo), budget=DecodeBudget())
    assert {c["slot"]: c["to"]["uuid"] for c in res.changes}["hardpoint_shield_generator_001"] == LORICA


def test_selected_entries_are_scoped_to_their_category_and_index():
    lo = real_loadout()
    # A shield entry filed under the RADAR map must not apply to the shield port.
    entry = lo["selectedShields"].pop("0-hardpoint_shield_generator_001")
    lo["selectedRadar"]["0-hardpoint_shield_generator_001"] = entry
    # Wrong index in a multi-port array (shieldPorts has 2): ignored.
    lo["selectedShields"]["5-hardpoint_shield_generator_002"] = lo["selectedShields"].pop(
        "1-hardpoint_shield_generator_002")
    # Wrong index in a single-port array (radarPorts has 1): accepted.
    lo["selectedRadar"]["3-hardpoint_radar"] = lo["selectedRadar"].pop("0-hardpoint_radar")
    ports = {p.slot: p for p in walk_ports(lo)}
    assert not ports["hardpoint_shield_generator_001"].has_selected
    assert not ports["hardpoint_shield_generator_002"].has_selected
    assert ports["hardpoint_radar"].selected_ref == V801
