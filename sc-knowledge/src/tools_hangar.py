"""sc_member_hangar / sc_member_fit_check: members' recorded ships and loadouts
(hangar-service) joined with Wiki item stats.

Ship resolution within ONE member's hangar (spec): exact nickname ->
nickname fuzzy -> owned model name/token (with community shorthand like
"Connie" -> Constellation) -> model fuzzy. Several ships at the same tier ->
`ambiguous` with display-label candidates; nothing -> `not_found` with the
member's owned ships listed.

Fit-check slot compatibility uses the hangar API's effective-loadout entries
(`type`, `sizeMin`, `sizeMax`): an item fits a slot when its Wiki type equals
the slot type and its size is within the range. Verdicts compare the item's
per-type key stat -- the same default stat sc_compare_components ranks by.
"""
import asyncio
import logging
import re

from rapidfuzz import fuzz

from .envelope import error
from .hangar import HangarError, HangarUnavailable
from .names import normalise
from .tools_items import COMPONENT_TYPES

logger = logging.getLogger("sc_knowledge.tools_hangar")

SOURCE = "hangar-service (member-recorded loadouts) + star-citizen.wiki"
_MEMBER_ID_RE = re.compile(r"^[0-9]{1,32}$")
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_LEADING_STOPWORDS = {"my", "the", "a", "an", "his", "her", "their", "our", "your"}
_FUZZY_MIN = 85.0
_FUZZY_CLEAR_LEAD = 5.0
# Relative key-stat difference at or under which two different items are a
# sidegrade rather than an up/downgrade.
_SIDEGRADE_PCT = 2.0
# Per current-item stat lookup; the whole tool call must stay inside the
# voice sidecar's 6s bound (hangar fetch is capped at 3s separately).
_LOOKUP_TIMEOUT_S = 2.0

# Community shorthand -> a token of the official model name. Only needed for
# nicknames that are neither a token nor a prefix of the real name ("harb"
# -> Harbinger already works by prefix).
SHIP_SHORTHAND: dict[str, str] = {
    "connie": "constellation", "conny": "constellation", "connies": "constellation",
    "cutty": "cutlass", "gladdy": "gladius", "cat": "caterpillar", "catty": "caterpillar",
    "hammy": "hammerhead", "tali": "retaliator", "prospy": "prospector",
    "lancer": "freelancer", "merchie": "merchantman", "polly": "polaris",
    "msr": "mercury", "starrunner": "mercury"
}


def _tokens(s: str | None) -> list[str]:
    return _TOKEN_RE.findall((s or "").casefold())


def _query_tokens(q: str) -> list[str]:
    # Single letters carry nothing here and break whole-token matching
    # ("Akira's Connie" tokenises to [..., "s", "connie"]).
    toks = [t for t in _tokens(q) if len(t) > 1 or t.isdigit()]
    while len(toks) > 1 and toks[0] in _LEADING_STOPWORDS:
        toks = toks[1:]
    return toks


def _size_label(lo, hi) -> str:
    if lo is None and hi is None:
        return "any size"
    if lo == hi or hi is None:
        return f"S{lo}"
    if lo is None:
        return f"S{hi}"
    return f"S{lo}-{hi}"


def _labels(ships: list[dict]) -> dict[str, str]:
    """shipId -> display label: `"Nickname" (Model)` or the model name;
    unnamed ships of the same model get their shipId appended so every
    candidate the model is shown is distinguishable."""
    base = {}
    for s in ships:
        nick = s.get("nickname")
        base[s["shipId"]] = f"\"{nick}\" ({s.get('vehicleName')})" if nick else (s.get("vehicleName") or s["shipId"])
    counts: dict[str, int] = {}
    for v in base.values():
        counts[v] = counts.get(v, 0) + 1
    return {sid: (f"{v} (ship {sid})" if counts[v] > 1 else v) for sid, v in base.items()}


def _compact_ship(ship: dict, label: str) -> dict:
    out = {"shipId": ship.get("shipId"), "label": label, "vehicle": ship.get("vehicleName"),
           "nickname": ship.get("nickname")}
    loadout = ship.get("loadout")
    if loadout is None:
        out["loadout"] = None
        out["loadout_error"] = ship.get("loadoutError") or "unavailable"
    else:
        out["loadout"] = [{"slot": s.get("slot"), "type": s.get("type"),
                           "size": _size_label(s.get("sizeMin"), s.get("sizeMax")),
                           "item": (s.get("item") or {}).get("name"), "source": s.get("source")}
                          for s in loadout]
    return out


def _best_fuzzy(q: str, scored: list[tuple[float, dict]]) -> list[dict]:
    """Ships at the top fuzzy score (>= _FUZZY_MIN); one when it has a clear
    lead, several (ambiguous) otherwise."""
    scored = sorted((sv for sv in scored if sv[0] >= _FUZZY_MIN), key=lambda sv: -sv[0])
    if not scored:
        return []
    if len(scored) == 1 or scored[0][0] - scored[1][0] >= _FUZZY_CLEAR_LEAD:
        return [scored[0][1]]
    return [s for score, s in scored if scored[0][0] - score < _FUZZY_CLEAR_LEAD]


