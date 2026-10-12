import json
import struct

import numpy as np
import pytest

from wireframes import glb as glbmod
from wireframes.glb import GlbError, class_name, iter_mesh_instances, load_glb, named_nodes
from wireframes.tests import synth


def world_points(g):
    out = []
    for P, F, W in iter_mesh_instances(g):
        assert P.dtype == np.float32 and P.shape[1] == 3
        assert F.dtype == np.int64 and F.shape[1] == 3
        assert W.shape == (4, 4)
        out.append(P.astype(np.float64) @ W[:3, :3].T + W[:3, 3])
    return np.concatenate(out) if out else np.zeros((0, 3))


def test_load_from_path_and_bytes(tmp_path):
    data = synth.ship_glb()
    p = tmp_path / "ship.glb"
    p.write_bytes(data)
    for src in (p, str(p), data):
        g = load_glb(src)
        assert g.json["asset"]["version"] == "2.0"
        assert len(g.nodes) == len(g.json["nodes"])
        assert len(g.bin) >= g.json["buffers"][0]["byteLength"]


@pytest.mark.parametrize("data", [
    b"", b"nope", b"glTF" + b"\0" * 3,
    struct.pack("<4sII", b"XXXX", 2, 12),
    struct.pack("<4sII", b"glTF", 1, 12),
    struct.pack("<4sII", b"glTF", 2, 12),                                  # no chunks
    struct.pack("<4sII", b"glTF", 2, 24) + struct.pack("<I4s", 4, b"JSON") + b"{{{{",
    struct.pack("<4sII", b"glTF", 2, 24) + struct.pack("<I4s", 400, b"JSON") + b"{}  ",
    struct.pack("<4sII", b"glTF", 2, 24) + struct.pack("<I4s", 4, b"JSON") + b"[]  ",
])
def test_corrupt_files_raise_glb_error(data):
    with pytest.raises(GlbError):
        load_glb(data)


def test_missing_file_raises_glb_error(tmp_path):
    with pytest.raises(GlbError):
        load_glb(tmp_path / "absent.glb")


def test_accessor_out_of_bounds_raises_glb_error():
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box())
    b.accessors[0]["count"] = 10_000
    g = load_glb(b.build([b.node("n", mesh=m)]))
    with pytest.raises(GlbError):
        list(iter_mesh_instances(g))


def test_draco_is_rejected_clearly():
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box())
    b.extra_json["extensionsRequired"] = ["KHR_draco_mesh_compression"]
    with pytest.raises(GlbError, match="(?i)draco"):
        load_glb(b.build([b.node("n", mesh=m)]))


def test_translation_rotation_scale_compose_down_the_tree():
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box(size=2.0))
    child = b.node("child", mesh=m, translation=(1.0, 0.0, 0.0), scale=(2.0, 1.0, 1.0))
    # parent: rotate +90 deg about Z, then translate by (10, 0, 0)
    root = b.node("root", children=[child], translation=(10.0, 0.0, 0.0),
                  rotation=(0.0, 0.0, np.sqrt(0.5), np.sqrt(0.5)))
    pts = world_points(load_glb(b.build([root])))
    # local x in [-1,1] -> scaled [-2,2] -> +1 => [-1,3]; rotated: x' = -y, y' = x
    assert np.allclose(pts.min(0), [10 - 1, -1, -1], atol=1e-5)
    assert np.allclose(pts.max(0), [10 + 1, 3, 1], atol=1e-5)


def test_matrix_nodes_are_column_major():
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box(size=2.0))
    M = np.eye(4)
    M[:3, 3] = (5.0, 6.0, 7.0)
    M[0, 0] = 3.0
    pts = world_points(load_glb(b.build([b.node("n", mesh=m, matrix=M)])))
    assert np.allclose(pts.min(0), [2, 5, 6], atol=1e-5)
    assert np.allclose(pts.max(0), [8, 7, 8], atol=1e-5)


def test_byte_stride_and_accessor_offset_and_u16_indices():
    P, F = synth.box(center=(1, 2, 3), size=2.0)
    b = synth.GlbBuilder()
    m = b.mesh(P, F, stride=20, accessor_offset=8, component=5123)
    (P2, F2, _), = list(iter_mesh_instances(load_glb(b.build([b.node("n", mesh=m)]))))
    assert np.array_equal(P2, P)
    assert np.array_equal(F2, F)


