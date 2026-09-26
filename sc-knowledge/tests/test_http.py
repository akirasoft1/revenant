import httpx
import pytest
from src.cache import RateLimiter
from src.http import UpstreamClient, UpstreamError


def _client(handler, headers=None):
    async def nosleep(_): return None
    return UpstreamClient("uex", "https://x.test/2.0", headers or {"User-Agent": "ua"},
                          RateLimiter(1000, 60), transport=httpx.MockTransport(handler), sleep=nosleep)


async def test_get_json_sends_headers_and_params():
    seen = {}
    def handler(req):
        seen["url"] = str(req.url); seen["ua"] = req.headers["user-agent"]
        return httpx.Response(200, json={"status": "ok", "data": [1]})
    c = _client(handler)
    assert await c.get_json("/items", {"id_category": 83}) == {"status": "ok", "data": [1]}
    assert seen["url"] == "https://x.test/2.0/items?id_category=83" and seen["ua"] == "ua"


async def test_retries_503_then_succeeds():
    n = {"i": 0}
    def handler(req):
        n["i"] += 1
        return httpx.Response(503) if n["i"] < 3 else httpx.Response(200, json={"ok": 1})
    assert await _client(handler).get_json("/x") == {"ok": 1}
    assert n["i"] == 3


async def test_does_not_retry_404_and_raises_upstream_error():
    n = {"i": 0}
    def handler(req):
        n["i"] += 1; return httpx.Response(404)
    with pytest.raises(UpstreamError) as ei:
        await _client(handler).get_json("/x")
    assert ei.value.status == 404 and ei.value.upstream == "uex" and n["i"] == 1


async def test_network_error_after_retries_raises_upstream_error():
    def handler(req): raise httpx.ConnectError("boom")
    with pytest.raises(UpstreamError) as ei:
        await _client(handler).get_json("/x")
    assert ei.value.status is None


async def test_preserves_long_error_body_intact():
    long_body = "x" * 1000  # >500 chars
    def handler(req):
        return httpx.Response(500, text=long_body)
    with pytest.raises(UpstreamError) as ei:
        await _client(handler).get_json("/x")
    assert ei.value.detail == long_body and len(ei.value.detail) == 1000
