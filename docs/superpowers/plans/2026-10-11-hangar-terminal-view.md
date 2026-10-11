# Hangar Terminal View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional "Terminal" view of the ship page on hangar.aklabs.io — category tabs, item cards with images and IN USE/STOCK/SIZE badges, a current→candidate stat comparison, a hero render with a port rail (and markers where hardpoint positions exist) — fed by richer catalog fields, a positions read path and image-failure reporting.

**Architecture:** hangar-service (FastAPI) enriches existing catalog responses from data it already fetches (Wiki v2 item lists and vehicle detail), adds a read-only `vehiclePositions` store + route and a rate-limited image-error log endpoint, and widens the CSP. The editor (React/TS/Vite) splits today's ship page body into `ClassicShipView` and adds `TerminalShipView`, both driven by the same queries and mutations in `ShipDetailPage`.

**Tech Stack:** Python 3.14, FastAPI, pytest (hangar-service); React 18 + TypeScript + TanStack Query + React Router + Vitest + Testing Library (hangar-editor). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-hangar-terminal-view-design.md` (binding — layout, field names, endpoint shapes, log line format, follow-ups).

## Global Constraints
- New response fields are OPTIONAL and additive; Classic view and existing tests keep working unchanged.
- Image hosts: `https://cdn.star-citizen.wiki` and `https://media.starcitizen.tools` (CSP `img-src`); no other new origins.
- Image-error log line exactly: `WARNING hangar: image load failed host=<host> url=<url> context=<context> member=<id>` — never truncated; never log cookies/tokens.
- Image-error endpoint: session principals only, same-origin (`check_same_origin`), ≤ 20 per session per minute → 429, url ≤ 2048 chars, context ≤ 200 chars, returns 204.
- Positions doc shape exactly as spec §3; `GET …/positions` returns the doc or `{}`, never 404 for a known vehicle (404 `not_found` for an unknown vehicle like `/slots`).
- Terminal toggle: `localStorage` key `hangar.shipView` = `"classic" | "terminal"`; every access in try/catch → Classic; toggle rendered only when `window.matchMedia('(min-width: 900px)').matches`.
- No game assets: our own inline SVG icons; CSS only; no UEE mark.
- Footer text exactly: "Unofficial fan site — not affiliated with Cloud Imperium Games. Images: Star Citizen Wiki / starcitizen.tools."
- Stage explicit paths only (never `git add -A`); commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. TDD. Suites: `cd hangar-service && .venv/bin/python -m pytest -q`; `cd hangar-editor && npm test && npm run build`. No deploys, no gcloud/kubectl mutations by implementers. Never read or print `.env*` files.

## Review Focus
1. **A port whose type has no stats (Turret, MissileLauncher, WeaponMining, TractorBeam)** — compare panel shows name/manufacturer/description with no stat rows and no crash; cards sort by name. → Task 3 test `compare panel with no stats`.
2. **Current item missing from the options list** (stock item no longer sold/compatible, or slot empty) — deltas are omitted (not NaN), header shows `EMPTY → X` or the current name. → Task 2 test `statRows with missing current`.
3. **Candidate equals current** — Install hidden; selecting the IN USE card is a no-op preview. → Task 3 test.
4. **Keyboard shortcuts while typing** — A/D/R/Esc ignored when focus is in an input/textarea/select or a modifier key is held. → Task 3 test.
5. **Image URL that keeps failing on every render** — reported once per URL per page load, not per render/card. → Task 2 test `reportImageError dedupes`.

---

### Task 1: hangar-service — enrichment, positions read path, image-error endpoint, CSP

