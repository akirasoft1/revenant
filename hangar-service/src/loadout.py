"""Pure loadout logic: effective loadout, slot compatibility, vehicle resolution."""
import logging
import re
from dataclasses import dataclass, field
from typing import Literal

from rapidfuzz import fuzz

from .catalog import Slot

log = logging.getLogger(__name__)

_FUZZY_MIN = 85.0       # a fuzzy candidate must score at least this
_FUZZY_CLEAR_LEAD = 5.0  # ...and beat the runner-up by this much to be a match


def _descends_from(slot: str, parent: str) -> bool:
    return slot.startswith(parent + "/")


def effective_loadout(slots: list[Slot], fitted: dict | None) -> list[dict]:
    """Stock slots with the ship's ``fitted`` overrides applied.

    ``fitted`` is the Firestore map ``{slotName: {itemUuid, itemName}}`` (only
    changes from stock). Returns one entry per slot, in catalog order::

        {slot, type, sizeMin, sizeMax, item: {uuid, name} | None, source: "stock"|"fitted"}

    A refitted slot's STOCK descendants are dropped (the stock gun belonged to
    the stock gimbal; what the new item carries is unknown); descendants the
    member fitted explicitly are kept. Fitted entries for slots the catalog no
    longer has (e.g. renamed in a patch) are ignored and logged.
    """
    fitted = fitted or {}
    known = {s.name for s in slots}
    orphaned = sorted(k for k in fitted if k not in known)
    if orphaned:
        log.warning("loadout: ignoring fitted entries for slots not in the catalog: %s", orphaned)
    refitted = [s.name for s in slots if s.name in fitted]
    out: list[dict] = []
    for s in slots:
        override = fitted.get(s.name)
        if override is None and any(_descends_from(s.name, p) for p in refitted):
            continue
        if override is not None:
            item = {"uuid": override.get("itemUuid"), "name": override.get("itemName")}
            source = "fitted"
        else:
            item = ({"uuid": s.stock_item["uuid"], "name": s.stock_item["name"]}
                    if s.stock_item else None)
            source = "stock"
        out.append({"slot": s.name, "type": s.type, "sizeMin": s.size_min, "sizeMax": s.size_max,
                    "item": item, "source": source})
    return out


def _size_label(lo: int | None, hi: int | None) -> str:
    if lo is None and hi is None:
        return "any size"
    if lo == hi or hi is None:
        return f"size {lo}"
    if lo is None:
        return f"size {hi}"
    return f"sizes {lo}-{hi}"


def check_compatible(slot: Slot, item: dict) -> str | None:
    """None when ``item`` (a dict with ``type``, ``size``, ``name``) fits
    ``slot`` -- its type is one of the slot's compatible types (falling back to
    the slot's own type when the catalog lists none) and its size is within
    ``[sizeMin, sizeMax]``. Otherwise a human-readable reason."""
    name = item.get("name") or item.get("uuid") or "item"
    allowed = [c["type"] for c in slot.compatible_types] or [slot.type]
    itype = item.get("type")
    if itype not in allowed:
        return (f"{name} is a {itype or 'unknown type'}, but slot {slot.name} accepts "
                f"{', '.join(allowed)}")
    size = item.get("size")
    if not isinstance(size, int) or isinstance(size, bool):
        return f"{name} has no known size, so it cannot be checked against slot {slot.name}"
    lo, hi = slot.size_min, slot.size_max
    if (lo is not None and size < lo) or (hi is not None and size > hi):
        return f"{name} is size {size}, but slot {slot.name} takes {_size_label(lo, hi)}"
    return None


@dataclass
class Resolution:
    status: Literal["match", "ambiguous", "not_found"]
    match: dict | None = None
    candidates: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"status": self.status, "match": self.match, "candidates": self.candidates}


_TOKEN_SPLIT = re.compile(r"[^0-9a-z]+")


