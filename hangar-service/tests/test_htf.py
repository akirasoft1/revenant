import json
from pathlib import Path

import pytest

from src import htf
from src.catalog import vehicle_summary

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def vehicles():
    data = json.loads((FIX / "wiki_vehicles_index.json").read_text())["data"]
    return [vehicle_summary(v) for v in data]


@pytest.fixture()
def file_data():
    return json.loads((FIX / "htf_hangarxplor.json").read_text())


PL = {"id": "1", "name": None, "date": None, "dateIso": None, "cost": None, "lti": False, "warbond": False}


def by_cls(vehicles, cls):
    return next(v for v in vehicles if v["className"] == cls)


def ship(ship_id, vehicles, cls, key=None, nickname=None, fitted=None, **rsi_extra):
    v = by_cls(vehicles, cls)
    d = {"shipId": ship_id, "vehicleUuid": v["uuid"], "vehicleName": v["name"],
         "vehicleClassName": cls, "nickname": nickname, "fitted": fitted or {}}
    if key:
        d["rsi"] = {"key": key, "rsiName": None, **rsi_extra}
    return d


# ---- parse_cost / parse_date -------------------------------------------------

@pytest.mark.parametrize("raw,amount,cur", [
    ("$350.00 USD", 350.0, "USD"),
    ("€45,00 EUR", 45.0, "EUR"),
    ("$1,234.50 USD", 1234.5, "USD"),
    ("£20.00", 20.0, "GBP"),
    ("$10", 10.0, "USD"),
    ("1.234,50 EUR", 1234.5, "EUR"),
    ("1,234 USD", 1234.0, "USD"),
])
def test_parse_cost_ok(raw, amount, cur):
    assert htf.parse_cost(raw) == {"amount": amount, "currency": cur, "raw": raw}


def test_parse_cost_garbage_keeps_raw():
    assert htf.parse_cost("garbage") == {"amount": None, "currency": None, "raw": "garbage"}


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_parse_cost_empty(raw):
    assert htf.parse_cost(raw) is None


@pytest.mark.parametrize("raw,iso", [
    ("December 08, 2016", "2016-12-08"),
    ("Created: December 08, 2016", "2016-12-08"),
    ("created:December 8, 2016", "2016-12-08"),
    ("2022-01-15", "2022-01-15"),
    ("2022-01-15T10:00:00Z", "2022-01-15"),
    ("nonsense", None),
    ("", None),
    (None, None),
])
def test_parse_date(raw, iso):
    assert htf.parse_date(raw) == iso


def test_rsi_key():
    assert htf.rsi_key("1001", "ANVL_Carrack", 0) == "1001:anvl_carrack:0"


# ---- parse_file -----------------------------------------------------------------

def test_parse_file_entries_and_skips(file_data):
    entries, skipped = htf.parse_file(file_data)
    assert [e.index for e in entries] == [0, 1, 2, 3, 4, 6]
    assert [(s["index"], s["reason"]) for s in skipped] == [(5, "not_a_ship")]
    assert skipped[0]["name"] == "Some Paint Pack"
    carrack = entries[0]
    assert carrack.ship_code == "ANVL_Carrack" and carrack.ship_name == "Serenity" and carrack.name == "Carrack"
    assert carrack.pledge == {"id": "1001", "name": "Standalone Ship - Carrack - Warbond Edition",
                              "date": "December 08, 2016", "dateIso": "2016-12-08",
                              "cost": {"amount": 350.0, "currency": "USD", "raw": "$350.00 USD"},
                              "lti": True, "warbond": True}
    assert carrack.raw == file_data[0]


def test_ordinals_for_identical_ships(file_data):
    entries, _ = htf.parse_file(file_data)
    assert [e.ordinal for e in entries] == [0, 0, 0, 1, 0, 0]


def test_ordinal_is_per_pledge():
    row = {"ship_code": "ANVL_Arrow", "name": "Arrow", "pledge_id": "A"}
    entries, _ = htf.parse_file([row, {**row, "pledge_id": "B"}, row])
    assert [(e.pledge["id"], e.ordinal) for e in entries] == [("A", 0), ("B", 0), ("A", 1)]


def test_entity_type_absent_is_ship():
    entries, skipped = htf.parse_file([{"ship_code": "ANVL_Arrow", "name": "Arrow", "pledge_id": "1"}])
    assert len(entries) == 1 and not skipped