def test_one_mesh_used_by_two_nodes_yields_two_instances():
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box())
    a = b.node("a", mesh=m)
    c = b.node("c", mesh=m, translation=(5.0, 0.0, 0.0))
    inst = list(iter_mesh_instances(load_glb(b.build([a, c]))))
    assert len(inst) == 2
    assert inst[0][0] is inst[1][0]          # geometry is cached per mesh
    assert np.allclose(inst[1][2][:3, 3], [5, 0, 0])


def test_multiple_primitives_are_merged_with_index_offsets():
    b = synth.GlbBuilder()
    Pa, Fa = synth.box()
    Pb, Fb = synth.box(center=(3, 0, 0))
    m = b.mesh_from_primitives([b.primitive(Pa, Fa), b.primitive(Pb, Fb)])
    (P, F, _), = list(iter_mesh_instances(load_glb(b.build([b.node("n", mesh=m)]))))
    assert len(P) == 16 and len(F) == 24
    assert np.allclose(P[F[12:]].reshape(-1, 3).mean(0), [3, 0, 0], atol=1e-6)


def test_nodes_outside_the_scene_are_ignored():
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box())
    used = b.node("used", mesh=m)
    b.node("orphan", mesh=m, translation=(100.0, 0.0, 0.0))
    assert len(list(iter_mesh_instances(load_glb(b.build([used]))))) == 1


# ---- degenerate inputs (Review Focus 2) -------------------------------------

def test_mesh_without_indices_uses_consecutive_triples():
    P, F = synth.box()
    soup = P[F].reshape(-1, 3)                       # 36 vertices, no index buffer
    b = synth.GlbBuilder()
    m = b.mesh(np.concatenate([soup, soup[:2]]))     # 2 trailing vertices: ignored
    (P2, F2, _), = list(iter_mesh_instances(load_glb(b.build([b.node("n", mesh=m)]))))
    assert len(F2) == 12
    assert np.array_equal(F2, np.arange(36).reshape(12, 3))


def test_mesh_without_position_and_non_triangle_modes_are_skipped():
    b = synth.GlbBuilder()
    P, F = synth.box()
    no_pos = b.mesh(P, F, with_position=False)
    lines = b.mesh(P, F, mode=1)
    ok = b.mesh(P, F)
    roots = [b.node("a", mesh=no_pos), b.node("b", mesh=lines), b.node("c", mesh=ok)]
    assert len(list(iter_mesh_instances(load_glb(b.build(roots))))) == 1


def test_out_of_range_indices_and_non_finite_vertices_are_dropped():
    P, F = synth.box()
    P = P.copy()
    P[7] = np.nan
    F = np.concatenate([F, [[0, 1, 99]]])
    b = synth.GlbBuilder()
    (P2, F2, _), = list(iter_mesh_instances(
        load_glb(b.build([b.node("n", mesh=b.mesh(P, F))]))))
    assert np.isfinite(P2[F2]).all()
    assert F2.max() < len(P2)
    assert len(F2) == 12 - 6       # the 6 triangles touching corner 7 are gone


def test_non_finite_node_transform_is_skipped():
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box())
    bad = b.node("bad", mesh=m, translation=(float("inf"), 0.0, 0.0))
    good = b.node("good", mesh=m)
    assert len(list(iter_mesh_instances(load_glb(b.build([bad, good]))))) == 1


def test_node_cycles_do_not_hang():
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box())
    a = b.node("a", mesh=m, children=[1])
    b.node("b", children=[0])
    assert len(list(iter_mesh_instances(load_glb(b.build([a]))))) == 1


# ---- class name --------------------------------------------------------------

def test_class_name_strips_the_entity_prefix():
    assert class_name(load_glb(synth.ship_glb("AEGS_Test_Ship"))) == "AEGS_Test_Ship"


def test_class_name_missing_is_none():
    assert class_name(load_glb(synth.ship_glb(with_class=False))) is None


def test_class_name_prefers_the_shallowest_node():
    b = synth.GlbBuilder()
    gun = b.node("gun", extras={"entity_name": "EntityClassDefinition.Some_Gun"})
    hp = b.node("hardpoint_gun", children=[gun])
    body = b.node("body", children=[hp], extras={"entity_name": "EntityClassDefinition.The_Ship"})
    assert class_name(load_glb(b.build([b.node("root", children=[body])]))) == "The_Ship"


def test_class_name_ignores_non_string_and_empty_values():
    b = synth.GlbBuilder()
    a = b.node("a", extras={"entity_name": 5})
    c = b.node("c", extras={"entity_name": "EntityClassDefinition."})
    d = b.node("d", extras="not a dict")
    e = b.node("e", extras={"entity_name": "Plain_Name"})
    assert class_name(load_glb(b.build([a, c, d, e]))) == "Plain_Name"


