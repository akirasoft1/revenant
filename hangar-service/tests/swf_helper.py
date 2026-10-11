"""Builds synthetic wireframe bundles (format SWF1) for tests. Mirrors the spec;
deliberately does not import from tools/."""
import gzip
import json
import struct


def make_bundle(*, class_name="RSI_Constellation_Taurus", nodes=None, lines=2, kind="vehicle",
                center=(0.0, 0.0, 0.0), half_extent=10.0, payload=None, header_extra=None,
                magic=b"SWF1", header_overrides=None, compress=True) -> bytes:
    header = {"format": 1, "kind": kind, "className": class_name, "sourceName": "x.glb",
              "space": "gltf-y-up-m", "center": list(center), "halfExtent": half_extent,
              "lines": lines, "nodes": nodes or [],
              "build": {"creaseDeg": 60, "minEdgeFrac": 0.0025, "maxLines": 60000,
                        "visibility": True, "depthRes": 640, "tool": "wireframes/1"}}
    header.update(header_extra or {})
    header.update(header_overrides or {})
    hb = json.dumps(header).encode()
    body = payload if payload is not None else struct.pack(f"<{lines * 6}h", *([100] * (lines * 6)))
    raw = magic + struct.pack("<I", len(hb)) + hb + body
    return gzip.compress(raw) if compress else raw


def node(name, parent=-1, pos=(0.0, 0.0, 0.0)):
    return {"name": name, "parent": parent, "pos": list(pos)}
