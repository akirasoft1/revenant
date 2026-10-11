import gzip
import json
import struct

import pytest

from src import swf
from tests.swf_helper import make_bundle, node


def test_parse_valid():
    b = swf.parse(make_bundle(lines=3, nodes=[node("hardpoint_a", -1, (1, 2, 3))]))
    assert b.header["className"] == "RSI_Constellation_Taurus"
    assert b.lines == 3 and b.nodes[0]["name"] == "hardpoint_a"
    assert b.build["tool"] == "wireframes/1"


@pytest.mark.parametrize("data,frag", [
    (b"not gzip at all", "gzip"),
    (make_bundle(magic=b"XXXX"), "magic"),
    (gzip.compress(b"SWF1"), "header"),
    (gzip.compress(b"SWF1" + struct.pack("<I", 50) + b"{}"), "header"),
    (gzip.compress(b"SWF1" + struct.pack("<I", 4) + b"nope"), "JSON"),
    (gzip.compress(b"SWF1" + struct.pack("<I", 2) + b"[]"), "object"),
    (make_bundle(header_overrides={"lines": 5}), "lines"),
    (make_bundle(lines=2, payload=b"\x00" * 24 + b"\x00"), "lines"),
    (make_bundle(kind="item"), "kind"),
    (make_bundle(header_overrides={"lines": -1}), "lines"),
    (make_bundle(header_overrides={"lines": 80001}), "80000"),
    (make_bundle(header_overrides={"nodes": [node("hardpoint")] * 5001}), "5000"),
    (make_bundle(header_overrides={"nodes": "x"}), "nodes"),
    (make_bundle(header_overrides={"halfExtent": "big"}), "halfExtent"),
    (make_bundle(header_overrides={"className": ""}), "className"),
    (make_bundle(header_overrides={"className": "../evil"}), "className"),
    (make_bundle(header_overrides={"center": [1, 2]}), "center"),
    (make_bundle(header_overrides={"nodes": [{"name": "a", "parent": "x", "pos": [0, 0, 0]}]}), "nodes"),
])
def test_parse_rejects(data, frag):
    with pytest.raises(swf.SwfError) as e:
        swf.parse(data)
    assert frag.lower() in str(e.value).lower()


def test_missing_key():
    raw = b"SWF1"
    hb = json.dumps({"format": 1}).encode()
    with pytest.raises(swf.SwfError, match="missing"):
        swf.parse(gzip.compress(raw + struct.pack("<I", len(hb)) + hb))


def test_decompressed_over_cap():
    data = gzip.compress(b"SWF1" + b"\x00" * (swf.MAX_DECOMPRESSED + 10))
    with pytest.raises(swf.SwfError, match="8 MB|decompress"):
        swf.parse(data)


def test_parent_cycles_rejected():
    with pytest.raises(swf.SwfError, match="cycle"):
        swf.parse(make_bundle(nodes=[node("a", 0)]))
    with pytest.raises(swf.SwfError, match="cycle"):
        swf.parse(make_bundle(nodes=[node("a", 1), node("b", 0)]))
    with pytest.raises(swf.SwfError, match="cycle"):
        swf.parse(make_bundle(nodes=[node("r"), node("a", 2), node("b", 3), node("c", 1)]))


def test_children_before_parents_allowed():
    swf.parse(make_bundle(nodes=[node("child", 1), node("root", -1)]))


@pytest.mark.parametrize("over,frag", [
    ({"center": [float("nan"), 0, 0]}, "center"),
    ({"halfExtent": float("inf")}, "halfExtent"),
    ({"halfExtent": 0}, "halfExtent"),
    ({"nodes": [{"name": "a", "parent": -1, "pos": [0, float("-inf"), 0]}]}, "nodes"),
    ({"format": 2}, "format"),
    ({"format": True}, "format"),
    ({"space": "z-up"}, "space"),
    ({"space": 5}, "space"),
])
def test_non_finite_and_header_fields(over, frag):
    with pytest.raises(swf.SwfError, match=frag):
        swf.parse(make_bundle(header_overrides=over))
