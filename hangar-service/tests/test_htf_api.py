"""HTF (HangarXPLOR) import routes, pledge ledger, leaderboard, hangar pledgeSummary."""
import copy
import json
import logging

import pytest
from fastapi.testclient import TestClient

from src.repository import InMemoryShipRepository
from tests.conftest import load_fixture
from tests.test_app import ADMIN, OTHER, SELF, H, make_catalog
from tests.test_browser_auth import ADMIN_USER, BROWSER_ENV, ORIGIN, Clock, as_user
from tests.test_import_api import WRITE, _make, add_ship

PRE, APP = "/api/v1/import/htf/preview", "/api/v1/import/htf/apply"


def htf_file() -> list:
    return copy.deepcopy(load_fixture("htf_hangarxplor.json"))


KRAKEN = {"ship_code": "RSI_Kraken_Fake", "ship_name": "Kraken", "name": "Zzzz Kraken Concept",
          "entity_type": "ship", "pledge_id": "7007", "pledge_name": "Kraken Concept",
          "pledge_date": "May 01, 2018", "pledge_cost": "$350.00 USD", "lti": True, "warbond": False}


@pytest.fixture
def repo():
    return InMemoryShipRepository()


@pytest.fixture
def client(repo):
    with TestClient(_make(repo), base_url=ORIGIN, follow_redirects=False) as c:
        yield c


def preview(c, file=None, **kw):
    return c.post(PRE, json={"file": htf_file() if file is None else file}, **kw)


def apply(c, file=None, choices=None, params=None, headers=WRITE):
    body = {"file": htf_file() if file is None else file}
    if choices is not None:
        body["choices"] = choices
    return c.post(APP, json=body, params=params, headers=headers)


def ships(c, member=SELF):
    return c.get(f"/v1/members/{member}/hangar", headers=H(None))


# ---------- preview ----------

def test_preview_classifies_rows_and_writes_nothing(client, repo):
    as_user(client)
    r = preview(client)
    assert r.status_code == 200, r.text
    b = r.json()
    kinds = {row["index"]: row["kind"] for row in b["rows"]}
    assert kinds == {0: "new", 1: "new", 2: "new", 3: "new", 4: "new", 5: "skipped", 6: "new"}
    assert b["partial"] is False and b["missing"] == []
    assert b["summary"]["new"] == 6 and b["summary"]["skipped"] == 1
    assert ships(client).json()["ships"] == []
    assert client.get("/v1/pledges/leaderboard", headers=H(None)).json()["entries"] == []


def test_preview_link_candidates(client):
    as_user(client)
    mine = add_ship(client, vehicle="carrack")
    r = preview(client)
    row = r.json()["rows"][0]
    assert row["kind"] == "link"
    assert [c["shipId"] for c in row["linkCandidates"]] == [mine["shipId"]]


@pytest.mark.parametrize("body", [{"file": {"no": "list"}}, {}, {"file": [{}] * 501}])
def test_preview_bad_bodies(client, body):
    as_user(client)
    r = client.post(PRE, json=body)
    assert r.status_code == 400 and r.json()["error"] == "invalid_request"


def test_preview_service_and_admin_member(client):
    r = client.post("/v1/import/htf/preview", json={"file": htf_file()}, headers=H(SELF))
    assert r.status_code == 200
    assert client.post("/v1/import/htf/preview", json={"file": htf_file()}, headers=H(None)).status_code == 400
    as_user(client, ADMIN_USER)
    assert preview(client, params={"member": OTHER}).status_code == 200


def test_preview_catalog_unavailable(repo):
    app = _make(repo)
    app.state.catalog = make_catalog(fail=lambda req: True)
    with TestClient(app, base_url=ORIGIN) as c:
        as_user(c)
        r = preview(c)
        assert r.status_code == 503 and r.json()["error"] == "unavailable"


# ---------- apply ----------

def test_apply_creates_ships_with_rsi_and_nickname(client, caplog):
    as_user(client)
    with caplog.at_level(logging.INFO):
        r = apply(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(x["index"], x["result"]) for x in body["rows"]] == [
        (0, "created"), (1, "created"), (2, "created"), (3, "created"), (4, "created"),
        (5, "skipped"), (6, "created")]
    assert body["removed"] == []
    got = ships(client).json()["ships"]
    assert len(got) == 6
    carrack = next(s for s in got if s["vehicleName"] == "Carrack")
    assert carrack["nickname"] == "Serenity"
    assert carrack["rsi"]["key"] == "1001:anvl_carrack:0" and carrack["rsi"]["pledgeCost"]["amount"] == 350.0
    assert carrack["rsi"]["lti"] is True and carrack["rsi"]["rsiName"] == "Serenity"
    assert "hangar: htf import member=111 created=6 linked=0 updated=0 removed=0 skipped=1" in caplog.text


