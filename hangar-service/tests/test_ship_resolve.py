"""Ship resolution parity with sc-knowledge's sc_member_hangar.

The cases mirror sc-knowledge/tests/test_tools_hangar.py (same hangars, same
queries, same expected ships/labels). The last tests compare the shorthand
table and the constants against sc-knowledge's source when that checkout is
present (it is in the monorepo; skipped in an isolated build context)."""
import ast
import pathlib

import pytest

from src import ship_resolve
from src.ship_resolve import SHIP_SHORTHAND, resolve_ship, ship_labels

SC_TOOLS_HANGAR = pathlib.Path(__file__).resolve().parents[2] / "sc-knowledge" / "src" / "tools_hangar.py"


def _ship(ship_id, vehicle, nickname=None):
    return {"shipId": ship_id, "vehicleName": vehicle, "nickname": nickname}


TAURUS = _ship("c1", "Constellation Taurus")
AKIRA = [_ship("h1", "Vanguard Harbinger"), TAURUS]
TWINS = [TAURUS, _ship("c2", "Constellation Andromeda"), _ship("c3", "Cutlass Black"),
         _ship("c4", "Cutlass Black")]
NICK = [_ship("h9", "Vanguard Harbinger", "Connie"), TAURUS, _ship("b1", "Caterpillar", "Big Bertha")]


def _labels_of(ships):
    labels = ship_labels(ships)
    return [labels[s["shipId"]] for s in ships]


def test_connie_resolves_to_only_constellation():
    status, hits, tier = resolve_ship("Connie", AKIRA)
    assert status == "match" and hits[0]["shipId"] == "c1" and tier == "model"


@pytest.mark.parametrize("query,ship_id", [
    ("my Harbinger", "h1"), ("harb", "h1"), ("constellation taurus", "c1"), ("my Connie's", "c1"),
])
def test_my_prefix_and_partial_model_name(query, ship_id):
    status, hits, _ = resolve_ship(query, AKIRA)
    assert status == "match" and hits[0]["shipId"] == ship_id


def test_connie_ambiguous_between_two_constellations():
    status, hits, _ = resolve_ship("Connie", TWINS)
    assert status == "ambiguous"
    assert set(_labels_of(hits)) == {"Constellation Taurus", "Constellation Andromeda"}


def test_two_unnamed_ships_of_same_model_get_distinct_labels():
    status, hits, _ = resolve_ship("Cutlass", TWINS)
    assert status == "ambiguous"
    labels = ship_labels(TWINS)
    cands = [labels[s["shipId"]] for s in hits]
    assert len(cands) == 2 and len(set(cands)) == 2
    assert all("Cutlass Black" in c for c in cands)
    assert labels["c3"] == "Cutlass Black (ship c3)"


def test_nickname_wins_over_model_shorthand():
    status, hits, tier = resolve_ship("Connie", NICK)
    assert status == "match" and hits[0]["shipId"] == "h9" and tier == "nickname"


def test_nickname_fuzzy():
    status, hits, tier = resolve_ship("big berta", NICK)
    assert status == "match" and hits[0]["shipId"] == "b1" and tier == "nickname_fuzzy"


def test_unknown_ship_not_found():
    assert resolve_ship("Polaris", AKIRA) == ("not_found", [], None)
    assert resolve_ship("", AKIRA) == ("not_found", [], None)
    assert resolve_ship("Connie", []) == ("not_found", [], None)


def test_nicknamed_label_format():
    assert ship_labels(NICK)["b1"] == "\"Big Bertha\" (Caterpillar)"


@pytest.mark.parametrize("short,full,vehicle", [
    ("cutty", "cutlass", "Cutlass Black"), ("gladdy", "gladius", "Gladius"),
    ("lancer", "freelancer", "Freelancer MAX"), ("msr", "mercury", "Mercury Star Runner"),
])
def test_shorthand_resolves(short, full, vehicle):
    assert SHIP_SHORTHAND[short] == full
    status, hits, _ = resolve_ship(f"my {short}", [_ship("x", vehicle), _ship("y", "Vanguard Harbinger")])
    assert status == "match" and hits[0]["shipId"] == "x"


def _sc_constant(name: str):
    tree = ast.parse(SC_TOOLS_HANGAR.read_text())
    for node in tree.body:
        targets = ([t.id for t in node.targets if isinstance(t, ast.Name)] if isinstance(node, ast.Assign)
                   else [node.target.id] if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
                   else [])
        if name in targets:
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in {SC_TOOLS_HANGAR}")


@pytest.mark.skipif(not SC_TOOLS_HANGAR.exists(), reason="sc-knowledge checkout not present")
@pytest.mark.parametrize("name", ["SHIP_SHORTHAND", "_LEADING_STOPWORDS", "_FUZZY_MIN", "_FUZZY_CLEAR_LEAD"])
def test_constants_match_sc_knowledge(name):
    assert getattr(ship_resolve, name) == _sc_constant(name)


@pytest.mark.skipif(not SC_TOOLS_HANGAR.exists(), reason="sc-knowledge checkout not present")
@pytest.mark.parametrize("ours,theirs", [("resolve_ship", "resolve_ship"), ("_best_fuzzy", "_best_fuzzy"),
                                         ("_token_hit", "_token_hit"), ("_query_tokens", "_query_tokens"),
                                         ("_tokens", "_tokens"), ("ship_labels", "_labels")])
def test_resolver_functions_match_sc_knowledge(ours, theirs):
    """Same function bodies (docstrings aside): a resolver change in one copy
    must be made in the other."""
    def body(source: str, fn: str) -> str:
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == fn)
        node.name = "f"
        if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant):
            node.body = node.body[1:]
        return ast.dump(node)
    mine = pathlib.Path(ship_resolve.__file__).read_text()
    assert body(mine, ours) == body(SC_TOOLS_HANGAR.read_text(), theirs)
