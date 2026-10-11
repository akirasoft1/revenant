# wireframes — ship wireframe bundles from StarBreaker exports

Turns a StarBreaker `.glb` ship export into a small wireframe bundle
(`<ClassName>.swf.gz`, typically 100–650 KB) that the hangar editor draws as a
rotatable wireframe with markers at the real hardpoint positions. Pure
Python + numpy: no Blender, no GPU.

Design: `docs/superpowers/specs/2026-10-11-ship-wireframes-design.md`.

## Never commit exports or bundles

This repository and its history are **public**. `.glb` exports and `.swf.gz`
bundles are extracted game geometry and stay on your machine and in the
private model store (uploaded on the editor's admin "Ship models" page).

- `.gitignore` and `.dockerignore` cover `*.glb`, `*.swf.gz` and
  `tools/wireframes/out/` (the default output folder). Do not force-add them.
- The tests build all their geometry in code (`tests/synth.py`). Never add a
  real export, or anything derived from one, as a fixture.

## Export settings (StarBreaker)

| Setting | Value |
| --- | --- |
| Format | GLB (binary glTF 2.0, no Draco) |
| LOD | 1 |
| Texture mip | 6 (textures are not used; this only keeps the file small) |
| Interiors | excluded |
| Lights | off |
| Animations | off |

The export is Y-up under a `CryEngine_Z_up` root node, keeps every game
hardpoint as a named node, and carries the class name in a node's
`extras.entity_name` (`EntityClassDefinition.<ClassName>`).

## Setup

Python ≥ 3.11 with numpy (pytest for the tests):

```bash
cd tools
python3 -m venv .venv && . .venv/bin/activate     # optional; tools/.venv is git-ignored
pip install -r requirements.txt
```

## Commands

Run from `tools/`:

```bash
python -m wireframes build "/mnt/d/starcitizen-exports/Aegis Avenger Stalker.glb"
python -m wireframes build-all /mnt/d/starcitizen-exports --jobs 8
python -m wireframes inspect wireframes/out/AEGS_Avenger_Stalker.swf.gz
```

- **`build <file.glb>`** writes `OUT_DIR/<ClassName>.swf.gz` and prints one
  summary line (lines, bytes, hardpoint count, seconds).
- **`build-all <folder>`** builds every `*.glb` directly in the folder (not
  recursive), one process per ship, at most `--jobs` at a time. It prints a
  result table and exits non-zero if any ship failed or two files produced the
  same class name; the others still complete.
- **`inspect <bundle>`** prints the header JSON and the line count.

### Flags (`build` and `build-all`)

| Flag | Default | Meaning |
| --- | --- | --- |
| `-o OUT_DIR` | `tools/wireframes/out/` | Output folder. |
| `--crease-deg` | `60` | Keep an edge when its two faces differ by more than this angle. |
| `--min-edge-frac` | `0.0025` | Drop edges shorter than this fraction of the longest dimension. |
| `--max-lines` | `60000` | Keep at most this many edges, longest first (the server refuses more than 80,000). |
| `--no-visibility` | off | Skip the visible-from-outside cull. Keeps interior edges; big ships become unreadable. |
| `--depth-res` | `640` | Depth-map resolution for the visibility cull. |
| `--kind` | `vehicle` | Bundle kind. The server only accepts `vehicle` today. |
| `--class-name NAME` | from the GLB | Use this class name. **Required when the GLB has none** — the build fails and says so. With `build-all` it is only allowed when the folder holds a single `.glb`. |
| `--jobs N` (`build-all`) | `8` | Ships built at the same time. |

### `--jobs` is a real core count

Each worker is a fresh process that sets `OMP_NUM_THREADS`,
`OPENBLAS_NUM_THREADS` and `MKL_NUM_THREADS` to `1` before numpy is imported,
so `--jobs 8` uses 8 cores, not 8 × (BLAS threads). Set it to your
performance-core count; the default is 8, never "all cores". `build` pins the
same variables. `wireframes/cli.py` and `wireframes/__init__.py` must stay free
of top-level numpy imports for this to hold (a test checks it).

## What the pipeline does

1. **Parse** the GLB: JSON + BIN chunk, accessors (with `byteStride`), node
   transforms (matrix or translation/rotation/scale), triangle lists. Each
   mesh keeps only the vertices its triangles use — exports share one large
   vertex buffer between many meshes.
2. **Feature edges**, once per mesh in its own space: weld vertices on a 1 mm
   grid, then keep boundary edges and creases sharper than `--crease-deg`.
   An edge shared by three or more triangles is kept unless they are all
   parallel (so a double-sided panel gives only its outline).
3. **Place** the edges with each node's world transform.
4. **Visibility cull**: surfaces are point-sampled (4 samples per depth pixel)
   into depth maps along 26 directions; an edge survives when any of 3 points
   along it is at the front of some view (within 2 pixels).
5. **Minimum length**: drop edges shorter than `--min-edge-frac` × the longest
   dimension.
6. **Stray fragments**: drop edges whose midpoint is farther than 1.25 × the
   99.5th-percentile distance from the median centre (exports sometimes carry
   a detached decal tens of metres off the hull).
7. **Budget**: keep the `--max-lines` longest.
8. **Quantise** to int16 and gzip.

Typical times on one core: 1–5 s per ship, about 200–700 MB of memory
(the 120 MB / 3.9M-triangle Ironclad Assault takes about 5 s).

Surface sampling is random but seeded, so the same input and flags give the
same bundle, byte for byte.

## Bundle format (`.swf.gz`)

gzip of:

```
b"SWF1" | uint32 LE headerLen | header JSON (UTF-8) | int16 LE × (lines × 6)
```

Each line is `x0 y0 z0 x1 y1 z1`; a coordinate is
`center[axis] + int16 / 32767 × halfExtent` (metres, glTF Y-up).

Header keys, exactly: `format` (1), `kind`, `className`, `sourceName`,
`space` (`"gltf-y-up-m"`), `center`, `halfExtent`, `lines`, `nodes`, `build`
(`creaseDeg`, `minEdgeFrac`, `maxLines`, `visibility`, `depthRes`, `tool`).

`nodes` is `[{name, parent, pos}]`: every named node that is a hardpoint (name
starts with `hardpoint`, any case) or has a hardpoint ancestor or descendant.
`parent` is an index into the list (`-1` for none; parents come first) and
`pos` the world position. The server walks these names to place slot markers.
The list is capped at 5,000 nodes: hardpoints and their ancestors are kept
first, then the shallowest of the rest.

## Limits

- Not read: Draco / meshopt compression (rejected with a message), external
  buffers (rejected), sparse accessors, triangle strips and fans (skipped).
- Welding and the crease test run in each mesh's own space, so a node with a
  non-uniform scale is welded at 1 mm × its scale.
- The minimum length and the depth-map resolution are measured on the
  bounding box before the stray-fragment filter runs, so a far-off stray
  fragment makes both slightly coarser for that ship.

## Tests

```bash
cd tools && python3 -m pytest -q wireframes
```

## Layout

| File | Role |
| --- | --- |
| `glb.py` | GLB reader: node tree, transforms, triangles, class name, named nodes |
| `edges.py` | Welding, feature edges, length / stray / budget filters |
| `visibility.py` | Surface sampling and the 26-direction depth-map cull |
| `bundle.py` | Bundle writer and reader |
| `pipeline.py` | One GLB → one bundle |
| `cli.py` | `build`, `build-all`, `inspect`; the one-process-per-ship scheduler |