def test_reapply_is_all_unchanged(client, caplog):
    as_user(client)
    apply(client)
    with caplog.at_level(logging.INFO):
        r = apply(client)
    assert {x["result"] for x in r.json()["rows"]} == {"unchanged", "skipped"}
    assert len(ships(client).json()["ships"]) == 6
    assert "created=0 linked=0 updated=0 removed=0 skipped=1" in caplog.text


def test_existing_refreshes_pledge_and_respects_manual_rename(client):
    as_user(client)
    apply(client)
    carrack = next(s for s in ships(client).json()["ships"] if s["vehicleName"] == "Carrack")
    client.patch(f"/v1/members/{SELF}/ships/{carrack['shipId']}", json={"nickname": "My Own"}, headers=H(SELF))
    f = htf_file()
    f[0]["pledge_cost"] = "$400.00 USD"
    r = apply(client, f)
    assert r.json()["rows"][0] == {"index": 0, "result": "updated", "shipId": carrack["shipId"]}
    again = next(s for s in ships(client).json()["ships"] if s["shipId"] == carrack["shipId"])
    assert again["nickname"] == "My Own" and again["rsi"]["pledgeCost"]["amount"] == 400.0
    f[0]["ship_name"] = "Renamed"
    apply(client, f)
    again = next(s for s in ships(client).json()["ships"] if s["shipId"] == carrack["shipId"])
    assert again["nickname"] == "Renamed"


def test_link_default_and_explicit_new(client):
    as_user(client)
    mine = add_ship(client, vehicle="carrack")
    r = apply(client)
    assert r.json()["rows"][0]["result"] == "linked" and r.json()["rows"][0]["shipId"] == mine["shipId"]
    got = ships(client).json()["ships"]
    assert len(got) == 6                                   # linked, not duplicated
    linked = next(s for s in got if s["shipId"] == mine["shipId"])
    assert linked["rsi"]["key"] == "1001:anvl_carrack:0" and linked["nickname"] == "Serenity"


def test_link_keeps_existing_nickname_and_choice_new(client):
    as_user(client)
    mine = add_ship(client, vehicle="carrack", nickname="Mine")
    r = apply(client, choices={"links": {"0": "new"}, "remove": []})
    assert r.json()["rows"][0]["result"] == "created" and r.json()["rows"][0]["shipId"] != mine["shipId"]
    assert len(ships(client).json()["ships"]) == 7
    # hand ship untouched
    h = next(s for s in ships(client).json()["ships"] if s["shipId"] == mine["shipId"])
    assert "rsi" not in h and h["nickname"] == "Mine"


def test_link_explicit_target_keeps_nickname(client):
    as_user(client)
    mine = add_ship(client, vehicle="carrack", nickname="Mine")
    r = apply(client, choices={"links": {"0": mine["shipId"]}})
    assert r.json()["rows"][0]["result"] == "linked"
    h = next(s for s in ships(client).json()["ships"] if s["shipId"] == mine["shipId"])
    assert h["nickname"] == "Mine" and h["rsi"]["rsiName"] == "Serenity"


def test_remove_missing_ship(client):
    as_user(client)
    apply(client)
    first = ships(client).json()["ships"]
    arrow = next(s for s in first if s["vehicleName"] == "Arrow")
    f = [r for r in htf_file() if r.get("ship_code") != "ANVL_Arrow"]
    p = preview(client, f).json()
    assert [m["shipId"] for m in p["missing"]] == [arrow["shipId"]] and p["missing"][0]["defaultRemove"] is True
    r = apply(client, f, choices={"remove": [arrow["shipId"]]})
    assert r.json()["removed"] == [arrow["shipId"]]
    assert arrow["shipId"] not in [s["shipId"] for s in ships(client).json()["ships"]]


def test_unremoved_missing_ship_stays(client):
    as_user(client)
    apply(client)
    f = [r for r in htf_file() if r.get("ship_code") != "ANVL_Arrow"]
    apply(client, f)
    assert len(ships(client).json()["ships"]) == 6