# ---- named nodes -------------------------------------------------------------

def test_named_nodes_keep_hardpoints_with_ancestors_and_descendants():
    nodes = named_nodes(load_glb(synth.ship_glb()))
    by_name = {n["name"]: n for n in nodes}
    assert set(by_name) == {"CryEngine_Z_up", "body", "hardpoint_turret_base", "turret_left",
                            "hardpoint_class_2", "Hardpoint_Quantum_Drive"}
    for n in nodes:
        assert set(n) == {"name", "parent", "pos"}
        assert len(n["pos"]) == 3 and all(isinstance(v, float) for v in n["pos"])
    assert by_name["CryEngine_Z_up"]["parent"] == -1
    assert nodes[by_name["turret_left"]["parent"]]["name"] == "hardpoint_turret_base"
    assert nodes[by_name["hardpoint_class_2"]["parent"]]["name"] == "turret_left"
    for i, n in enumerate(nodes):
        assert n["parent"] < i                      # parents precede children
    # Z-up (0,2,0)+(1,0,0)+(0,0,0.5) = (1,2,0.5) -> Y-up (x, z, -y)
    assert np.allclose(by_name["hardpoint_class_2"]["pos"], [1.0, 0.5, -2.0], atol=1e-4)
    assert np.allclose(by_name["Hardpoint_Quantum_Drive"]["pos"], [0.0, 0.0, 1.0], atol=1e-4)


def test_named_nodes_skip_unnamed_links_but_keep_the_chain():
    b = synth.GlbBuilder()
    leaf = b.node("hardpoint_gun", translation=(0.0, 0.0, 1.0))
    anon = b.node(None, children=[leaf], translation=(0.0, 1.0, 0.0))
    top = b.node("top", children=[anon], translation=(1.0, 0.0, 0.0))
    nodes = named_nodes(load_glb(b.build([top])))
    assert [n["name"] for n in nodes] == ["top", "hardpoint_gun"]
    assert nodes[1]["parent"] == 0
    assert np.allclose(nodes[1]["pos"], [1, 1, 1])


def test_named_nodes_empty_without_hardpoints():
    b = synth.GlbBuilder()
    assert named_nodes(load_glb(b.build([b.node("a", children=[b.node("b")])]))) == []


def test_named_nodes_cap_keeps_hardpoint_chains_first():
    b = synth.GlbBuilder()
    deep = [b.node(f"detail_{i}") for i in range(30)]
    hp_a = b.node("hardpoint_a", children=deep)
    hp_b = b.node("hardpoint_b")
    root = b.node("root", children=[hp_a, hp_b])
    nodes = named_nodes(load_glb(b.build([root])), max_nodes=10)
    names = [n["name"] for n in nodes]
    assert len(nodes) == 10
    assert {"root", "hardpoint_a", "hardpoint_b"} <= set(names)
    for i, n in enumerate(nodes):
        assert -1 <= n["parent"] < i
    assert glbmod.MAX_NODES == 5000


def test_shared_vertex_buffers_are_compacted_per_mesh():
    # exporters put many meshes in one big vertex buffer; each mesh must only
    # carry the vertices its own triangles use (order of first use not required)
    Pa, Fa = synth.box(center=(0, 0, 0))
    Pb, Fb = synth.box(center=(50, 0, 0))
    filler = np.full((1000, 3), 777.0, dtype=np.float32)
    shared = np.concatenate([Pa, filler, Pb])
    b = synth.GlbBuilder()
    pos = b.positions(shared)
    ma = b.mesh_from_primitives([{"attributes": {"POSITION": pos}, "indices": b.indices(Fa)}])
    mb = b.mesh_from_primitives([{"attributes": {"POSITION": pos},
                                  "indices": b.indices(Fb + 1008)}])
    g = load_glb(b.build([b.node("a", mesh=ma), b.node("b", mesh=mb)]))
    (P1, F1, _), (P2, F2, _) = list(iter_mesh_instances(g))
    assert len(P1) == 8 and len(P2) == 8
    assert np.allclose(np.sort(P1[F1].reshape(-1, 3), axis=0), np.sort(Pa[Fa].reshape(-1, 3), axis=0))
    assert np.allclose(P2[F2], Pb[Fb])
    assert not (P1 == 777.0).any() and not (P2 == 777.0).any()
