import json
import pathlib
from typing import Callable

import httpx

FIX = pathlib.Path(__file__).parent / "fixtures"

TAURUS_UUID = "d1c3fa10-b2d9-421e-8301-97dbf4d0c115"
TAURUS_SLUG = "rsi-constellation-taurus"
HARBINGER_UUID = "34295443-da9b-4e6c-9335-69d5f3b29a88"
HARBINGER_SLUG = "aegs-vanguard-harbinger"
HEMERA_UUID = "3bd1502d-f593-456f-a3a9-14fec5b8c1a5"


def load_fixture(name: str):
    return json.loads((FIX / name).read_text())


def wiki_handler(calls: list | None = None, fail: Callable[[httpx.Request], bool] | None = None,
                 page_size: int = 50):
    """A fake Star Citizen Wiki API backed by the recorded fixtures.

    - GET /api/vehicles?page=N        -> the recorded 299-vehicle index, paged
    - GET /api/vehicles/<uuid|slug>   -> Taurus / Harbinger fixtures, else 404
    - GET /api/v2/items?filter[type]=QuantumDrive&filter[size]=2 -> QD S2 fixture
      (any other type/size -> empty page)
    - GET /api/v2/items/<uuid|Hemera> -> Hemera fixture, else 404
    `fail(req)` returning True turns that request into a 503.
    """
    index = load_fixture("wiki_vehicles_index.json")["data"]
    vehicles = {
        TAURUS_UUID: "wiki_vehicle_constellation_taurus.json",
        TAURUS_SLUG: "wiki_vehicle_constellation_taurus.json",
        HARBINGER_UUID: "wiki_vehicle_vanguard_harbinger.json",
        HARBINGER_SLUG: "wiki_vehicle_vanguard_harbinger.json",
    }

    def handler(req: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(req)
        if fail is not None and fail(req):
            return httpx.Response(503, text="upstream down")
        path = req.url.path
        if path == "/api/vehicles":
            page = int(req.url.params.get("page", "1"))
            last = (len(index) + page_size - 1) // page_size
            chunk = index[(page - 1) * page_size: page * page_size]
            return httpx.Response(200, json={"data": chunk, "meta": {"current_page": page, "last_page": last}})
        if path.startswith("/api/vehicles/"):
            key = path.rsplit("/", 1)[1]
            if key in vehicles:
                return httpx.Response(200, json=load_fixture(vehicles[key]))
            return httpx.Response(404, json={"message": "No query results"})
        if path == "/api/v2/items":
            p = req.url.params
            if p.get("filter[type]") == "QuantumDrive" and p.get("filter[size]") in (None, "2"):
                return httpx.Response(200, json=load_fixture("wiki_items_quantumdrive_s2.json"))
            return httpx.Response(200, json={"data": [], "meta": {"current_page": 1, "last_page": 1}})
        if path.startswith("/api/v2/items/"):
            key = path.rsplit("/", 1)[1]
            if key in (HEMERA_UUID, "Hemera"):
                return httpx.Response(200, json=load_fixture("wiki_item_hemera.json"))
            return httpx.Response(404, json={"message": "No query results"})
        return httpx.Response(404, json={"message": "unrouted"})
    return handler
