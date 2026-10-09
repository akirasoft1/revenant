"""Friendly slot hints for chat edits -> slot ids.

A member says "the left cooler", "shield 2", "nose guns" or "all"; the bot
passes that through as ``slot`` and the server picks among the candidate
slots (for a fit: the ship's slots compatible with the item; for a reset:
the ship's slots). ``match_slots`` returns:

  ("match", [ids])      one slot -- or several when the hint asked for
                        several ("all", "both coolers", "shields")
  ("ambiguous", [ids])  several fit a singular hint -> the caller asks
  ("none", [])          nothing matches

Rules: "all"/"both"/"every"/"everything" alone -> every candidate; an exact
slot id (case-insensitive) -> that slot; otherwise the hint's words are
matched against slot-id tokens (``hardpoint_cooler_left`` -> hardpoint,
cooler, left). Component-type words ("shield", "power plant", "qd", "guns")
filter by slot type, and a plural one (or "both"/"all" in the hint) selects
every slot it leaves. Numbers compare numerically ("1" == "001"), and a word
is first matched only against tokens that distinguish the candidates -- every
Harbinger nose-gun slot ends in ``hardpoint_class_2``, so "2" means
``..._fixed_002`` rather than all four.
"""
import re

_SPLIT = re.compile(r"[^0-9a-z]+")
ALL_WORDS = frozenset({"all", "both", "every", "everything", "each"})
_PLURAL_MARKERS = ALL_WORDS
_FILLER = frozenset({"the", "my", "a", "an", "one", "ones", "slot", "slots", "hardpoint", "hardpoints",
                     "side", "on", "in", "its", "his", "her", "their", "of", "mount", "position"})
_SYNONYMS = {"front": "nose", "top": "upper", "bottom": "lower", "l": "left", "r": "right",
             "port": "left", "starboard": "right", "first": "1", "second": "2", "third": "3",
             "fourth": "4", "fifth": "5", "sixth": "6"}
# (words, slot types, plural?) -- two-word phrases are tried first.
_TYPE_PHRASES: list[tuple[tuple[str, ...], frozenset[str], bool]] = []
for _words, _types in [
    (("power", "plant"), {"PowerPlant"}), (("quantum", "drive"), {"QuantumDrive"}),
    (("missile", "launcher"), {"MissileLauncher"}), (("missile", "rack"), {"MissileLauncher"}),
    (("mining", "laser"), {"WeaponMining"}), (("tractor", "beam"), {"TractorBeam"}),
    (("powerplant",), {"PowerPlant"}), (("qd",), {"QuantumDrive"}), (("quantum",), {"QuantumDrive"}),
    (("shield",), {"Shield"}), (("cooler",), {"Cooler"}), (("radar",), {"Radar"}),
    (("gun",), {"WeaponGun"}), (("weapon",), {"WeaponGun"}), (("turret",), {"Turret"}),
]:
    _TYPE_PHRASES.append((_words, frozenset(_types), False))
    _TYPE_PHRASES.append((_words[:-1] + (_words[-1] + "s",), frozenset(_types), True))
_TYPE_PHRASES.sort(key=lambda p: -len(p[0]))


def _tokens(text: str | None) -> list[str]:
    return [t for t in _SPLIT.split((text or "").casefold()) if t]


def _tok_eq(a: str, b: str) -> bool:
    return a == b or (a.isdigit() and b.isdigit() and int(a) == int(b))


def _take_types(words: list[str]) -> tuple[list[str], frozenset[str] | None, bool]:
    """Strip component-type phrases from ``words``: (rest, types|None, plural)."""
    types: set[str] = set()
    plural = False
    rest: list[str] = []
    i = 0
    while i < len(words):
        for phrase, ptypes, pplural in _TYPE_PHRASES:
            if tuple(words[i:i + len(phrase)]) == phrase:
                types |= ptypes
                plural = plural or pplural
                i += len(phrase)
                break
        else:
            rest.append(words[i])
            i += 1
    return rest, (frozenset(types) if types else None), plural


def match_slots(hint: str, slots: list[tuple[str, str | None]]) -> tuple[str, list[str]]:
    """``slots`` = [(slot id, slot type)] candidates, in display order."""
    names = [s for s, _ in slots]
    h = (hint or "").strip().casefold()
    if not h or not slots:
        return "none", []
    if h in ALL_WORDS:
        return "match", names
    exact = [s for s in names if s.casefold() == h]
    if exact:
        return "match", exact[:1]

    words = [_SYNONYMS.get(t, t) for t in _tokens(h)]
    plural = any(w in _PLURAL_MARKERS for w in words)
    words = [w for w in words if w not in _PLURAL_MARKERS and w not in _FILLER]
    words, types, type_plural = _take_types(words)
    plural = plural or type_plural
    cands = [(s, t) for s, t in slots if types is None or t in types]
    if not cands or (not words and types is None):
        return "none", []

    if words:
        toks = {s: _tokens(s) for s, _ in cands}
        shared = set.intersection(*(set(v) for v in toks.values())) if len(cands) > 1 else set()

        def hits(pool: dict[str, list[str]]) -> list[str]:
            return [s for s, _ in cands if all(any(_tok_eq(w, t) for t in pool[s]) for w in words)]
        found = hits({s: [t for t in v if t not in shared] for s, v in toks.items()}) or hits(toks)
    else:
        found = [s for s, _ in cands]
    if not found:
        return "none", []
    if len(found) == 1 or plural:
        return "match", found
    return "ambiguous", found
