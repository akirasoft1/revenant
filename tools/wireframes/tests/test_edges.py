import numpy as np
import pytest

from wireframes.edges import feature_edges, filter_and_budget, robust_bounds
from wireframes.tests import synth

CREASE = np.radians(60.0)


def test_cube_has_exactly_twelve_edges():
    segs = feature_edges(*synth.box(center=(1, 2, 3), size=2.0), CREASE)
    assert segs.shape == (12, 6)
    assert synth.segs_set(segs) == synth.box_edge_set((1, 2, 3), 2.0)


def test_subdivided_cube_still_has_twelve_long_edges_at_60_degrees():
    P, F = synth.subdivided_box(size=2.0, n=4)
    segs = feature_edges(P, F, CREASE)
    # each of the 12 cube edges is split into 4 collinear pieces; no face diagonals
    assert len(segs) == 48
    d = np.abs(segs[:, :3] - segs[:, 3:])
    assert (np.count_nonzero(d > 1e-6, axis=1) == 1).all()
    assert np.allclose(np.linalg.norm(segs[:, :3] - segs[:, 3:], axis=1).sum(), 24.0)
    on_edge = np.count_nonzero(np.isclose(np.abs(segs.reshape(-1, 3)), 1.0, atol=1e-5), axis=1)
    assert (on_edge >= 2).all()


def test_split_vertices_are_welded():
    P, F = synth.split_box(size=2.0)
    assert len(P) == 24
    segs = feature_edges(P, F, CREASE)
    assert synth.segs_set(segs) == synth.box_edge_set(size=2.0)
    # sub-tolerance jitter still welds; a much finer tolerance does not
    P2 = P + np.random.default_rng(0).uniform(-2e-4, 2e-4, P.shape).astype(np.float32)
    assert synth.segs_set(feature_edges(P2, F, CREASE, weld=0.001)) == synth.box_edge_set(size=2.0)
    assert len(feature_edges(P2, F, CREASE, weld=1e-6)) == 24     # six separate quads
    with pytest.raises(ValueError):
        feature_edges(P, F, CREASE, weld=0.0)


def test_crease_threshold_is_respected():
    # two quads meeting along the x axis with a 45 degree fold
    P = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
                  [1, -1, 1], [0, -1, 1]], dtype=np.float32)
    F = np.array([[0, 1, 2], [0, 2, 3], [0, 5, 4], [0, 4, 1]])
    fold = ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0))
    assert fold not in synth.segs_set(feature_edges(P, F, np.radians(60)))
    assert fold in synth.segs_set(feature_edges(P, F, np.radians(30)))
    assert len(feature_edges(P, F, np.radians(60))) == 6      # the outline only


def test_boundary_edges_of_an_open_sheet_are_kept():
    P, F = synth.grid_quad((0, 0, 0), (2, 0, 0), (0, 2, 0), 4)
    segs = feature_edges(P, F, CREASE)
    assert len(segs) == 16
    assert np.allclose(np.linalg.norm(segs[:, :3] - segs[:, 3:], axis=1).sum(), 8.0)


def test_double_sided_sheet_gives_only_its_outline():
    P, F = synth.grid_quad((0, 0, 0), (2, 0, 0), (0, 2, 0), 2)
    both = np.concatenate([F, F[:, ::-1]])
    segs = feature_edges(P, both, CREASE)
    assert len(segs) == 8


def test_wall_standing_on_a_floor_keeps_the_junction():
    floor_p, floor_f = synth.grid_quad((-1, -1, 0), (2, 0, 0), (0, 2, 0), 2)
    wall_p, wall_f = synth.grid_quad((-1, 0, 0), (2, 0, 0), (0, 0, 2), 2)
    P = np.concatenate([floor_p, wall_p])
    F = np.concatenate([floor_f, wall_f + len(floor_p)])
    got = synth.segs_set(feature_edges(P, F, CREASE))
    assert ((-1.0, 0.0, 0.0), (0.0, 0.0, 0.0)) in got
    assert ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0)) in got