def test_invalid_rows_skipped():
    entries, skipped = htf.parse_file(["nope", {"entity_type": "ship", "pledge_id": "1"},
                                       {"ship_code": "ANVL_Arrow", "name": "Arrow"}])
    assert not entries
    assert [s["reason"] for s in skipped] == ["invalid"] * 3
    assert [s["index"] for s in skipped] == [0, 1, 2]


def test_parse_file_rejects_bad_input():
    with pytest.raises(ValueError):
        htf.parse_file({"a": 1})
    with pytest.raises(ValueError):
        htf.parse_file([{}] * 501)
    htf.parse_file([{}] * 500)


# ---- match_vehicle ---------------------------------------------------------------

def test_match_by_ship_code(file_data, vehicles):
    entries, _ = htf.parse_file(file_data)
    assert htf.match_vehicle(entries[0], vehicles)["className"] == "ANVL_Carrack"


def test_match_ship_code_case_insensitive(vehicles):
    e = htf.HtfEntry(0, "anvl_arrow", "Arrow", None, {"id": "1"}, {})
    assert htf.match_vehicle(e, vehicles)["className"] == "ANVL_Arrow"


def test_match_falls_back_to_name(file_data, vehicles):
    entries, _ = htf.parse_file(file_data)
    unidentified = next(e for e in entries if e.index == 4)
    assert htf.match_vehicle(unidentified, vehicles)["className"] == "ANVL_Gladiator"


def test_match_never_uses_custom_ship_name_when_name_is_unmatched(vehicles):
    # DRAK_Kraken (concept, not in catalog) named "Arrow" by its owner must NOT become an Arrow.
    e = htf.HtfEntry(0, "DRAK_Kraken_Fake", "Zzzz Kraken Concept", "Arrow", PL, {})
    assert htf.match_vehicle(e, vehicles) is None
    out = htf.classify([e], [], vehicles, [])
    assert out["rows"][0]["kind"] == "skipped" and out["rows"][0]["countedInTotals"] is True


def test_match_uses_ship_name_only_when_name_is_empty(vehicles):
    e = htf.HtfEntry(0, "BOGUS", None, "Gladiator", {"id": "1"}, {})
    assert htf.match_vehicle(e, vehicles)["className"] == "ANVL_Gladiator"


def test_match_unmatched_and_ambiguous(vehicles):
    assert htf.match_vehicle(htf.HtfEntry(0, "BOGUS", "Totally Fake Ship", None, {"id": "1"}, {}), vehicles) is None
    assert htf.match_vehicle(htf.HtfEntry(0, None, "Cutlass", None, {"id": "1"}, {}), vehicles) is None


# ---- rsi_record --------------------------------------------------------------------

def test_rsi_record_custom_name(file_data, vehicles):
    entries, _ = htf.parse_file(file_data)
    v = by_cls(vehicles, "ANVL_Carrack")
    rec = htf.rsi_record(entries[0], v, "2026-10-11T00:00:00+00:00")
    assert rec == {"key": "1001:anvl_carrack:0", "pledgeId": "1001", "shipCode": "ANVL_Carrack", "ordinal": 0,
                   "pledgeName": "Standalone Ship - Carrack - Warbond Edition",
                   "pledgeDate": "December 08, 2016", "pledgeDateIso": "2016-12-08",
                   "pledgeCost": {"amount": 350.0, "currency": "USD", "raw": "$350.00 USD"},
                   "lti": True, "warbond": True, "rsiName": "Serenity",
                   "importedAt": "2026-10-11T00:00:00+00:00"}


def test_rsi_name_null_when_same_as_model(file_data, vehicles):
    entries, _ = htf.parse_file(file_data)
    rec = htf.rsi_record(entries[1], by_cls(vehicles, "AEGS_Avenger_Titan"), "t")
    assert rec["rsiName"] is None
    e = htf.HtfEntry(0, "ANVL_Arrow", "Arrow", "  ARROW ", PL, {})
    assert htf.rsi_record(e, by_cls(vehicles, "ANVL_Arrow"), "t")["rsiName"] is None


def test_rsi_name_null_when_same_as_vehicle_name_only(vehicles):
    e = htf.HtfEntry(0, "ANVL_Hornet_F7C", "Hornet F7C", "F7C Hornet Mk I", PL, {})
    assert htf.rsi_record(e, by_cls(vehicles, "ANVL_Hornet_F7C"), "t")["rsiName"] is None


