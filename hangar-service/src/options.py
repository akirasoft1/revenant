"""Compatible items for one vehicle slot (the web editor's item picker)."""
from .catalog import SLOT_TYPES, Slot
from .loadout import check_compatible

_MAX_PER_SIZE_SPAN = 12   # wider/unknown size ranges fetch the whole type instead


def _sort_key(item: dict):
    ks = item.get("keyStat") or {}
    value = ks.get("value")
    if value is None:
        return (1, 0.0, (item.get("name") or "").casefold())
    return (0, value if ks.get("lowerIsBetter") else -value, (item.get("name") or "").casefold())


def _view(item: dict) -> dict:
    out = {k: item.get(k) for k in ("uuid", "name", "type", "size", "grade", "class")}
    out["keyStat"] = item.get("keyStat")
    if item.get("cheapestPrice"):
        out["cheapestPrice"] = item["cheapestPrice"]   # omitted when unknown / not sold
    return out


async def slot_options(catalog, slot: Slot) -> list[dict]:
    """Every catalog item ``check_compatible`` accepts for ``slot``, best key
    stat first (``lowerIsBetter`` respected; no stat last; name tiebreak).
    Each: ``{uuid, name, type, size, grade, class, keyStat, cheapestPrice?}``."""
    types = [c["type"] for c in slot.compatible_types] or [slot.type]
    types = list(dict.fromkeys(t for t in types if t in SLOT_TYPES))
    lo, hi = slot.size_min, slot.size_max
    if isinstance(lo, int) and isinstance(hi, int) and 0 <= hi - lo <= _MAX_PER_SIZE_SPAN:
        sizes: list[int | None] = list(range(lo, hi + 1))
    else:
        sizes = [None]
    seen: set = set()
    out: list[dict] = []
    for t in types:
        for size in sizes:
            for item in await catalog.item_options(t, size):
                if item.get("uuid") in seen or check_compatible(slot, item) is not None:
                    continue
                seen.add(item.get("uuid"))
                out.append(item)
    out.sort(key=_sort_key)
    return [_view(i) for i in out]
