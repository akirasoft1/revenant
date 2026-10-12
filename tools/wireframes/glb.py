"""Minimal binary glTF 2.0 (``.glb``) reader: node tree, transforms, triangles.

Only what the wireframe pipeline needs. Supported: the embedded BIN buffer,
accessors with ``byteStride`` / ``byteOffset``, node ``matrix`` or
translation/rotation/scale, indexed and non-indexed triangle lists.
Not supported (rejected or skipped, never guessed): Draco / meshopt compression,
external buffers, sparse accessors, strips and fans, skinning and morph targets.
"""
from __future__ import annotations

import functools
import json
import os
import struct
from typing import Iterator

import numpy as np

MAX_NODES = 5000                      # the server refuses bundles with more nodes
ENTITY_PREFIX = "EntityClassDefinition."
HARDPOINT_PREFIX = "hardpoint"

_COMPONENT = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
_COMPRESSION = ("KHR_draco_mesh_compression", "EXT_meshopt_compression")


class GlbError(Exception):
    """The file is not a GLB this tool can read."""


def _structural(fn):
    """Turn the exceptions a malformed document provokes (a list where an object
    should be, a missing key, ...) into :class:`GlbError`."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (KeyError, AttributeError, IndexError, TypeError, ValueError,
                OverflowError) as e:
            raise GlbError(f"malformed glTF structure ({type(e).__name__}: {e})") from e
    return wrapper


class Glb:
    """A parsed GLB. ``json`` is the document, ``bin`` the binary chunk,
    ``nodes`` the document's node list."""

    def __init__(self, doc: dict, binary: bytes):
        self.json = doc
        self.bin = binary
        nodes = doc.get("nodes", [])
        if not isinstance(nodes, list) or any(not isinstance(n, dict) for n in nodes):
            raise GlbError("'nodes' is not a list of objects")
        self.nodes: list[dict] = nodes
        self._walked = None
        self._meshes: dict[int, tuple[np.ndarray, np.ndarray] | None] = {}

    # ---- node tree ---------------------------------------------------------
    @_structural
    def walk(self):
        """(order, parent, depth, world): scene nodes in pre-order, each node's
        parent index (-1 for roots), depth, and 4x4 world matrix."""
        if self._walked is None:
            self._walked = _walk(self)
        return self._walked

    # ---- geometry ----------------------------------------------------------
    @_structural
    def mesh_geometry(self, mesh_index: int):
        """(positions Nx3 float32, faces Mx3 int64) for a mesh, all triangle
        primitives merged; ``None`` when it has no usable triangles. Cached."""
        if mesh_index not in self._meshes:
            self._meshes[mesh_index] = _mesh_geometry(self, mesh_index)
        return self._meshes[mesh_index]