def _tokens(text: str | None) -> list[str]:
    return [t for t in _TOKEN_SPLIT.split((text or "").casefold()) if t]


def _dedupe(vs: list[dict]) -> list[dict]:
    seen: set = set()
    out = []
    for v in vs:
        if v.get("uuid") not in seen:
            seen.add(v.get("uuid"))
            out.append(v)
    return out


def _base_edition(vs: list[dict]) -> dict | None:
    """The Wiki lists special editions under the SAME display name as the base
    ship (``Carrack`` = ``anvl-carrack`` and ``anvl-carrack-bis2950``;
    ``Cutlass Black`` = ``drak-cutlass-black`` and ``...-bis2950``). When exactly
    one candidate's slug is a ``-``-delimited prefix of every other candidate's
    slug, that one is the base edition. Otherwise (e.g. the ``PYAM Exec``
    military/stealth pairs) there is no base and the name stays ambiguous."""
    bases = [b for b in vs
             if b.get("slug") and all(o is b or (o.get("slug") or "").startswith(b["slug"] + "-") for o in vs)]
    return bases[0] if len(bases) == 1 else None


def _fuzzy(q: str, v: dict) -> float:
    return max(fuzz.token_sort_ratio(q, (v.get("name") or "").casefold()),
               fuzz.token_sort_ratio(q, (v.get("gameName") or "").casefold()))


def resolve_vehicle(query: str, candidates: list[dict], *, max_candidates: int = 10) -> Resolution:
    """Resolve free text to one vehicle among ``candidates`` (catalog summary
    dicts: uuid, name, gameName, slug, className).

    Tiers, first that yields anything wins:
      1. exact (case-insensitive) uuid / slug / className / name / gameName;
         several exact hits collapse to the base edition when there is one
         (see ``_base_edition``)
      2. whole-token containment: every query token is a token of the name or
         gameName ("harbinger" -> Vanguard Harbinger)
      3. fuzzy (token_sort_ratio >= 85), a match only with a clear lead
    One distinct vehicle -> ``match``; several -> ``ambiguous`` (best first,
    capped at ``max_candidates``); none -> ``not_found``.
    """
    q = (query or "").strip().casefold()
    if not q:
        return Resolution("not_found")

    def finish(hits: list[dict]) -> Resolution:
        hits = _dedupe(hits)
        if len(hits) == 1:
            return Resolution("match", dict(hits[0]))
        hits.sort(key=lambda v: (-_fuzzy(q, v), (v.get("name") or "").casefold()))
        return Resolution("ambiguous", None, [dict(v) for v in hits[:max_candidates]])

    exact = _dedupe([v for v in candidates
                     if q in {(v.get(k) or "").casefold() for k in ("uuid", "slug", "className", "name", "gameName")}])
    if len(exact) > 1:
        base = _base_edition(exact)
        if base is not None:
            return Resolution("match", dict(base))
    if exact:
        return finish(exact)

    q_tokens = _tokens(q)
    token_hits = [v for v in candidates
                  if q_tokens and (all(t in _tokens(v.get("name")) for t in q_tokens)
                                   or all(t in _tokens(v.get("gameName")) for t in q_tokens))]
    if token_hits:
        return finish(token_hits)

    scored = sorted(((s, v) for v in candidates if (s := _fuzzy(q, v)) >= _FUZZY_MIN),
                    key=lambda sv: -sv[0])
    scored_unique: list[tuple[float, dict]] = []
    seen: set = set()
    for s, v in scored:
        if v.get("uuid") not in seen:
            seen.add(v.get("uuid"))
            scored_unique.append((s, v))
    if not scored_unique:
        return Resolution("not_found")
    if len(scored_unique) == 1 or scored_unique[0][0] - scored_unique[1][0] >= _FUZZY_CLEAR_LEAD:
        return Resolution("match", dict(scored_unique[0][1]))
    return Resolution("ambiguous", None, [dict(v) for _, v in scored_unique[:max_candidates]])
