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
current item of a port is its non-stock ``selected*`` entry when there is one,
else its ``Loadout`` when that is not stock (older/other exports).

Each ``selectedX`` map is paired with its ``xPorts`` array (``_category``);
an entry is used only at its own index, except in a one-port array.

**Diff rule.** A port is changed when its current item is not stock --
compared by class name AND uuid against both spviewer's stock
(``BaseLoadout.ClassName``) and the Wiki's stock item, resolving a uuid/class
name through the Wiki catalog when the strings alone cannot tell (a uuid
``Loadout`` naming the stock item is NOT a change). ``Loadout`` is a stock
spelling only when it matches that stock or is the ``reference`` of a stock
``selected*`` entry; otherwise it is a change (``_current``).

**Abuse bounds.** A duplicate slot path fails the row (``unrecognized_format``),
>500 ports fail it (``too_large``), and a request may make at most
``MAX_ITEM_LOOKUPS`` DISTINCT Wiki item lookups -- only for tracked slots, only
for well-formed keys -- because the Wiki rate limiter is shared with every
hangar read.
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
TOO_MANY_LOOKUPS = "too_many_lookups"        # the request's distinct Wiki item-lookup budget is spent
SKIP_REASONS = (UNTRACKED_SLOT, UNKNOWN_ITEM, INCOMPATIBLE, UNKNOWN_VEHICLE, UNRECOGNIZED_FORMAT,
                TOO_LARGE, EMPTY_SLOT, TOO_MANY_LOOKUPS)

MAX_PORTS_PER_ROW = 500
# Distinct Wiki item lookups per request. The Wiki client shares ONE 60/min
# rate limiter with every hangar read (bot, sc-knowledge, editor), so an upload
# must never be able to queue thousands of lookups behind it.
MAX_ITEM_LOOKUPS = 64

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_SELECTED_KEY_RE = re.compile(r"^([0-9]+)-(.+)$", re.S)
_MAX_DEPTH = 8
_MAX_REF_LEN = 200
_CLASS_NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,100}$")


class FormatError(ValueError):
    """``loadoutData`` cannot be decoded into the expected shape."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


class DecodeBudget:
    """Per-request budgets: decompressed characters still allowed, and the
    DISTINCT Wiki item lookups made so far (a repeat of a key is free)."""

    def __init__(self, total: int = MAX_REQUEST_DECODED_CHARS, max_lookups: int = MAX_ITEM_LOOKUPS) -> None:
        self.remaining = total
        self.max_lookups = max_lookups
        self.looked_up: set[str] = set()

    def admit_lookup(self, key: str) -> bool:
        """True if ``key`` may be looked up (already seen, or budget left)."""
        k = key.casefold()
        if k in self.looked_up:
            return True
        if len(self.looked_up) >= self.max_lookups:
            return False
        self.looked_up.add(k)
        return True


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
    except (ValueError, RecursionError) as e:     # RecursionError: absurdly deep nesting
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
    selected_ref: str | None        # the port's selected* entry: Wiki uuid ...
    selected_class: str | None      # ... and game class name (both None: no entry)
    loadout_ref: str | None         # the port's Loadout (Wiki uuid or class name)
    base_class: str | None          # BaseLoadout.ClassName (spviewer's stock)
    stock_name: str | None = None

    @property
    def has_selected(self) -> bool:
        return bool(self.selected_ref or self.selected_class)


def _category(key: str, prefix: str = "", suffix: str = "") -> str:
    """``pilotWeaponsPorts`` / ``selectedPilotWeapons`` -> ``pilotweapon``;
    ``missilesRackPorts`` / ``selectedMissilesRacks`` -> ``missilesrack``."""
    core = key[len(prefix):len(key) - len(suffix)] if suffix else key[len(prefix):]
    core = core.casefold()
    return core[:-1] if core.endswith("s") else core


def _selected_maps(loadout: dict) -> dict[str, dict]:
    """``selectedX`` maps by normalised category (paired with ``xPorts``)."""
    out: dict[str, dict] = {}
    for k, v in loadout.items():
        if isinstance(k, str) and k.startswith("selected") and len(k) > len("selected") and isinstance(v, dict):
            out[_category(k, prefix="selected")] = v
    return out


def _pick_selected(sel_map: dict | None, top_index: int, concat: str, single_port: bool) -> dict | None:
    """The entry keyed ``"<top_index>-<concat>"`` in this category's map. Only
    when the category's ``*Ports`` array has exactly one port is an entry with
    another index accepted (a mismatched index is otherwise ambiguous)."""
    if not sel_map:
        return None
    entry = sel_map.get(f"{top_index}-{concat}")
    if isinstance(entry, dict):
        return entry
    if single_port:
        hits = [e for k, e in sel_map.items() if isinstance(k, str) and isinstance(e, dict)
                and (m := _SELECTED_KEY_RE.match(k)) and m.group(2) == concat]
        if len(hits) == 1:
            return hits[0]
    return None


def walk_ports(loadout: dict, *, max_ports: int = MAX_PORTS_PER_ROW) -> list[Port]:
    """Every port of every ``*Ports`` array, depth-first. Raises ``FormatError``
    on a duplicate slot path (``unrecognized_format``) or more than
    ``max_ports`` ports (``too_large``)."""
    selected = _selected_maps(loadout)
    ports: list[Port] = []
    seen: set[str] = set()

    def visit(p: Any, names: list[str], top_index: int, category: str, sel_map, single: bool,
              depth: int) -> None:
        if not isinstance(p, dict) or depth > _MAX_DEPTH:
            return
        name = p.get("PortName")
        if not isinstance(name, str) or not name:
            return
        names = names + [name]
        slot = "/".join(names)
        if slot in seen:
            raise FormatError(UNRECOGNIZED_FORMAT, f"port {slot!r} appears more than once")
        seen.add(slot)
        if len(ports) >= max_ports:
            raise FormatError(TOO_LARGE, f"the loadout has more than {max_ports} ports")
        base = p.get("BaseLoadout") if isinstance(p.get("BaseLoadout"), dict) else {}
        sel = _pick_selected(sel_map, top_index, "".join(names), single) or {}
        ports.append(Port(slot=slot, category=category, selected_ref=_ref(sel.get("reference")),
                          selected_class=_ref(sel.get("className")), loadout_ref=_ref(p.get("Loadout")),
                          base_class=_ref(base.get("ClassName")), stock_name=_ref(base.get("Name"))))
        children = p.get("Ports")
        for child in children if isinstance(children, list) else []:
            visit(child, names, top_index, category, sel_map, single, depth + 1)

    for key, arr in loadout.items():
        if isinstance(key, str) and key.endswith("Ports") and isinstance(arr, list):
            sel_map = selected.get(_category(key, suffix="Ports"))
            for i, p in enumerate(arr):
                visit(p, [], i, key, sel_map, len(arr) == 1, 0)
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


class _LookupBudgetSpent(Exception):
    pass


def _lookup_key_ok(ref: str | None) -> bool:
    return bool(ref) and bool(_UUID_RE.match(ref) or _CLASS_NAME_RE.match(ref))


async def _resolve_item(catalog, ref: str | None, class_name: str | None, budget: DecodeBudget) -> dict | None:
    """Wiki item for a uuid and/or class name. Only well-formed keys (a uuid or
    ``[A-Za-z0-9_]{1,100}``) are ever sent to the Wiki, and each DISTINCT key
    spends the request's lookup budget (``_LookupBudgetSpent`` when empty)."""
    for key in (ref, class_name):
        if not _lookup_key_ok(key):
            continue
        if not budget.admit_lookup(key):
            raise _LookupBudgetSpent()
        item = await catalog.item(key)
        if item is not None:
            return item
    return None


