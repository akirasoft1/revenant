"""spviewer.eu saved-loadout import: decode, walk ports, diff against stock.

Export format (verified on a real export, ``tests/fixtures/spviewer_harbinger.json``):
the editor's export snippet dumps spviewer's IndexedDB ``SCSPVDatabase`` ->
``vehiclesLoadout`` as a JSON array of rows::

    {vehicleClassName: "AEGS_Vanguard_Harbinger",   # = Wiki vehicle class_name
     vehicleName, loadoutName, build, patch, date, loadoutPerfs, id,
     loadoutData: <LZString.compressToEncodedURIComponent(JSON)>}

The decoded ``loadoutData`` object holds

- ``*Ports`` arrays (``pilotWeaponsPorts``, ``shieldPorts``, ``quantumdrivePorts``,
  ...) of ports ``{PortName, MinSize, MaxSize, Loadout, BaseLoadout:{ClassName,
  Name, Type, Size, Grade, Class}, Types, Uneditable, Ports:[children]}``. A
  slot id is the ``/``-joined ``PortName`` path, identical to hangar slot ids.
  ``BaseLoadout`` is the stock item. ``Loadout`` is a Wiki item uuid OR a game
  class name.
- ``selected*`` maps (``selectedShields``, ``selectedPilotWeapons``, ...) keyed
  ``"<index in its *Ports array>-<PortName><childPortName>..."`` (names
  concatenated WITHOUT a separator) -> ``{className, reference: <Wiki uuid>, ...}``.

**Which field is the member's loadout.** In the real export the ``*Ports``
``Loadout`` fields are all stock while the ``selected*`` maps carry the
member's actual choices -- and spviewer's own ``loadoutPerfs`` agree with the
``selected*`` maps, not with ``Loadout`` (shield pool 20000 / regen 4400 =
2 x 7MA 'Lorica' 10000 / 2200, not 2 x SecureShield 10560 / 1901; pilot alpha
1166 = 950 + 4 x 54 BRVS Repeater, not 950 + 4 x 162 CVSA Cannon). So the
current item of a port is its ``selected*`` entry when there is one, else its
``Loadout`` (older/other exports); with a ``selected*`` entry, ``Loadout`` is
treated as another spelling of stock.

**Diff rule.** A port is changed when its current item is not stock --
compared by class name AND uuid against both spviewer's stock
(``BaseLoadout.ClassName``, plus ``Loadout`` as above) and the Wiki's stock
item, resolving a uuid/class name through the Wiki catalog when the strings
alone cannot tell (a uuid ``Loadout`` naming the stock item is NOT a change).
A changed port that is a tracked hangar slot becomes a ``fitted`` override if
the Wiki knows the item and ``check_compatible`` accepts it; anything else is
reported in ``skipped`` with a reason code (``SKIP_REASONS``) -- never dropped
silently. Unchanged ports produce nothing (stock). One deliberate exception: an
UNTRACKED port whose current item is only a bare uuid (no ``selected*`` entry)
is not resolved, since it cannot affect the import and would cost a Wiki
lookup per gimbal/rack/turret port.
"""
import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from .catalog import Slot
from .loadout import check_compatible
from .lzstring import LZStringError, decompress_from_encoded_uri_component

log = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 2 * 1024 * 1024           # the exported file (spec cap)
MAX_ROW_DECODED_CHARS = 2 * 1024 * 1024      # decompressed loadoutData per row (spec cap)
MAX_REQUEST_DECODED_CHARS = 16 * 1024 * 1024  # all rows of one request together
MAX_ROWS = 100

# Skip reason codes (stable; the SPA labels them).
UNTRACKED_SLOT = "untracked_slot"            # changed port the hangar does not track
UNKNOWN_ITEM = "unknown_item"                # the Wiki has no such item
INCOMPATIBLE = "incompatible"                # check_compatible refused it
UNKNOWN_VEHICLE = "unknown_vehicle"          # vehicleClassName not in the Wiki catalog
UNRECOGNIZED_FORMAT = "unrecognized_format"  # row/loadoutData missing, undecodable or unexpected shape
TOO_LARGE = "too_large"                      # decoded data over the per-row / per-request cap
EMPTY_SLOT = "empty_slot"                    # tracked slot emptied in spviewer (hangar cannot store "empty")
SKIP_REASONS = (UNTRACKED_SLOT, UNKNOWN_ITEM, INCOMPATIBLE, UNKNOWN_VEHICLE, UNRECOGNIZED_FORMAT,
                TOO_LARGE, EMPTY_SLOT)

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_SELECTED_KEY_RE = re.compile(r"^([0-9]+)-(.+)$", re.S)
_MAX_DEPTH = 8
_MAX_REF_LEN = 200