@_structural
def load_glb(src) -> Glb:
    """Parse a ``.glb`` from a path or from bytes. Raises :class:`GlbError`."""
    if isinstance(src, (bytes, bytearray, memoryview)):
        data = bytes(src)
    else:
        try:
            with open(os.fspath(src), "rb") as f:
                data = f.read()
        except OSError as e:
            raise GlbError(f"cannot read file: {e.strerror or e}") from e
    if len(data) < 12:
        raise GlbError("not a GLB file (too short)")
    magic, version, _total = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise GlbError("not a GLB file (bad magic)")
    if version != 2:
        raise GlbError(f"unsupported glTF version {version} (need 2)")
    doc = None
    binary = b""
    pos = 12
    while pos + 8 <= len(data):
        length, kind = struct.unpack_from("<I4s", data, pos)
        pos += 8
        if pos + length > len(data):
            raise GlbError("truncated GLB (chunk runs past the end of the file)")
        if kind == b"JSON" and doc is None:
            try:
                doc = json.loads(data[pos:pos + length].decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as e:
                raise GlbError(f"GLB JSON chunk is not valid JSON: {e}") from e
        elif kind == b"BIN\0" and not binary:
            binary = data[pos:pos + length]
        pos += length + (-length % 4)
    if doc is None:
        raise GlbError("GLB has no JSON chunk")
    if not isinstance(doc, dict):
        raise GlbError("GLB JSON chunk is not an object")
    required = doc.get("extensionsRequired") or []
    for ext in _COMPRESSION:
        if ext in required:
            raise GlbError(f"compressed geometry ({ext}) is not supported — "
                           "export plain GLB (no Draco / meshopt)")
    return Glb(doc, binary)


# ---- transforms ---------------------------------------------------------------

def _local_matrix(node: dict) -> np.ndarray:
    try:
        if "matrix" in node:
            return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
        m = np.eye(4)
        if "rotation" in node:
            x, y, z, w = (float(v) for v in node["rotation"])
            norm = (x * x + y * y + z * z + w * w) ** 0.5
            if norm > 0 and np.isfinite(norm):
                x, y, z, w = x / norm, y / norm, z / norm, w / norm
                m[:3, :3] = [
                    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
                ]
        if "scale" in node:
            m[:3, :3] *= np.array(node["scale"], dtype=np.float64).reshape(3)
        if "translation" in node:
            m[:3, 3] = np.array(node["translation"], dtype=np.float64).reshape(3)
        return m
    except (TypeError, ValueError) as e:
        raise GlbError(f"node {node.get('name')!r} has a malformed transform: {e}") from e


def _walk(glb: Glb):
    nodes = glb.nodes
    doc = glb.json
    scenes = doc.get("scenes")
    roots = None
    if isinstance(scenes, list) and scenes:
        index = doc.get("scene", 0)
        scene = scenes[index] if isinstance(index, int) and 0 <= index < len(scenes) else scenes[0]
        if isinstance(scene, dict) and isinstance(scene.get("nodes"), list):
            roots = scene["nodes"]
    if roots is None:                   # no scene: every node that is nobody's child
        children = {c for n in nodes for c in (n.get("children") or []) if isinstance(c, int)}
        roots = [i for i in range(len(nodes)) if i not in children]
    order: list[int] = []
    parent: dict[int, int] = {}
    depth: dict[int, int] = {}
    world: dict[int, np.ndarray] = {}
    stack = [(r, -1) for r in reversed(roots)]
    while stack:
        i, par = stack.pop()
        if not isinstance(i, int) or not 0 <= i < len(nodes) or i in world:
            continue                    # bad index, shared node, or a cycle
        local = _local_matrix(nodes[i])
        world[i] = world[par] @ local if par >= 0 else local
        parent[i] = par
        depth[i] = depth[par] + 1 if par >= 0 else 0
        order.append(i)
        kids = nodes[i].get("children") or []
        if isinstance(kids, list):
            stack.extend((c, i) for c in reversed(kids))
    return order, parent, depth, world


# ---- accessors ----------------------------------------------------------------

@_structural
def read_accessor(glb: Glb, index) -> np.ndarray:
    """An accessor as a ``(count, components)`` array (a view where possible)."""
    accessors = glb.json.get("accessors") or []
    if not isinstance(index, int) or not 0 <= index < len(accessors):
        raise GlbError(f"accessor {index!r} does not exist")
    acc = accessors[index]
    try:
        dtype = np.dtype(_COMPONENT[acc["componentType"]])
        width = _WIDTH[acc["type"]]
        count = int(acc["count"])
    except (KeyError, TypeError, ValueError) as e:
        raise GlbError(f"accessor {index} is malformed ({e})") from e
    if count < 0:
        raise GlbError(f"accessor {index} has a negative count")
    if "bufferView" not in acc:         # all zeros by definition (sparse is not applied)
        return np.zeros((count, width), dtype=dtype)
    views = glb.json.get("bufferViews") or []
    vi = acc["bufferView"]
    if not isinstance(vi, int) or not 0 <= vi < len(views):
        raise GlbError(f"accessor {index} points at a missing bufferView")
    view = views[vi]
    if view.get("buffer", 0) != 0 or (glb.json.get("buffers") or [{}])[0].get("uri"):
        raise GlbError("external buffers are not supported (export a single .glb)")
    try:
        offset = int(view.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
        elem = dtype.itemsize * width
        stride = int(view.get("byteStride") or elem)
    except (TypeError, ValueError) as e:
        raise GlbError(f"accessor {index} has malformed offsets ({e})") from e
    if count == 0:
        return np.zeros((0, width), dtype=dtype)
    if offset < 0 or stride < elem or offset + stride * (count - 1) + elem > len(glb.bin):
        raise GlbError(f"accessor {index} runs outside the binary chunk")
    if stride == elem:
        return np.frombuffer(glb.bin, dtype=dtype, count=count * width,
                             offset=offset).reshape(count, width)
    strided = np.ndarray((count, width), dtype=dtype, buffer=glb.bin, offset=offset,
                         strides=(stride, dtype.itemsize))
    return np.ascontiguousarray(strided)


def _mesh_geometry(glb: Glb, mesh_index):
    meshes = glb.json.get("meshes") or []
    if not isinstance(mesh_index, int) or not 0 <= mesh_index < len(meshes):
        return None
    positions, faces, offset = [], [], 0
    for prim in meshes[mesh_index].get("primitives") or []:
        if not isinstance(prim, dict) or prim.get("mode", 4) != 4:
            continue                    # triangle lists only
        if any(ext in (prim.get("extensions") or {}) for ext in _COMPRESSION):
            raise GlbError("compressed geometry (Draco / meshopt) is not supported")
        attrs = prim.get("attributes") or {}
        if "POSITION" not in attrs:
            continue
        acc_index = attrs["POSITION"]
        P = read_accessor(glb, acc_index)
        if P.shape[1] != 3:
            raise GlbError(f"POSITION accessor {acc_index} is not VEC3")
        if "indices" in prim:
            flat = read_accessor(glb, prim["indices"]).reshape(-1)
            F = flat[: len(flat) // 3 * 3].reshape(-1, 3).astype(np.int64)
            F = F[((F >= 0) & (F < len(P))).all(axis=1)]
            if not len(F):
                continue
            # Exporters share one big vertex buffer between many meshes: keep
            # only the vertices this primitive uses (cost follows the triangle
            # count, not the size of the shared buffer).
            used, F = np.unique(F, return_inverse=True)
            P, F = P[used], F.reshape(-1, 3)
        else:
            F = np.arange(len(P) // 3 * 3, dtype=np.int64).reshape(-1, 3)
            P = P[: len(F) * 3]
            if not len(F):
                continue
        if P.dtype != np.float32:       # KHR_mesh_quantization-style integer positions
            scale = 1.0
            if glb.json["accessors"][acc_index].get("normalized"):
                scale = 1.0 / np.iinfo(P.dtype).max
            P = (P.astype(np.float32) * np.float32(scale)).astype(np.float32)
        positions.append(P)
        faces.append(F + offset)
        offset += len(P)
    if not positions:
        return None
    P = positions[0] if len(positions) == 1 else np.concatenate(positions)
    F = faces[0] if len(faces) == 1 else np.concatenate(faces)
    finite = np.isfinite(P).all(axis=1)
    if not finite.all():
        F = F[finite[F].all(axis=1)]
    if not len(F):
        return None
    return P, F


def iter_mesh_nodes(glb: Glb) -> Iterator[tuple[int, int, np.ndarray]]:
    """(node index, mesh index, world 4x4) for every scene node carrying a mesh
    with usable triangles and a finite transform."""
    order, _parent, _depth, world = glb.walk()
    for i in order:
        mesh = glb.nodes[i].get("mesh")
        if mesh is None or not np.isfinite(world[i]).all():
            continue
        if glb.mesh_geometry(mesh) is not None:
            yield i, mesh, world[i]


def iter_mesh_instances(glb: Glb) -> Iterator[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """(positions Nx3 float32 in mesh-local space, faces Mx3 int64, world 4x4)
    per mesh node. Nodes sharing a mesh get the very same arrays."""
    for _node, mesh, world in iter_mesh_nodes(glb):
        P, F = glb.mesh_geometry(mesh)
        yield P, F, world


# ---- names ----------------------------------------------------------------------

@_structural
def class_name(glb: Glb) -> str | None:
    """The ship's class name from ``extras.entity_name``
    (``EntityClassDefinition.<ClassName>``) of the shallowest node carrying one."""
    order, _parent, depth, _world = glb.walk()
    seen = set(order)
    candidates = sorted(order, key=lambda i: depth[i])          # stable: shallowest first
    candidates += [i for i in range(len(glb.nodes)) if i not in seen]
    for i in candidates:
        extras = glb.nodes[i].get("extras")
        value = extras.get("entity_name") if isinstance(extras, dict) else None
        if not isinstance(value, str):
            continue
        value = value.strip()
        if value.startswith(ENTITY_PREFIX):
            value = value[len(ENTITY_PREFIX):]
        if value:
            return value
    return None


def _is_hardpoint(node: dict) -> bool:
    name = node.get("name")
    return isinstance(name, str) and name.lower().startswith(HARDPOINT_PREFIX)


@_structural
def named_nodes(glb: Glb, max_nodes: int = MAX_NODES) -> list[dict]:
    """``[{name, parent, pos}]``: every named node that is a hardpoint (name
    starts with ``hardpoint``, any case) or has a hardpoint ancestor or
    descendant. ``parent`` indexes this list (-1 = none; unnamed links are
    skipped), ``pos`` is the world position in metres. Parents come first.

    Over ``max_nodes`` the hardpoints and their ancestors are kept first, then
    the shallowest of the remaining descendants.
    """
    order, parent, depth, world = glb.walk()
    nodes = glb.nodes
    is_hp = {i: _is_hardpoint(nodes[i]) for i in order}
    below = dict.fromkeys(order, False)        # has a hardpoint descendant
    for i in reversed(order):
        p = parent[i]
        if p >= 0 and (is_hp[i] or below[i]):
            below[p] = True
    above = dict.fromkeys(order, False)        # has a hardpoint ancestor
    for i in order:
        p = parent[i]
        if p >= 0 and (is_hp[p] or above[p]):
            above[i] = True

    def usable(i):
        name = nodes[i].get("name")
        return isinstance(name, str) and name != "" and bool(np.isfinite(world[i]).all())

    core = [i for i in order if usable(i) and (is_hp[i] or below[i])]
    extra = [i for i in order if usable(i) and above[i] and not (is_hp[i] or below[i])]
    if len(core) >= max_nodes:
        chosen = set(core[:max_nodes])
    else:
        extra.sort(key=lambda i: depth[i])     # stable: shallowest first
        chosen = set(core) | set(extra[: max_nodes - len(core)])
    out, index_of = [], {}
    for i in order:
        if i not in chosen:
            continue
        p = parent[i]
        while p >= 0 and p not in index_of:
            p = parent[p]
        index_of[i] = len(out)
        out.append({"name": nodes[i]["name"],
                    "parent": index_of[p] if p >= 0 else -1,
                    "pos": [round(float(v), 4) + 0.0 for v in world[i][:3, 3]]})
    return out
