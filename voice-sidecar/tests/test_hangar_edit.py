"""hangar-service WRITE client for voice chat edits (spec 2026-10-09 hangar
chat edits). No network: httpx.MockTransport + a fake token provider."""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from src import hangar_edit
from src.hangar_edit import HangarEditClient, IdTokenProvider

URL = "https://hangar-service-hvmf2jpuca-uc.a.run.app"


class FakeTokens:
    def __init__(self, token="tok-123", exc=None, delay=0.0):
        self.token_value = token
        self.exc = exc
        self.delay = delay
        self.calls = 0

    async def token(self):
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        return self.token_value


def _client(handler, tokens=None, timeout_s=5.0):
    return HangarEditClient(URL, tokens or FakeTokens(),
                            transport=httpx.MockTransport(handler), timeout_s=timeout_s)


def _recorder(status=200, body=None, *, text=None):
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        if text is not None:
            return httpx.Response(status, text=text)
        return httpx.Response(status, json=body if body is not None else {})
    return handler, seen


FIT_OK = {"member": "111", "ship": {"shipId": "s1", "label": "Constellation Taurus",
                                    "vehicle": "Constellation Taurus"},
          "item": {"uuid": "u", "name": "Hemera", "type": "QuantumDrive", "size": 2},
          "changes": [{"slot": "hardpoint_quantum_drive", "from": {"name": "Bolon", "uuid": "b"},
                       "to": {"name": "Hemera", "uuid": "u"}}],
          "unchanged": False}


# ---- fit -----------------------------------------------------------------

async def test_fit_posts_to_member_fit_with_acting_member_and_bearer():
    handler, seen = _recorder(200, FIT_OK)
    out = await _client(handler).call("hangar_fit", "111",
                                      {"ship": "my Connie", "item": "Hemera"})
    assert out == FIT_OK
    req = seen[0]
    assert req.method == "POST"
    assert str(req.url) == f"{URL}/v1/members/111/fit"
    assert req.headers["X-Acting-Member"] == "111"
    assert req.headers["Authorization"] == "Bearer tok-123"
    assert json.loads(req.content) == {"ship": "my Connie", "item": "Hemera"}


async def test_fit_passes_slot_when_given():
    handler, seen = _recorder(200, FIT_OK)
    await _client(handler).call("hangar_fit", "111",
                                {"ship": "Connie", "item": "Hemera", "slot": "left"})
    assert json.loads(seen[0].content) == {"ship": "Connie", "item": "Hemera", "slot": "left"}


async def test_fit_blank_slot_is_omitted():
    handler, seen = _recorder(200, FIT_OK)
    await _client(handler).call("hangar_fit", "111",
                                {"ship": "Connie", "item": "Hemera", "slot": "  "})
    assert "slot" not in json.loads(seen[0].content)


@pytest.mark.parametrize("args", [{}, {"ship": "Connie"}, {"item": "Hemera"},
                                  {"ship": " ", "item": "Hemera"}, {"ship": 3, "item": "x"}])
async def test_fit_missing_args_never_calls_the_service(args):
    handler, seen = _recorder(200, FIT_OK)
    out = await _client(handler).call("hangar_fit", "111", args)
    assert out["error"] == "invalid_request" and out["message"]
    assert seen == []


# ---- add ship ------------------------------------------------------------

async def test_add_ship_posts_vehicle_and_nickname_and_summarises_the_ship():
    ship = {"shipId": "s9", "vehicleUuid": "v", "vehicleName": "Cutlass Black",
            "vehicleClassName": "DRAK_Cutlass_Black", "nickname": "Bertha", "fitted": {},
            "loadout": [{"slot": f"x{i}"} for i in range(40)]}
    handler, seen = _recorder(201, {"ship": ship})
    out = await _client(handler).call("hangar_add_ship", "111",
                                      {"vehicle": "Cutlass Black", "nickname": "Bertha"})
    req = seen[0]
    assert str(req.url) == f"{URL}/v1/members/111/ships"
    assert req.headers["X-Acting-Member"] == "111"
    assert json.loads(req.content) == {"vehicle": "Cutlass Black", "nickname": "Bertha"}
    # the loadout is dropped: 40 slots of JSON in a Live audio context is noise
    assert out == {"added": True, "ship": {"shipId": "s9", "vehicle": "Cutlass Black",
                                           "nickname": "Bertha"}}