class FormatError(ValueError):
    """``loadoutData`` cannot be decoded into the expected shape."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


class DecodeBudget:
    """Decompressed characters still allowed for this request."""

    def __init__(self, total: int = MAX_REQUEST_DECODED_CHARS) -> None:
        self.remaining = total


def decode_loadout(data: Any, *, budget: DecodeBudget | None = None,
                   max_chars: int = MAX_ROW_DECODED_CHARS) -> dict:
    """LZ-string -> JSON object with at least one ``*Ports`` array, else ``FormatError``."""
    if not isinstance(data, str) or not data:
        raise FormatError(UNRECOGNIZED_FORMAT, "loadoutData is missing or not a string")
    limit = max_chars if budget is None else min(max_chars, budget.remaining)
    try:
        text = decompress_from_encoded_uri_component(data, max_chars=limit)
    except LZStringError as e:
        if "exceeds" in str(e):
            which = ("this request's total decoded-data budget" if budget is not None and limit < max_chars
                     else f"the {max_chars}-character per-loadout limit")
            raise FormatError(TOO_LARGE, f"decoded loadoutData exceeds {which}") from None
        raise FormatError(UNRECOGNIZED_FORMAT, f"loadoutData is not LZ-string data: {e}") from None
    if budget is not None:
        budget.remaining -= len(text)
    try:
        obj = json.loads(text)
    except ValueError as e:
        raise FormatError(UNRECOGNIZED_FORMAT, f"decoded loadoutData is not JSON: {e}") from None
    if not isinstance(obj, dict) or not any(k.endswith("Ports") and isinstance(v, list) for k, v in obj.items()):
        raise FormatError(UNRECOGNIZED_FORMAT, "decoded loadoutData has no *Ports arrays")
    return obj


def _ref(v: Any) -> str | None:
    if isinstance(v, str) and v.strip() and len(v) <= _MAX_REF_LEN:
        return v.strip()
    return None


def _fold(*vals: Any) -> set[str]:
    return {v.casefold() for v in vals if isinstance(v, str) and v}


@dataclass
class Port:
    slot: str                       # "/"-joined PortName path
    category: str                   # the *Ports key it came from
    current_ref: str | None         # Wiki uuid (selected.reference / uuid Loadout)
    current_class: str | None       # game class name
    stock_refs: set[str] = field(default_factory=set)   # casefolded spellings of spviewer's stock
    stock_name: str | None = None

    @property
    def current_label(self) -> str:
        return self.current_class or self.current_ref or "nothing"

    @property
    def is_empty(self) -> bool:
        return not (self.current_ref or self.current_class)


def _selected_index(loadout: dict) -> dict[str, list[tuple[int, dict]]]:
    out: dict[str, list[tuple[int, dict]]] = {}
    for k, v in loadout.items():
        if not (isinstance(k, str) and k.startswith("selected") and isinstance(v, dict)):
            continue
        for key, entry in v.items():
            m = _SELECTED_KEY_RE.match(key) if isinstance(key, str) else None
            if m and isinstance(entry, dict):
                out.setdefault(m.group(2), []).append((int(m.group(1)), entry))
    return out


def _pick_selected(entries: list[tuple[int, dict]] | None, top_index: int) -> dict | None:
    if not entries:
        return None
    exact = [e for i, e in entries if i == top_index]
    if exact:
        return exact[0]
    return entries[0][1] if len(entries) == 1 else None


def walk_ports(loadout: dict) -> list[Port]:
    """Every port of every ``*Ports`` array, depth-first, with its current
    item and spviewer's stock spellings."""
    selected = _selected_index(loadout)
    ports: list[Port] = []

    def visit(p: Any, names: list[str], top_index: int, category: str, depth: int) -> None:
        if not isinstance(p, dict) or depth > _MAX_DEPTH:
            return
        name = p.get("PortName")
        if not isinstance(name, str) or not name:
            return
        names = names + [name]
        base = p.get("BaseLoadout") if isinstance(p.get("BaseLoadout"), dict) else {}
        loadout_ref = _ref(p.get("Loadout"))
        sel = _pick_selected(selected.get("".join(names)), top_index)
        stock_refs = _fold(_ref(base.get("ClassName")))
        if sel is not None:
            cur_ref, cur_class = _ref(sel.get("reference")), _ref(sel.get("className"))
            if loadout_ref:                 # with a selected entry, Loadout spells stock
                stock_refs |= _fold(loadout_ref)
        elif loadout_ref and _UUID_RE.match(loadout_ref):
            cur_ref, cur_class = loadout_ref, None
        else:
            cur_ref, cur_class = None, loadout_ref
        ports.append(Port(slot="/".join(names), category=category, current_ref=cur_ref,
                          current_class=cur_class, stock_refs=stock_refs,
                          stock_name=_ref(base.get("Name"))))
        children = p.get("Ports")
        for child in children if isinstance(children, list) else []:
            visit(child, names, top_index, category, depth + 1)

    for key, arr in loadout.items():
        if isinstance(key, str) and key.endswith("Ports") and isinstance(arr, list):
            for i, p in enumerate(arr):
                visit(p, [], i, key, 0)
    return ports