def _token_hit(q_tok: str, name_tokens: list[str]) -> bool:
    q_tok = SHIP_SHORTHAND.get(q_tok, q_tok)
    return any(t == q_tok or (len(q_tok) >= 3 and t.startswith(q_tok)) for t in name_tokens)


def resolve_ship(query: str, ships: list[dict]) -> tuple[str, list[dict], str | None]:
    """(status, ships, tier): status "match" (one ship), "ambiguous"
    (several) or "not_found"; tier names how it was resolved."""
    toks = _query_tokens(query)
    q = " ".join(toks)
    if not q:
        return "not_found", [], None

    def done(hits: list[dict], tier: str):
        uniq = list({s["shipId"]: s for s in hits}.values())
        return ("match" if len(uniq) == 1 else "ambiguous"), uniq, tier

    named = [s for s in ships if s.get("nickname")]
    exact = [s for s in named if " ".join(_tokens(s["nickname"])) == q]
    if exact:
        return done(exact, "nickname")
    nick_fuzzy = _best_fuzzy(q, [(max(fuzz.ratio(q, " ".join(_tokens(s["nickname"]))),
                                      100.0 if all(t in _tokens(s["nickname"]) for t in toks) else 0.0), s)
                                 for s in named])
    if nick_fuzzy:
        return done(nick_fuzzy, "nickname_fuzzy")
    model_exact = [s for s in ships if " ".join(_tokens(s.get("vehicleName"))) == q]
    if model_exact:
        return done(model_exact, "model")
    model_tokens = [s for s in ships if all(_token_hit(t, _tokens(s.get("vehicleName"))) for t in toks)]
    if model_tokens:
        return done(model_tokens, "model")
    model_fuzzy = _best_fuzzy(q, [(fuzz.token_set_ratio(q, " ".join(_tokens(s.get("vehicleName")))), s)
                                  for s in ships])
    if model_fuzzy:
        return done(model_fuzzy, "model_fuzzy")
    return "not_found", [], None


def _verdict(item_value, current_value, lower_is_better: bool) -> tuple[str, float | None]:
    if item_value is None or current_value is None:
        return "unknown", None
    if current_value == 0:
        if item_value == 0:
            return "sidegrade", 0.0
        better = (item_value < 0) if lower_is_better else (item_value > 0)
        return ("upgrade" if better else "downgrade"), None
    delta_pct = round((item_value - current_value) / abs(current_value) * 100, 1)
    if abs(delta_pct) <= _SIDEGRADE_PCT:
        return "sidegrade", delta_pct
    better = delta_pct < 0 if lower_is_better else delta_pct > 0
    return ("upgrade" if better else "downgrade"), delta_pct


