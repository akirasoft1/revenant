# Ship Wireframes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local pipeline turns StarBreaker `.glb` exports into small wireframe bundles; an admin page uploads them; the Terminal ship panel shows a rotatable wireframe with markers at real hardpoint positions.

**Architecture:** `tools/wireframes/` (pure Python + numpy CLI) writes `.swf.gz` bundles (header JSON + int16 line data). hangar-service validates and stores bundles (private GCS bucket + Firestore metadata), matches the bundle's node tree to catalog slot ids and writes `vehiclePositions`, and serves bundles to members. The editor adds a lazily loaded three.js `WireframeViewer`, wires it into `ShipPanel`, and adds an admin "Ship models" page.

**Tech Stack:** Python ≥ 3.11 + numpy + pytest (tools); FastAPI, google-cloud-storage, Firestore, pytest (hangar-service); React 18 + TS + Vite + TanStack Query + three.js + Vitest (hangar-editor).

**Spec:** `docs/superpowers/specs/2026-10-11-ship-wireframes-design.md` (binding — bundle format, routes, matching rule, thresholds, flags).

## Global Constraints
- **No extracted game data in the repo or any image:** tests build synthetic GLBs/bundles in code; never add `.glb`/`.swf.gz` fixtures; `.gitignore` already ignores `*.swf.gz`, `*.glb`, `tools/wireframes/out/` — add the same to the root `.dockerignore`.
- Bundle format exactly: gzip of `b"SWF1"` + `uint32 LE headerLen` + header JSON + `int16 LE` × `lines*6`; position = `center + int16/32767 * halfExtent`; header keys exactly as the spec (`format, kind, className, sourceName, space, center, halfExtent, lines, nodes, build`).
- Defaults: crease 60°, weld 1 mm, min edge 0.25% of the longest dimension, max 60,000 lines (longest first), visibility on (26 directions, depth res 640, 3 test points per edge), stray filter 1.25× the 99.5th-percentile radius, `build-all --jobs` default **8**; workers set `OMP_NUM_THREADS=OPENBLAS_NUM_THREADS=MKL_NUM_THREADS=1` BEFORE importing numpy.
- Server limits: upload ≤ 2 MB (413), decompressed ≤ 8 MB, ≤ 80,000 lines, ≤ 5,000 nodes, `kind == "vehicle"`; admin = session principal in `HANGAR_ADMIN_IDS` + same-origin; model routes under `/api/v1` only; bucket unset → 503 `unavailable` on model routes only.
- Slot matching: case-insensitive name walk per path segment, nearest descendants (BFS, don't descend past a match); one → `{xyz}`; none → `missing`; several → first if all within 0.05 m, else `ambiguous`.
- Editor: `three` imported only inside the lazy viewer chunk; `localStorage` key `hangar.shipVisual` = `"wireframe"|"render"`, default wireframe, try/catch; every viewer failure falls back to the render panel.
- Stage explicit paths only; commit trailer lines `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` then `Claude-Session: https://claude.ai/code/session_01Tqoz2C7KZNHqJGMzGQgsrQ`; TDD; never read/print `.env*`; no deploys/gcloud by implementers. Suites: `cd tools && python3 -m pytest -q wireframes`; `cd hangar-service && .venv/bin/python -m pytest -q`; `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null; cd hangar-editor && npm test && npm run build`.

## Review Focus
1. **A GLB with no class name in extras** → `build` fails with a clear message naming `--class-name`; `build-all` reports that file failed and continues. → Task 1.
2. **Degenerate geometry** (zero-area triangles, a mesh with no indices, a node with a mesh but no POSITION, non-uniform/negative node scale) → no crash, no NaNs in the bundle. → Task 1.
3. **Re-uploading a ship** replaces bundle, metadata and positions; a stale `ETag` then gets 200 with new bytes, not 304. → Task 2.
4. **Deleting a model** removes markers too (positions doc with `source: "extracted"`), and the ship falls back to the render panel without a reload error. → Task 2 / Task 3.
5. **A browser without WebGL or `DecompressionStream`** shows the render panel and a note, never a blank panel. → Task 3.

---

### Task 1: `tools/wireframes/` pipeline + CLI
**Files:** Create `tools/wireframes/{__init__.py,__main__.py,glb.py,edges.py,visibility.py,bundle.py,cli.py,README.md}`, `tools/wireframes/tests/{__init__.py,synth.py,test_glb.py,test_edges.py,test_visibility.py,test_bundle.py,test_cli.py}`, `tools/requirements.txt` (`numpy`, `pytest`); modify root `.dockerignore`.
**Reference (algorithms proven in the spike — read, then reimplement cleanly and vectorised; do NOT copy game data):** `/tmp/claude-1000/-home-ubuntu-workspace-revenant/9b482b33-f217-4133-913c-f43edace67a5/scratchpad/wire/glb_wire.py` (GLB parse, weld, feature edges, node walk) and `…/wire/visible.py` (surface sampling + 26-direction depth-map visibility). The spike's edge step took 8.5 min on a 3.9M-triangle file; the target here is < 60 s on one core — avoid per-mesh `np.unique(axis=0)` on float rows (pack rounded int coords into one int64 key), cache per mesh, vectorise.
**Interfaces (Produces):**
```python
# glb.py
def load_glb(path) -> Glb                       # .json, .bin, .nodes; raises GlbError
def iter_mesh_instances(glb) -> Iterator[tuple[np.ndarray, np.ndarray, np.ndarray]]  # (positions Nx3 float32 local, faces Mx3 int64, world 4x4)
def named_nodes(glb) -> list[dict]              # [{name, parent, pos}] per spec (hardpoint nodes + their ancestors/descendants), world positions
def class_name(glb) -> str | None               # from extras.entity_name
# edges.py
def feature_edges(P, F, crease_rad, weld=0.001) -> np.ndarray      # Kx6 local-space segments
def filter_and_budget(segs, min_frac, max_lines) -> np.ndarray     # size-relative min length, stray filter, longest-first cap
# visibility.py
def cull_hidden(segs, surface_points, depth_res=640, eps_px=2.0) -> np.ndarray
def sample_surface(glb, spacing, rng) -> np.ndarray
# bundle.py
def write_bundle(path, *, kind, class_name, source_name, segs, nodes, build) -> dict   # returns header
def read_bundle(path_or_bytes) -> tuple[dict, np.ndarray]                               # header, Kx6 float32
# cli.py
def main(argv=None) -> int      # build / build-all / inspect per spec
```
- [ ] Tests first using `tests/synth.py` helpers that build tiny GLBs in memory (cube, subdivided cube, box-in-box, box with a window, split-vertex cube, transformed child node, node with `extras.entity_name`, hardpoint node tree): cube → exactly 12 edges; subdivided cube → 12 at 60°; split vertices welded; box-in-box → inner edges culled; windowed box → inner edges visible through the window kept; min-length + budget keep the longest; stray fragment dropped; `class_name` + `--class-name` override + missing-name error (Review Focus 1); degenerate inputs (Review Focus 2); bundle round-trip within `halfExtent/32767`; header key set exact; `build-all` with `--jobs 2` over 3 files where one is corrupt → exit code non-zero, two bundles written, table lists the failure; thread env vars are set in workers. Run → fail → implement → pass. README: export settings (GLB, LOD 1, Mip 6, no interiors/lights/animations), commands, flags, the no-commit rule. Commit `feat(tools): wireframe bundle pipeline for StarBreaker GLB exports`.

### Task 2: hangar-service — model store, admin routes, slot matching, serving
**Files:** Create `hangar-service/src/{swf.py,models.py,slot_match.py}`; modify `hangar-service/src/{app.py,positions.py,config.py,catalog.py}`, `hangar-service/requirements.txt` (+`google-cloud-storage`), `hangar-service/README.md`; tests `hangar-service/tests/test_models_api.py`, `tests/test_slot_match.py`, `tests/test_swf.py` (bundles built in tests with a local helper mirroring the format — do not import from `tools/`).
**Interfaces (Produces JSON for Tasks 3–4):** `POST /api/v1/models` (octet-stream) → `{kind, className, vehicleUuid, vehicleName, lines, bytes, sha256, slots: {matched, missing: [..], ambiguous: [..]}, uploadedBy, uploadedAt}`; `GET /api/v1/models` → `{models: [same shape]}`; `DELETE /api/v1/models/{kind}/{className}` → 204; `GET /api/v1/models/vehicle/{uuid}/wireframe` → bytes (+ETag); `vehicle.hasWireframe` on `/catalog/vehicles/{uuid}/slots`. `PositionsStore` gains `put(vehicle_uuid, doc)` and `delete(vehicle_uuid)` (Firestore + in-memory).
- [ ] Tests first: `swf.parse(bytes)` validation matrix (bad gzip, bad magic, header not JSON, missing keys, wrong `lines` vs payload length, > 80k lines, > 5k nodes, decompressed > 8 MB, `kind != vehicle`); slot matching per Global Constraints (nested path through a non-`hardpoint` name, case-insensitive, missing, ambiguous, coincident duplicates within 0.05 m → first); upload happy path writes object + metadata + positions (`source: "extracted"`, `space`); unknown class name stored with `vehicleUuid: null` and no positions; non-admin session 403, service token 403, cross-origin 403, > 2 MB 413; re-upload replaces and a previously valid `If-None-Match` now returns 200 (Review Focus 3); delete removes object, metadata and an `extracted` positions doc but leaves a non-extracted one (Review Focus 4); serve 200 with ETag/Cache-Control, 304, 404, readable by any member session and service token; `hasWireframe` true/false and false when the store errors; bucket unset → 503 on model routes while `/catalog/...` still works; metadata write failure after object write deletes the object; INFO log lines. Implement `ModelStore` (abstract; `GcsFirestoreModelStore(bucket, firestore_client)`; `InMemoryModelStore`), build it next to the repository/positions wiring, config `HANGAR_MODELS_BUCKET`. Run full suite. Commit `feat(hangar): wireframe model store, admin upload, slot position matching`.

### Task 3: hangar-editor — bundle decode, WireframeViewer, ShipPanel integration
**Files:** Create `hangar-editor/src/lib/swf.ts` (+test), `src/components/wireframe/WireframeViewer.tsx`, `src/components/wireframe/markers.ts` (+test, pure), modify `src/components/terminal/ShipPanel.tsx` (+ its tests), `src/api/{types.ts,client.ts}`, `src/components/terminal/terminal.css`, `package.json` (+`three`, `@types/three` dev), `hangar-editor/README.md`.
**Interfaces:** `decodeBundle(buf: ArrayBuffer): Promise<{header: SwfHeader; positions: Float32Array}>`; `getWireframe(uuid): Promise<ArrayBuffer>` (404 → null); `buildMarkers(positions: VehiclePositions | undefined, loadout: LoadoutSlot[]): {id, label, xyz}[]`; `WireframeViewer` props per spec; `loadVisualPref()/saveVisualPref()`.
- [ ] Tests first (mock `WireframeViewer` module in panel tests; build bundle fixtures in the test with `CompressionStream` or a prebuilt byte helper): decode round-trip and rejects bad magic; markers only for loadout slots with finite `xyz`; panel shows the viewer by default when `hasWireframe`, switch toggles + persists, storage failure → wireframe; no `hasWireframe` → render panel exactly as today (existing tests untouched); bundle 404/fetch error/decode error → render panel + note; missing `WebGLRenderingContext` or `DecompressionStream` → render panel + note (Review Focus 5); selecting a marker calls `onSelect`; a deleted model (hasWireframe flips false after refetch) → render panel (Review Focus 4). Implement the viewer (three.js `LineSegments` additive cyan, `OrbitControls`, auto-rotate until interaction, marker spheres, hover tooltip, target easing, dispose on unmount, reduced-motion). `npm test && npm run build`; confirm `three` lands in a separate chunk (build output). Commit `feat(hangar-editor): rotatable wireframe ship panel`.

### Task 4: hangar-editor — admin "Ship models" page
**Files:** Create `hangar-editor/src/pages/AdminModelsPage.tsx` (+test); modify `src/App.tsx` (route `/admin/models`, admin-only nav link), `src/api/{client.ts,types.ts}` (`uploadModel(file)`, `listModels()`, `deleteModel(kind, className)`), README.
- [ ] Tests first: non-admin → not-found page and no nav link; admin sees the table from `listModels`; dropping/choosing multiple files uploads them sequentially and renders each result (matched ship or "no matching ship", lines, size, missing/ambiguous slot lists); a failed upload shows its error and the rest continue; delete asks for confirmation, calls the API, refreshes; Preview opens the viewer (mocked). Implement. `npm test && npm run build`. Commit `feat(hangar-editor): admin ship models page`.

### Task 5: docs
**Files:** `CLAUDE.md` (Member hangar → Terminal view: wireframes paragraph — pipeline, export settings, bundle format, storage, matching rule, admin page, fallbacks, the no-extracted-data rule, updated follow-up list), `features.md`, `README.md`.
- [ ] Write from the code, verifying each claim; replace the Terminal follow-up list items 1–3 with the spec's new list. Commit `docs(hangar): ship wireframes`.

## Coordinator steps
Create bucket `revenant-discord-bot-2-hangar-models` (uniform, public access prevention enforced) + `roles/storage.objectAdmin` for `hangar-runtime@` on it → deploy hangar-service with `--update-env-vars HANGAR_MODELS_BUCKET=…` → run `python -m wireframes build-all /mnt/d/starcitizen-exports --jobs 8` locally to verify timings and bundles → owner uploads on `/admin/models` and checks the four ships → PR + memory.
