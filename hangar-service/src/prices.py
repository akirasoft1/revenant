"""Cheapest in-game shop price for an item, for the web editor's item picker.

Source: the UEX Corp player-reported purchase prices that the Star Citizen
Wiki embeds in every ``v2/items`` record (``uex_prices.purchase``) -- the
same embedded data sc-knowledge's ``_shops`` (``sc-knowledge/src/tools_items.py``)
reads for components. Using the embedded copy needs no UEX item-id mapping,
no UEX bearer and no extra upstream call: it rides along with the item list
the catalog already fetches and caches (12h), which is fresh enough for a
"roughly what does it cost and where" hint.

Price is optional by design: anything missing or malformed -> None, and the
picker simply omits ``cheapestPrice`` for that item.
"""
from typing import Any


def _price(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    try:
        p = int(v)
    except (TypeError, ValueError):
        return None
    return p if p > 0 else None


def cheapest_price(raw_item: Any) -> dict | None:
    """``{price, shop, location}`` (aUEC, cheapest live buy price) or None."""
    if not isinstance(raw_item, dict):
        return None
    uex = raw_item.get("uex_prices")
    purchase = uex.get("purchase") if isinstance(uex, dict) else None
    best: dict | None = None
    for row in purchase if isinstance(purchase, list) else []:
        if not isinstance(row, dict):
            continue
        price = _price(row.get("price_buy"))
        if price is None or (best is not None and price >= best["price"]):
            continue
        loc = row.get("starmap_location") if isinstance(row.get("starmap_location"), dict) else {}
        location = ", ".join(str(x) for x in (loc.get("name"), loc.get("parent_name")) if x) or None
        best = {"price": price, "shop": row.get("terminal_name") or None, "location": location}
    return best
