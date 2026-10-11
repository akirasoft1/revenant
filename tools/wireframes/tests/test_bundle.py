import gzip
import json
import struct

import numpy as np
import pytest

from wireframes import __version__
from wireframes.bundle import BundleError, read_bundle, write_bundle

BUILD = {"creaseDeg": 60.0, "minEdgeFrac": 0.0025, "maxLines": 60000,
         "visibility": True, "depthRes": 640}
NODES = [{"name": "root", "parent": -1, "pos": [0.0, 0.0, 0.0]},
         {"name": "hardpoint_gun", "parent": 0, "pos": [1.5, -2.25, 3.0]}]


def random_segs(n=500, seed=0):
    rng = np.random.default_rng(seed)
    return rng.uniform([-30, -4, -12] * 2, [10, 6, 12] * 2, (n, 6))


def write(path, segs, **kw):
    args = dict(kind="vehicle", class_name="TEST_Ship", source_name="Test Ship.glb",
                segs=segs, nodes=NODES, build=BUILD)
    args.update(kw)
    return write_bundle(path, **args)


def test_round_trip_is_within_quantisation_error(tmp_path):
    segs = random_segs()
    p = tmp_path / "TEST_Ship.swf.gz"
    header = write(p, segs)
    got_header, got = read_bundle(p)
    assert got_header == header
    assert got.dtype == np.float32 and got.shape == (500, 6)
    assert np.abs(got - segs).max() <= header["halfExtent"] / 32767
    # bytes work too
    h2, g2 = read_bundle(p.read_bytes())
    assert h2 == header and np.array_equal(g2, got)


def test_header_has_exactly_the_spec_keys(tmp_path):
    header = write(tmp_path / "a.swf.gz", random_segs(7))
    assert set(header) == {"format", "kind", "className", "sourceName", "space", "center",
                           "halfExtent", "lines", "nodes", "build"}
    assert header["format"] == 1
    assert header["kind"] == "vehicle"
    assert header["className"] == "TEST_Ship"
    assert header["sourceName"] == "Test Ship.glb"
    assert header["space"] == "gltf-y-up-m"
    assert header["lines"] == 7
    assert header["nodes"] == NODES
    assert set(header["build"]) == {"creaseDeg", "minEdgeFrac", "maxLines", "visibility",
                                    "depthRes", "tool"}
    assert header["build"]["tool"] == f"wireframes/{__version__}"
    assert len(header["center"]) == 3 and header["halfExtent"] > 0


def test_center_and_half_extent_cover_the_bounding_box(tmp_path):
    segs = np.array([[-30.0, 0, 0, 10, 0, 0], [0, -4, -12, 0, 6, 12]])
    header = write(tmp_path / "a.swf.gz", segs)
    assert np.allclose(header["center"], [-10, 1, 0], atol=1e-4)
    assert 20.0 <= header["halfExtent"] <= 20.001


def test_file_layout_matches_the_format(tmp_path):
    segs = random_segs(11)
    p = tmp_path / "a.swf.gz"
    header = write(p, segs)
    raw = gzip.decompress(p.read_bytes())
    assert raw[:4] == b"SWF1"
    (hlen,) = struct.unpack("<I", raw[4:8])
    assert json.loads(raw[8:8 + hlen].decode("utf-8")) == header
    payload = raw[8 + hlen:]
    assert len(payload) == 11 * 6 * 2
    q = np.frombuffer(payload, dtype="<i2").reshape(11, 6)
    assert np.abs(q.astype(np.int32)).max() <= 32767
    pos = np.tile(header["center"], 2) + q / 32767 * header["halfExtent"]
    assert np.abs(pos - segs).max() <= header["halfExtent"] / 32767


def test_output_is_deterministic(tmp_path):
    segs = random_segs(50)
    write(tmp_path / "a.swf.gz", segs)
    write(tmp_path / "b.swf.gz", segs)
    assert (tmp_path / "a.swf.gz").read_bytes() == (tmp_path / "b.swf.gz").read_bytes()


def test_write_replaces_an_existing_bundle_and_leaves_no_temp_files(tmp_path):
    p = tmp_path / "a.swf.gz"
    write(p, random_segs(5))
    write(p, random_segs(9))
    assert read_bundle(p)[0]["lines"] == 9
    assert [f.name for f in tmp_path.iterdir()] == ["a.swf.gz"]


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_non_finite_segments_are_refused(tmp_path, bad):
    segs = random_segs(5)
    segs[2, 4] = bad
    with pytest.raises(ValueError):
        write(tmp_path / "a.swf.gz", segs)
    assert list(tmp_path.iterdir()) == []