def test_rsi_record_garbage_cost_and_missing_date(file_data, vehicles):
    entries, _ = htf.parse_file(file_data)
    rec = htf.rsi_record(entries[-1], by_cls(vehicles, "ANVL_Arrow"), "t")
    assert rec["pledgeCost"] == {"amount": None, "currency": None, "raw": "garbage"}
    assert rec["pledgeDateIso"] == "2022-01-15"


# ---- classify ---------------------------------------------------------------------------

def test_classify_all_new(file_data, vehicles):
    entries, skipped = htf.parse_file(file_data)
    out = htf.classify(entries, skipped, vehicles, [])
    kinds = [r["kind"] for r in out["rows"]]
    assert [r["index"] for r in out["rows"]] == [0, 1, 2, 3, 4, 5, 6]
    assert kinds == ["new", "new", "new", "new", "new", "skipped", "new"]
    assert out["missing"] == [] and out["partial"] is False
    assert out["summary"] == {"new": 6, "existing": 0, "link": 0, "skipped": 1, "missing": 0}
    r0 = out["rows"][0]
    assert r0["rsiKey"] == "1001:anvl_carrack:0"
    assert r0["vehicle"] == {"uuid": by_cls(vehicles, "ANVL_Carrack")["uuid"], "name": "Carrack"}
    assert r0["nickname"] == "Serenity"
    assert r0["existing"] is None and r0["linkCandidates"] == [] and r0["reason"] is None
    assert r0["pledge"]["cost"]["amount"] == 350.0
    assert out["rows"][2]["rsiKey"] == "2002:anvl_c8_pisces:0" and out["rows"][3]["rsiKey"] == "2002:anvl_c8_pisces:1"
    sk = out["rows"][5]
    assert sk["vehicle"] is None and sk["reason"] == "not_a_ship" and sk["rsiKey"] is None


def test_classify_unmatched_row(vehicles):
    entries, skipped = htf.parse_file([{"ship_code": "BOGUS_X", "name": "Totally Fake Ship", "pledge_id": "9",
                                        "pledge_name": "Fake"}])
    out = htf.classify(entries, skipped, vehicles, [])
    row = out["rows"][0]
    assert row["kind"] == "skipped" and row["reason"] == "unmatched"
    assert "Totally Fake Ship" in row["detail"] and "BOGUS_X" in row["detail"]
    assert out["summary"]["skipped"] == 1


def test_classify_existing_and_nickname_rule(file_data, vehicles):
    entries, skipped = htf.parse_file(file_data)
    ships = [ship("s1", vehicles, "ANVL_Carrack", key="1001:anvl_carrack:0", nickname="Renamed", rsiName="Serenity")]
    out = htf.classify(entries, skipped, vehicles, ships)
    r0 = out["rows"][0]
    assert r0["kind"] == "existing" and r0["existing"] == {"shipId": "s1", "label": "Renamed (Carrack)"}
    assert r0["nickname"] == "Serenity"
    assert out["summary"]["existing"] == 1


def test_classify_link_candidates_and_claiming(file_data, vehicles):
    entries, skipped = htf.parse_file(file_data)
    ships = [ship("h1", vehicles, "ANVL_C8_Pisces"), ship("h2", vehicles, "ANVL_C8_Pisces", nickname="Fish"),
             ship("h3", vehicles, "ANVL_C8_Pisces")]
    out = htf.classify(entries, skipped, vehicles, ships)
    r2, r3 = out["rows"][2], out["rows"][3]
    assert r2["kind"] == "link" and r3["kind"] == "link"
    assert [c["shipId"] for c in r2["linkCandidates"]] == ["h1", "h2", "h3"]
    assert [c["shipId"] for c in r3["linkCandidates"]] == ["h2", "h3"]  # h1 claimed by the earlier row
    assert r2["linkCandidates"][1]["label"] == "Fish (C8 Pisces)"
    assert out["summary"]["link"] == 2


def test_link_claims_run_out_then_new(file_data, vehicles):
    entries, skipped = htf.parse_file(file_data)
    out = htf.classify(entries, skipped, vehicles, [ship("h1", vehicles, "ANVL_C8_Pisces")])
    assert [out["rows"][2]["kind"], out["rows"][3]["kind"]] == ["link", "new"]