def test_returns_local_space_float_segments():
    segs = feature_edges(*synth.box(), CREASE)
    assert segs.dtype == np.float64 and np.isfinite(segs).all()


# ---- degenerate inputs (Review Focus 2) -------------------------------------

@pytest.mark.parametrize("P,F", [
    (np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int64)),
    (np.zeros((3, 3), np.float32), np.array([[0, 1, 2]])),                 # zero area
    (np.array([[0, 0, 0], [1, 0, 0], [2, 0, 0]], np.float32), np.array([[0, 1, 2]])),  # collinear
    (np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32), np.array([[0, 0, 1]])),  # repeated
])
def test_degenerate_meshes_give_no_edges_and_no_nans(P, F):
    segs = feature_edges(P, F, CREASE)
    assert segs.shape == (0, 6)


def test_zero_area_triangles_mixed_into_a_cube_change_nothing():
    P, F = synth.box(size=2.0)
    P = np.concatenate([P, P[:1] + 1e-5])            # welds onto corner 0
    F = np.concatenate([F, [[0, 1, 8], [0, 0, 3], [2, 2, 2]]])
    segs = feature_edges(P, F, CREASE)
    assert np.isfinite(segs).all()
    assert synth.segs_set(segs) == synth.box_edge_set(size=2.0)


def test_huge_coordinates_fall_back_without_overflow():
    P, F = synth.box(center=(0, 0, 0), size=2.0)
    P = P.astype(np.float64) * 1e9                   # 1e12 weld cells per axis
    segs = feature_edges(P, F, CREASE)
    assert len(segs) == 12 and np.isfinite(segs).all()


def test_large_random_mesh_matches_a_bruteforce_reference():
    rng = np.random.default_rng(3)
    P = rng.integers(0, 6, size=(60, 3)).astype(np.float32)
    F = rng.integers(0, 60, size=(300, 3))
    got = synth.segs_set(feature_edges(P, F, CREASE))
    # reference: python loops
    key = {}
    V = []
    remap = []
    for p in P:
        k = tuple(np.round(p / 0.001).astype(int))
        if k not in key:
            key[k] = len(V)
            V.append(p.astype(float))
        remap.append(key[k])
    V = np.array(V)
    edges = {}
    for tri in F:
        t = [remap[i] for i in tri]
        if len(set(t)) < 3:
            continue
        n = np.cross(V[t[1]] - V[t[0]], V[t[2]] - V[t[0]])
        ln = np.linalg.norm(n)
        if ln <= 1e-12:
            continue
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            edges.setdefault((min(a, b), max(a, b)), []).append(n / ln)
    want = []
    for (a, b), ns in edges.items():
        if len(ns) == 1:
            keep = True
        elif len(ns) == 2:
            keep = float(ns[0] @ ns[1]) < np.cos(CREASE)
        else:
            keep = min(abs(float(ns[0] @ m)) for m in ns[1:]) < np.cos(CREASE)
        if keep:
            want.append(np.concatenate([V[a], V[b]]))
    assert got == synth.segs_set(np.array(want))


# ---- filter_and_budget -------------------------------------------------------

def _seg(a, b):
    return np.array([*a, *b], dtype=np.float64)


def test_min_length_is_relative_to_the_longest_dimension():
    segs = np.array([_seg((0, 0, 0), (100, 0, 0)), _seg((0, 0, 0), (0, 0.3, 0)),
                     _seg((0, 0, 0), (0, 0.2, 0)), _seg((5, 5, 0), (5, 5, 0.26))])
    out = filter_and_budget(segs, 0.0025, 100)          # threshold 0.25
    lengths = sorted(np.linalg.norm(out[:, :3] - out[:, 3:], axis=1).round(3))
    assert lengths == [0.26, 0.3, 100.0]


