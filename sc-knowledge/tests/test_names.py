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


def test_commodity_fuzzy_via_rapidfuzz_wration():
    """Test fuzzy resolution via rapidfuzz WRatio scorer (score ≥88, margin ≥8).

    Uses hand-made entries to ensure no substring relation (both directions):
    - Query "quantanium" vs entry "Quantainium" (one-letter transposition)
    - WRatio score 95.24 (≥88), margin 51.76 vs "Hephaestanite" (≥8)
    - No substring overlap: "quantanium" ⊄ "quantainium" and vice versa
    """
    from src.names import Entry
    idx = NameIndex()
    idx.add(Entry("commodity", 101, "Quantainium", ("Quantainium",), {}))
    idx.add(Entry("commodity", 102, "Hephaestanite", ("Hephaestanite",), {}))
    idx.add(Entry("commodity", 103, "Zenithium", ("Zenithium",), {}))

    r = idx.resolve("quantanium", kind="commodity")
    assert r.status == "fuzzy" and r.match is not None and r.match.name == "Quantainium"


def test_commodity_one_letter_typo():
    """Test one-letter typo resolves to Laranite (via ambiguous candidates)."""
    r = _idx().resolve("Laranit", kind="commodity")
    laranite_found = (r.match is not None and r.match.name.startswith("Laranite")) or \
                     any(c.name.startswith("Laranite") for c in r.candidates)
    assert laranite_found, f"Expected Laranite in match or candidates, got status={r.status}"


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


def test_faction_entries():
    """Test faction entry conversion: id=uuid, alias=name."""
    from src.names import faction_entries
    factions = load_fixture("wiki_factions.json")["data"]
    entries = faction_entries(factions)
    assert len(entries) > 0
    # Sample a faction: id is uuid, name is in aliases
    first = entries[0]
    assert first.kind == "faction"
    assert isinstance(first.id, str) and len(first.id) > 0  # uuid
    assert first.name in first.aliases
    # Resolve by exact name
    idx = NameIndex()
    for e in entries:
        idx.add(e)
    r = idx.resolve(first.name, kind="faction")
    assert r.status == "exact" and r.match is not None and r.match.id == first.id