def test_rsi_sourced_ships_are_not_link_candidates(file_data, vehicles):
    entries, skipped = htf.parse_file(file_data)
    other = ship("r1", vehicles, "ANVL_Carrack", key="OTHER:anvl_carrack:0")
    out = htf.classify(entries, skipped, vehicles, [other])
    assert out["rows"][0]["kind"] == "new"


def test_missing_and_default_remove(file_data, vehicles):
    entries, skipped = htf.parse_file(file_data)
    ships = [ship("s1", vehicles, "ANVL_Carrack", key="1001:anvl_carrack:0"),
             ship("s2", vehicles, "ANVL_Arrow", key="4004:anvl_arrow:0"),
             ship("m1", vehicles, "RSI_Scorpius", key="7:rsi_scorpius:0"),
             ship("m2", vehicles, "RSI_Mantis", key="8:rsi_mantis:0", nickname="Fitted", fitted={"a": {"itemUuid": "x"}}),
             ship("hand", vehicles, "RSI_Perseus")]
    out = htf.classify(entries, skipped, vehicles, ships)
    assert out["partial"] is False
    assert out["missing"] == [
        {"shipId": "m1", "label": "Scorpius", "rsiKey": "7:rsi_scorpius:0", "hasFittings": False, "defaultRemove": True},
        {"shipId": "m2", "label": "Fitted (Mantis)", "rsiKey": "8:rsi_mantis:0", "hasFittings": True, "defaultRemove": False},
    ]
    assert out["summary"]["missing"] == 2


def test_unmatched_file_row_key_is_not_missing(vehicles):
    entries, skipped = htf.parse_file([{"ship_code": "BOGUS_X", "name": "Totally Fake Ship", "pledge_id": "9"}])
    ships = [ship("a", vehicles, "ANVL_Arrow", key="9:bogus_x:0")]
    assert htf.classify(entries, skipped, vehicles, ships)["missing"] == []


def test_partial_guard(vehicles):
    entries, skipped = htf.parse_file([{"ship_code": "ANVL_Arrow", "name": "Arrow", "pledge_id": "1"}])
    ships = [ship("a", vehicles, "ANVL_Arrow", key="1:anvl_arrow:0"),
             ship("b", vehicles, "RSI_Scorpius", key="2:rsi_scorpius:0"),
             ship("c", vehicles, "RSI_Mantis", key="3:rsi_mantis:0"),
             ship("d", vehicles, "RSI_Lynx", key="4:rsi_lynx:0")]
    out = htf.classify(entries, skipped, vehicles, ships)
    assert out["partial"] is True  # 1 of 4 matched < 50%
    assert [m["defaultRemove"] for m in out["missing"]] == [False, False, False]


def test_partial_boundary_exactly_half_is_not_partial(vehicles):
    entries, skipped = htf.parse_file([{"ship_code": "ANVL_Arrow", "name": "Arrow", "pledge_id": "1"}])
    ships = [ship("a", vehicles, "ANVL_Arrow", key="1:anvl_arrow:0"),
             ship("b", vehicles, "RSI_Scorpius", key="2:rsi_scorpius:0")]
    out = htf.classify(entries, skipped, vehicles, ships)
    assert out["partial"] is False and out["missing"][0]["defaultRemove"] is True


def test_fewer_than_two_rsi_ships_never_partial(vehicles):
    entries, skipped = htf.parse_file([{"ship_code": "ANVL_Arrow", "name": "Arrow", "pledge_id": "1"}])
    ships = [ship("b", vehicles, "RSI_Scorpius", key="2:rsi_scorpius:0")]
    out = htf.classify(entries, skipped, vehicles, ships)
    assert out["partial"] is False and out["missing"][0]["defaultRemove"] is True


# ---- pledge_records / pledge_summary / ledger_sync ---------------------------------------------

def test_pledge_records_one_per_pledge_including_unmatched(file_data, vehicles):
    entries, _ = htf.parse_file(file_data)
    recs = htf.pledge_records(entries, vehicles, "NOW")
    assert [r["pledgeId"] for r in recs] == ["1001", "2002", "3003", "4004"]
    pkg = recs[1]
    assert pkg["name"] == "Pisces Fleet Package"
    assert pkg["cost"] == {"amount": 1234.5, "currency": "USD", "raw": "$1,234.50 USD"}
    assert pkg["lti"] is True and pkg["warbond"] is False and pkg["importedAt"] == "NOW"
    assert pkg["date"] == "March 02, 2019" and pkg["dateIso"] == "2019-03-02"
    avenger = by_cls(vehicles, "AEGS_Avenger_Titan")
    assert pkg["ships"][0] == {"shipCode": "AEGS_Avenger_Titan", "name": "Avenger Titan", "rsiName": None,
                               "vehicleUuid": avenger["uuid"], "matched": True}
    assert len(pkg["ships"]) == 3
    assert recs[0]["ships"][0]["rsiName"] == "Serenity"
    assert recs[2]["ships"][0]["matched"] is True  # unidentified row resolved by name


