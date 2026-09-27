"""Star Citizen Wiki API client (per-patch extracted game data + embedded UEX prices)."""
from urllib.parse import quote

import httpx

from .cache import RateLimiter
from .config import Config
from .http import UpstreamClient, UpstreamError

_MAX_PAGES = 20


class WikiClient:
    def __init__(self, upstream: UpstreamClient) -> None:
        self._u = upstream

    async def _all_pages(self, path: str, params: dict) -> list[dict]:
        out: list[dict] = []
        page = 1
        while page <= _MAX_PAGES:
            body = await self._u.get_json(path, {**params, "page": page})
            out.extend(body.get("data") or [])
            last = (body.get("meta") or {}).get("last_page") or 1
            if page >= last:
                break
            page += 1
        return out

    async def item(self, name_or_uuid: str) -> dict | None:
        try:
            body = await self._u.get_json(f"v2/items/{quote(name_or_uuid, safe='')}")
        except UpstreamError as e:
            if e.status == 404:
                return None
            raise
        # R1: a `data` payload that isn't a dict (e.g. a list, from a
        # non-existent item path being routed to a list-returning endpoint)
        # must resolve to None, not be returned as-is.
        data = body.get("data") if isinstance(body, dict) else None
        return data if isinstance(data, dict) else None

    async def search_items(self, query: str) -> list[dict]:
        body = await self._u.get_json("v2/items", {"filter[name]": query, "limit": 10})
        return body.get("data") or []

    async def vehicle_items(self, type_: str, size: int | None) -> list[dict]:
        params = {"filter[type]": type_, "limit": 200}
        if size is not None:
            params["filter[size]"] = size
        return await self._all_pages("vehicle-items", params)

    async def missions(self, mission_giver: str) -> list[dict]:
        return await self._all_pages("missions", {"filter[mission_giver]": mission_giver, "limit": 200})

    async def factions(self) -> list[dict]:
        return await self._all_pages("factions", {"limit": 200})


def build_wiki(config: Config, transport: httpx.AsyncBaseTransport | None = None) -> WikiClient:
    headers = {"User-Agent": f"revenant-discord-bot/{config.version}", "Accept": "application/json"}
    return WikiClient(UpstreamClient("wiki", config.wiki_base, headers, RateLimiter(60, 60.0),
                                     transport=transport))