async def test_add_ship_without_nickname_sends_only_vehicle():
    handler, seen = _recorder(201, {"ship": {"shipId": "s9", "vehicleName": "Cutlass Black",
                                             "nickname": None}})
    await _client(handler).call("hangar_add_ship", "111", {"vehicle": "Cutlass Black"})
    assert json.loads(seen[0].content) == {"vehicle": "Cutlass Black"}


async def test_add_ship_requires_vehicle():
    handler, seen = _recorder(201, {})
    out = await _client(handler).call("hangar_add_ship", "111", {"nickname": "x"})
    assert out["error"] == "invalid_request" and seen == []


# ---- reset ---------------------------------------------------------------

async def test_reset_posts_to_url_encoded_ship_ref():
    body = {"member": "111", "ship": {"shipId": "s1", "label": "Vanguard Harbinger"},
            "changes": [], "unchanged": True}
    handler, seen = _recorder(200, body)
    out = await _client(handler).call("hangar_reset", "111",
                                      {"ship": "Big Bertha", "slot": "all"})
    assert out == body
    req = seen[0]
    assert req.url.raw_path == b"/v1/members/111/ships/Big%20Bertha/reset"
    assert req.headers["X-Acting-Member"] == "111"
    assert json.loads(req.content) == {"slot": "all"}


async def test_reset_requires_a_slot():
    handler, seen = _recorder(200, {})
    out = await _client(handler).call("hangar_reset", "111", {"ship": "Harbinger"})
    assert out["error"] == "invalid_request" and "all" in out["message"]
    assert seen == []


async def test_reset_ship_with_slash_is_refused_locally():
    handler, seen = _recorder(200, {})
    out = await _client(handler).call("hangar_reset", "111", {"ship": "a/b", "slot": "all"})
    assert out["error"] == "invalid_request" and seen == []


# ---- errors: generic envelope passthrough, never raise -------------------

@pytest.mark.parametrize("status,body", [
    (409, {"error": "ambiguous", "message": "several", "candidates": [{"shipId": "a", "label": "A"}]}),
    (409, {"error": "choose_slot", "message": "which", "slots": [{"slot": "x", "size": "S1",
                                                                  "current": {"name": "y"}}]}),
    (404, {"error": "not_found", "message": "no ship", "owned": []}),
    (422, {"error": "incompatible", "message": "too big", "reason": "size_mismatch"}),
    (403, {"error": "forbidden", "message": "nope"}),
    (409, {"error": "ambiguous", "field": "item", "message": "which item",
           "candidates": [{"name": "Hemera"}, {"name": "Hemera X"}]}),
    (404, {"error": "not_found", "message": "no item", "suggestions": ["Hemera"]}),
    (400, {"error": "invalid_request", "message": "bad"}),
])
async def test_error_envelopes_pass_through_unchanged(status, body):
    handler, _ = _recorder(status, body)
    out = await _client(handler).call("hangar_fit", "111", {"ship": "s", "item": "i"})
    assert out == body


async def test_401_is_reported_as_unavailable_not_as_a_user_problem():
    handler, _ = _recorder(401, {"error": "unauthenticated", "message": "bad token"})
    out = await _client(handler).call("hangar_fit", "111", {"ship": "s", "item": "i"})
    assert out["error"] == "unavailable"


async def test_5xx_without_envelope_is_unavailable():
    handler, _ = _recorder(502, text="<html>bad gateway</html>")
    out = await _client(handler).call("hangar_fit", "111", {"ship": "s", "item": "i"})
    assert out["error"] == "unavailable" and "502" in out["message"]


