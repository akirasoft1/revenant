"""Spoken / typed item names -> ONE catalog item, for chat edits (text and
voice share it through POST .../fit).

Members say "the hemera quantum drive", "lorica shields", or (voice ASR)
"hemra". Steps, first that settles it wins:

1. exact ``catalog.item(text)`` (Wiki uuid / exact name / class name);
2. normalise -- drop leading "my/the/...", possessive "'s" and component-type
   words ("quantum drive", "qd", "shields"; see ``slot_hint.TYPE_PHRASES``) --
   and retry the exact lookup on what is left ("Hemera");
3. score a candidate pool: ``catalog.items(type)`` for the spoken type(s), or
   else every type the ship's slots accept. Tiers: exact casefold name /
   class name (``matched_by="exact"``) -> every query word is a whole token or
   a >= 3-char prefix of a name token, quotes stripped so "lorica" hits
   "7MA 'Lorica'" -> fuzzy ratio >= 85 against the name or one of its tokens
   with a clear 5-point lead (``ship_resolve``'s thresholds). Several hits at
   a tier are narrowed to the ones that fit one of the ship's slots
   (``check_compatible``: type + size).

One winner -> ``match``; several -> ``ambiguous`` (<= 5 candidates); none ->
``not_found`` with <= 3 ``suggestions`` (closest names, score >= 60).
"""
import asyncio
import re
from dataclasses import dataclass, field

from rapidfuzz import fuzz

from .catalog import SLOT_TYPES, Slot
from .loadout import check_compatible
from .slot_hint import TYPE_PHRASES

_FUZZY_MIN = 85.0
_FUZZY_CLEAR_LEAD = 5.0
_SUGGEST_MIN = 60.0
MAX_CANDIDATES = 5
MAX_SUGGESTIONS = 3
_STOPWORDS = frozenset({"my", "the", "a", "an", "his", "her", "their", "our", "your", "new", "that", "this"})
_QUOTES = re.compile(r"['‘’\"“”`]")
_TOKEN = re.compile(r"[a-z0-9]+")


@dataclass
class ItemResolution:
    status: str                      # "match" | "ambiguous" | "not_found"
    item: dict | None = None
    matched_by: str | None = None    # "exact" | "fuzzy"
    candidates: list[dict] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)


def _norm_tokens(text: str | None) -> list[str]:
    return _TOKEN.findall(_QUOTES.sub("", (text or "").casefold()))


def _strip_word(w: str) -> str:
    w = re.sub(r"^[^\w'’]+|[^\w'’]+$", "", w)
    return re.sub(r"['’]s$", "", w, flags=re.IGNORECASE)


def _residual(text: str) -> tuple[str, frozenset[str] | None]:
    """(text without leading stopwords / possessives / type words, spoken types)."""
    words = [w for w in (_strip_word(x) for x in text.split()) if w]
    keys = ["".join(_norm_tokens(w)) for w in words]
    while len(keys) > 1 and keys[0] in _STOPWORDS:
        words, keys = words[1:], keys[1:]
    kept, types = [], set()
    i = 0
    while i < len(keys):
        for phrase, ptypes, _plural in TYPE_PHRASES:
            if tuple(keys[i:i + len(phrase)]) == phrase:
                types |= ptypes
                i += len(phrase)
                break
        else:
            kept.append(words[i])
            i += 1
    return " ".join(kept), (frozenset(types) if types else None)


def _compact(item: dict) -> dict:
    return {"uuid": item.get("uuid"), "name": item.get("name"), "type": item.get("type"), "size": item.get("size")}


def _fits_any(item: dict, slots: list[Slot]) -> bool:
    return any(check_compatible(s, item) is None for s in slots)


def _narrow(hits: list[dict], slots: list[Slot]) -> list[dict]:
    fitting = [h for h in hits if _fits_any(h, slots)]
    return fitting or hits


def _fuzzy_score(q: str, q_tokens: list[str], item: dict) -> float:
    name_tokens = _norm_tokens(item.get("name"))
    score = fuzz.ratio(q, " ".join(name_tokens))
    if len(q_tokens) == 1:
        score = max([score] + [fuzz.ratio(q, t) for t in name_tokens])
    return score


def _token_hit(q_tok: str, name_tokens: list[str]) -> bool:
    return any(t == q_tok or (len(q_tok) >= 3 and t.startswith(q_tok)) for t in name_tokens)


def _dedupe(items: list[dict]) -> list[dict]:
    return list({i.get("uuid"): i for i in items}.values())


async def resolve_item(catalog, text: str, slots: list[Slot]) -> ItemResolution:
    """``slots``: the ship's visible slots (pool types + size tie-break)."""
    exact = await catalog.item(text)
    if exact is not None:
        return ItemResolution("match", exact, "exact")
    residual, spoken = _residual(text)
    if residual and residual != text.strip():
        exact = await catalog.item(residual)
        if exact is not None:
            return ItemResolution("match", exact, "exact")

    q_tokens = _norm_tokens(residual)
    if not q_tokens:
        return ItemResolution("not_found")
    q = " ".join(q_tokens)
    if spoken:
        types = sorted(spoken & SLOT_TYPES)
    else:
        types = sorted({t for s in slots for t in ([c["type"] for c in s.compatible_types] or [s.type])}
                       & SLOT_TYPES)
    lists = await asyncio.gather(*(catalog.items(t) for t in types))
    pool = _dedupe([i for lst in lists for i in lst if i.get("uuid")])

    def settle(hits: list[dict], by: str) -> ItemResolution:
        hits = _narrow(_dedupe(hits), slots)
        if len(hits) == 1:
            return ItemResolution("match", hits[0], by)
        return ItemResolution("ambiguous", candidates=[_compact(h) for h in hits[:MAX_CANDIDATES]])

    exact_hits = [i for i in pool if q in (" ".join(_norm_tokens(i.get("name"))),
                                           (i.get("className") or "").casefold())]
    if exact_hits:
        return settle(exact_hits, "exact")
    token_hits = [i for i in pool if all(_token_hit(t, _norm_tokens(i.get("name"))) for t in q_tokens)]
    if token_hits:
        return settle(token_hits, "fuzzy")
    scored = sorted(((_fuzzy_score(q, q_tokens, i), i) for i in pool), key=lambda si: -si[0])
    top = [(s, i) for s, i in scored if s >= _FUZZY_MIN]
    if top:
        if len(top) == 1 or top[0][0] - top[1][0] >= _FUZZY_CLEAR_LEAD:
            return ItemResolution("match", top[0][1], "fuzzy")
        return settle([i for s, i in top if top[0][0] - s < _FUZZY_CLEAR_LEAD], "fuzzy")
    names: list[str] = []
    for s, i in scored:
        if s < _SUGGEST_MIN or len(names) >= MAX_SUGGESTIONS:
            break
        if i.get("name") not in names:
            names.append(i.get("name"))
    return ItemResolution("not_found", suggestions=names)