def test_empty_and_malformed_input_is_refused(tmp_path):
    with pytest.raises(ValueError):
        write(tmp_path / "a.swf.gz", np.zeros((0, 6)))
    with pytest.raises(ValueError):
        write(tmp_path / "a.swf.gz", np.zeros((4, 3)))
    with pytest.raises(ValueError):
        write(tmp_path / "a.swf.gz", random_segs(3), build={"creaseDeg": 60.0})
    with pytest.raises(ValueError):
        write(tmp_path / "a.swf.gz", random_segs(3),
              nodes=[{"name": "n", "parent": -1, "pos": [0.0, float("nan"), 0.0]}])
    with pytest.raises(ValueError):
        write(tmp_path / "a.swf.gz", random_segs(3),
              nodes=[{"name": f"n{i}", "parent": -1, "pos": [0.0, 0.0, 0.0]}
                     for i in range(5001)])


def test_degenerate_extent_does_not_divide_by_zero(tmp_path):
    segs = np.full((2, 6), 3.0)
    header = write(tmp_path / "a.swf.gz", segs)
    _, got = read_bundle(tmp_path / "a.swf.gz")
    assert header["halfExtent"] > 0 and np.allclose(got, 3.0, atol=1e-3)


def _pack(header: dict, payload: bytes) -> bytes:
    h = json.dumps(header).encode()
    return gzip.compress(b"SWF1" + struct.pack("<I", len(h)) + h + payload)


@pytest.mark.parametrize("data", [
    b"not gzip at all",
    gzip.compress(b"SWF2" + struct.pack("<I", 2) + b"{}"),
    gzip.compress(b"SW"),
    gzip.compress(b"SWF1" + struct.pack("<I", 9999) + b"{}"),
    gzip.compress(b"SWF1" + struct.pack("<I", 4) + b"{{{{"),
    gzip.compress(b"SWF1" + struct.pack("<I", 2) + b"[]"),
    _pack({"lines": 2, "center": [0, 0, 0], "halfExtent": 1.0}, b"\0" * 12),      # short
    _pack({"lines": 1, "center": [0, 0], "halfExtent": 1.0}, b"\0" * 12),         # bad center
    _pack({"lines": 1, "center": [0, 0, 0]}, b"\0" * 12),                         # no extent
])
def test_read_rejects_bad_bundles(data):
    with pytest.raises(BundleError):
        read_bundle(data)


def test_read_missing_file_raises_bundle_error(tmp_path):
    with pytest.raises(BundleError):
        read_bundle(tmp_path / "nope.swf.gz")


# ---- optional per-view visibility ---------------------------------------------

VIEWS = np.array([[1.0, 0, 0], [0, 1.0, 0], [0, 0, -1.0]])


def test_views_and_masks_round_trip(tmp_path):
    from wireframes.bundle import read_bundle_full
    segs = random_segs(9)
    masks = np.arange(9, dtype=np.uint32) % 8
    header = write(tmp_path / "v.swf.gz", segs, views=VIEWS, masks=masks)
    assert header["views"] == VIEWS.tolist()
    got_header, pos, got = read_bundle_full(tmp_path / "v.swf.gz")
    assert got_header == header
    assert got.dtype == np.uint32 and got.tolist() == masks.tolist()
    assert np.abs(pos - segs).max() <= header["halfExtent"] / 32767 * 0.51 + 1e-6
    # the plain reader still works and the layout is lines * 12 then lines * 4
    assert read_bundle(tmp_path / "v.swf.gz")[0] == header
    raw = gzip.decompress((tmp_path / "v.swf.gz").read_bytes())
    (hlen,) = struct.unpack_from("<I", raw, 4)
    assert len(raw) - 8 - hlen == 9 * 16
    assert np.frombuffer(raw[-36:], dtype="<u4").tolist() == masks.tolist()


def test_bundle_without_views_has_no_masks(tmp_path):
    from wireframes.bundle import read_bundle_full
    write(tmp_path / "p.swf.gz", random_segs(4))
    header, _pos, masks = read_bundle_full(tmp_path / "p.swf.gz")
    assert "views" not in header and masks is None


@pytest.mark.parametrize("kw", [
    dict(views=VIEWS),                                              # masks missing
    dict(masks=np.zeros(5, dtype=np.uint32)),                       # views missing
    dict(views=VIEWS, masks=np.zeros(4, dtype=np.uint32)),          # wrong mask count
    dict(views=np.zeros((33, 3)), masks=np.zeros(5, dtype=np.uint32)),
    dict(views=np.zeros((0, 3)), masks=np.zeros(5, dtype=np.uint32)),
    dict(views=np.array([[np.nan, 0, 0]]), masks=np.zeros(5, dtype=np.uint32)),
])
def test_bad_views_or_masks_are_refused(tmp_path, kw):
    with pytest.raises(ValueError):
        write(tmp_path / "bad.swf.gz", random_segs(5), **kw)
    assert not list(tmp_path.iterdir())


def test_read_rejects_a_views_bundle_with_a_short_payload(tmp_path):
    write(tmp_path / "v.swf.gz", random_segs(3), views=VIEWS, masks=np.zeros(3, dtype=np.uint32))
    raw = gzip.decompress((tmp_path / "v.swf.gz").read_bytes())
    with pytest.raises(BundleError, match="payload"):
        read_bundle(gzip.compress(raw[:-4]))
