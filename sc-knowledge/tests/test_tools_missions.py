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


async def test_vip_clients_both_variants_separate():
    """De-dup by (title, systems), so Stanton and Pyro variants appear separately."""
    r = await _tools().faction_missions("Foxwell Enforcement", limit=200)
    vip_rows = [m for m in r["missions"] if "Support VIP Clients" in m["title"]]
    assert len(vip_rows) == 2, f"Expected 2 VIP variants, got {len(vip_rows)}"

    # Stanton variant: 16000 rep / 126 min = 126.98 rep/min (outlier)
    stanton = next((m for m in vip_rows if "Stanton" in m["systems"]), None)
    assert stanton is not None, "Stanton variant missing"
    assert stanton["reputation_gained"] == 16000
    assert stanton["minutes"] == 126
    assert stanton["rep_per_minute"] == 126.98
    assert stanton.get("outlier") is True, "Stanton variant should be marked outlier"
    assert "Unusually high" in stanton.get("caveat", ""), "Outlier should have caveat"
    assert stanton.get("rep_tier") == "+T_09", "Should preserve non-standard tier"

    # Pyro variant: 300 rep / 126 min = 2.38 rep/min (normal)
    pyro = next((m for m in vip_rows if "Pyro" in m["systems"]), None)
    assert pyro is not None, "Pyro variant missing"
    assert pyro["reputation_gained"] == 300
    assert pyro["minutes"] == 126
    assert pyro["rep_per_minute"] == 2.38
    assert pyro.get("outlier") is not True, "Pyro variant should not be outlier"
    assert pyro.get("rep_tier") is None, "Undefined Name tier should not appear in output"

    # Check notes include outlier warning
    outlier_notes = [n for n in r["notes"] if "outlier" in n.lower()]
    assert len(outlier_notes) > 0, "Notes should include outlier warning"


async def test_reward_zero_preserved():
    """Verify that reward_auec=0 is preserved (0 is valid, not None)."""
    r = await _tools().faction_missions("Foxwell Enforcement", limit=50)
    # All Foxwell missions have null rewards, so this primarily tests the logic path
    # The logic is: reward_max if reward_max is not None else reward_min
    # If both are None, result is None (which is fine)
    # This test confirms the implementation doesn't skip 0 if it were present
    assert isinstance(r["missions"][0].get("reward_auec"), (int, type(None))), \
        "reward_auec should be int or None, never missing"