def test_budget_keeps_the_longest_first():
    rng = np.random.default_rng(1)
    a = rng.uniform(-1, 1, (500, 3))
    d = rng.normal(size=(500, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    L = rng.uniform(0.1, 1.0, 500)
    segs = np.concatenate([a, a + d * L[:, None]], axis=1)
    out = filter_and_budget(segs, 0.0, 50)
    got = np.linalg.norm(out[:, :3] - out[:, 3:], axis=1)
    assert len(out) == 50
    assert np.allclose(got, np.sort(L)[::-1][:50])       # longest, in descending order
    assert len(filter_and_budget(segs, 0.0, 10_000)) == 500


def test_stray_fragment_is_dropped():
    rng = np.random.default_rng(2)
    a = rng.normal(size=(2000, 3))
    a *= (rng.uniform(0, 1, (2000, 1)) ** (1 / 3)) / np.linalg.norm(a, axis=1, keepdims=True)
    body = np.concatenate([a, a + rng.normal(scale=0.05, size=(2000, 3))], axis=1)
    stray = np.array([_seg((40, 0, 0), (40, 1, 0)), _seg((40, 0, 0), (41, 0, 0)),
                      _seg((0, -30, 0), (0, -30, 2))])
    out = filter_and_budget(np.concatenate([body, stray]), 0.0, 100_000)
    assert np.abs(out).max() < 3.0
    assert len(out) >= 1990


def test_stray_filter_keeps_everything_on_a_plain_cube():
    segs = np.array(sorted(synth.box_edge_set(size=2.0))).reshape(-1, 6)
    assert len(filter_and_budget(segs, 0.0025, 60_000)) == 12


def test_filter_handles_empty_and_non_finite_input():
    assert filter_and_budget(np.zeros((0, 6)), 0.0025, 10).shape == (0, 6)
    segs = np.array([_seg((0, 0, 0), (1, 0, 0)), _seg((0, 0, 0), (np.nan, 0, 0)),
                     _seg((0, 0, 0), (np.inf, 0, 0)), _seg((1, 1, 1), (1, 1, 1))])
    out = filter_and_budget(segs, 0.0025, 10)
    assert len(out) == 1 and np.isfinite(out).all()


# ---- robust extent -----------------------------------------------------------

def _hull_and_decal():
    hull = feature_edges(*synth.subdivided_box(size=20.0, n=64), CREASE)       # 768 edges
    decal = np.array([_seg((200, 0, 0), (200.2, 0, 0)), _seg((200, 0, 0), (200, 0.2, 0)),
                      _seg((200.2, 0, 0), (200, 0.2, 0))])
    return hull, decal


def test_robust_bounds_ignore_a_far_stray_fragment():
    hull, decal = _hull_and_decal()
    lo, hi = robust_bounds(np.concatenate([hull, decal]))
    assert np.allclose(lo, -10) and np.allclose(hi, 10)
    lo2, hi2 = robust_bounds(hull)                       # no strays: the plain bounding box
    assert np.allclose(lo2, -10) and np.allclose(hi2, 10)


def test_robust_bounds_of_tiny_or_empty_input():
    assert robust_bounds(np.zeros((0, 6))) is None
    lo, hi = robust_bounds(np.array([_seg((1, 2, 3), (4, 5, 6))]))
    assert np.allclose(lo, [1, 2, 3]) and np.allclose(hi, [4, 5, 6])
    lo, hi = robust_bounds(np.array([_seg((0, 0, 0), (1, 0, 0)), _seg((0, 0, 0), (np.nan, 0, 0))]))
    assert np.allclose(lo, 0) and np.allclose(hi, [1, 0, 0])


def test_min_length_uses_the_robust_extent_not_the_stray_inflated_box():
    hull, decal = _hull_and_decal()
    alone = filter_and_budget(hull, 0.0025, 60_000)
    both = filter_and_budget(np.concatenate([hull, decal]), 0.0025, 60_000)
    assert len(alone) == 768
    assert synth.segs_set(both) == synth.segs_set(alone)


def test_min_length_reference_can_be_given_explicitly():
    hull, _ = _hull_and_decal()                          # edges are 0.3125 m
    assert len(filter_and_budget(hull, 0.0025, 60_000, reference=200.0)) == 0
    assert len(filter_and_budget(hull, 0.0025, 60_000, reference=20.0)) == 768
