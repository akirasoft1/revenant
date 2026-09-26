from src.cache import TTLCache
from src.config import load
from src.tools_missions import MissionTools
from src.wiki import build_wiki
from tests.conftest import fixture_transport


def _tools():
    wiki = build_wiki(load(), transport=fixture_transport({
        "/api/missions": "wiki_missions_foxwell.json",
        "/api/factions": "wiki_factions.json",
    }))
    return MissionTools(wiki, TTLCache())


async def test_foxwell_sorted_by_rep_per_minute():
    r = await _tools().faction_missions("Foxwell Enforcement", limit=10)
    assert len(r["missions"]) > 0, "Foxwell result must not be empty"
    rpm = [m["rep_per_minute"] for m in r["missions"]]
    assert rpm == sorted(rpm, reverse=True) and len(r["missions"]) <= 10
    assert r["rank_ladder"] and r["rank_ladder"][0]["min_reputation"] <= r["rank_ladder"][-1]["min_reputation"]


async def test_fuzzy_faction_name():
    r = await _tools().faction_missions("foxwell", limit=3)
    assert r["faction"] == "Foxwell Enforcement"


async def test_rank_filter_excludes_higher_rank_missions():
    t = _tools()
    full = await t.faction_missions("Foxwell Enforcement", limit=200)
    low = full["rank_ladder"][0]["name"]
    r = await t.faction_missions("Foxwell Enforcement", current_rank=low, limit=200)
    ladder = {x["name"]: x["min_reputation"] for x in full["rank_ladder"]}
    assert all(m["min_rank"] is None or ladder[m["min_rank"]] <= ladder[low] for m in r["missions"])


async def test_unknown_faction_not_found():
    r = await _tools().faction_missions("Zzqq Nonexistent Corp")
    assert r["error"] in ("not_found", "ambiguous")
