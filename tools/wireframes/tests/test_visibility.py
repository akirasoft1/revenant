import numpy as np

from wireframes.edges import feature_edges
from wireframes.glb import load_glb
from wireframes.tests import synth
from wireframes.visibility import DIRECTIONS, cull_hidden, pixel_size, sample_surface

CREASE = np.radians(60.0)
RES = 256


def scene(meshes):
    b = synth.GlbBuilder()
    roots = [b.node(f"n{i}", mesh=b.mesh(P, F)) for i, (P, F) in enumerate(meshes)]
    g = load_glb(b.build(roots))
    segs = np.concatenate([feature_edges(P, F, CREASE) for P, F in meshes])
    return g, segs


def cull(g, segs, res=RES):
    pts = sample_surface(g, pixel_size(segs, res) * 0.5, np.random.default_rng(1))
    return cull_hidden(segs, pts, depth_res=res)


def test_twenty_six_directions():
    assert DIRECTIONS.shape == (26, 3)
    assert len({tuple(d) for d in DIRECTIONS}) == 26


def test_inner_box_of_a_closed_box_is_culled():
    g, segs = scene([synth.subdivided_box(size=10.0, n=2), synth.box(size=2.0)])
    assert len(segs) == 24 + 12
    out = cull(g, segs)
    assert synth.segs_set(out) == synth.segs_set(segs[:24])
    assert out.shape[1] == 6


def test_inner_edges_seen_through_a_window_are_kept():
    # 10 m box, 6 m square window in the +z face, 2 m box at the centre
    outer = synth.subdivided_box(size=10.0, n=10, window=(2, 8))
    g, segs = scene([outer, synth.box(size=2.0)])
    n_outer = len(feature_edges(*outer, CREASE))
    out = cull(g, segs)
    kept = synth.segs_set(out)
    assert synth.segs_set(segs[:n_outer]) <= kept            # hull + window frame
    inner_kept = kept - synth.segs_set(segs[:n_outer])
    front = {s for s in synth.box_edge_set(size=2.0) if s[0][2] == 1.0 and s[1][2] == 1.0}
    assert len(front) == 4
    assert inner_kept == front                               # only the face behind the window


def test_single_box_keeps_all_edges_and_is_deterministic():
    g, segs = scene([synth.box(size=3.0)])
    a, b = cull(g, segs), cull(g, segs)
    assert len(a) == 12 and np.array_equal(a, b)


def test_large_flat_triangles_are_not_see_through():
    # two huge triangles per face: a per-triangle sample cap would leave holes
    g, segs = scene([synth.box(size=10.0), synth.box(size=2.0)])
    assert len(cull(g, segs, res=640)) == 12


def test_sample_surface_covers_the_surface_at_the_requested_spacing():
    g, _ = scene([synth.box(size=2.0)])
    pts = sample_surface(g, 0.05, np.random.default_rng(0))
    assert pts.dtype == np.float32 and pts.shape[1] == 3
    assert np.isclose(np.abs(pts).max(axis=1), 1.0, atol=1e-5).all()   # all on the surface
    assert 24 / 0.05 ** 2 <= len(pts) <= 24 / 0.05 ** 2 * 1.2
    cells = set(map(tuple, np.floor(pts[np.isclose(pts[:, 2], 1.0, atol=1e-5)][:, :2] / 0.2)
                    .astype(int)))
    assert len(cells) >= 100                                           # no bald patches


def test_sample_surface_honours_node_transforms_and_degenerates():
    b = synth.GlbBuilder()
    P, F = synth.box(size=2.0)
    F = np.concatenate([F, [[0, 0, 1], [2, 2, 2]]])
    m = b.mesh(P, F)
    n = b.node("n", mesh=m, translation=(10.0, 0.0, 0.0), scale=(-1.0, 2.0, 0.5))
    pts = sample_surface(load_glb(b.build([n])), 0.1, np.random.default_rng(0))
    assert np.isfinite(pts).all()
    assert np.allclose(pts.min(0), [9, -2, -0.5], atol=1e-4)
    assert np.allclose(pts.max(0), [11, 2, 0.5], atol=1e-4)


def test_per_triangle_cap_bounds_the_sample_count():
    g, _ = scene([synth.box(size=1000.0)])
    pts = sample_surface(g, 0.5, np.random.default_rng(0), max_per_triangle=100)
    assert len(pts) <= 12 * 100 + 8


def test_cull_handles_empty_inputs():
    assert cull_hidden(np.zeros((0, 6)), np.zeros((0, 3), np.float32)).shape == (0, 6)
    segs = np.array([[0, 0, 0, 1, 0, 0]], dtype=np.float64)
    assert len(cull_hidden(segs, np.zeros((0, 3), np.float32))) == 1    # nothing occludes


def test_occluders_outside_the_edge_bounds_still_occlude_nothing_behind_them():
    # a point cloud far outside the edges' bounding box must not crash or leak
    segs = np.array([[0, 0, 0, 1, 0, 0], [0, 1, 0, 1, 1, 0]], dtype=np.float64)
    far = np.random.default_rng(0).uniform(500, 600, (1000, 3)).astype(np.float32)
    assert len(cull_hidden(segs, far, depth_res=64)) == 2