@pytest.mark.parametrize("choices", [
    {"links": {"0": "nosuchship"}},        # row 0 is 'new' (not a link row)
    {"links": {"99": "new"}},
    {"links": {"x": "new"}},
    {"remove": ["nosuchship"]},
    {"links": []}, {"remove": "abc"}, [],
])
def test_forged_choices_rejected_nothing_written(client, choices):
    as_user(client)
    r = apply(client, choices=choices)
    assert r.status_code == 400 and r.json()["error"] == "invalid_request"
    assert ships(client).json()["ships"] == []
    assert client.get("/v1/pledges/leaderboard", headers=H(None)).json()["entries"] == []


def test_link_target_not_in_candidates_rejected(client):
    as_user(client)
    add_ship(client, vehicle="carrack")
    other = add_ship(client, vehicle="harbinger")
    r = apply(client, choices={"links": {"0": other["shipId"]}})
    assert r.status_code == 400 and "0" in r.json()["message"] and other["shipId"] in r.json()["message"]
    assert all("rsi" not in s for s in ships(client).json()["ships"])


def test_remove_hand_added_ship_rejected(client):
    as_user(client)
    hand = add_ship(client, vehicle="harbinger")
    r = apply(client, choices={"remove": [hand["shipId"]]})
    assert r.status_code == 400 and hand["shipId"] in r.json()["message"]
    assert any(s["shipId"] == hand["shipId"] for s in ships(client).json()["ships"])


def test_apply_permissions(client):
    as_user(client)
    assert apply(client, headers={}).status_code == 403                       # CSRF
    assert apply(client, headers={"Origin": "https://evil.example"}).status_code == 403
    assert apply(client, params={"member": OTHER}).status_code == 403
    assert ships(client, OTHER).json()["ships"] == []
    as_user(client, ADMIN_USER)
    r = apply(client, params={"member": OTHER})
    assert r.status_code == 200
    assert len(ships(client, OTHER).json()["ships"]) == 6
    client.cookies.clear()
    r = client.post("/v1/import/htf/apply", json={"file": htf_file()}, headers=H(SELF))
    assert r.status_code == 200


@pytest.mark.parametrize("body", [{"file": {"no": "list"}}, {"file": [{}] * 501}, {}])
def test_apply_bad_files(client, body):
    as_user(client)
    r = client.post(APP, json=body, headers=WRITE)
    assert r.status_code == 400 and r.json()["error"] == "invalid_request"


def test_apply_oversize_body(client):
    as_user(client)
    big = [{"name": "x" * 1000, "pledge_id": "1", "ship_code": "a"}] * 500
    r = client.post(APP, content=json.dumps({"file": big, "pad": "x" * (2 * 1024 * 1024)}),
                    headers={**WRITE, "Content-Type": "application/json"})
    assert r.status_code == 413


def test_apply_catalog_unavailable_writes_nothing(repo):
    app = _make(repo)
    app.state.catalog = make_catalog(fail=lambda req: True)
    with TestClient(app, base_url=ORIGIN) as c:
        as_user(c)
        r = apply(c)
        assert r.status_code == 503 and r.json()["error"] == "unavailable"
    assert repo._data == {} and repo._pledges == {}


def test_ship_limit(repo):
    app = _make(repo, HANGAR_MAX_SHIPS_PER_MEMBER="3")
    with TestClient(app, base_url=ORIGIN) as c:
        as_user(c)
        r = apply(c)
        assert r.status_code == 409 and r.json()["error"] == "limit"
        assert ships(c).json()["ships"] == []


# ---------- ledger ----------

def test_ledger_counts_unmatched_pledges_and_distinct_pledge_once(client, repo):
    as_user(client)
    f = htf_file() + [KRAKEN]
    r = apply(client, f)
    assert r.json()["rows"][-1]["result"] == "skipped"
    led = {p["pledgeId"]: p for p in repo._pledges[SELF].values()}
    assert set(led) == {"1001", "2002", "3003", "4004", "7007"}
    assert len(led["2002"]["ships"]) == 3 and led["7007"]["ships"][0]["matched"] is False
    lb = client.get("/v1/pledges/leaderboard", headers=H(None)).json()["entries"][0]
    # 350 + 1234.50 (once, three ships) + 350 (Kraken) + 0 (garbage) ; EUR 45
    assert lb["totals"] == {"USD": 1934.5, "EUR": 45.0} and lb["pledges"] == 5 and lb["ships"] == 7
    assert lb["lti"] == 3 and lb["topPledge"] == {"name": "Pisces Fleet Package", "amount": 1234.5, "currency": "USD"}


