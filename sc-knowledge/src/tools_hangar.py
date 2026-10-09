"""sc_member_hangar / sc_member_fit_check: members' recorded ships and loadouts
(hangar-service) joined with Wiki item stats.

Ship resolution within ONE member's hangar (spec): exact nickname ->
nickname fuzzy -> owned model name/token (with community shorthand like
"Connie" -> Constellation) -> model fuzzy. Several ships at the same tier ->
`ambiguous` with display-label candidates; nothing -> `not_found` with the
member's owned ships listed.

KEEP IN SYNC with hangar-service/src/ship_resolve.py: ``resolve_ship``,
``_labels`` (``ship_labels`` there), ``_tokens``, ``_query_tokens``,
``_best_fuzzy``, ``_token_hit``, ``SHIP_SHORTHAND``, ``_LEADING_STOPWORDS``
and the fuzzy thresholds are duplicated there for chat edits (POST .../fit,
.../reset), so a ship read here as "my Connie" is the ship written there.
hangar-service's tests/test_ship_resolve.py fails if the two copies drift.

Fit-check slot compatibility is the SAME rule as hangar-service's
`check_compatible`, applied to the effective-loadout entries (`type`,
`sizeMin`, `sizeMax`, `compatibleTypes`): the item's type must be one of the
slot's compatible types (falling back to the slot's own type), a listed
sub-type is enforced only when the item states a real one (not empty /
"UNDEFINED"), and the size must be within the range. Verdicts compare the
item's per-type key stat -- the same default stat sc_compare_components
ranks by.

Time budget: the voice sidecar bounds a whole tool call at 6s, including
opening the MCP session. So the hangar fetch and the item lookup run
concurrently, the item lookup is capped, every tool call has an overall
deadline, and the current-item stat lookups only get what is left of it
(running out yields verdict `unknown`, never a cancelled call).
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
# Overall per-tool-call deadline, target-item lookup cap, and per-attempt
# cap on a current-item stat lookup (which also never exceeds what is left
# of the deadline). The hangar client caps its own fetch at 3s.
_TOOL_DEADLINE_S = 5.0
_ITEM_TIMEOUT_S = 3.0
_LOOKUP_TIMEOUT_S = 2.0

# Component types hangar-service tracks as slots (its catalog SLOT_TYPES).
# KEEP IN SYNC with SLOT_TYPES in hangar-service/src/catalog.py: if they drift,
# fit-check silently reports not_tracked/no_slot for types the hangar does hold.
# Missiles (ordnance on racks) are not tracked -- a known limitation.
TRACKED_TYPES = frozenset({"QuantumDrive", "Shield", "PowerPlant", "Cooler", "Radar", "WeaponGun",
                           "Turret", "MissileLauncher", "WeaponMining", "TractorBeam"})

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


def _real_sub_type(sub) -> str | None:
    return sub if sub and str(sub).upper() != "UNDEFINED" else None


def slot_mismatch(slot: dict, itype: str | None, isub: str | None, isize) -> str | None:
    """None when the item fits `slot` (hangar-service check_compatible rule),
    else which test failed: "type", "sub_type" or "size"."""
    compat = slot.get("compatibleTypes") or []
    allowed = [c.get("type") for c in compat] or [slot.get("type")]
    if itype not in allowed:
        return "type"
    entries = [c for c in compat if c.get("type") == itype]
    listed = [c.get("subTypes") or [] for c in entries]
    isub = _real_sub_type(isub)
    if isub and entries and all(listed) and not any(isub in subs for subs in listed):
        return "sub_type"
    if isize is None:
        return None  # unknown item size: reported with size_unverified
    lo, hi = slot.get("sizeMin"), slot.get("sizeMax")
    if (lo is not None and isize < lo) or (hi is not None and isize > hi):
        return "size"
    return None


def _same_item(ref: dict, target_uuid: str | None, target_name: str | None) -> bool:
    # Distinct items can share a display name (two different "CF-227 Badger
    # Repeater"s), so when both uuids are known only the uuid decides.
    if ref.get("uuid") and target_uuid:
        return ref["uuid"] == target_uuid
    return normalise(ref.get("name") or "") == normalise(target_name or "")


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
    def __init__(self, client, items, *, deadline_s: float = _TOOL_DEADLINE_S,
                 item_timeout_s: float = _ITEM_TIMEOUT_S,
                 lookup_timeout_s: float = _LOOKUP_TIMEOUT_S) -> None:
        """`client`: HangarClient (or None when HANGAR_API_URL is unset).
        `items`: anything with `async component(name_or_uuid) -> dict`
        (ItemTools in production)."""
        self._client = client
        self._items = items
        self._deadline_s = deadline_s
        self._item_timeout_s = item_timeout_s
        self._lookup_timeout_s = lookup_timeout_s

    async def _hangar(self, member_id: str) -> tuple[dict | None, dict | None]:
        if self._client is None:
            return None, error("unavailable", "the member hangar is not configured on this "
                                              "server (HANGAR_API_URL unset)")
        mid = (member_id or "").strip()
        if not _MEMBER_ID_RE.match(mid):
            # invalid_request: the same code hangar-service uses for a bad member id.
            return None, error("invalid_request",
                               f"member_id must be the numeric Discord ID (e.g. from a "
                               f"'[Name · 123456789]' label or the conversation roster), "
                               f"not {member_id!r}")
        try:
            # The client bounds itself at 3s; this is the belt to that brace.
            return await asyncio.wait_for(self._client.get_hangar(mid), self._deadline_s), None
        except TimeoutError:
            return None, error("unavailable", f"member hangar unavailable: timed out after "
                                              f"{self._deadline_s}s")
        except HangarUnavailable as e:
            return None, error("unavailable", f"member hangar unavailable: {e}")
        except HangarError as e:
            return None, error(e.code, e.message)

    async def _target(self, item: str) -> dict:
        try:
            return await asyncio.wait_for(self._items.component(item), self._item_timeout_s)
        except TimeoutError:
            logger.warning("fit-check: item lookup for %r timed out after %ss", item, self._item_timeout_s)
            return error("wiki_unavailable", f"item lookup for '{item}' timed out after "
                                             f"{self._item_timeout_s}s")

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
        for key in [x for x in (ref.get("uuid"), ref.get("name")) if x]:
            try:
                r = await asyncio.wait_for(self._items.component(key), self._lookup_timeout_s)
            except TimeoutError:
                logger.warning("fit-check: stat lookup for %r timed out after %ss", key, self._lookup_timeout_s)
                return None
            except Exception:
                logger.warning("fit-check: stat lookup for %r failed", key, exc_info=True)
                return None
            if "error" not in r:
                return r
        return None

    async def _profiles(self, refs: dict[tuple, dict], budget_s: float) -> tuple[dict, set]:
        """Concurrent current-item lookups within `budget_s`. Returns
        (profiles by ref key, keys whose lookup ran out of time)."""
        if not refs:
            return {}, set()
        tasks = {key: asyncio.ensure_future(self._current_profile(ref)) for key, ref in refs.items()}
        done, pending = await asyncio.wait(tasks.values(), timeout=max(0.0, budget_s))
        for t in pending:
            t.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
            logger.warning("fit-check: %d stat lookup(s) ran out of the %ss tool budget",
                           len(pending), self._deadline_s)
        profiles, timed_out = {}, set()
        for key, t in tasks.items():
            if t in done and not t.cancelled() and t.exception() is None:
                profiles[key] = t.result()
            elif t in pending:
                timed_out.add(key)
        return profiles, timed_out

    async def member_fit_check(self, member_id: str, item: str) -> dict:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._deadline_s
        (body, err), target = await asyncio.gather(self._hangar(member_id), self._target(item))
        if err is not None:
            return err
        if "error" in target:
            return target
        t = target["item"]
        ttype, tsub, tsize = t.get("type"), t.get("sub_type"), t.get("size")
        if ttype not in TRACKED_TYPES:
            if ttype == "Missile":
                return error("not_tracked", "missiles and missile racks aren't tracked in the member "
                                            "hangar, so it can't say which ships carry or can use them")
            return error("not_tracked", f"{t.get('name')} is a {ttype or 'item of unknown type'}, which "
                                        f"isn't a ship component the member hangar tracks "
                                        f"({', '.join(sorted(TRACKED_TYPES))})")
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
            checks = [(sl, slot_mismatch(sl, ttype, tsub, tsize)) for sl in loadout]
            fits = [sl for sl, why in checks if why is None]
            if not fits:
                size_miss = [sl for sl, why in checks if why == "size"]
                sub_miss = [sl for sl, why in checks if why == "sub_type"]
                if size_miss:
                    sizes = ", ".join(sorted({_size_label(sl.get("sizeMin"), sl.get("sizeMax")) for sl in size_miss}))
                    not_compatible.append({**base, "reason": "size_mismatch",
                                           "detail": f"{t.get('name')} is size {tsize}, but the "
                                                     f"{s.get('vehicleName')}'s {ttype} slots take {sizes}"})
                elif sub_miss:
                    subs = sorted({x for sl in sub_miss for c in (sl.get("compatibleTypes") or [])
                                   if c.get("type") == ttype for x in (c.get("subTypes") or [])})
                    not_compatible.append({**base, "reason": "no_slot",
                                           "detail": f"{s.get('vehicleName')}'s {ttype} slots take "
                                                     f"{', '.join(subs)}, not {tsub}"})
                else:
                    not_compatible.append({**base, "reason": "no_slot",
                                           "detail": f"{s.get('vehicleName')} has no {ttype} slot"})
                continue
            # A mount slot of another type that also accepts the item (a gimbal
            # Turret hardpoint accepting WeaponGun) is only offered when it has
            # no fitting child visible -- the child is where the item goes.
            names = [sl.get("slot") or "" for sl in fits]
            fits = [sl for sl in fits if sl.get("type") == ttype
                    or not any(n.startswith((sl.get("slot") or "") + "/") for n in names)]
            candidates.append((base, fits))

        refs: dict[tuple, dict] = {}
        for _, fits in candidates:
            for sl in fits:
                ref = sl.get("item")
                if ref and not _same_item(ref, target.get("uuid"), t.get("name")):
                    refs.setdefault((ref.get("uuid"), ref.get("name")), ref)
        profiles, timed_out = await self._profiles(refs, deadline - loop.time())

        out_ships = []
        for base, fits in candidates:
            rows = []
            for sl in fits:
                ref = sl.get("item")
                cross_type = sl.get("type") != ttype
                row = {"slot": sl.get("slot"), "size": _size_label(sl.get("sizeMin"), sl.get("sizeMax")),
                       "item_value": t_value}
                if not ref:
                    row.update(current=None, verdict="upgrade", delta_pct=None,
                               reason="slot is empty -- anything that fits is an upgrade")
                elif _same_item(ref, target.get("uuid"), t.get("name")):
                    row.update(current={"name": ref.get("name"), "source": sl.get("source"),
                                        "value": t_value},
                               verdict="same", delta_pct=0.0)
                else:
                    rkey = (ref.get("uuid"), ref.get("name"))
                    prof = profiles.get(rkey)
                    p_item = (prof or {}).get("item") or {}
                    if cross_type and prof is not None and p_item.get("type") != ttype:
                        continue  # the mount holds a gimbal/turret, not an item of this type
                    c_value = (p_item.get("key_stats") or {}).get(key) if key else None
                    verdict, delta = _verdict(t_value, c_value, lower)
                    row.update(current={"name": ref.get("name"), "source": sl.get("source"),
                                        "value": c_value},
                               verdict=verdict, delta_pct=delta)
                    if verdict == "unknown":
                        if rkey in timed_out:
                            row["reason"] = "ran out of time looking up the fitted item's stats"
                        elif not key:
                            row["reason"] = f"no key stat is defined for {ttype}"
                        else:
                            row["reason"] = f"no comparable {key} figure for one of the items"
                if tsize is None:
                    row["size_unverified"] = True
                rows.append(row)
            if rows:
                out_ships.append({**base, "slots": rows})
            else:
                not_compatible.append({**base, "reason": "no_slot",
                                       "detail": f"its only mounts that accept a {ttype} currently hold "
                                                 f"a gimbal/turret, not a {ttype}"})

        out = {"source": SOURCE, "game_version": target.get("game_version"),
               "member": body.get("member"),
               "item": {k: t.get(k) for k in ("name", "type", "sub_type", "size", "grade", "class", "key_stats")},
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
