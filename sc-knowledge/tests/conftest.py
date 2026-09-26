import json
import pathlib

import httpx

FIX = pathlib.Path(__file__).parent / "fixtures"


def load_fixture(name: str):
    return json.loads((FIX / name).read_text())


def fixture_transport(routes: dict[str, str]) -> httpx.MockTransport:
    """routes: path-prefix (as seen by the server, e.g. '/2.0/terminals' or
    '/api/v2/items/V801-12') -> fixture filename. Longest prefix wins.
    Unmatched -> 404."""
    ordered = sorted(routes.items(), key=lambda kv: -len(kv[0]))

    def handler(req: httpx.Request) -> httpx.Response:
        for prefix, fname in ordered:
            if req.url.path.startswith(prefix):
                return httpx.Response(200, json=load_fixture(fname))
        return httpx.Response(404, json={"status": "not_found"})
    return httpx.MockTransport(handler)
