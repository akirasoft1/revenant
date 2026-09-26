"""Star Citizen knowledge toolset for the channel-voice agent: built once at
startup, attached per turn only when a cached health probe says the
sc-knowledge server is up — so a dead add-on can never fail Chat."""
import logging
import time
from typing import Awaitable, Callable

import httpx

log = logging.getLogger(__name__)


async def _http_probe(url: str) -> bool:
    async with httpx.AsyncClient(timeout=2.0) as c:
        r = await c.get(url)
        return r.status_code == 200


def health_url_for(mcp_url: str) -> str:
    return mcp_url[: -len("/mcp")] + "/healthz" if mcp_url.endswith("/mcp") else mcp_url.rstrip("/") + "/healthz"


class ScToolsProvider:
    def __init__(self, toolsets: list, health_url: str | None,
                 probe: Callable[[str], Awaitable[bool]] | None = None,
                 clock: Callable[[], float] = time.monotonic, ttl_s: float = 30.0) -> None:
        self.toolsets = toolsets
        self._health_url = health_url
        self._probe = probe or _http_probe
        self._clock = clock
        self._ttl = ttl_s
        self._checked_at: float | None = None
        self._ok = False

    @classmethod
    def disabled(cls) -> "ScToolsProvider":
        return cls([], None)

    @property
    def enabled(self) -> bool:
        return bool(self.toolsets) and bool(self._health_url)

    async def available(self) -> bool:
        if not self.enabled:
            return False
        now = self._clock()
        if self._checked_at is not None and now - self._checked_at < self._ttl:
            return self._ok
        try:
            ok = bool(await self._probe(self._health_url))
        except Exception as e:  # noqa: BLE001
            log.warning("sc-knowledge health probe failed: %s: %s", type(e).__name__, e)
            ok = False
        self._checked_at, self._ok = now, ok
        return ok
