"""faction_missions: rank ladder + missions ranked by reputation per minute."""
from .cache import TTLCache
from .envelope import error, freshness
from .http import UpstreamError
from .names import NameIndex, faction_entries, normalise
from .wiki import WikiClient

_TTL = 43200
SOURCE = "star-citizen.wiki"
_NOTE = "rep_per_minute = reputation_gained / time_to_complete_minutes (game-data estimate; real time varies)"


def _rep(m: dict):
    for k in ("reputation_gained", "reputation_amount"):
        v = m.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return v
    return None


class MissionTools:
    def __init__(self, wiki: WikiClient, cache: TTLCache) -> None:
        self._wiki = wiki
        self._cache = cache

    async def _resolve_faction(self, faction: str):
        res = await self._cache.get_or_fetch("wiki:factions", _TTL, self._wiki.factions)
        idx = NameIndex()
        for e in faction_entries(res.value):
            idx.add(e)
        return idx.resolve(faction, kind="faction")

    async def faction_missions(self, faction: str, current_rank: str | None = None,
                               system: str | None = None, limit: int = 10) -> dict:
        try:
            r = await self._resolve_faction(faction)
            if r.match is None:
                return error(r.status, f"faction '{faction}' not resolved",
                             candidates=[c.name for c in r.candidates])
            name = r.match.name
            mres = await self._cache.get_or_fetch(f"wiki:missions:{normalise(name)}", _TTL,
                                                  lambda: self._wiki.missions(name))
        except UpstreamError as e:
            return error("wiki_unavailable", str(e))
        missions = [m for m in mres.value if not m.get("not_for_release") and not m.get("work_in_progress")]
        ladder_pairs = {((m.get("min_standing") or {}).get("name"), (m.get("min_standing") or {}).get("min_reputation"))
                        for m in missions}
        ladder = sorted(({"name": n, "min_reputation": int(v)} for n, v in ladder_pairs if n and v is not None),
                        key=lambda x: x["min_reputation"])
        rank_rep, rank_name = None, None
        if current_rank:
            li = NameIndex()
            from .names import Entry
            for step in ladder:
                li.add(Entry("rank", step["name"], step["name"], (step["name"],), step))
            rr = li.resolve(current_rank, kind="rank")
            if rr.match is None:
                return error("not_found", f"rank '{current_rank}' not in ladder",
                             candidates=[s["name"] for s in ladder])
            rank_rep, rank_name = rr.match.data["min_reputation"], rr.match.name
        best: dict[str, dict] = {}
        skipped = 0
        for m in missions:
            rep, mins = _rep(m), m.get("time_to_complete_minutes")
            if not rep or not isinstance(mins, (int, float)) or mins <= 0:
                skipped += 1
                continue
            lo = (m.get("min_standing") or {}).get("min_reputation") or 0
            hi = (m.get("max_standing") or {}).get("min_reputation")
            if rank_rep is not None and (lo > rank_rep or (hi is not None and hi < rank_rep)):
                continue
            if system and system.lower() not in [s.lower() for s in (m.get("star_systems") or [])]:
                continue
            row = {"title": m.get("title"), "rep_per_minute": round(rep / mins, 2),
                   "reputation_gained": int(rep), "minutes": int(mins),
                   "reward_auec": m.get("reward_max") or m.get("reward_min"),
                   "min_rank": (m.get("min_standing") or {}).get("name"),
                   "max_rank": (m.get("max_standing") or {}).get("name"),
                   "systems": m.get("star_systems") or [], "cooldown": m.get("cooldown_label"),
                   "has_prerequisites": bool(m.get("has_prerequisites")), "has_chain": bool(m.get("has_chain")),
                   "once_only": bool(m.get("once_only")), "legal": not m.get("illegal")}
            prev = best.get(row["title"])
            if prev is None or row["rep_per_minute"] > prev["rep_per_minute"]:
                best[row["title"]] = row
        rows = sorted(best.values(), key=lambda x: x["rep_per_minute"], reverse=True)
        notes = [_NOTE]
        if skipped:
            notes.append(f"{skipped} missions omitted (no reputation or duration in game data)")
        gv = next((m.get("game_version") or m.get("version") for m in missions if m.get("game_version") or m.get("version")), None)
        return {"source": SOURCE, "game_version": gv, "faction": name, "rank_ladder": ladder,
                "current_rank": rank_name, "missions": rows[:max(1, min(limit, 50))], "notes": notes,
                **freshness(mres)}
