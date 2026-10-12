"""Synthetic GLB builders for the tests.

Everything here is generated in code. No extracted game geometry may ever be
used as a fixture (this repository is public).
"""
from __future__ import annotations

import json
import struct

import numpy as np

_QUADS = (  # outward-facing quads of a box, as corner indices
    (0, 2, 3, 1), (4, 5, 7, 6),  # -x, +x
    (0, 1, 5, 4), (2, 6, 7, 3),  # -y, +y
    (0, 4, 6, 2), (1, 3, 7, 5),  # -z, +z
)


def box(center=(0.0, 0.0, 0.0), size=1.0):
    """8 shared vertices, 12 outward-wound triangles."""
    c = np.asarray(center, dtype=np.float64)
    h = np.broadcast_to(np.asarray(size, dtype=np.float64) / 2.0, (3,))
    corners = np.array(
        [[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], dtype=np.float64
    )
    faces = []
    for a, b, cc, d in _QUADS:
        faces += [(a, cc, b), (a, d, cc)]
    return (c + corners * h).astype(np.float32), np.array(faces, dtype=np.int64)


def split_box(center=(0.0, 0.0, 0.0), size=1.0):
    """The same box with every face owning its own 4 vertices (24 in all)."""
    P, _ = box(center, size)
    verts, faces = [], []
    for quad in _QUADS:
        o = len(verts)
        verts += [P[i] for i in quad]
        faces += [(o, o + 2, o + 1), (o, o + 3, o + 2)]
    return np.array(verts, dtype=np.float32), np.array(faces, dtype=np.int64)


def _dedupe(P, F):
    keys = {}
    remap = np.empty(len(P), dtype=np.int64)
    out = []
    for i, p in enumerate(np.round(np.asarray(P, dtype=np.float64), 6)):
        k = tuple(p)
        if k not in keys:
            keys[k] = len(out)
            out.append(P[i])
        remap[i] = keys[k]
    return np.array(out, dtype=np.float32), remap[np.asarray(F)]


def grid_quad(origin, eu, ev, n, hole=None):
    """An n x n grid of quads spanning origin + s*eu + t*ev, s,t in [0, 1].

    ``hole`` = (lo, hi) in cell indices removes cells lo <= i, j < hi.
    """
    origin, eu, ev = (np.asarray(a, dtype=np.float64) for a in (origin, eu, ev))
    verts = [origin + eu * (i / n) + ev * (j / n) for j in range(n + 1) for i in range(n + 1)]
    faces = []
    for j in range(n):
        for i in range(n):
            if hole and hole[0] <= i < hole[1] and hole[0] <= j < hole[1]:
                continue
            a = j * (n + 1) + i
            b, c, d = a + 1, a + n + 2, a + n + 1
            faces += [(a, b, c), (a, c, d)]
    return np.array(verts, dtype=np.float32), np.array(faces, dtype=np.int64)


def subdivided_box(center=(0.0, 0.0, 0.0), size=1.0, n=4, window=None):
    """A box whose faces are n x n grids, vertices shared across faces.

    ``window`` = (lo, hi) cuts a square hole (in cell indices) in the +z face.
    """
    c = np.asarray(center, dtype=np.float64)
    h = float(size) / 2.0
    s = float(size)
    spec = [  # origin, eu, ev with eu x ev pointing outward
        ((-h, -h, -h), (0, 0, s), (0, s, 0)), ((h, -h, -h), (0, s, 0), (0, 0, s)),
        ((-h, -h, -h), (s, 0, 0), (0, 0, s)), ((-h, h, -h), (0, 0, s), (s, 0, 0)),
        ((-h, -h, -h), (0, s, 0), (s, 0, 0)), ((-h, -h, h), (s, 0, 0), (0, s, 0)),
    ]
    Ps, Fs, off = [], [], 0
    for k, (o, eu, ev) in enumerate(spec):
        P, F = grid_quad(c + np.array(o), eu, ev, n, hole=window if k == 5 else None)
        Ps.append(P)
        Fs.append(F + off)
        off += len(P)
    return _dedupe(np.concatenate(Ps), np.concatenate(Fs))


def segs_set(segs, decimals=3):
    """Order-independent, direction-independent set of segments."""
    out = set()
    for s in np.round(np.asarray(segs, dtype=np.float64), decimals) + 0.0:
        a, b = tuple(s[:3]), tuple(s[3:])
        out.add((a, b) if a <= b else (b, a))
    return out


def box_edge_set(center=(0.0, 0.0, 0.0), size=1.0, decimals=3):
    P, _ = box(center, size)
    out = []
    for i in range(8):
        for j in range(i + 1, 8):
            if np.count_nonzero(np.abs(P[i] - P[j]) > 1e-9) == 1:
                out.append(np.concatenate([P[i], P[j]]))
    return segs_set(np.array(out), decimals)


class GlbBuilder:
    """Builds a minimal binary glTF 2.0 file in memory."""

    def __init__(self):
        self.bin = bytearray()
        self.views, self.accessors, self.meshes, self.nodes = [], [], [], []
        self.extra_json = {}

    def _view(self, data: bytes, stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if stride:
            view["byteStride"] = stride
        self.bin += data
        self.views.append(view)
        return len(self.views) - 1

    def positions(self, P, stride=None, accessor_offset=0):
        P = np.asarray(P, dtype="<f4").reshape(-1, 3)
        if stride:
            rows = np.full((len(P), stride), 0xAB, dtype=np.uint8)
            rows[:, :12] = P.view(np.uint8).reshape(len(P), 12)
            data = bytes(accessor_offset) + rows.tobytes()
        else:
            data = bytes(accessor_offset) + P.tobytes()
        acc = {"bufferView": self._view(data, stride), "componentType": 5126,
               "count": len(P), "type": "VEC3"}
        if accessor_offset:
            acc["byteOffset"] = accessor_offset
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def indices(self, F, component=5125):
        dt = {5121: "u1", 5123: "<u2", 5125: "<u4"}[component]
        flat = np.asarray(F).reshape(-1).astype(dt)
        self.accessors.append({"bufferView": self._view(flat.tobytes()),
                               "componentType": component, "count": len(flat),
                               "type": "SCALAR"})
        return len(self.accessors) - 1

    def mesh(self, P, F=None, *, stride=None, accessor_offset=0, component=5125,
             mode=None, with_position=True):
        prim = {"attributes": {}}
        if with_position:
            prim["attributes"]["POSITION"] = self.positions(P, stride, accessor_offset)
        if F is not None:
            prim["indices"] = self.indices(F, component)
        if mode is not None:
            prim["mode"] = mode
        return self.mesh_from_primitives([prim])

    def mesh_from_primitives(self, prims):
        self.meshes.append({"primitives": prims})
        return len(self.meshes) - 1

    def primitive(self, P, F):
        return {"attributes": {"POSITION": self.positions(P)}, "indices": self.indices(F)}

    def node(self, name=None, *, mesh=None, children=(), translation=None, rotation=None,
             scale=None, matrix=None, extras=None):
        n = {}
        if name is not None:
            n["name"] = name
        if mesh is not None:
            n["mesh"] = mesh
        if children:
            n["children"] = list(children)
        if translation is not None:
            n["translation"] = list(translation)
        if rotation is not None:
            n["rotation"] = list(rotation)
        if scale is not None:
            n["scale"] = list(scale)
        if matrix is not None:  # row-major 4x4 in, column-major out (glTF)
            n["matrix"] = [float(x) for x in np.asarray(matrix, dtype=float).T.reshape(-1)]
        if extras is not None:
            n["extras"] = extras
        self.nodes.append(n)
        return len(self.nodes) - 1

    def build(self, roots) -> bytes:
        doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": list(roots)}],
               "nodes": self.nodes, "meshes": self.meshes, "accessors": self.accessors,
               "bufferViews": self.views, "buffers": [{"byteLength": len(self.bin)}]}
        doc.update(self.extra_json)
        js = json.dumps(doc).encode()
        js += b" " * (-len(js) % 4)
        binary = bytes(self.bin) + b"\0" * (-len(self.bin) % 4)
        total = 12 + 8 + len(js) + 8 + len(binary)
        return (struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(js), b"JSON")
                + js + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


def ship_glb(class_name="TEST_Ship", *, with_class=True, inner=False, size=4.0) -> bytes:
    """A small 'ship': Z-up root, a hull box, hardpoints, optionally an inner box."""
    b = GlbBuilder()
    hull = b.mesh(*subdivided_box(size=size, n=4))
    kids = []
    if inner:
        kids.append(b.node("interior_box", mesh=b.mesh(*box(size=size / 4))))
    gun = b.node("hardpoint_class_2", translation=(0.0, 0.0, 0.5))
    turret = b.node("turret_left", children=[gun], translation=(1.0, 0.0, 0.0))
    hp = b.node("hardpoint_turret_base", children=[turret], translation=(0.0, 2.0, 0.0))
    qd = b.node("Hardpoint_Quantum_Drive", translation=(0.0, -1.0, 0.0))
    other = b.node("decal_only", translation=(9.0, 9.0, 9.0))
    extras = {"entity_name": f"EntityClassDefinition.{class_name}"} if with_class else None
    body = b.node("body", mesh=hull, children=kids + [hp, qd, other], extras=extras)
    # +90 deg about X: CryEngine Z-up -> glTF Y-up
    root = b.node("CryEngine_Z_up", children=[body],
                  rotation=(-np.sqrt(0.5), 0.0, 0.0, np.sqrt(0.5)))
    return b.build([root])
