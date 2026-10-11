"""Keep only the edges that can be seen from outside the ship.

Surfaces are point-sampled and splatted into orthographic depth maps looking
along 26 directions (the 13 axis / face-diagonal / body-diagonal lines, both
ways). An edge survives when any of its 3 test points lies at the front of at
least one depth map. No GPU, no ray tracing: numpy only.
"""
from __future__ import annotations

import itertools
from typing import Iterator

import numpy as np

from .edges import robust_bounds
from .glb import Glb, iter_mesh_nodes

DIRECTIONS = np.array([d for d in itertools.product((-1, 0, 1), repeat=3) if any(d)],
                      dtype=np.float64)
TEST_FRACTIONS = (0.25, 0.5, 0.75)      # 3 test points per edge
SAMPLES_PER_PIXEL_SIDE = 2              # surface sample spacing = pixel / 2
_BLOCK = 1 << 15                        # points projected at a time (stays in cache)
_YIELD = 1 << 18                        # surface samples handed over at a time


def _bounds(segs, bounds=None):
    """(centre, diagonal) of the view volume: ``bounds`` = (lo, hi) if given,
    else the robust bounds of ``segs`` (stray fragments do not count)."""
    if bounds is None:
        bounds = robust_bounds(segs)
    if bounds is None:
        return np.zeros(3), 0.0
    lo, hi = (np.asarray(v, dtype=np.float64) for v in bounds)
    return (lo + hi) * 0.5, float(np.linalg.norm(hi - lo))


def pixel_size(segs, depth_res: int, bounds=None) -> float:
    """Depth-map pixel size in metres: (robust) bounding-box diagonal / resolution."""
    return _bounds(segs, bounds)[1] / float(depth_res)


