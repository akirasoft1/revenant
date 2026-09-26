"""UEX Corp API v2 client. Every endpoint returns {"status": "ok", "data": ...}."""
import httpx

from .cache import RateLimiter
from .config import Config
from .http import UpstreamClient, UpstreamError


class UexClient:
    def __init__(self, upstream: UpstreamClient) -> None:
        self._u = upstream

    async def _data(self, path: str, params: dict | None = None):
        body = await self._u.get_json(path, {k: v for k, v in (params or {}).items() if v is not None})
        if not isinstance(body, dict) or body.get("status") != "ok":
            raise UpstreamError("uex", None, f"non-ok status for {path}: {str(body)[:300]}")
        return body.get("data")

    async def game_versions(self) -> dict:
        return await self._data("game_versions")

    async def terminals(self) -> list[dict]:
        return await self._data("terminals")

    async def commodities(self) -> list[dict]:
        return await self._data("commodities")

    async def commodities_routes(self, id_terminal_origin: int | None = None,
                                 id_terminal_destination: int | None = None,
                                 id_commodity: int | None = None) -> list[dict]:
        return await self._data("commodities_routes", {
            "id_terminal_origin": id_terminal_origin,
            "id_terminal_destination": id_terminal_destination,
            "id_commodity": id_commodity,
        })

    async def commodities_prices(self, id_commodity: int) -> list[dict]:
        return await self._data("commodities_prices", {"id_commodity": id_commodity})

    async def items_prices(self, id_item: int) -> list[dict]:
        return await self._data("items_prices", {"id_item": id_item})


def build_uex(config: Config, transport: httpx.AsyncBaseTransport | None = None) -> UexClient:
    headers = {
        "User-Agent": f"revenant-discord-bot/{config.version}",
        "X-Client-Version": f"revenant-sc-knowledge/{config.version}",
        "Accept": "application/json",
    }
    if config.uex_bearer:
        headers["Authorization"] = f"Bearer {config.uex_bearer}"
    return UexClient(UpstreamClient("uex", config.uex_base, headers, RateLimiter(120, 60.0),
                                    transport=transport))