def _current(port: Port, stock_refs: set[str]) -> tuple[str | None, str | None] | None:
    """The port's current item as (uuid?, class?) when it is NOT stock, ``()``
    -- falsy -- when it is stock, or None when the port is empty while stock is not.

    ``Loadout`` counts as stock only when it equals spviewer's or the Wiki's
    stock (by uuid or class), or is the ``reference`` of a selected entry
    whose class IS stock (spviewer spelling the same item two ways). A
    ``Loadout`` that differs from stock is a change even next to a selected
    entry; a non-stock selected entry wins over it."""
    sel = _fold(port.selected_ref, port.selected_class)
    sel_is_stock = bool(sel & stock_refs)
    lo = port.loadout_ref
    lo_is_stock = (not lo or bool(_fold(lo) & stock_refs)
                   or (sel_is_stock and port.selected_ref is not None and lo.casefold() == port.selected_ref.casefold()))
    if port.has_selected and not sel_is_stock:
        return (port.selected_ref, port.selected_class)
    if not lo_is_stock:
        return (lo, None) if _UUID_RE.match(lo) else (None, lo)
    if not port.has_selected and not lo and stock_refs:
        return None                                    # emptied in spviewer
    return ()


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
        ports = walk_ports(loadout)
    except FormatError as e:
        return res.fail(e.reason, e.detail)

    by_slot: dict[str, Slot] = {s.name: s for s in slots}
    for port in ports:
        slot = by_slot.get(port.slot)
        stock = slot.stock_item if slot is not None else None
        stock_refs = _fold(port.base_class) | (_fold(stock.get("uuid"), stock.get("className")) if stock else set())
        current = _current(port, stock_refs)
        if current == ():
            continue                                   # stock (or empty and empty in stock)
        if current is None:
            if slot is not None:
                res.skipped.append({"slot": port.slot, "reason": EMPTY_SLOT,
                                    "detail": f"{port.slot} is empty in spviewer; the hangar cannot record "
                                              f"an empty slot, so it stays stock"})
            else:
                res.skipped.append({"slot": port.slot, "reason": UNTRACKED_SLOT,
                                    "detail": f"{port.slot} is empty in spviewer (the hangar does not "
                                              f"track this slot)"})
            continue
        cur_ref, cur_class = current
        label = cur_class or cur_ref
        if slot is None:
            if cur_class:
                # Untracked and its class name differs from stock: reported
                # without a Wiki lookup -- it never affects the hangar.
                res.skipped.append({"slot": port.slot, "reason": UNTRACKED_SLOT,
                                    "detail": f"{label} in {port.slot} (the hangar does not track this slot)"})
            # else: a bare uuid in an untracked port. Telling whether it is
            # stock would cost a Wiki lookup per gimbal/rack/turret port for a
            # slot the import cannot write anyway, so it is not resolved (the
            # selected* shape always carries a class name, so real changes
            # there ARE reported).
            continue
        try:
            item = await _resolve_item(catalog, cur_ref, cur_class, budget)
        except _LookupBudgetSpent:
            res.skipped.append({"slot": port.slot, "reason": TOO_MANY_LOOKUPS,
                                "detail": f"{label} was not looked up: this import already looked up "
                                          f"{budget.max_lookups} different items (import fewer loadouts "
                                          f"at once)"})
            continue
        if item is not None and _fold(item.get("uuid"), item.get("className")) & stock_refs:
            continue                                   # a uuid spelling of the stock item
        if item is None:
            res.skipped.append({"slot": port.slot, "reason": UNKNOWN_ITEM,
                                "detail": f"{label} is not in the Star Citizen Wiki catalog"})
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
