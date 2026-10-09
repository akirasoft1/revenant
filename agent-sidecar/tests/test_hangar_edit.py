"""Hangar chat-edit tools (2026-10-09 hangar-chat-edits spec): the acting
member is bound in code from the turn's ChatRequest.user_id, never a tool
argument; every call goes to hangar-service with an ID token +
X-Acting-Member; nothing ever raises. Fake HTTP transport, no network."""
import asyncio
import inspect
import json
import logging
from datetime import datetime, timezone

import httpx
import pytest

from src.hangar_edit import (
    EDIT_TOOL_NAMES,
    HangarEditClient,
    HangarEditTools,
    IdTokenProvider,
)

AKIRA = "100000000000000001"
BASE = "https://hangar-service-hvmf2jpuca-uc.a.run.app"


class _Tokens:
    def __init__(self, token="tok-123", exc=None):
        self.token_value = token
        self.exc = exc
        self.calls = 0

    async def token(self):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.token_value


def _client(handler, tokens=None, **kw):
    seen = []

    def wrapped(request: httpx.Request):
        seen.append(request)
        return handler(request)

    client = HangarEditClient(BASE, tokens or _Tokens(), transport=httpx.MockTransport(wrapped), **kw)
    return client, seen


def _json(status, body):
    return lambda request: httpx.Response(status, json=body)


FIT_OK = {
    "member": AKIRA,
    "ship": {"shipId": "s1", "label": '"Connie" (Constellation Taurus)', "vehicle": "Constellation Taurus"},
    "item": {"uuid": "u", "name": "Hemera", "type": "QuantumDrive", "size": 2},
    "changes": [{"slot": "hardpoint_quantum_drive", "from": {"name": "Bolon", "uuid": "b"},
                 "to": {"name": "Hemera", "uuid": "u"}}],
    "unchanged": False,
}


def _run(coro):
    return asyncio.run(coro)


# --- binding: no member parameter, ever -------------------------------------

def test_tool_names_are_exactly_the_three_spec_names():
    assert EDIT_TOOL_NAMES == ("hangar_fit", "hangar_add_ship", "hangar_reset")
    client, _ = _client(_json(200, FIT_OK))
    fns = HangarEditTools(client, user_id=AKIRA).functions()
    assert [f.__name__ for f in fns] == list(EDIT_TOOL_NAMES)


def test_tool_signatures_match_the_spec_and_carry_no_member_parameter():
    client, _ = _client(_json(200, FIT_OK))
    fit, add, reset = HangarEditTools(client, user_id=AKIRA).functions()
    assert list(inspect.signature(fit).parameters) == ["ship", "item", "slot"]
    assert inspect.signature(fit).parameters["slot"].default is None
    assert list(inspect.signature(add).parameters) == ["vehicle", "nickname"]
    assert inspect.signature(add).parameters["nickname"].default is None
    assert list(inspect.signature(reset).parameters) == ["ship", "slot"]
    assert inspect.signature(reset).parameters["slot"].default is inspect.Parameter.empty
    for f in (fit, add, reset):
        for p in inspect.signature(f).parameters:
            assert "member" not in p and "user" not in p and "discord" not in p


def test_adk_declarations_build_and_expose_no_member_parameter():
    from google.adk.tools import FunctionTool

    client, _ = _client(_json(200, FIT_OK))
    for f in HangarEditTools(client, user_id=AKIRA).functions():
        decl = FunctionTool(f)._get_declaration()
        schema = decl.parameters_json_schema or {}
        props = set((schema.get("properties") or {}).keys())
        assert not any("member" in p for p in props), props
        assert decl.description and "own" in decl.description.lower()


def test_fit_posts_to_the_bound_members_fit_endpoint_with_token_and_acting_member():
    client, seen = _client(_json(200, FIT_OK))
    fit = HangarEditTools(client, user_id=AKIRA).functions()[0]
    out = _run(fit("my Connie", "Hemera"))
    assert out == FIT_OK
    (req,) = seen
    assert req.method == "POST"
    assert req.url == httpx.URL(f"{BASE}/v1/members/{AKIRA}/fit")
    assert req.headers["Authorization"] == "Bearer tok-123"
    assert req.headers["X-Acting-Member"] == AKIRA
    assert json.loads(req.content) == {"ship": "my Connie", "item": "Hemera"}


def test_fit_forwards_slot_when_given():
    client, seen = _client(_json(200, FIT_OK))
    fit = HangarEditTools(client, user_id=AKIRA).functions()[0]
    _run(fit("Harby", "FR-76", slot="left"))
    assert json.loads(seen[0].content) == {"ship": "Harby", "item": "FR-76", "slot": "left"}