def _basis(d: np.ndarray):
    w = d / np.linalg.norm(d)
    up = np.array([0.0, 1.0, 0.0]) if abs(w[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(up, w)
    u /= np.linalg.norm(u)
    return u, np.cross(w, u), w


class DepthMaps:
    """Front-most surface depth per pixel, for all 26 view directions.

    Opposite directions share one pixel grid: the nearest sample along +w is the
    front for one, the farthest for the other, so 13 projections serve 26 views.
    """

    def __init__(self, center, extent: float, depth_res: int = 640, eps_px: float = 2.0):
        self.res = int(depth_res)
        self.center = np.asarray(center, dtype=np.float32)
        extent = float(extent) if extent > 0 else 1.0
        # one spare pixel on each side so the bounding box never lands on the rim
        self.px = extent * (1.0 + 2.0 / self.res) / self.res
        self.eps = np.float32(eps_px * self.px)
        self.width = self.res + 2                  # plus a border ring for out-of-view points
        axes = [d for d in DIRECTIONS if tuple(d) > (0.0, 0.0, 0.0)]
        self.pairs = len(axes)                     # 13
        cols_uv, cols_w = [], []
        for d in axes:
            u, v, w = _basis(d)
            cols_uv += [u / self.px, v / self.px]
            cols_w.append(w)
        self._proj = np.array(cols_uv + cols_w, dtype=np.float32)          # (39, 3)
        cells = self.width * self.width
        self._offsets = (np.arange(self.pairs, dtype=np.int64) * cells)[:, None]
        self._near = np.full(self.pairs * cells, np.inf, dtype=np.float32)
        self._far = np.full(self.pairs * cells, -np.inf, dtype=np.float32)
        self._closed = None
        self.samples = 0

    @classmethod
    def for_segments(cls, segs, depth_res: int = 640, eps_px: float = 2.0, *,
                     bounds=None) -> "DepthMaps":
        """Maps framed on ``bounds`` (lo, hi), by default the robust bounds of
        ``segs``. Anything outside the frame counts as visible and occludes
        nothing in it."""
        center, extent = _bounds(segs, bounds)
        return cls(center, extent, depth_res, eps_px)

    def _project(self, pts: np.ndarray):
        """(flat cell index (13, n), depth along +w (13, n)) for a block of points."""
        rel = np.ascontiguousarray((pts - self.center).T, dtype=np.float32)   # (3, n)
        proj = self._proj @ rel                                               # (39, n)
        uv = proj[: 2 * self.pairs]
        uv += np.float32(self.res * 0.5 + 1.0)
        np.clip(uv, 0.0, np.float32(self.width - 1), out=uv)       # out of view -> border ring
        cell = uv.astype(np.int64)
        index = cell[1::2] * self.width + cell[0::2] + self._offsets
        return index, proj[2 * self.pairs:]

    def add(self, points) -> None:
        """Splat surface points into the depth maps."""
        points = np.asarray(points, dtype=np.float32).reshape(-1, 3)
        self._closed = None
        self.samples += len(points)
        for s in range(0, len(points), _BLOCK):
            index, depth = self._project(points[s:s + _BLOCK])
            index, depth = index.ravel(), depth.ravel()
            np.minimum.at(self._near, index, depth)
            np.maximum.at(self._far, index, depth)

    def _close(self):
        """Clear the border ring, then 3x3 min / max to close sampling pinholes."""
        if self._closed is None:
            w = self.width
            out = []
            for maps, fill, reduce in ((self._near, np.inf, np.minimum),
                                       (self._far, -np.inf, np.maximum)):
                m = maps.reshape(self.pairs, w, w).copy()
                m[:, 0, :] = m[:, -1, :] = fill
                m[:, :, 0] = m[:, :, -1] = fill
                pad = np.pad(m, ((0, 0), (1, 1), (1, 1)), constant_values=fill)
                acc = m
                for dy in range(3):
                    for dx in range(3):
                        acc = reduce(acc, pad[:, dy:dy + w, dx:dx + w])
                out.append(acc.reshape(-1))
            self._closed = tuple(out)
        return self._closed

    def visible(self, points) -> np.ndarray:
        """True for each point that is at the front of at least one view."""
        points = np.asarray(points, dtype=np.float32).reshape(-1, 3)
        near, far = self._close()
        out = np.zeros(len(points), dtype=bool)
        for s in range(0, len(points), _BLOCK):
            index, depth = self._project(points[s:s + _BLOCK])
            front = (depth <= near[index] + self.eps) | (depth >= far[index] - self.eps)
            out[s:s + _BLOCK] = front.any(axis=0)
        return out

    def segments_visible(self, segs) -> np.ndarray:
        segs = np.asarray(segs).reshape(-1, 6)
        a, b = segs[:, :3], segs[:, 3:]
        out = np.zeros(len(segs), dtype=bool)
        for f in TEST_FRACTIONS:
            out |= self.visible(a * (1.0 - f) + b * f)
        return out


def cull_hidden(segs, surface_points, depth_res: int = 640, eps_px: float = 2.0, *,
                bounds=None) -> np.ndarray:
    """The rows of ``segs`` (Kx6) visible from outside, given points sampled on
    every surface (see :func:`sample_surface`; use spacing ``pixel_size / 2``).
    ``surface_points`` may also be an iterable of point arrays. The views are
    framed on ``bounds`` (lo, hi), by default the robust bounds of ``segs``;
    edges outside the frame (stray fragments) are returned as visible."""
    segs = np.asarray(segs).reshape(-1, 6)
    if not len(segs):
        return segs
    maps = DepthMaps.for_segments(segs, depth_res, eps_px, bounds=bounds)
    if isinstance(surface_points, np.ndarray):
        surface_points = (surface_points,)
    for chunk in surface_points:
        maps.add(chunk)
    return segs[maps.segments_visible(segs)]


def iter_surface_samples(glb: Glb, spacing: float, rng, *,
                         max_per_triangle: int = 2_000_000) -> Iterator[np.ndarray]:
    """Batches of world-space points (float32, Nx3) covering every triangle at
    about one point per ``spacing`` x ``spacing`` of area, plus the mesh
    vertices. Random within each triangle, so a seeded ``rng`` reproduces."""
    if not spacing > 0:
        raise ValueError("spacing must be positive")
    cell = np.float32(spacing * spacing)
    pending, held = [], 0
    for _node, mesh, world in iter_mesh_nodes(glb):
        P, F = glb.mesh_geometry(mesh)
        rot = world[:3, :3].astype(np.float32)
        Pw = P @ rot.T + world[:3, 3].astype(np.float32)
        if not np.isfinite(Pw).all():
            continue
        origin = Pw[F[:, 0]]
        e1 = Pw[F[:, 1]] - origin
        e2 = Pw[F[:, 2]] - origin
        area = 0.5 * np.linalg.norm(np.cross(e1, e2), axis=1)
        count = np.ceil(np.nan_to_num(area, posinf=0.0) / cell)
        count = np.clip(count, 1, max_per_triangle).astype(np.int64)
        total = np.cumsum(count)
        blocks = [Pw]
        start = 0
        while start < len(F):
            base = int(total[start - 1]) if start else 0
            end = max(start + 1, int(np.searchsorted(total, base + _YIELD, side="right")))
            tri = np.repeat(np.arange(start, end), count[start:end])
            s = rng.random(len(tri), dtype=np.float32)
            t = rng.random(len(tri), dtype=np.float32)
            flip = s + t > 1.0                          # fold the square onto the triangle
            s = np.where(flip, 1.0 - s, s)
            t = np.where(flip, 1.0 - t, t)
            blocks.append(origin[tri] + s[:, None] * e1[tri] + t[:, None] * e2[tri])
            start = end
        for block in blocks:
            pending.append(block)
            held += len(block)
            if held >= _YIELD:
                yield np.concatenate(pending) if len(pending) > 1 else pending[0]
                pending, held = [], 0
    if pending:
        yield np.concatenate(pending)


def sample_surface(glb: Glb, spacing: float, rng, *,
                   max_per_triangle: int = 2_000_000) -> np.ndarray:
    """All of :func:`iter_surface_samples` as one Nx3 float32 array."""
    chunks = list(iter_surface_samples(glb, spacing, rng, max_per_triangle=max_per_triangle))
    if not chunks:
        return np.zeros((0, 3), dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32, copy=False)
