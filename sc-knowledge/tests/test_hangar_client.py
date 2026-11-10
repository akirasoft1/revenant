"""hangar-service client: ID-token minting/caching, read-only GETs, 30s
response cache, and the error mapping (unreachable -> HangarUnavailable)."""
import asyncio
import inspect
from datetime import datetime, timezone

import httpx
import pytest

from src.hangar import (HangarClient, HangarError, HangarUnavailable, IdTokenProvider,
                        build_hangar_client)
from src.config import load

URL = "https://hangar-service-hvmf2jpuca-uc.a.run.app"


class _Clock:
    def __init__(self, t: float = 1_800_000_000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


class _FakeCreds:
    """Stands in for service_account.IDTokenCredentials: refresh() mints a
    new token valid for `lifetime_s` from the fake clock's now."""
    def __init__(self, clock, lifetime_s=3600, fail=False):
        self._clock = clock
        self._lifetime = lifetime_s
        self._fail = fail
        self.token = None
        self.expiry = None
        self.refreshes = 0
        self.requests = []

    def refresh(self, request):
        self.requests.append(request)
        if self._fail:
            raise RuntimeError("token endpoint down")
        self.refreshes += 1
        self.token = f"tok-{self.refreshes}"
        # google-auth keeps expiry as a NAIVE UTC datetime.
        self.expiry = datetime.fromtimestamp(self._clock() + self._lifetime,
                                             tz=timezone.utc).replace(tzinfo=None)


def _provider(clock, creds=None, factory_calls=None):
    creds = creds or _FakeCreds(clock)

    def factory(path, audience):
        if factory_calls is not None:
            factory_calls.append((path, audience))
        return creds
    return IdTokenProvider("/keys/key.json", URL, credentials_factory=factory,
                           request_factory=lambda: "REQ", clock=clock), creds


async def test_token_minted_with_audience_and_key_path():
    clock = _Clock()
    calls = []
    p, creds = _provider(clock, factory_calls=calls)
    assert await p.token() == "tok-1"
    assert calls == [("/keys/key.json", URL)]
    assert creds.requests == ["REQ"]


async def test_token_cached_until_five_minutes_before_expiry():
    clock = _Clock()
    p, creds = _provider(clock)
    assert await p.token() == "tok-1"
    clock.t += 3600 - 301  # still more than 5 min left
    assert await p.token() == "tok-1"
    assert creds.refreshes == 1
    clock.t += 2  # now inside the 5-minute margin
    assert await p.token() == "tok-2"
    assert creds.refreshes == 2


async def test_concurrent_token_requests_refresh_once():
    clock = _Clock()
    p, creds = _provider(clock)
    toks = await asyncio.gather(*(p.token() for _ in range(5)))
    assert toks == ["tok-1"] * 5
    assert creds.refreshes == 1


async def test_token_refresh_failure_is_unavailable():
    clock = _Clock()
    p, _ = _provider(clock, creds=_FakeCreds(clock, fail=True))
    with pytest.raises(HangarUnavailable) as ei:
        await p.token()
    assert "token endpoint down" in str(ei.value)


async def test_missing_key_file_is_unavailable():
    p = IdTokenProvider("/nonexistent/key.json", URL)
    with pytest.raises(HangarUnavailable) as ei:
        await p.token()
    assert "/nonexistent/key.json" in str(ei.value)


class _FakeTokens:
    def __init__(self):
        self.calls = 0

    async def token(self):
        self.calls += 1
        return "tok-x"


def _client(handler, clock=None, tokens=None, timeout_s=3.0):
    return HangarClient(URL, tokens or _FakeTokens(), transport=httpx.MockTransport(handler),
                        timeout_s=timeout_s, clock=clock or _Clock())


_HANGAR = {"member": "111", "ships": []}


async def test_get_hangar_sends_bearer_and_no_acting_member():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=_HANGAR)
    c = _client(handler)
    body = await c.get_hangar("111")
    assert body == _HANGAR
    req = seen[0]
    assert req.method == "GET"
    assert str(req.url) == f"{URL}/v1/members/111/hangar"
    assert req.headers["Authorization"] == "Bearer tok-x"
    assert "X-Acting-Member" not in req.headers