def test_two_turns_bind_two_different_speakers():
    client, seen = _client(_json(200, FIT_OK))
    a = HangarEditTools(client, user_id="111").functions()[0]
    b = HangarEditTools(client, user_id="222").functions()[0]
    _run(a("Connie", "Hemera"))
    _run(b("Connie", "Hemera"))
    assert [r.url.path for r in seen] == ["/v1/members/111/fit", "/v1/members/222/fit"]
    assert [r.headers["X-Acting-Member"] for r in seen] == ["111", "222"]


def test_add_ship_posts_vehicle_and_optional_nickname():
    body = {"ship": {"shipId": "s9", "vehicleName": "Cutlass Black", "nickname": None}}
    client, seen = _client(_json(201, body))
    add = HangarEditTools(client, user_id=AKIRA).functions()[1]
    assert _run(add("Cutlass Black")) == body
    assert seen[0].url.path == f"/v1/members/{AKIRA}/ships"
    assert json.loads(seen[0].content) == {"vehicle": "Cutlass Black"}
    assert seen[0].headers["X-Acting-Member"] == AKIRA
    _run(add("Cutlass Black", nickname="Cutty"))
    assert json.loads(seen[1].content) == {"vehicle": "Cutlass Black", "nickname": "Cutty"}


def test_reset_url_encodes_the_ship_ref_and_sends_slot():
    client, seen = _client(_json(200, {"changes": [], "unchanged": True}))
    reset = HangarEditTools(client, user_id=AKIRA).functions()[2]
    _run(reset("Big Bertha", "all"))
    assert seen[0].url.raw_path.decode() == f"/v1/members/{AKIRA}/ships/Big%20Bertha/reset"
    assert json.loads(seen[0].content) == {"slot": "all"}
    assert seen[0].headers["X-Acting-Member"] == AKIRA


def test_reset_with_a_slash_in_the_ship_is_refused_locally():
    client, seen = _client(_json(200, {}))
    reset = HangarEditTools(client, user_id=AKIRA).functions()[2]
    out = _run(reset("A/B", "all"))
    assert out["error"] == "invalid_request"
    assert seen == []


def test_reset_with_a_blank_slot_asks_for_one_without_calling_the_service():
    client, seen = _client(_json(200, {}))
    reset = HangarEditTools(client, user_id=AKIRA).functions()[2]
    out = _run(reset("Harby", "  "))
    assert out["error"] == "invalid_request"
    assert "all" in out["message"]
    assert seen == []


# --- unknown speaker: refuse without calling the service --------------------

@pytest.mark.parametrize("uid", ["", "  ", "eval", "abc123", "12 34", None])
def test_unknown_speaker_is_refused_without_any_request(uid):
    tokens = _Tokens()
    client, seen = _client(_json(200, FIT_OK), tokens=tokens)
    tools = HangarEditTools(client, user_id=uid)
    for fn, args in zip(tools.functions(), [("Connie", "Hemera"), ("Cutlass Black",), ("Connie", "all")]):
        out = _run(fn(*args))
        assert out["error"] == "unknown_speaker"
        assert out["message"]
    assert seen == [] and tokens.calls == 0
    assert tools.edits == 0
    assert [c["result"] for c in tools.calls] == ["unknown_speaker"] * 3


# --- error passthrough + never raise -----------------------------------------

@pytest.mark.parametrize("status,body", [
    (409, {"error": "choose_slot", "message": "pick one", "slots": [{"slot": "a"}, {"slot": "b"}]}),
    (409, {"error": "ambiguous", "message": "which?", "candidates": [{"shipId": "1", "label": "x"}]}),
    (409, {"error": "ambiguous", "field": "item", "message": "which item?", "candidates": [{"name": "A"}]}),
    (404, {"error": "not_found", "message": "no item", "suggestions": ["Hemera"]}),
    (404, {"error": "not_found", "message": "no ship", "owned": []}),
    (422, {"error": "incompatible", "message": "too big", "reason": "size_mismatch"}),
    (403, {"error": "forbidden", "message": "no"}),
    (400, {"error": "invalid_request", "message": "bad"}),
    (503, {"error": "unavailable", "message": "wiki down"}),
])
def test_error_envelopes_are_returned_to_the_model_verbatim(status, body):
    client, _ = _client(_json(status, body))
    tools = HangarEditTools(client, user_id=AKIRA)
    out = _run(tools.functions()[0]("Connie", "Hemera"))
    assert out == body
    assert tools.edits == 0
    assert tools.calls[-1]["result"] == body["error"]