async def test_network_error_is_unavailable():
    def handler(request):
        raise httpx.ConnectError("refused")
    out = await _client(handler).call("hangar_fit", "111", {"ship": "s", "item": "i"})
    assert out["error"] == "unavailable"


async def test_token_failure_is_unavailable_and_service_not_called():
    handler, seen = _recorder(200, FIT_OK)
    out = await _client(handler, FakeTokens(exc=RuntimeError("no key"))).call(
        "hangar_fit", "111", {"ship": "s", "item": "i"})
    assert out["error"] == "unavailable" and seen == []


async def test_timeout_is_unavailable():
    handler, _ = _recorder(200, FIT_OK)
    out = await _client(handler, FakeTokens(delay=0.5), timeout_s=0.05).call(
        "hangar_fit", "111", {"ship": "s", "item": "i"})
    assert out["error"] == "unavailable" and "timed out" in out["message"]


async def test_unknown_tool_name():
    handler, seen = _recorder(200, {})
    out = await _client(handler).call("hangar_delete_everything", "111", {})
    assert out["error"] == "unknown_tool" and seen == []


@pytest.mark.parametrize("member", ["", "abc", "12a", None, "1 2", "../111"])
async def test_non_numeric_member_never_reaches_the_service(member):
    handler, seen = _recorder(200, FIT_OK)
    out = await _client(handler).call("hangar_fit", member, {"ship": "s", "item": "i"})
    assert out["error"] == "unknown_speaker" and seen == []


def test_client_never_logs_or_exposes_a_member_parameter_in_tool_args():
    # The acting member is a positional argument supplied by the bridge from
    # trusted plumbing; anything the MODEL puts in args (member_id, member,
    # discordId) is ignored -- the path and header use the bound id.
    async def run():
        handler, seen = _recorder(200, FIT_OK)
        await _client(handler).call("hangar_fit", "111", {"ship": "s", "item": "i",
                                                         "member_id": "999", "member": "999"})
        return seen
    seen = asyncio.run(run())
    assert "/members/111/" in str(seen[0].url)
    assert seen[0].headers["X-Acting-Member"] == "111"
    assert "999" not in seen[0].content.decode()


# ---- ID token provider ---------------------------------------------------

class _FakeCreds:
    def __init__(self):
        self.refreshes = 0
        self.token = None
        self.expiry = None

    def refresh(self, request):
        self.refreshes += 1
        self.token = f"t{self.refreshes}"
        self.expiry = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1)


async def test_id_token_minted_with_exact_audience_and_cached():
    seen = {}
    creds = _FakeCreds()

    def factory(key_path, audience):
        seen["key"], seen["aud"] = key_path, audience
        return creds
    p = IdTokenProvider("/var/secrets/hangar/key.json", URL, credentials_factory=factory,
                        request_factory=lambda: None)
    assert await p.token() == "t1"
    assert await p.token() == "t1"
    assert creds.refreshes == 1
    assert seen == {"key": "/var/secrets/hangar/key.json", "aud": URL}


async def test_id_token_mint_failure_raises_hangar_unavailable():
    def factory(key_path, audience):
        raise FileNotFoundError(key_path)
    p = IdTokenProvider("/nope", URL, credentials_factory=factory, request_factory=lambda: None)
    with pytest.raises(hangar_edit.HangarUnavailable):
        await p.token()


def test_build_client_none_when_disabled():
    from types import SimpleNamespace
    assert hangar_edit.build_hangar_edit_client(SimpleNamespace(
        hangar_edits_enabled=False, hangar_api_url=URL, hangar_sa_key_path="/k")) is None
    c = hangar_edit.build_hangar_edit_client(SimpleNamespace(
        hangar_edits_enabled=True, hangar_api_url=URL, hangar_sa_key_path="/k"))
    assert isinstance(c, HangarEditClient)
