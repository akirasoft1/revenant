"""Fuzzy name index for terminals, commodities, factions (and anything else)."""
import re
from dataclasses import dataclass, field
from typing import Literal

from rapidfuzz import fuzz, process

_NON_ALNUM = re.compile(r"[^a-z0-9]")


def normalise(s: str) -> str:
    return _NON_ALNUM.sub("", (s or "").lower())


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokens(s: str) -> list[str]:
    return _TOKEN_RE.findall((s or "").lower())


def token_match(field_value: str, query_norm: str) -> bool:
    """True when `query_norm` (a fully-normalised query, e.g. normalise("MIC-L5")
    == "micl5") equals the concatenation of some run of CONSECUTIVE lowercase
    alnum tokens found in field_value.

    This is deliberately NOT raw substring matching: query "l1" (tokens ["l1"])
    matches field "Admin - ARC-L1" (tokens ["admin","arc","l1"], run ["l1"]
    concatenates to "l1") but must NEVER match "Admin - L19 Residences - Metro
    Center - Lorville" (tokens [...,"l19",...]) -- raw `"l1" in "l19"` is True
    and would wrongly merge that unrelated station in.
    """
    if not query_norm or not field_value:
        return False
    toks = tokens(field_value)
    for i in range(len(toks)):
        acc = ""
        for j in range(i, len(toks)):
            acc += toks[j]
            if acc == query_norm:
                return True
            if len(acc) > len(query_norm):
                break
    return False


@dataclass(frozen=True)
class Entry:
    kind: str
    id: int | str
    name: str
    aliases: tuple[str, ...]
    data: dict = field(default_factory=dict, compare=False, hash=False)


@dataclass
class Resolution:
    status: Literal["exact", "fuzzy", "ambiguous", "not_found"]
    match: Entry | None
    candidates: list[Entry]


class NameIndex:
    def __init__(self) -> None:
        self._by_kind: dict[str, list[Entry]] = {}

    def add(self, entry: Entry) -> None:
        self._by_kind.setdefault(entry.kind, []).append(entry)

    def entries(self, kind: str) -> list[Entry]:
        return list(self._by_kind.get(kind, []))

    def resolve(self, query: str, kind: str | None = None) -> Resolution:
        pool = self.entries(kind) if kind else [e for es in self._by_kind.values() for e in es]
        q = normalise(query)
        if not q or not pool:
            return Resolution("not_found", None, [])
        exact = _distinct([e for e in pool if any(normalise(a) == q for a in e.aliases)])
        if len(exact) == 1:
            return Resolution("exact", exact[0], [])
        if len(exact) > 1:
            return Resolution("ambiguous", None, exact[:5])
        if len(q) >= 3:
            sub = _distinct([e for e in pool if any(q in normalise(a) or (normalise(a) and normalise(a) in q and len(normalise(a)) >= 3) for a in e.aliases)])
            if len(sub) == 1:
                return Resolution("fuzzy", sub[0], [])
        choices = [(normalise(a), e) for e in pool for a in e.aliases if a]
        scored = process.extract(q, [c[0] for c in choices], scorer=fuzz.WRatio, limit=50)
        ranked: list[tuple[float, Entry]] = []
        seen: set = set()
        for _, score, i in scored:
            e = choices[i][1]
            key = (e.kind, e.id)
            if key in seen:
                continue
            seen.add(key)
            ranked.append((score, e))
        if not ranked:
            return Resolution("not_found", None, [])
        top_score, top = ranked[0]
        next_score = ranked[1][0] if len(ranked) > 1 else 0
        if top_score >= 88 and top_score - next_score >= 8:
            return Resolution("fuzzy", top, [])
        if top_score >= 60:
            return Resolution("ambiguous", None, [e for _, e in ranked[:5]])
        return Resolution("not_found", None, [e for s, e in ranked[:5] if s >= 40])


def _distinct(entries: list[Entry]) -> list[Entry]:
    seen, out = set(), []
    for e in entries:
        if (e.kind, e.id) not in seen:
            seen.add((e.kind, e.id))
            out.append(e)
    return out


def terminal_entries(terminals: list[dict]) -> list[Entry]:
    out = []
    for t in terminals:
        name = t.get("name") or ""
        aliases = {name, t.get("nickname") or "", t.get("code") or "", t.get("displayname") or "",
                   t.get("fullname") or ""}
        if name.startswith("Admin - "):
            aliases.add(name[len("Admin - "):])
        out.append(Entry("terminal", t["id"], name, tuple(a for a in aliases if a), t))
    return out


def commodity_entries(commodities: list[dict]) -> list[Entry]:
    return [Entry("commodity", c["id"], c.get("name") or "",
                  tuple(a for a in {c.get("name"), c.get("code"), c.get("slug")} if a), c)
            for c in commodities]


def vehicle_entries(vehicles: list[dict]) -> list[Entry]:
    return [Entry("vehicle", v["id"], v.get("name") or "",
                  tuple(a for a in {v.get("name"), v.get("name_full"), v.get("slug")} if a), v)
            for v in vehicles]


def faction_entries(factions: list[dict]) -> list[Entry]:
    return [Entry("faction", f.get("uuid") or f.get("name"), f.get("name") or "",
                  tuple(a for a in {f.get("name")} if a), f)
            for f in factions]