def test_non_json_error_maps_to_unavailable():
    # a non-JSON 4xx was rejected before any write (5xx: see maybe_applied below)
    client, _ = _client(lambda r: httpx.Response(413, text="<html>too large</html>"))
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[0]("Connie", "Hemera"))
    assert out["error"] == "unavailable" and "maybe_applied" not in out
    assert "413" in out["message"]


def test_transport_error_maps_to_unavailable():
    def boom(request):
        raise httpx.ConnectError("refused")
    client, _ = _client(boom)
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[1]("Cutlass Black"))
    assert out["error"] == "unavailable"


def test_token_mint_failure_maps_to_unavailable():
    client, seen = _client(_json(200, FIT_OK), tokens=_Tokens(exc=RuntimeError("no key")))
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[0]("Connie", "Hemera"))
    assert out["error"] == "unavailable"
    assert seen == []


def test_slow_service_times_out_as_unavailable():
    class _SlowTokens(_Tokens):
        async def token(self):
            await asyncio.sleep(1)
            return "t"
    client, _ = _client(_json(200, FIT_OK), tokens=_SlowTokens(), timeout_s=0.05)
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[0]("Connie", "Hemera"))
    assert out["error"] == "unavailable"
    assert "timed out" in out["message"]


def test_default_timeout_is_five_seconds():
    client, _ = _client(_json(200, FIT_OK))
    assert client.timeout_s == 5.0


# --- edits counter + per-call log --------------------------------------------

def test_edits_counts_only_successful_writes_with_changes():
    responses = iter([
        httpx.Response(200, json=FIT_OK),
        httpx.Response(200, json={**FIT_OK, "changes": [], "unchanged": True}),
        httpx.Response(201, json={"ship": {"shipId": "s9"}}),
        httpx.Response(409, json={"error": "choose_slot", "message": "m", "slots": []}),
    ])
    client, _ = _client(lambda r: next(responses))
    tools = HangarEditTools(client, user_id=AKIRA)
    fit, add, _reset = tools.functions()
    _run(fit("Connie", "Hemera"))
    _run(fit("Connie", "Hemera"))
    _run(add("Cutlass Black"))
    _run(fit("Harby", "FR-76"))
    assert tools.edits == 2
    assert [c["name"] for c in tools.calls] == ["hangar_fit", "hangar_fit", "hangar_add_ship", "hangar_fit"]
    assert [c["result"] for c in tools.calls] == ["ok", "unchanged", "ok", "choose_slot"]
    assert tools.calls[0]["args"] == {"ship": "Connie", "item": "Hemera", "slot": None}


def test_each_call_logs_tool_member_ship_slot_and_result_but_never_the_token(caplog):
    client, _ = _client(_json(200, FIT_OK), tokens=_Tokens(token="SECRET-TOKEN"))
    with caplog.at_level(logging.INFO, logger="src.hangar_edit"):
        _run(HangarEditTools(client, user_id=AKIRA).functions()[0]("my Connie", "Hemera", slot="qd"))
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "hangar_fit" in text and AKIRA in text and "my Connie" in text and "qd" in text
    assert "ok" in text and "Bolon -> Hemera" in text
    assert "SECRET-TOKEN" not in text


# --- ID token provider ---------------------------------------------------------

class _Creds:
    def __init__(self, expiry):
        self.token = None
        self.expiry = expiry
        self.refreshes = 0

    def refresh(self, request):
        self.refreshes += 1
        self.token = f"id-{self.refreshes}"


def test_id_token_minted_with_exact_audience_and_cached_until_near_expiry():
    made = []
    now = [1_000_000.0]
    expiry = datetime.fromtimestamp(now[0] + 3600, timezone.utc).replace(tzinfo=None)
    creds = _Creds(expiry)

    def factory(key_path, audience):
        made.append((key_path, audience))
        return creds

    p = IdTokenProvider("/var/secrets/hangar/key.json", BASE, credentials_factory=factory,
                        request_factory=lambda: None, clock=lambda: now[0])

    async def go():
        t1 = await p.token()
        t2 = await p.token()
        now[0] += 3600 - 200  # inside the 5-minute refresh margin
        t3 = await p.token()
        return t1, t2, t3

    assert _run(go()) == ("id-1", "id-1", "id-2")
    assert made == [("/var/secrets/hangar/key.json", BASE)]


def test_id_token_mint_failure_raises_for_the_client_to_map():
    def factory(key_path, audience):
        raise FileNotFoundError(key_path)

    p = IdTokenProvider("/nope.json", BASE, credentials_factory=factory, request_factory=lambda: None)
    with pytest.raises(Exception):
        _run(p.token())