**Files:**
- Modify: `hangar-service/src/catalog.py` (`item_option`, `vehicle_summary` callers / `_detail`), `hangar-service/src/keystats.py` (add `all_stats`), `hangar-service/src/options.py` (`_view`), `hangar-service/src/app.py` (positions route, image-error route, wiring), `hangar-service/src/static_site.py` (`build_csp`)
- Create: `hangar-service/src/positions.py` (store interface + Firestore + in-memory), `hangar-service/src/client_events.py` (rate limiter + log helper)
- Test: `hangar-service/tests/test_terminal_api.py` (new), update `tests/fixtures/wiki_item_hemera.json` only if needed (add `images`/`description` keys copied from a real v2 response), `tests/test_static_site.py`

**Interfaces:**
- Produces (JSON, consumed by Tasks 2–3):
  - slot option: existing keys + optional `image: str`, `manufacturer: str`, `description: str`, `stats: [{key: str, label: str, value: number, unit: str|null, lowerIsBetter: bool}]`
  - `/catalog/vehicles/{uuid}/slots` → `vehicle` gains optional `image: str`, `dimension: {length, width, height}`, `mass: number`, `crew: {min, max}`, `portCounts: {[type]: number}`
  - `GET /v1|/api/v1/catalog/vehicles/{uuid}/positions` → positions doc or `{}`
  - `POST /api/v1/client-events/image-error` body `{url: str, context?: str}` → 204

- [ ] **Step 1: Write failing tests** in `tests/test_terminal_api.py` using the existing app/TestClient fixtures from `tests/test_app.py` / `tests/conftest.py` (fake catalog, session principal helper from `tests/test_browser_auth.py`):
  - `keystats.all_stats(raw)` for a QuantumDrive record returns `[{"key":"speed","label":"Speed","value":…,"unit":"m/s","lowerIsBetter":False},{"key":"fuel_rate","label":"Fuel rate","value":…,"unit":None,"lowerIsBetter":True}]`; a stat whose value is missing is skipped; an unknown type returns `[]`.
  - `catalog.item_option(raw)` includes `image` = `images[0].thumbnail_url` (fallback `original_url`), `description` = `description.en_EN` (or the string when `description` is a plain string), `manufacturer` name, `stats`; records without images/description omit those keys.
  - slot-options response items carry those keys through `_view` (and still sort by keyStat).
  - vehicle summary: from a Wiki vehicle dict with `images`, `dimension {length,width,height}`, `mass`, `crew {min,max}` → fields present; absent → omitted; `portCounts` counts the parsed slots by `type`.
  - positions: unknown vehicle → 404 `not_found`; known vehicle, no doc → `200 {}`; seeded in-memory doc → returned verbatim; both `/v1` and `/api/v1` prefixes.
  - image-error: service-token principal → 403 `forbidden`; session without same-origin `Origin` → 403; session same-origin → 204 and `caplog` has exactly one WARNING containing `host=cdn.star-citizen.wiki url=https://cdn.star-citizen.wiki/images/x.jpg context=card member=<id>`; 21st call within a minute → 429 `rate_limited`; url > 2048 chars or missing → 400 `invalid_request`.
  - `build_csp(())` contains `img-src 'self' https://cdn.discordapp.com https://cdn.star-citizen.wiki https://media.starcitizen.tools data:`.