class HangarTools:
    def __init__(self, client, items) -> None:
        """`client`: HangarClient (or None when HANGAR_API_URL is unset).
        `items`: anything with `async component(name_or_uuid) -> dict`
        (ItemTools in production)."""
        self._client = client
        self._items = items

    async def _hangar(self, member_id: str) -> tuple[dict | None, dict | None]:
        if self._client is None:
            return None, error("unavailable", "the member hangar is not configured on this "
                                              "server (HANGAR_API_URL unset)")
        mid = (member_id or "").strip()
        if not _MEMBER_ID_RE.match(mid):
            return None, error("bad_request",
                               f"member_id must be the numeric Discord ID (e.g. from a "
                               f"'[Name · 123456789]' label or the conversation roster), "
                               f"not {member_id!r}")
        try:
            return await self._client.get_hangar(mid), None
        except HangarUnavailable as e:
            return None, error("unavailable", f"member hangar unavailable: {e}")
        except HangarError as e:
            return None, error(e.code, e.message)

    async def member_hangar(self, member_id: str, ship: str | None = None) -> dict:
        body, err = await self._hangar(member_id)
        if err is not None:
            return err
        ships = body.get("ships") or []
        labels = _labels(ships)
        out = {"source": "hangar-service (member-recorded loadouts)", "member": body.get("member")}
        if not ship or not ship.strip():
            out.update(ships=[_compact_ship(s, labels[s["shipId"]]) for s in ships], count=len(ships))
            if not ships:
                out["note"] = ("This member has no ships recorded in the hangar; they can add "
                               "them with /hangar add.")
            return out
        status, hits, tier = resolve_ship(ship, ships)
        if status == "not_found":
            return error("not_found", f"member {body.get('member')} has no ship matching '{ship}'",
                         owned=[labels[s["shipId"]] for s in ships])
        if status == "ambiguous":
            return error("ambiguous", f"'{ship}' matches several of this member's ships",
                         candidates=[labels[s["shipId"]] for s in hits])
        out.update(ship=_compact_ship(hits[0], labels[hits[0]["shipId"]]), resolved_by=tier)
        return out

    async def _current_profile(self, ref: dict) -> dict | None:
        """Wiki profile of a fitted item: by uuid first (exact), then name."""
        attempts = [x for x in (ref.get("uuid"), ref.get("name")) if x]
        for key in attempts:
            try:
                r = await asyncio.wait_for(self._items.component(key), _LOOKUP_TIMEOUT_S)
            except TimeoutError:
                logger.warning("fit-check: stat lookup for %r timed out after %ss", key, _LOOKUP_TIMEOUT_S)
                return None
            except Exception:
                logger.warning("fit-check: stat lookup for %r failed", key, exc_info=True)
                return None
            if "error" not in r:
                return r
        return None

    async def member_fit_check(self, member_id: str, item: str) -> dict:
        body, err = await self._hangar(member_id)
        if err is not None:
            return err
        target = await self._items.component(item)
        if "error" in target:
            return target
        t = target["item"]
        ttype, tsize = t.get("type"), t.get("size")
        ct = next((c for c in COMPONENT_TYPES.values() if c["wiki_type"] == ttype), None)
        key = ct["default_rank"] if ct else None
        lower = bool(ct and key in ct.get("lower_is_better", ()))
        t_value = (t.get("key_stats") or {}).get(key) if key else None

        ships = body.get("ships") or []
        labels = _labels(ships)
        candidates: list[tuple[dict, list[dict]]] = []
        not_compatible = []
        for s in ships:
            base = {"shipId": s.get("shipId"), "label": labels[s["shipId"]],
                    "vehicle": s.get("vehicleName"), "nickname": s.get("nickname")}
            loadout = s.get("loadout")
            if loadout is None:
                not_compatible.append({**base, "reason": "loadout_unavailable",
                                       "detail": "this ship's slots couldn't be loaded from the catalog"})
                continue
            same_type = [sl for sl in loadout if sl.get("type") == ttype]
            if not same_type:
                not_compatible.append({**base, "reason": "no_slot",
                                       "detail": f"{s.get('vehicleName')} has no {ttype} slot"})
                continue
            fits = [sl for sl in same_type if tsize is None
                    or ((sl.get("sizeMin") is None or tsize >= sl["sizeMin"])
                        and (sl.get("sizeMax") is None or tsize <= sl["sizeMax"]))]
            if not fits:
                sizes = ", ".join(sorted({_size_label(sl.get("sizeMin"), sl.get("sizeMax")) for sl in same_type}))
                not_compatible.append({**base, "reason": "size_mismatch",
                                       "detail": f"{t.get('name')} is size {tsize}, but the "
                                                 f"{s.get('vehicleName')}'s {ttype} slots take {sizes}"})
                continue
            candidates.append((base, fits))

        # One stat lookup per distinct fitted item, concurrently.
        refs: dict[tuple, dict] = {}
        for _, fits in candidates:
            for sl in fits:
                ref = sl.get("item")
                if ref:
                    refs.setdefault((ref.get("uuid"), ref.get("name")), ref)
        profiles = dict(zip(refs, await asyncio.gather(*(self._current_profile(r) for r in refs.values()))))

        out_ships = []
        for base, fits in candidates:
            rows = []
            for sl in fits:
                ref = sl.get("item")
                row = {"slot": sl.get("slot"), "size": _size_label(sl.get("sizeMin"), sl.get("sizeMax")),
                       "item_value": t_value}
                if not ref:
                    row.update(current=None, verdict="upgrade", delta_pct=None,
                               reason="slot is empty -- anything that fits is an upgrade")
                elif (ref.get("uuid") and ref.get("uuid") == target.get("uuid")) or \
                        normalise(ref.get("name") or "") == normalise(t.get("name") or ""):
                    row.update(current={"name": ref.get("name"), "source": sl.get("source"),
                                        "value": t_value},
                               verdict="same", delta_pct=0.0)
                else:
                    prof = profiles.get((ref.get("uuid"), ref.get("name")))
                    c_value = ((prof or {}).get("item", {}).get("key_stats") or {}).get(key) if key else None
                    verdict, delta = _verdict(t_value, c_value, lower)
                    row.update(current={"name": ref.get("name"), "source": sl.get("source"),
                                        "value": c_value},
                               verdict=verdict, delta_pct=delta)
                    if verdict == "unknown":
                        row["reason"] = (f"no comparable {key} figure for one of the items"
                                         if key else f"no key stat is defined for {ttype}")
                if tsize is None:
                    row["size_unverified"] = True
                rows.append(row)
            out_ships.append({**base, "slots": rows})

        out = {"source": SOURCE, "game_version": target.get("game_version"),
               "member": body.get("member"),
               "item": {k: t.get(k) for k in ("name", "type", "size", "grade", "class", "key_stats")},
               "key_stat": key, "order": "asc" if lower else "desc",
               "ships": out_ships, "not_compatible": not_compatible}
        if target.get("stale"):
            out.update(stale=True, age_minutes=target.get("age_minutes"))
        if target.get("note"):
            out["note"] = target["note"]
        if not ships:
            out["note"] = ("This member has no ships recorded in the hangar; they can add them "
                           "with /hangar add.")
        return out