def test_from_config_builds_a_client_only_when_enabled():
    from types import SimpleNamespace

    off = SimpleNamespace(hangar_edits_enabled=False, hangar_api_url=BASE,
                          hangar_sa_key_path="/k.json")
    assert HangarEditClient.from_config(off) is None
    on = SimpleNamespace(hangar_edits_enabled=True, hangar_api_url=BASE, hangar_sa_key_path="/k.json")
    c = HangarEditClient.from_config(on)
    assert isinstance(c, HangarEditClient)
    assert c.base_url == BASE


# --- fix round 1 ---------------------------------------------------------------

MAYBE = ("The hangar service didn't answer in time — the change may have been saved; "
         "check before retrying")


@pytest.mark.parametrize("exc", [httpx.ReadTimeout("slow"), httpx.ReadError("reset"),
                                 httpx.RemoteProtocolError("eof")])
def test_failure_after_the_request_was_sent_is_maybe_applied(exc):
    def boom(request):
        raise exc
    client, _ = _client(boom)
    tools = HangarEditTools(client, user_id=AKIRA)
    out = _run(tools.functions()[1]("Cutlass Black"))
    assert out == {"error": "unavailable", "maybe_applied": True, "message": MAYBE}
    assert tools.calls[-1]["result"] == "unavailable"
    assert tools.edits == 0


def test_overall_timeout_while_the_request_is_in_flight_is_maybe_applied():
    async def slow(request):
        await asyncio.sleep(1)
        return httpx.Response(200, json=FIT_OK)

    class _Slow(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            return await slow(request)
    client = HangarEditClient(BASE, _Tokens(), transport=_Slow(), timeout_s=0.05)
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[0]("Connie", "Hemera"))
    assert out["maybe_applied"] is True and out["error"] == "unavailable"


@pytest.mark.parametrize("exc", [httpx.ConnectError("refused"), httpx.ConnectTimeout("no route")])
def test_connect_failures_are_not_maybe_applied(exc):
    def boom(request):
        raise exc
    client, _ = _client(boom)
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[0]("Connie", "Hemera"))
    assert out["error"] == "unavailable" and "maybe_applied" not in out


def test_timeout_during_token_mint_is_not_maybe_applied():
    class _SlowTokens(_Tokens):
        async def token(self):
            await asyncio.sleep(1)
            return "t"
    client, seen = _client(_json(200, FIT_OK), tokens=_SlowTokens(), timeout_s=0.05)
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[0]("Connie", "Hemera"))
    assert "maybe_applied" not in out and seen == []


def test_non_json_gateway_5xx_is_maybe_applied():
    client, _ = _client(lambda r: httpx.Response(504, text="upstream request timeout"))
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[0]("Connie", "Hemera"))
    assert out["maybe_applied"] is True


def test_prewarm_mints_the_token_and_never_raises():
    tokens = _Tokens()
    client, _ = _client(_json(200, FIT_OK), tokens=tokens)
    _run(client.prewarm())
    assert tokens.calls == 1
    bad, _ = _client(_json(200, FIT_OK), tokens=_Tokens(exc=RuntimeError("no key")))
    _run(bad.prewarm())  # must not raise


@pytest.mark.parametrize("ref", [".", "..", " .. ", " . "])
def test_reset_refuses_dot_ship_refs_locally(ref):
    client, seen = _client(_json(200, {}))
    out = _run(HangarEditTools(client, user_id=AKIRA).functions()[2](ref, "all"))
    assert out["error"] == "invalid_request"
    assert seen == []


@pytest.mark.parametrize("uid", ["١٢٣", "１２３", "²³"])
def test_non_ascii_digits_are_not_a_discord_id(uid):
    client, seen = _client(_json(200, FIT_OK))
    out = _run(HangarEditTools(client, user_id=uid).functions()[0]("Connie", "Hemera"))
    assert out["error"] == "unknown_speaker" and seen == []


def test_from_config_strips_a_trailing_slash_for_audience_and_paths():
    from types import SimpleNamespace
    made = {}

    class _P:
        def __init__(self, key, aud):
            made["aud"] = aud
    import src.hangar_edit as H
    orig = H.IdTokenProvider
    H.IdTokenProvider = _P
    try:
        c = HangarEditClient.from_config(SimpleNamespace(
            hangar_edits_enabled=True, hangar_api_url=BASE + "/", hangar_sa_key_path="/k.json"))
    finally:
        H.IdTokenProvider = orig
    assert c.base_url == BASE and made["aud"] == BASE