- [ ] **Step 2: Run** `cd hangar-service && .venv/bin/python -m pytest -q tests/test_terminal_api.py` — expect failures.
- [ ] **Step 3: Implement.**
  - `keystats.py`: add `STAT_LABELS = {"max_health": ("Shield HP", None), "regen_rate": ("Regen rate", "HP/s"), "regen_delay_damage_s": ("Regen delay", "s"), "power_segment_generation": ("Power output", "segments"), "coolant_segment_generation": ("Cooling", "segments"), "speed": ("Speed", "m/s"), "fuel_rate": ("Fuel rate", None), "assignment_range_max": ("Lock range", "m"), "detection_lifetime": ("Detection lifetime", "s"), "dps": ("Burst DPS", None), "sustained_dps_60s": ("Sustained DPS (60s)", None), "range": ("Range", "m"), "damage": ("Damage", None)}` and
    ```python
    def all_stats(raw_item: dict) -> list[dict]:
        spec = KEY_STATS.get(raw_item.get("type") if isinstance(raw_item, dict) else None)
        if spec is None:
            return []
        block = raw_item.get(spec["stat_key"]) or {}
        out = []
        for key, path in spec["stats"].items():
            value = _number(_get(block, path))
            if value is None:
                continue
            label, unit = STAT_LABELS.get(key, (key.replace("_", " ").capitalize(), None))
            out.append({"key": key, "label": label, "value": value, "unit": unit,
                        "lowerIsBetter": key in spec["lower_is_better"]})
        return out
    ```
    (Missile `speed` reuses the `speed` label; if a unit differs per type, prefer `None` over a wrong unit.)
  - `catalog.py`: helpers `_first_image(v) -> str|None` (first `images[]` entry: `thumbnail_url` else `original_url`) and `_description(d) -> str|None` (`en_EN` of a dict, or a plain string, stripped; None if empty). `item_option` adds `image`/`description`/`stats` only when present (`stats` always a list, may be empty). In `_detail` store the extra vehicle fields in the cached `summary`? NO — keep `summary` unchanged for other callers; store `extra = {image, dimension, mass, crew}` (present keys only) alongside, and add `async def vehicle_profile(uuid) -> dict | None` returning `{**summary, **extra, "portCounts": Counter(slot.type for slot in slots)}`.
  - `options._view`: copy `image`, `manufacturer`, `description`, `stats` when present.
  - `app.py` `/catalog/vehicles/{uuid}/slots`: return `"vehicle": await catalog.vehicle_profile(uuid)` (same 404 rule).
  - `positions.py`: `class PositionsStore(abc.ABC): async def get(self, vehicle_uuid: str) -> dict | None`; `InMemoryPositionsStore(docs: dict | None = None)`; `FirestorePositionsStore(client)` reading collection `vehiclePositions` document `vehicle_uuid` (`to_dict()` or None). Build it where the ship repository is built (`_build_repository`'s Firestore client), in-memory when the app is created with an in-memory repository (tests). `app.state.positions`.
  - Route `@router.get("/catalog/vehicles/{uuid}/positions")`: 404 via `_not_found` when `catalog.vehicle(uuid)` is None; else `await app.state.positions.get(uuid) or {}`. Store errors → existing `unavailable` mapping.
  - `client_events.py`: `class SlidingWindowLimiter(limit=20, window_s=60, clock=time.monotonic)` with `allow(key) -> bool` (deque per key, prune old, cap tracked keys at 10_000 by dropping the oldest key); `def log_image_error(logger, *, url, context, member)` emitting the exact line with `urllib.parse.urlsplit(url).hostname`.
  - Route `@router.post("/client-events/image-error", status_code=204)` registered on the `/api/v1` router only (browser-only): `principal.kind != "session"` → 403 `forbidden`; `check_same_origin(request, config.public_origin)`; validate JSON body (`url` str 1–2048 and `http(s)` scheme; `context` optional str ≤ 200, default `""`) → 400 `invalid_request`; limiter key = `principal.acting_member` → 429 `{"error":"rate_limited"}`; log; return `Response(status_code=204)`.
  - `static_site.py`: `IMAGE_ORIGINS = ("https://cdn.star-citizen.wiki", "https://media.starcitizen.tools")`; `img-src 'self' {AVATAR_ORIGIN} {' '.join(IMAGE_ORIGINS)} data:`.
- [ ] **Step 4: Run** the new file then the full suite: `cd hangar-service && .venv/bin/python -m pytest -q` — all pass.
- [ ] **Step 5: Update `hangar-service/README.md`** (API list: positions route, image-error route, new optional fields; positions doc shape) and **commit**:
  `git add hangar-service/src/{catalog,keystats,options,app,static_site,positions,client_events}.py hangar-service/tests/test_terminal_api.py hangar-service/tests/test_static_site.py hangar-service/README.md` (+ fixture if changed) — `feat(hangar): terminal view catalog fields, positions read path, image-error reporting`.

### Task 2: hangar-editor — API types/client, pure terminal logic, SafeImage, view toggle, Classic extraction, footer

**Files:**
- Modify: `hangar-editor/src/api/types.ts`, `hangar-editor/src/api/client.ts`, `hangar-editor/src/pages/ShipDetailPage.tsx`, `hangar-editor/src/App.tsx` (footer), `hangar-editor/src/styles.css` (footer only)
- Create: `hangar-editor/src/components/ClassicShipView.tsx` (today's ship page body, moved unchanged), `hangar-editor/src/lib/terminal.ts`, `hangar-editor/src/lib/terminal.test.ts`, `hangar-editor/src/components/terminal/SafeImage.tsx`, `hangar-editor/src/components/terminal/SafeImage.test.tsx`, `hangar-editor/src/components/terminal/icons.tsx`
- Test: existing `src/pages/ShipDetailPage.test.tsx` must still pass; add toggle tests there.

**Interfaces:**
- Consumes: Task 1 JSON.
- Produces (used by Task 3):
  ```ts
  // types.ts
  export interface StatValue { key: string; label: string; value: number; unit: string | null; lowerIsBetter: boolean }
  // SlotOption gains: image?: string; manufacturer?: string; description?: string; stats?: StatValue[]
  // VehicleSummary gains: image?: string; dimension?: {length?: number; width?: number; height?: number}; mass?: number; crew?: {min?: number; max?: number}; portCounts?: Record<string, number>
  export interface PositionPoint { view?: string; x?: number; y?: number; xyz?: [number, number, number] }
  export interface VehiclePositions { views?: Record<string, {imageUrl: string; width: number; height: number}>; slots?: Record<string, PositionPoint>; source?: string; gameVersion?: string }
  // client.ts
  export const getVehiclePositions: (uuid: string) => Promise<VehiclePositions>;
  export function reportImageError(url: string, context: string): void; // fire-and-forget, deduped per page load
  export const resetShip: (memberId: string, shipId: string) => Promise<unknown>; // POST /api/v1/members/{id}/ships/{shipId}/reset {slot:"all"} -- the route accepts an exact shipId; its response is the chat-edit shape {ship:{shipId,label}, changes}, NOT a Ship, so the page invalidates ['hangar', memberId] on success instead of patching the cache
  // lib/terminal.ts
  export type TabId = 'all'|'weapons'|'turrets'|'missiles'|'shields'|'power'|'coolers'|'qd'|'radar'|'utility';
  export const TABS: {id: TabId; label: string; types: string[] | null}[]; // null = all
  export function portsForTab(loadout: LoadoutSlot[], tab: TabId): LoadoutSlot[]; // TYPE_ORDER, then slot id
  export function stepPort(ports: LoadoutSlot[], current: string | null, dir: 1 | -1): string | null; // wraps
  export interface StatRow { key: string; label: string; unit: string|null; value: number; delta: number | null; better: boolean | null; fraction: number }
  export function statRows(candidate: SlotOption | null, current: SlotOption | null, options: SlotOption[]): StatRow[];
  export function badges(option: SlotOption, slot: LoadoutSlot, stockUuid: string | null): ('IN USE'|'STOCK')[];
  export function sortOptions(options: SlotOption[]): SlotOption[]; // keyStat desc (asc if lowerIsBetter), no stat last, name
  export const READONLY_TYPES: ReadonlySet<string>; // MissileLauncher
  export function loadViewPref(storage?: Storage | null): 'classic' | 'terminal';
  export function saveViewPref(v: 'classic'|'terminal', storage?: Storage | null): void;
  // components
  export function SafeImage(props: { src?: string; alt: string; type: string; context: string; className?: string }): JSX.Element;
  export function TypeIcon(props: { type: string; className?: string }): JSX.Element; // icons.tsx
  export function ClassicShipView(props: ShipViewProps): JSX.Element;
  export interface ShipViewProps { memberId: string; ship: Ship; loadout: LoadoutSlot[]; stockBySlot: Map<string, StockItem | null>; vehicle?: VehicleSummary; editable: boolean; onFit(slot: string, item: SlotOption): Promise<unknown>; onReset(slot: string): Promise<unknown>; onResetShip(): Promise<unknown>; busy: boolean; error: string | null }
  ```
- [ ] **Step 1: Write failing tests** (`lib/terminal.test.ts`):
  - `statRows`: QD candidate speed 290_000 vs current 180_000 → delta 110_000, better true; fuel_rate lower → better true; `fraction` = value / best among options (for lowerIsBetter: best/value), clamped 0–1; **missing current → delta null, better null** (Review Focus 2); candidate with no `stats` → `[]` (Review Focus 1).
  - `stepPort` wraps both directions; `null` current → first/last; empty list → null.
  - `portsForTab('shields')` only Shield slots; `'utility'` = WeaponMining + TractorBeam; `'all'` all in TYPE_ORDER order.
  - `badges`: fitted uuid → `IN USE`; stock uuid → `STOCK`; same uuid → both.
  - `sortOptions` respects lowerIsBetter and puts no-stat items last by name.
  - `loadViewPref`/`saveViewPref` with a throwing storage → `'classic'` and no throw; round-trip with a working storage.
  - `SafeImage.test.tsx`: on `error` event renders `TypeIcon` and calls `reportImageError` once; two `SafeImage`s with the same failing src → **one** report (Review Focus 5); no `src` → icon, no report.
  - `ShipDetailPage.test.tsx`: with `matchMedia` wide → toggle buttons "Classic" / "Terminal" visible, choosing Terminal persists; narrow → no toggle and Classic renders; existing Classic tests still pass.
- [ ] **Step 2: Run** `cd hangar-editor && npm test` — new tests fail.
- [ ] **Step 3: Implement.** `reportImageError` keeps a module-level `Set<string>`; `fetch('/api/v1/client-events/image-error', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body: JSON.stringify({url, context}), keepalive: true}).catch(() => {})`. Move the ship page body into `ClassicShipView` with no behaviour change; `ShipDetailPage` keeps queries/mutations, adds `getVehiclePositions` + vehicle (from the `getVehicleSlots` response's `vehicle`) queries, the toggle (wide only) and renders `TerminalShipView` lazily-imported as a placeholder `<div data-testid="terminal-view" />` until Task 3 (Task 3 replaces it). `icons.tsx`: simple inline SVGs per slot type + an "all" grid icon (stroke `currentColor`, 24×24). Footer in `App.tsx` with the exact text.
- [ ] **Step 4: Run** `npm test && npm run build` — pass.
- [ ] **Step 5: Commit** explicit paths — `feat(hangar-editor): terminal view groundwork (types, logic, SafeImage, toggle, Classic extraction)`.

### Task 3: hangar-editor — Terminal view components and styling

**Files:**
- Create: `hangar-editor/src/components/terminal/{TerminalShipView,CategoryTabs,ItemGrid,ItemCard,ComparePanel,PortRail,ShipVisual,ShipStatsSidebar,ActionBar}.tsx`, `hangar-editor/src/components/terminal/terminal.css`, `hangar-editor/src/components/terminal/TerminalShipView.test.tsx`
- Modify: `hangar-editor/src/pages/ShipDetailPage.tsx` (render the real `TerminalShipView`), `hangar-editor/README.md`

**Interfaces:**
- Consumes: everything Task 2 produces; `getSlotOptions(vehicleUuid, slot)` (existing) via `useQuery(['slot-options', vehicleUuid, slot])`.
- Produces: `export function TerminalShipView(props: ShipViewProps & { positions?: VehiclePositions; me: Me | null }): JSX.Element`.

- [ ] **Step 1: Write failing tests** (`TerminalShipView.test.tsx`, mocking `api/client` like the existing page tests):
  - renders tabs; tab with no ports is disabled; selecting "Shields" restricts the rail.
  - first port selected by default; grid shows that port's options sorted; fitted option has `IN USE`, stock option `STOCK`, every card `SIZE n`.
  - clicking a card shows `CURRENT → CANDIDATE` and stat rows with ▲/▼; **no fit call** until Install is clicked; Install calls `onFit(slot, option)` once.
  - **candidate == current → Install hidden** (Review Focus 3).
  - **compare panel with no stats** for a Turret port shows name/manufacturer/description and no stat rows (Review Focus 1).
  - `editable=false` → no Install / Reset buttons.
  - Reset port (after confirm) → `onReset(slot)`; Reset ship (after confirm) → `onResetShip()`.
  - keyboard: `d` moves to next port, `a` previous (wraps); **typing `d` inside an input does nothing; `ctrl+d` does nothing** (Review Focus 4); `Escape` switches to Classic via `onExit`.
  - with positions `{views:{top:{imageUrl,width,height}}, slots:{<slotId>:{view:'top',x:.5,y:.5}, <other>:{xyz:[1,2,3]}}}` → exactly one marker rendered; clicking it selects that port.
  - Missiles tab ports show read-only notice and no Install.
  - stats sidebar shows mass/dimensions/crew when present and omits absent ones.
- [ ] **Step 2: Run** `npm test` — fail.
- [ ] **Step 3: Implement** per spec Layout: top bar (title "Hangar Configuration Terminal", "Changes saved" pulse for 2.5s after a successful write, signed-in-as `me.globalName ?? me.username`, ship nickname/manufacturer/model), left (CategoryTabs + ItemGrid of ItemCards using `SafeImage` with `context="card"`), centre ComparePanel (uses `statRows`; current option = option whose uuid == slot.item.uuid, else a synthetic `{name: slot.item?.name ?? 'EMPTY'}`), right ShipVisual (`SafeImage` hero with `context="hero"`, markers as absolutely positioned buttons over the view image at `x*100%`/`y*100%` only for points with `view`) + PortRail (grouped by type with `TypeIcon`, size, current item, stock/fitted dot, `aria-current` on selected), ShipStatsSidebar, ActionBar (buttons + `keydown` listener on `window`, skipping when `e.target` is input/textarea/select/contenteditable or any of ctrl/meta/alt is held; confirm via `window.confirm`). `terminal.css` scoped under `.terminal` with CSS variables (`--t-bg:#07111f; --t-panel:#0c1b2e; --t-accent:#3fd0ff; --t-good:#3be38b; --t-bad:#ff5a6a; --t-text:#cfe7ff`), bracket corners via `::before/::after`, scanline via a repeating-linear-gradient overlay, `@media (prefers-reduced-motion: reduce)` disables pulse/glow animation. Grid uses CSS grid; whole view min-width 900px.
- [ ] **Step 4: Run** `npm test && npm run build` — pass. Update `hangar-editor/README.md` (Terminal view section: toggle, shortcuts, image hosts/failure reporting, positions data).
- [ ] **Step 5: Commit** explicit paths — `feat(hangar-editor): terminal ship view`.

### Task 4: docs + follow-up tracking

**Files:** `CLAUDE.md` (Member hangar → Web editor: Terminal view paragraph — toggle, image hotlinking + failure WARNING, positions doc + read route, follow-ups list), `features.md`, `README.md` (one line).
- [ ] Write the docs (spec Follow-ups copied as a numbered "Next" list in CLAUDE.md so they survive this branch). Commit — `docs(hangar): terminal view`.

## Coordinator steps (not for implementers)
Build `hangar-service` image (repo-root context, tag = git short SHA) → push to Artifact Registry → `gcloud run deploy hangar-service` with the new image (env unchanged) → verify `/version.txt`, open a ship in Terminal view on hangar.aklabs.io, break one image URL via devtools and confirm the WARNING in Cloud Run logs → push branch, PR. Record follow-ups in memory.
