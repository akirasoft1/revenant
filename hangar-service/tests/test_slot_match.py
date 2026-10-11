from src.slot_match import match_slots
from tests.swf_helper import node


def test_simple_and_case_insensitive():
    nodes = [node("Hardpoint_Radar", -1, (1, 2, 3))]
    r = match_slots(nodes, ["hardpoint_radar", "hardpoint_shield"])
    assert r.slots == {"hardpoint_radar": {"xyz": [1, 2, 3]}}
    assert r.missing == ["hardpoint_shield"] and r.ambiguous == []


def test_nested_path_through_non_hardpoint_names():
    nodes = [node("hardpoint_turret", -1, (0, 0, 0)),
             node("Turret_Base", 0, (1, 0, 0)),
             node("hardpoint_weapon_left", 1, (2, 0, 0)),
             node("hardpoint_class_2", 2, (3, 4, 5))]
    r = match_slots(nodes, ["hardpoint_turret/hardpoint_weapon_left/hardpoint_class_2",
                            "hardpoint_turret/hardpoint_weapon_left"])
    assert r.slots["hardpoint_turret/hardpoint_weapon_left/hardpoint_class_2"] == {"xyz": [3, 4, 5]}
    assert r.slots["hardpoint_turret/hardpoint_weapon_left"] == {"xyz": [2, 0, 0]}


def test_bfs_does_not_descend_past_match():
    nodes = [node("a", -1, (0, 0, 0)),
             node("b", 0, (1, 0, 0)),
             node("b", 1, (9, 9, 9))]          # nested under a matching b: ignored
    r = match_slots(nodes, ["a/b"])
    assert r.slots["a/b"] == {"xyz": [1, 0, 0]}


def test_ambiguous_and_coincident():
    nodes = [node("a", -1), node("c", 0, (0, 0, 0)), node("c", 0, (0, 0, 5)),
             node("d", -1), node("e", 3, (1, 1, 1)), node("e", 3, (1, 1, 1.04))]
    r = match_slots(nodes, ["a/c", "d/e"])
    assert r.ambiguous == ["a/c"] and "a/c" not in r.slots
    assert r.slots["d/e"] == {"xyz": [1, 1, 1]}


def test_multiple_roots_same_name_ambiguous():
    nodes = [node("a", -1, (0, 0, 0)), node("a", -1, (3, 0, 0))]
    assert match_slots(nodes, ["a"]).ambiguous == ["a"]