def test_partial_import_does_not_delete_ledger(client, repo):
    as_user(client)
    apply(client, htf_file() + [KRAKEN])
    only = [KRAKEN | {"pledge_id": "8008"}]          # 0 matches of 6 RSI ships -> partial
    p = preview(client, only).json()
    assert p["partial"] is True and all(m["defaultRemove"] is False for m in p["missing"])
    apply(client, only)
    assert set(repo._pledges[SELF]) == {"1001", "2002", "3003", "4004", "7007", "8008"}


def test_full_import_prunes_vanished_pledges(client, repo):
    as_user(client)
    apply(client, htf_file() + [KRAKEN])
    f = [r for r in htf_file() if r.get("pledge_id") != "4004"]
    apply(client, f)
    assert set(repo._pledges[SELF]) == {"1001", "2002", "3003"}


# ---------- leaderboard ----------

def test_leaderboard_ordering_and_filters(client, repo):
    as_user(client)
    apply(client)
    f2 = [r for r in htf_file() if r.get("pledge_id") in ("1001", "4004")]
    as_user(client, ADMIN_USER)
    apply(client, f2, params={"member": OTHER})
    # a member with only a ledger (no RSI ships) is excluded
    import asyncio
    asyncio.run(repo.upsert_pledges("333", [{"pledgeId": "1", "name": "x", "cost": {"amount": 9999.0, "currency": "USD", "raw": "x"},
                                             "ships": [], "lti": False, "importedAt": "2026-01-01T00:00:00+00:00"}]))
    for url in ("/v1/pledges/leaderboard", "/api/v1/pledges/leaderboard"):
        r = client.get(url, headers=H(None))
        assert r.status_code == 200
    body = client.get("/v1/pledges/leaderboard", headers=H(None)).json()
    assert [e["member"] for e in body["entries"]] == [SELF, OTHER]
    assert body["entries"][1]["totals"] == {"USD": 350.0}
    assert "pledged on ships" in body["caveat"].lower()
    e = body["entries"][0]
    assert set(e) == {"member", "displayName", "totals", "pledges", "ships", "lti", "topPledge", "lastImport"}
    client.cookies.clear()
    assert client.get("/v1/pledges/leaderboard").status_code == 401


def test_leaderboard_session_allowed_and_display_name(client):
    as_user(client)
    apply(client)
    r = client.get("/api/v1/pledges/leaderboard")
    assert r.status_code == 200 and r.json()["entries"][0]["displayName"] == "Akira"


def test_leaderboard_sorts_usd_desc_then_other_then_id(repo):
    import asyncio
    rec = lambda amt, cur: {"pledgeId": "p", "name": "n", "cost": {"amount": amt, "currency": cur, "raw": ""},
                            "ships": [], "lti": False, "importedAt": "2026-01-01T00:00:00+00:00"}
    app = _make(repo)

    async def seed():
        for mid, (amt, cur) in {"30": (100.0, "USD"), "20": (100.0, "USD"), "10": (50.0, "USD"),
                                "40": (500.0, "EUR")}.items():
            await repo.create_ship(mid, vehicle_uuid="u", vehicle_name="V", vehicle_class_name="c", nickname=None,
                                   updated_by=mid, rsi={"key": "k"})
            await repo.upsert_pledges(mid, [rec(amt, cur)])
    asyncio.run(seed())
    with TestClient(app, base_url=ORIGIN) as c:
        body = c.get("/v1/pledges/leaderboard", headers=H(None)).json()
    assert [e["member"] for e in body["entries"]] == ["20", "30", "10", "40"]


# ---------- hangar pledgeSummary ----------

def test_hangar_pledge_summary(client):
    as_user(client)
    assert "pledgeSummary" not in ships(client).json()
    add_ship(client, vehicle="harbinger")
    assert "pledgeSummary" not in ships(client).json()
    apply(client, htf_file() + [KRAKEN])
    s = ships(client).json()["pledgeSummary"]
    assert s == {"totals": {"USD": 1934.5, "EUR": 45.0}, "pledges": 5, "ships": 7, "lti": 3}
