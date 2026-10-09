"""Spoken / typed item names -> one catalog item (chat edits, text + voice)."""
import pytest

from src.catalog import Slot
from src.item_resolve import resolve_item


def _it(name, type_, size, uuid=None, cls=None):
    return {"uuid": uuid or f"u-{name}", "name": name, "className": cls or f"CLS_{name}", "type": type_,
            "subType": None, "size": size}


ITEMS = [
    _it("Hemera", "QuantumDrive", 2), _it("Bolon", "QuantumDrive", 2), _it("Bolt", "QuantumDrive", 2),
    _it("Yeager", "QuantumDrive", 2), _it("Atlas", "QuantumDrive", 1),
    _it("7MA 'Lorica'", "Shield", 2), _it("FR-66", "Shield", 2), _it("Bulwark", "Shield", 1),
    _it("Bulwark", "Shield", 2, uuid="u-bulwark-2"),
]


class FakeCatalog:
    def __init__(self):
        self.item_calls, self.items_calls = [], []

    async def item(self, ident):
        self.item_calls.append(ident)
        return next((dict(i) for i in ITEMS if ident in (i["uuid"], i["name"], i["className"])), None)

    async def items(self, type_, size=None, q=None):
        self.items_calls.append(type_)
        return [dict(i) for i in ITEMS if i["type"] == type_]


def _slot(name, type_, size):
    return Slot(name=name, type=type_, sub_type=None, size_min=size, size_max=size,
                compatible_types=[{"type": type_, "sub_types": []}])


SHIP = [_slot("hardpoint_quantum_drive", "QuantumDrive", 2), _slot("hardpoint_shield_generator_001", "Shield", 2),
        _slot("hardpoint_shield_generator_002", "Shield", 2)]


async def test_exact_lookup_needs_no_pool():
    cat = FakeCatalog()
    r = await resolve_item(cat, "Hemera", SHIP)
    assert r.status == "match" and r.item["name"] == "Hemera" and r.matched_by == "exact"
    assert cat.items_calls == []


@pytest.mark.parametrize("text", ["the Hemera quantum drive", "my Hemera QD", "Hemera's"])
async def test_residual_exact_retry(text):
    cat = FakeCatalog()
    r = await resolve_item(cat, text, SHIP)
    assert r.status == "match" and r.item["name"] == "Hemera" and r.matched_by == "exact"
    assert "Hemera" in cat.item_calls


@pytest.mark.parametrize("text,name,by", [
    ("hemera qd", "Hemera", "exact"),            # casefold exact in the QD pool
    ("lorica shields", "7MA 'Lorica'", "fuzzy"),  # whole token, quotes stripped
    ("lorica", "7MA 'Lorica'", "fuzzy"),
    ("hemra", "Hemera", "fuzzy"),                 # ASR slip
    ("yeagr quantum drive", "Yeager", "fuzzy"),
])
async def test_pool_resolution(text, name, by):
    cat = FakeCatalog()
    r = await resolve_item(cat, text, SHIP)
    assert r.status == "match", r
    assert r.item["name"] == name and r.matched_by == by


async def test_spoken_type_limits_the_pool():
    cat = FakeCatalog()
    await resolve_item(cat, "hemra quantum drive", SHIP)
    assert cat.items_calls == ["QuantumDrive"]


async def test_pool_is_the_ships_slot_types_without_a_spoken_type():
    cat = FakeCatalog()
    await resolve_item(cat, "hemra", SHIP)
    assert sorted(cat.items_calls) == ["QuantumDrive", "Shield"]


async def test_ambiguous_partial_name():
    r = await resolve_item(FakeCatalog(), "bol", SHIP)
    assert r.status == "ambiguous"
    assert [c["name"] for c in r.candidates] == ["Bolon", "Bolt"]
    assert set(r.candidates[0]) == {"uuid", "name", "type", "size"}


async def test_tie_break_prefers_an_item_that_fits_a_slot_size():
    r = await resolve_item(FakeCatalog(), "bulwark shield", SHIP)       # S1 and S2 Bulwark; ship takes S2
    assert r.status == "match" and r.item["uuid"] == "u-bulwark-2"


async def test_not_found_with_suggestions():
    r = await resolve_item(FakeCatalog(), "hemoglobin drive", SHIP)
    assert r.status == "not_found"
    assert len(r.suggestions) <= 3
    r = await resolve_item(FakeCatalog(), "zzzzqqq", SHIP)
    assert r.status == "not_found" and r.suggestions == []


async def test_ambiguous_caps_candidates_at_five():
    many = [_it(f"Spark {i}", "QuantumDrive", 2) for i in range(8)]
    cat = FakeCatalog()

    async def items(type_, size=None, q=None):
        return [dict(i) for i in many]
    cat.items = items
    r = await resolve_item(cat, "spark", SHIP)
    assert r.status == "ambiguous" and len(r.candidates) == 5
