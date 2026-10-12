"""The ``.swf.gz`` wireframe bundle.

gzip of::

    b"SWF1" | uint32 LE headerLen | header JSON (UTF-8) | int16 LE x (lines * 6)
           [| uint32 LE x lines]                    (only when the header has "views")

Each line is two points (x, y, z, x, y, z); a coordinate decodes as
``center[axis] + value / 32767 * halfExtent``.

Optional per-view visibility: header ``views`` is a list of up to 32 unit
vectors pointing from the ship toward a viewer, and the trailing uint32 per line
has bit ``i`` set when the line can be seen from ``views[i]``. A viewer uses it
to hide the lines the current camera cannot see (hidden-line removal).
"""
from __future__ import annotations

import gzip
import io
import json
import math
import os
import struct
from pathlib import Path

import numpy as np

from . import __version__

MAGIC = b"SWF1"
FORMAT = 1
SPACE = "gltf-y-up-m"
MAX_NODES = 5000
MAX_VIEWS = 32
BUILD_KEYS = ("creaseDeg", "minEdgeFrac", "maxLines", "visibility", "depthRes")
HEADER_KEYS = ("format", "kind", "className", "sourceName", "space", "center", "halfExtent",
               "lines", "nodes", "build")


class BundleError(Exception):
    """Not a readable wireframe bundle."""


def _check_nodes(nodes) -> list[dict]:
    out = []
    for i, n in enumerate(nodes):
        try:
            name, parent, pos = n["name"], int(n["parent"]), [float(v) for v in n["pos"]]
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"node {i} is malformed ({e})") from e
        if not isinstance(name, str) or len(pos) != 3 or not all(map(math.isfinite, pos)):
            raise ValueError(f"node {i} needs a string name and a finite [x, y, z] position")
        if not -1 <= parent < i:
            raise ValueError(f"node {i} has parent {parent}; parents must come first")
        out.append({"name": name, "parent": parent, "pos": pos})
    if len(out) > MAX_NODES:
        raise ValueError(f"{len(out)} nodes exceeds the limit of {MAX_NODES}")
    return out


def write_bundle(path, *, kind: str, class_name: str, source_name: str, segs, nodes,
                 build: dict, views=None, masks=None) -> dict:
    """Quantise ``segs`` (Kx6, metres) and write the bundle. Returns the header.

    ``build`` must hold exactly ``creaseDeg, minEdgeFrac, maxLines, visibility,
    depthRes``; ``tool`` is added here. The file is written to a temporary name
    and renamed, so a failed build never leaves a half-written bundle.

    ``views`` (Vx3 unit vectors, V <= 32) with ``masks`` (one uint32 per segment)
    adds the optional per-view visibility; give both or neither.
    """
    segs = np.asarray(segs, dtype=np.float64)
    if segs.ndim != 2 or segs.shape[1] != 6:
        raise ValueError("segs must be a Kx6 array")
    if not len(segs):
        raise ValueError("no line segments to write")
    if not np.isfinite(segs).all():
        raise ValueError("segments contain NaN or infinite coordinates")
    if set(build) != set(BUILD_KEYS):
        raise ValueError(f"build must have exactly the keys {', '.join(BUILD_KEYS)}")
    nodes = _check_nodes(nodes)
    if (views is None) != (masks is None):
        raise ValueError("views and masks go together")
    if views is not None:
        views = np.asarray(views, dtype=np.float64)
        masks = np.asarray(masks)
        if views.ndim != 2 or views.shape[1] != 3 or not 1 <= len(views) <= MAX_VIEWS:
            raise ValueError(f"views must be 1 to {MAX_VIEWS} [x, y, z] vectors")
        if not np.isfinite(views).all():
            raise ValueError("views contain NaN or infinite values")
        if masks.shape != (len(segs),):
            raise ValueError("masks must have one value per segment")
        masks = masks.astype("<u4")

    pts = segs.reshape(-1, 3)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    center = np.round((lo + hi) * 0.5, 4) + 0.0
    half = float(np.abs(pts - center).max())
    half = math.ceil(half * 1e4) / 1e4 if half > 0 else 1.0
    quant = np.rint((pts - center) / half * 32767.0)
    quant = np.clip(quant, -32767, 32767).astype("<i2")

    header = {
        "format": FORMAT,
        "kind": str(kind),
        "className": str(class_name),
        "sourceName": str(source_name),
        "space": SPACE,
        "center": [float(v) for v in center],
        "halfExtent": half,
        "lines": int(len(segs)),
        "nodes": nodes,
        "build": {**{k: build[k] for k in BUILD_KEYS}, "tool": f"wireframes/{__version__}"},
    }
    if views is not None:
        header["views"] = [[round(float(v), 6) + 0.0 for v in row] for row in views]
    head = json.dumps(header, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")
    raw = MAGIC + struct.pack("<I", len(head)) + head + quant.tobytes()
    if masks is not None:
        raw += masks.tobytes()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0, filename="") as gz:
        gz.write(raw)

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # the temporary name still ends in .swf.gz so the ignore rules cover it
    tmp = path.with_name(f".tmp-{os.getpid()}-{path.name}")
    try:
        tmp.write_bytes(buf.getvalue())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return header


def read_bundle(src) -> tuple[dict, np.ndarray]:
    """(header, Kx6 float32 positions in metres) from a path or bytes."""
    header, pos, _masks = read_bundle_full(src)
    return header, pos


def read_bundle_full(src) -> tuple[dict, np.ndarray, np.ndarray | None]:
    """(header, Kx6 float32 positions, per-line uint32 view masks or None)."""
    if isinstance(src, (bytes, bytearray, memoryview)):
        data = bytes(src)
    else:
        try:
            data = Path(src).read_bytes()
        except OSError as e:
            raise BundleError(f"cannot read file: {e.strerror or e}") from e
    try:
        raw = gzip.decompress(data)
    except (OSError, EOFError, ValueError) as e:
        raise BundleError(f"not a gzip file ({e})") from e
    if raw[:4] != MAGIC:
        raise BundleError("bad magic (not a SWF1 wireframe bundle)")
    if len(raw) < 8:
        raise BundleError("truncated bundle")
    (hlen,) = struct.unpack_from("<I", raw, 4)
    if 8 + hlen > len(raw):
        raise BundleError("truncated bundle (header runs past the end)")
    try:
        header = json.loads(raw[8:8 + hlen].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise BundleError(f"header is not valid JSON ({e})") from e
    if not isinstance(header, dict):
        raise BundleError("header is not a JSON object")
    try:
        lines = int(header["lines"])
        center = np.array(header["center"], dtype=np.float64).reshape(3)
        half = float(header["halfExtent"])
    except (KeyError, TypeError, ValueError) as e:
        raise BundleError(f"header lacks a usable lines / center / halfExtent ({e})") from e
    payload = raw[8 + hlen:]
    has_views = "views" in header
    need = lines * (16 if has_views else 12)
    if lines < 0 or len(payload) != need:
        raise BundleError(f"payload is {len(payload)} bytes; {lines} lines need {need}")
    quant = np.frombuffer(payload, dtype="<i2", count=lines * 6).reshape(lines, 6).astype(np.float64)
    pos = np.tile(center, 2) + quant / 32767.0 * half
    masks = np.frombuffer(payload, dtype="<u4", offset=lines * 12).copy() if has_views else None
    return header, pos.astype(np.float32), masks