def test_pledge_records_concept_ship_unmatched_still_recorded(vehicles):
    entries, _ = htf.parse_file([{"ship_code": "DRAK_Kraken", "name": "Kraken", "ship_name": "Kraken",
                                  "pledge_id": "K1", "pledge_name": "Kraken", "pledge_cost": "$1,650.00 USD",
                                  "lti": True}])
    [rec] = htf.pledge_records(entries, vehicles, "t")
    assert rec["cost"]["amount"] == 1650.0
    assert rec["ships"] == [{"shipCode": "DRAK_Kraken", "name": "Kraken", "rsiName": None,
                             "vehicleUuid": None, "matched": False}]


def test_classify_counted_in_totals_flag(vehicles):
    entries, skipped = htf.parse_file([
        {"ship_code": "DRAK_Kraken", "name": "Kraken", "pledge_id": "K1"},
        {"name": "Paint", "entity_type": "component"}, "junk"])
    rows = htf.classify(entries, skipped, vehicles, [])["rows"]
    assert [(r["reason"], r["countedInTotals"]) for r in rows] == [
        ("unmatched", True), ("not_a_ship", False), ("invalid", False)]


def prec(pid, amount, cur, lti=False, name="P", imported="2026-01-01T00:00:00+00:00", nships=1):
    cost = None if amount is None and cur is None else {"amount": amount, "currency": cur, "raw": "x"}
    return {"pledgeId": pid, "name": name, "cost": cost, "lti": lti, "importedAt": imported,
            "ships": [{"shipCode": "c", "matched": True}] * nships}


def test_pledge_summary_none_when_empty():
    assert htf.pledge_summary([]) is None


def test_pledge_summary_totals_per_currency():
    s = htf.pledge_summary([prec("P1", 100.0, "USD", lti=True, name="Big", nships=3),
                            prec("P2", 45.0, "EUR", name="Euro", imported="2026-03-01T00:00:00+00:00"),
                            prec("P3", 20.5, "USD", lti=True, name="Small")])
    assert s["totals"] == {"USD": 120.5, "EUR": 45.0}
    assert s["pledges"] == 3 and s["ships"] == 5 and s["lti"] == 4
    # ships carry no names here, so the label falls back to the pledge name
    assert s["topPledge"] == {"name": "Big", "pledgeName": "Big", "amount": 100.0, "currency": "USD"}
    assert s["lastImport"] == "2026-03-01T00:00:00+00:00"


def test_pledge_summary_unparseable_cost_adds_nothing():
    s = htf.pledge_summary([prec("P1", None, None), {**prec("P2", None, None), "cost": None}])
    assert s["totals"] == {} and s["pledges"] == 2 and s["topPledge"] is None


def test_package_counts_once_end_to_end(file_data, vehicles):
    entries, _ = htf.parse_file(file_data)
    s = htf.pledge_summary(htf.pledge_records(entries, vehicles, "t"))
    assert s["totals"] == {"USD": 1584.5, "EUR": 45.0}
    assert s["pledges"] == 4 and s["ships"] == 6


def test_concept_ship_counts_in_totals(vehicles):
    entries, _ = htf.parse_file([{"ship_code": "DRAK_Kraken", "name": "Kraken", "pledge_id": "K1",
                                  "pledge_cost": "$1,650.00 USD"}])
    assert htf.pledge_summary(htf.pledge_records(entries, vehicles, "t"))["totals"] == {"USD": 1650.0}


def test_ledger_sync_deletes_absent_ids():
    inc = [prec("A", 1.0, "USD"), prec("B", 1.0, "USD")]
    up, dele = htf.ledger_sync([prec("B", 1.0, "USD"), prec("C", 1.0, "USD")], inc, False)
    assert up == inc and dele == ["C"]


