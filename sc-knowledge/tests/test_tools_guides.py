import os
import time

from src.tools_guides import GuideStore, GuideTools

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "guides")


def test_parses_title_version_and_sections():
    secs = GuideStore(FIX).sections()
    guides = {s.guide for s in secs}
    assert len(guides) == 2 and all(s.version == "Alpha 4.10.1" for s in secs)
    assert len(secs) >= 4


def test_query_ranks_relevant_section_first():
    r = GuideTools(GuideStore(FIX)).org_guides("why did the terminal refuse my cargo demand saturation")
    assert r["sections"] and "satur" in (r["sections"][0]["heading"] + r["sections"][0]["text"]).lower()
    assert r["source"] == "org guide"


def test_missing_dir_returns_note(tmp_path):
    r = GuideTools(GuideStore(str(tmp_path / "nope"))).org_guides("anything")
    assert r["sections"] == [] and r["note"] == "no org guides loaded"


def test_reloads_when_files_change(tmp_path):
    d = tmp_path / "g"; d.mkdir()
    (d / "a.txt").write_text("GUIDE A\nAlpha 4.10.1\n1. SALVAGE BASICS\nscraper beams\n")
    clk = [0.0]
    store = GuideStore(str(d), clock=lambda: clk[0], recheck_s=60)
    assert len(store.sections()) >= 1
    (d / "b.txt").write_text("GUIDE B\nAlpha 4.10.1\n1. MINING BASICS\nlasers\n")
    os.utime(d / "b.txt", (time.time() + 5, time.time() + 5))
    clk[0] = 61
    assert {s.guide for s in store.sections()} == {"GUIDE A", "GUIDE B"}
