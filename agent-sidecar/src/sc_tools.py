"""Star Citizen knowledge toolset for the channel-voice agent: built once at
startup, attached per turn only when a cached availability check says the
sc-knowledge server is up — so a dead add-on can never fail Chat.

"Available" means BOTH that `/healthz` answers 200 AND that the MCP path
actually lists at least one `sc_*` tool. /healthz alone is not enough: an
MCP-path-only failure (e.g. the server's DNS-rebinding guard answering every
`/mcp` request with 421 while /healthz stays green) used to report
"available", so SC_TOOLS_PREAMBLE promised tools that had silently failed to
load. Both checks share one TTL cache (default 30s)."""
import asyncio
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
                 clock: Callable[[], float] = time.monotonic, ttl_s: float = 30.0,
                 list_timeout_s: float = 5.0) -> None:
        self.toolsets = toolsets
        self._health_url = health_url
        self._probe = probe or _http_probe
        self._clock = clock
        self._ttl = ttl_s
        self._list_timeout = list_timeout_s
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
        if ok:
            ok = await self._lists_sc_tools()
        self._checked_at, self._ok = now, ok
        return ok

    async def _lists_sc_tools(self) -> bool:
        """True iff the real toolset(s) list at least one `sc_*` tool within
        `list_timeout_s`. Any exception or timeout -> False (unavailable)."""
        names: list[str] = []
        try:
            for ts in self.toolsets:
                tools = await asyncio.wait_for(ts.get_tools(), self._list_timeout)
                names.extend(str(getattr(t, "name", "")) for t in tools or [])
        except Exception as e:  # noqa: BLE001 -- incl. TimeoutError
            log.warning("sc-knowledge health OK but listing its MCP tools failed "
                        "(%s: %s); treating sc tools as unavailable", type(e).__name__, e)
            return False
        if not any(n.startswith("sc_") for n in names):
            log.warning("sc-knowledge health OK but its MCP toolset lists no sc_* tools "
                        "(got %r); treating sc tools as unavailable", names)
            return False
        return True