@dataclass
class RowResult:
    row_index: int
    loadout_name: str | None
    patch: str | None
    vehicle: dict | None = None            # catalog summary (uuid, name, className, ...)
    changes: list[dict] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    fitted: dict[str, dict] = field(default_factory=dict)   # slot -> {itemUuid, itemName}
    error: str | None = None               # row-level failure code (no vehicle / undecodable)
    error_message: str | None = None

    def to_preview(self) -> dict:
        return {"rowIndex": self.row_index, "loadoutName": self.loadout_name,
                "vehicle": ({"uuid": self.vehicle["uuid"], "name": self.vehicle["name"]}
                            if self.vehicle else None),
                "patch": self.patch, "changes": self.changes, "skipped": self.skipped}

    def fail(self, reason: str, detail: str) -> "RowResult":
        self.skipped.append({"reason": reason, "detail": detail})
        self.error, self.error_message = reason, detail
        return self


def _text(v: Any, limit: int = 200) -> str | None:
    if isinstance(v, (str, int, float)) and not isinstance(v, bool):
        s = str(v).strip()
        return s[:limit] if s else None
    return None


async def _resolve_item(catalog, port: Port) -> dict | None:
    item = await catalog.item(port.current_ref) if port.current_ref else None
    if item is None and port.current_class:
        item = await catalog.item(port.current_class)
    return item


async def analyze_row(catalog, row_index: int, row: Any, *, budget: DecodeBudget) -> RowResult:
    """Preview one export row. Raises only on upstream (Wiki) failures."""
    if not isinstance(row, dict):
        return RowResult(row_index, None, None).fail(UNRECOGNIZED_FORMAT, "row is not a JSON object")
    res = RowResult(row_index, _text(row.get("loadoutName")), _text(row.get("patch"), 64))
    class_name = _ref(row.get("vehicleClassName"))
    if class_name is None:
        return res.fail(UNRECOGNIZED_FORMAT, "row has no vehicleClassName")
    vehicle = await catalog.vehicle_by_class_name(class_name)
    slots = await catalog.slots(vehicle["uuid"]) if vehicle else None
    if vehicle is None or slots is None:
        label = _text(row.get("vehicleName")) or class_name
        return res.fail(UNKNOWN_VEHICLE, f"{label} ({class_name}) is not in the Star Citizen Wiki catalog")
    res.vehicle = vehicle
    try:
        loadout = await asyncio.to_thread(decode_loadout, row.get("loadoutData"), budget=budget)
    except FormatError as e:
        return res.fail(e.reason, e.detail)

    by_slot: dict[str, Slot] = {s.name: s for s in slots}
    for port in walk_ports(loadout):
        slot = by_slot.get(port.slot)
        stock = slot.stock_item if slot is not None else None
        stock_refs = port.stock_refs | (_fold(stock.get("uuid"), stock.get("className")) if stock else set())
        current = _fold(port.current_ref, port.current_class)
        if current & stock_refs or (port.is_empty and not port.stock_refs and not stock):
            continue                                   # stock (or empty and empty in stock)
        if port.is_empty:
            if slot is not None:
                res.skipped.append({"slot": port.slot, "reason": EMPTY_SLOT,
                                    "detail": f"{port.slot} is empty in spviewer; the hangar cannot record "
                                              f"an empty slot, so it stays stock"})
            elif port.stock_refs:
                res.skipped.append({"slot": port.slot, "reason": UNTRACKED_SLOT,
                                    "detail": f"{port.slot} is empty in spviewer (the hangar does not "
                                              f"track this slot)"})
            continue
        if slot is None:
            if port.current_class:
                # Untracked and its class name differs from stock: reported
                # without a Wiki lookup -- it never affects the hangar.
                res.skipped.append({"slot": port.slot, "reason": UNTRACKED_SLOT,
                                    "detail": f"{port.current_label} in {port.slot} (the hangar does not "
                                              f"track this slot)"})
            # else: a bare-uuid Loadout (older export shape, no selected* entry)
            # in an untracked port. Telling whether it is stock would cost a Wiki
            # lookup per gimbal/rack/turret port for a slot the import cannot
            # write anyway, so it is not resolved (the selected* shape always
            # carries a class name, so real changes there ARE reported).
            continue
        item = await _resolve_item(catalog, port)
        if item is not None and _fold(item.get("uuid"), item.get("className")) & stock_refs:
            continue                                   # a uuid spelling of the stock item
        if item is None:
            res.skipped.append({"slot": port.slot, "reason": UNKNOWN_ITEM,
                                "detail": f"{port.current_label} is not in the Star Citizen Wiki catalog"})
            continue
        reason = check_compatible(slot, item)
        if reason is not None:
            res.skipped.append({"slot": port.slot, "reason": INCOMPATIBLE, "detail": reason})
            continue
        res.changes.append({"slot": port.slot,
                            "from": {"uuid": stock["uuid"], "name": stock.get("name")} if stock else None,
                            "to": {"uuid": item["uuid"], "name": item.get("name")}})
        res.fitted[port.slot] = {"itemUuid": item["uuid"], "itemName": item.get("name")}
    return res
