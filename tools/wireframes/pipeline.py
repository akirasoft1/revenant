"""GLB -> wireframe bundle. Imports numpy: load lazily from the CLI."""
from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .bundle import write_bundle
from .edges import feature_edges, filter_and_budget
from .glb import HARDPOINT_PREFIX, Glb, class_name, iter_mesh_nodes, load_glb, named_nodes
from .visibility import SAMPLES_PER_PIXEL_SIDE, DepthMaps, iter_surface_samples

SAMPLE_SEED = 1
_CLASS_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")   # same rule as the server


class BuildError(Exception):
    """A build failed for a reason the user can act on."""


@dataclass(frozen=True)
class Options:
    crease_deg: float = 60.0
    min_edge_frac: float = 0.0025
    max_lines: int = 60_000
    visibility: bool = True
    depth_res: int = 640
    kind: str = "vehicle"
    class_name: str | None = None
    weld: float = 0.001


def resolve_class_name(glb: Glb, override: str | None) -> str:
    name = override if override is not None else class_name(glb)
    if name is None:
        raise BuildError("no class name found (no node has extras.entity_name) — "
                         "pass --class-name NAME")
    if not _CLASS_NAME.fullmatch(name):
        raise BuildError(f"invalid class name {name!r}: use letters, digits, '_', '.' and '-' "
                         "(at most 128, starting with a letter or digit)")
    return name


def scene_edges(glb: Glb, crease_rad: float, weld: float = 0.001) -> np.ndarray:
    """World-space feature edges (Kx6 float64) of every mesh node. Edges are
    found once per mesh in its own space, then placed per node."""
    per_mesh: dict[int, np.ndarray] = {}
    out = []
    for _node, mesh, world in iter_mesh_nodes(glb):
        if mesh not in per_mesh:
            per_mesh[mesh] = feature_edges(*glb.mesh_geometry(mesh), crease_rad, weld)
        local = per_mesh[mesh]
        if not len(local):
            continue
        rot, shift = world[:3, :3].T, world[:3, 3]
        placed = np.concatenate([local[:, :3] @ rot + shift, local[:, 3:] @ rot + shift], axis=1)
        out.append(placed[np.isfinite(placed).all(axis=1)])
    return np.concatenate(out) if out else np.zeros((0, 6), dtype=np.float64)


def build_bundle(src, out_dir, options: Options = Options()) -> dict:
    """Build ``out_dir/<ClassName>.swf.gz`` from one GLB. Returns a summary dict."""
    t0 = time.perf_counter()
    src = Path(src)
    glb = load_glb(src)
    name = resolve_class_name(glb, options.class_name)

    segs = scene_edges(glb, math.radians(options.crease_deg), options.weld)
    feature_count = len(segs)
    t_edges = time.perf_counter()
    if not feature_count:
        raise BuildError("no edges found (the file has no triangle meshes)")

    samples = 0
    if options.visibility:
        maps = DepthMaps.for_segments(segs, options.depth_res)
        rng = np.random.default_rng(SAMPLE_SEED)
        spacing = maps.px / SAMPLES_PER_PIXEL_SIDE
        # a triangle never needs more samples than a few screens' worth
        cap = 8 * options.depth_res * options.depth_res
        for chunk in iter_surface_samples(glb, spacing, rng, max_per_triangle=cap):
            maps.add(chunk)
        samples = maps.samples
        segs = segs[maps.segments_visible(segs)]
    visible_count = len(segs)
    t_vis = time.perf_counter()

    segs = filter_and_budget(segs, options.min_edge_frac, options.max_lines)
    if not len(segs):
        raise BuildError("no edges left after filtering "
                         "(try a smaller --min-edge-frac or --no-visibility)")

    nodes = named_nodes(glb)
    path = Path(out_dir) / f"{name}.swf.gz"
    header = write_bundle(
        path, kind=options.kind, class_name=name, source_name=src.name, segs=segs, nodes=nodes,
        build={"creaseDeg": float(options.crease_deg), "minEdgeFrac": float(options.min_edge_frac),
               "maxLines": int(options.max_lines), "visibility": bool(options.visibility),
               "depthRes": int(options.depth_res)})
    done = time.perf_counter()
    return {
        "file": src.name, "className": name, "path": str(path), "lines": header["lines"],
        "bytes": path.stat().st_size, "nodes": len(nodes),
        "hardpoints": sum(n["name"].lower().startswith(HARDPOINT_PREFIX) for n in nodes),
        "featureEdges": feature_count, "visibleEdges": visible_count, "samples": samples,
        "seconds": done - t0, "edgeSeconds": t_edges - t0, "visibilitySeconds": t_vis - t_edges,
    }
