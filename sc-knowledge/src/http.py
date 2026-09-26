"""Shared async HTTP client for upstream APIs: timeouts, bounded jittered retry
on 429/5xx and network errors, rate limiting, honest identification."""
import asyncio
import random
from typing import Any, Awaitable, Callable

import httpx

from .cache import RateLimiter

_RETRY_STATUS = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 3  # 1 try + 2 retries


class UpstreamError(Exception):
    def __init__(self, upstream: str, status: int | None, detail: str) -> None:
        super().__init__(f"{upstream} {status}: {detail}")
        self.upstream = upstream
        self.status = status
        self.detail = detail


class UpstreamClient:
    def __init__(self, name: str, base_url: str, headers: dict, limiter: RateLimiter,
                 transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self.name = name
        self._limiter = limiter
        self._sleep = sleep
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            headers=headers,
            timeout=httpx.Timeout(8.0, connect=3.0),
            transport=transport,
        )

    async def _request(self, method: str, path: str, **kw) -> Any:
        last: UpstreamError | None = None
        for attempt in range(_MAX_ATTEMPTS):
            await self._limiter.acquire()
            try:
                resp = await self._http.request(method, path.lstrip("/"), **kw)
            except httpx.HTTPError as e:
                last = UpstreamError(self.name, None, f"{type(e).__name__}: {e}")
            else:
                if resp.status_code < 400:
                    try:
                        return resp.json()
                    except ValueError:
                        # A success status with a non-JSON body (e.g. an HTML
                        # outage page served with a 200) is not retryable --
                        # raise immediately, full body, no truncation.
                        raise UpstreamError(
                            self.name, resp.status_code,
                            f"non-JSON response body: {resp.text}") from None
                last = UpstreamError(self.name, resp.status_code, resp.text)
                if resp.status_code not in _RETRY_STATUS:
                    raise last
            if attempt < _MAX_ATTEMPTS - 1:
                await self._sleep(0.4 * (2 ** attempt) + random.uniform(0, 0.3))
        raise last  # type: ignore[misc]

    async def get_json(self, path: str, params: dict | None = None) -> Any:
        return await self._request("GET", path, params=params)

    async def post_json(self, path: str, body: dict) -> Any:
        return await self._request("POST", path, json=body)

    async def aclose(self) -> None:
        await self._http.aclose()
