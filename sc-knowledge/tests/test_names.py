from src.names import NameIndex, normalise, terminal_entries, commodity_entries
from tests.conftest import load_fixture


def _idx():
    idx = NameIndex()
    for e in terminal_entries(load_fixture("uex_terminals.json")["data"]):
        idx.add(e)
    for e in commodity_entries(load_fixture("uex_commodities.json")["data"]):
        idx.add(e)
    return idx


def test_normalise():
    assert normalise("Admin - MIC-L5") == "adminmicl5"
    assert normalise("  MIC L5 ") == "micl5"


def test_mic_l5_variants_resolve_to_terminal_58():
    idx = _idx()
    for q in ("MIC-L5", "micl5", "Admin - MIC-L5", "mic l5"):
        r = idx.resolve(q, kind="terminal")
        assert 58 in {c.id for c in ([r.match] if r.match else r.candidates)}, (q, r.status, [c.name for c in r.candidates])


def test_commodity_fuzzy_typo():
    r = _idx().resolve("Laranite", kind="commodity")
    assert r.match is not None and r.match.name.lower().startswith("laranite")


def test_nonsense_is_not_found_with_no_match():
    r = _idx().resolve("zzqqxx", kind="commodity")
    assert r.status == "not_found" and r.match is None


def test_ambiguous_returns_candidates():
    idx = NameIndex()
    from src.names import Entry
    idx.add(Entry("terminal", 1, "Port Olisar Admin", ("Port Olisar Admin",), {}))
    idx.add(Entry("terminal", 2, "Port Olisar Cargo", ("Port Olisar Cargo",), {}))
    r = idx.resolve("Port Olisar", kind="terminal")
    assert r.status == "ambiguous" and {c.id for c in r.candidates} == {1, 2}