def test_ledger_sync_partial_never_deletes():
    inc = [prec("A", 1.0, "USD")]
    up, dele = htf.ledger_sync([prec("C", 1.0, "USD")], inc, True)
    assert up == inc and dele == []


# ---- Task 2 review minors ----------------------------------------------------

@pytest.mark.parametrize("raw,amount,cur", [
    ("USD 350.00", 350.0, "USD"),
    ("eur 45,00", 45.0, "EUR"),
    ("350 usd", 350.0, "USD"),
    ("$ 350.00 USD", 350.0, "USD"),
])
def test_parse_cost_code_in_prefix_or_lowercase(raw, amount, cur):
    assert htf.parse_cost(raw) == {"amount": amount, "currency": cur, "raw": raw}


def test_pledge_cost_is_first_non_null_amount(vehicles):
    base = {"ship_code": "ANVL_Carrack", "name": "Carrack", "pledge_id": "P", "entity_type": "ship"}
    rows = [{**base, "pledge_cost": "garbage"}, {**base, "pledge_cost": "$100.00 USD"},
            {**base, "pledge_cost": "$999.00 USD"}]
    entries, _ = htf.parse_file(rows)
    rec = htf.pledge_records(entries, vehicles, "2026-01-01T00:00:00+00:00")[0]
    assert rec["cost"]["amount"] == 100.0
    entries, _ = htf.parse_file([{**base, "pledge_cost": "garbage"}])
    assert htf.pledge_records(entries, vehicles, "t")[0]["cost"]["raw"] == "garbage"


def test_ledger_partial_guard():
    def ent(pid):
        return htf.HtfEntry(0, "c", "n", None, {**PL, "id": pid}, {})
    ex = [prec("A", 1, "USD"), prec("B", 1, "USD"), prec("C", 1, "USD"), prec("D", 1, "USD")]
    assert htf.ledger_partial([ent("A")], ex) is True            # 1/4 < 50%
    assert htf.ledger_partial([ent("A"), ent("B")], ex) is False  # exactly 50%
    assert htf.ledger_partial([ent("Z")], [prec("A", 1, "USD")]) is False   # < 2 ledger pledges
    assert htf.classify([ent("A")], [], [], [], ex)["ledgerPartial"] is True


def test_ledger_sync_keep_ids_not_deleted():
    inc = [prec("A", 1.0, "USD")]
    up, dele = htf.ledger_sync([prec("B", 1.0, "USD"), prec("C", 1.0, "USD")], inc, False, {"B"})
    assert dele == ["C"]


def test_pledge_summary_counts_lti_ships():
    out = htf.pledge_summary([prec("A", 1, "USD", lti=True, nships=3), prec("B", 1, "USD", nships=2)])
    assert out["ships"] == 5 and out["lti"] == 3


def _named(pid, amount, pledge_name, ship_names):
    return {"pledgeId": pid, "name": pledge_name, "cost": {"amount": amount, "currency": "USD", "raw": ""},
            "lti": False, "importedAt": "2026-10-11T00:00:00+00:00",
            "ships": [{"shipCode": n.replace(" ", "_"), "name": n, "matched": True} for n in ship_names]}


def test_top_pledge_is_labelled_by_end_state_ship_not_pledge_name():
    # A CCU'd pledge keeps its original pledge_name ("...Constellation Aquila") while the
    # ship in it is now an Ironclad Assault -- the label must show what the member owns.
    s = htf.pledge_summary([_named("110411072", 650.0, "Standalone Ships - Constellation Aquila", ["Ironclad Assault"]),
                            _named("531965", 185.0, "Arbiter - LTI", ["F7C Hornet Mk II"])])
    assert s["topPledge"] == {"name": "Ironclad Assault", "pledgeName": "Standalone Ships - Constellation Aquila",
                              "amount": 650.0, "currency": "USD"}


def test_top_pledge_label_for_packages():
    two = htf.pledge_summary([_named("1", 600.0, "Pkg", ["Starfarer", "Cutlass Black"])])
    assert two["topPledge"]["name"] == "Starfarer + Cutlass Black"
    dup = htf.pledge_summary([_named("1", 600.0, "Pkg", ["Pisces C8", "Pisces C8"])])
    assert dup["topPledge"]["name"] == "2× Pisces C8"
    many = htf.pledge_summary([_named("1", 900.0, "Pkg", ["A", "B", "C", "D", "E"])])
    assert many["topPledge"]["name"] == "A + B + C + 2 more"
