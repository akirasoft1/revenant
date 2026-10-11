"""Feature edges of a triangle mesh, and the size / stray / budget filters."""
from __future__ import annotations

import numpy as np

STRAY_PERCENTILE = 99.5
STRAY_FACTOR = 1.25
_EMPTY = np.zeros((0, 6), dtype=np.float64)


def _weld(P: np.ndarray, weld: float):
    """(V, inverse): vertices merged on a ``weld``-sized grid."""
    q = P / weld
    if np.abs(q).max() >= 2.0 ** 52:           # far beyond any grid: do not merge
        return P, np.arange(len(P), dtype=np.int64)
    q = np.rint(q).astype(np.int64)
    lo = q.min(axis=0)
    q -= lo
    span = q.max(axis=0) + 1
    if float(span[0]) * float(span[1]) * float(span[2]) < 2.0 ** 62:
        # one int64 key per vertex: a 1-D sort instead of a row-wise unique
        key = (q[:, 0] * span[1] + q[:, 1]) * span[2] + q[:, 2]
        uniq, inverse = np.unique(key, return_inverse=True)
        count = len(uniq)
    else:
        rows, inverse = np.unique(q, axis=0, return_inverse=True)
        count = len(rows)
    inverse = inverse.reshape(-1)
    V = np.empty((count, 3), dtype=np.float64)
    V[inverse[::-1]] = P[::-1]                 # the first vertex of each cell represents it
    return V, inverse


def feature_edges(P, F, crease_rad: float, weld: float = 0.001) -> np.ndarray:
    """Kx6 segments (same space as ``P``) for the edges worth drawing.

    Vertices closer than ``weld`` are merged first (exports split vertices
    along UV / normal seams). An edge is kept when
    - one triangle uses it (a boundary), or
    - two triangles use it and their normals differ by more than ``crease_rad``, or
    - three or more use it and they are not all (anti)parallel within
      ``crease_rad`` (so a double-sided flat sheet contributes its outline only).
    Zero-area and repeated-vertex triangles are ignored.
    """
    if not weld > 0:
        raise ValueError("weld tolerance must be positive")
    P = np.asarray(P, dtype=np.float64).reshape(-1, 3)
    F = np.asarray(F, dtype=np.int64).reshape(-1, 3)
    if not len(P) or not len(F):
        return _EMPTY.copy()
    F = F[((F >= 0) & (F < len(P))).all(axis=1)]
    finite = np.isfinite(P).all(axis=1)
    if not finite.all():
        F = F[finite[F].all(axis=1)]
        P = np.where(finite[:, None], P, 0.0)
    if not len(F):
        return _EMPTY.copy()

    V, inverse = _weld(P, weld)
    F = inverse[F]
    a, b, c = F[:, 0], F[:, 1], F[:, 2]
    F = F[(a != b) & (b != c) & (a != c)]
    if not len(F):
        return _EMPTY.copy()
    v0 = V[F[:, 0]]
    normal = np.cross(V[F[:, 1]] - v0, V[F[:, 2]] - v0)
    length = np.sqrt(np.einsum("ij,ij->i", normal, normal))
    ok = length > 1e-12
    if not ok.all():
        F, normal, length = F[ok], normal[ok], length[ok]
        if not len(F):
            return _EMPTY.copy()
    normal /= length[:, None]

    n_faces, n_verts = len(F), len(V)
    e0 = np.concatenate([F[:, 0], F[:, 1], F[:, 2]])
    e1 = np.concatenate([F[:, 1], F[:, 2], F[:, 0]])
    key = np.minimum(e0, e1) * n_verts + np.maximum(e0, e1)
    order = np.argsort(key)
    key = key[order]
    face = order % n_faces                     # half-edge i belongs to face i mod n_faces
    start = np.flatnonzero(np.concatenate([[True], key[1:] != key[:-1]]))
    count = np.diff(np.concatenate([start, [len(key)]]))
    cos_crease = np.cos(crease_rad)

    keep = count == 1
    two = np.flatnonzero(count == 2)
    if len(two):
        i = start[two]
        cos = np.einsum("ij,ij->i", normal[face[i]], normal[face[i + 1]])
        keep[two] = cos < cos_crease
    many = np.flatnonzero(count > 2)
    if len(many):
        sizes = count[many]
        offsets = np.concatenate([[0], np.cumsum(sizes)[:-1]])
        entries = np.repeat(start[many] - offsets, sizes) + np.arange(sizes.sum())
        faces = face[entries]
        reference = np.repeat(np.minimum.reduceat(faces, offsets), sizes)
        spread = np.abs(np.einsum("ij,ij->i", normal[faces], normal[reference]))
        keep[many] = np.minimum.reduceat(spread, offsets) < cos_crease

    edge = key[start[keep]]
    return np.concatenate([V[edge // n_verts], V[edge % n_verts]], axis=1)


def filter_and_budget(segs, min_frac: float, max_lines: int, *,
                      stray_percentile: float = STRAY_PERCENTILE,
                      stray_factor: float = STRAY_FACTOR) -> np.ndarray:
    """Size-relative minimum length, stray-fragment filter, longest-first cap.

    1. drop edges shorter than ``min_frac`` x the longest bounding-box dimension
       (and zero-length / non-finite ones);
    2. drop edges whose midpoint is farther than ``stray_factor`` x the robust
       radius (``stray_percentile`` of the distances from the median centre);
    3. keep the ``max_lines`` longest. The result is sorted longest first.
    """
    segs = np.asarray(segs).reshape(-1, 6)
    segs = segs[np.isfinite(segs).all(axis=1)]
    if not len(segs):
        return segs
    a, b = segs[:, :3].astype(np.float64), segs[:, 3:].astype(np.float64)
    length = np.linalg.norm(b - a, axis=1)
    lo = np.minimum(a.min(axis=0), b.min(axis=0))
    hi = np.maximum(a.max(axis=0), b.max(axis=0))
    keep = (length > 0) & (length >= min_frac * float((hi - lo).max()))
    segs, length, a, b = segs[keep], length[keep], a[keep], b[keep]
    if not len(segs):
        return segs

    mid = (a + b) * 0.5
    dist = np.linalg.norm(mid - np.median(mid, axis=0), axis=1)
    radius = float(np.percentile(dist, stray_percentile))
    if radius > 0:
        keep = dist <= stray_factor * radius
        segs, length = segs[keep], length[keep]

    order = np.argsort(-length, kind="stable")[: max(int(max_lines), 0)]
    return segs[order]