async def test_responses_cached_for_30_seconds():
    n = {"calls": 0}

    def handler(req):
        n["calls"] += 1
        return httpx.Response(200, json={**_HANGAR, "n": n["calls"]})
    clock = _Clock()
    c = _client(handler, clock=clock)
    assert (await c.get_hangar("111"))["n"] == 1
    clock.t += 29
    assert (await c.get_hangar("111"))["n"] == 1
    clock.t += 2
    assert (await c.get_hangar("111"))["n"] == 2
    assert (await c.get_hangar("222"))["n"] == 3  # keyed per member


@pytest.mark.parametrize("status", [500, 502, 503, 401, 403])
async def test_server_or_auth_errors_are_unavailable(status):
    def handler(req):
        return httpx.Response(status, json={"error": "unavailable", "message": "firestore down"})
    with pytest.raises(HangarUnavailable) as ei:
        await _client(handler).get_hangar("111")
    assert str(status) in str(ei.value) and "firestore down" in str(ei.value)


async def test_connect_error_is_unavailable():
    def handler(req):
        raise httpx.ConnectError("refused", request=req)
    with pytest.raises(HangarUnavailable):
        await _client(handler).get_hangar("111")


async def test_slow_service_times_out_as_unavailable():
    async def handler(req):
        await asyncio.sleep(1.0)
        return httpx.Response(200, json=_HANGAR)
    with pytest.raises(HangarUnavailable) as ei:
        await _client(handler, timeout_s=0.05).get_hangar("111")
    assert "timed out" in str(ei.value)


async def test_not_found_and_bad_request_carry_service_code():
    def handler(req):
        return httpx.Response(400, json={"error": "invalid_request", "message": "bad member id"})
    with pytest.raises(HangarError) as ei:
        await _client(handler).get_hangar("111")
    assert ei.value.code == "invalid_request" and ei.value.status == 400
    assert "bad member id" in ei.value.message


async def test_errors_are_not_cached():
    n = {"calls": 0}

    def handler(req):
        n["calls"] += 1
        if n["calls"] == 1:
            return httpx.Response(503, json={"error": "unavailable", "message": "x"})
        return httpx.Response(200, json=_HANGAR)
    c = _client(handler)
    with pytest.raises(HangarUnavailable):
        await c.get_hangar("111")
    assert await c.get_hangar("111") == _HANGAR


def test_client_is_read_only():
    """This client is model-driven and the service trusts any allow-listed
    caller's X-Acting-Member on writes -- it must never be able to write.
    No write-shaped public method may exist, and the only HTTP verb in the
    module source is GET."""
    public = {n for n, _ in inspect.getmembers(HangarClient) if not n.startswith("_")}
    assert public == {"get_hangar", "aclose"}
    import src.hangar as mod
    src = inspect.getsource(mod)
    for verb in ("\"POST\"", "\"PUT\"", "\"PATCH\"", "\"DELETE\"", ".post(", ".put(",
                 ".patch(", ".delete(", "X-Acting-Member"):
        assert verb not in src, verb


async def test_every_request_is_a_get():
    methods = []

    def handler(req):
        methods.append(req.method)
        return httpx.Response(200, json=_HANGAR)
    c = _client(handler)
    await c.get_hangar("1")
    await c.get_hangar("2")
    assert methods == ["GET", "GET"]


def test_build_hangar_client_none_when_url_unset(monkeypatch):
    monkeypatch.delenv("HANGAR_API_URL", raising=False)
    assert build_hangar_client(load()) is None


def test_config_hangar_env(monkeypatch):
    monkeypatch.setenv("HANGAR_API_URL", URL + "/")
    monkeypatch.delenv("HANGAR_SA_KEY_PATH", raising=False)
    cfg = load()
    assert cfg.hangar_api_url == URL  # trailing slash dropped: it's the token audience
    assert cfg.hangar_sa_key_path == "/var/secrets/hangar/key.json"
    assert build_hangar_client(cfg) is not None


def test_default_factory_builds_real_id_token_credentials(tmp_path):
    """The production path: google-auth's IDTokenCredentials from a JSON key
    with target_audience = the service URL (no network -- not refreshed)."""
    import json as _json
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from google.oauth2 import service_account
    from src.hangar import _default_credentials_factory

    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()).decode()
    key = tmp_path / "key.json"
    key.write_text(_json.dumps({
        "type": "service_account", "project_id": "p", "private_key_id": "k1",
        "private_key": pem, "client_email": "hangar-api@p.iam.gserviceaccount.com",
        "client_id": "1", "token_uri": "https://oauth2.googleapis.com/token"}))
    creds = _default_credentials_factory(str(key), URL)
    assert isinstance(creds, service_account.IDTokenCredentials)
    assert creds._target_audience == URL
