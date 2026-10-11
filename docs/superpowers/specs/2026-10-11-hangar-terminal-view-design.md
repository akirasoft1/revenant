# Hangar editor: "Terminal" ship view — Design

**Date:** 2026-10-11 · **Status:** approved (chat) · **Branch:** `feat/hangar-terminal-view`
Builds on the web editor (`2026-10-09-hangar-editor-design.md`). Inspiration: the in-game loadout/configuration terminal (category icon tabs, item cards with IN USE / SIZE badges, "current → candidate" stat comparison with deltas and bars, ship visual with hardpoints, ship stats sidebar, prev/next port).

## Goal
An optional, slicker way to edit one ship's loadout on `https://hangar.aklabs.io`, alongside the existing page. Same data, same writes — a new presentation plus richer catalog fields.

## Decisions (owner-approved)
- **Optional = a view toggle** on the ship page: `Classic | Terminal`, remembered per browser in `localStorage` (every access wrapped in try/catch; failure → Classic). Same URL. Shown only at viewport width ≥ 900px; narrower always renders Classic (desktop-first; no mobile terminal layout in this project).
- **Images are hotlinked** from the wiki CDNs (`cdn.star-citizen.wiki` for items, `media.starcitizen.tools` for vehicles). Failures are **reported, not assumed away**: the client reports each failing URL once per page load to hangar-service, which logs a WARNING (see API §5); the card falls back to a type icon.
- **Ship visual = option 3:** hero render + port rail now, with a hardpoint-position data model and read path so glowing markers appear on ships that later get positions (hand-placed, or extracted by the owner with external tools such as StarBreaker, pursued asynchronously). Research (2026-10-11): no public source has meshes with hardpoint positions; FleetYards has meshes/orthographic renders without hardpoints; the Wiki API `ports[].position` is null.
- No game assets are copied: icons are our own SVGs, styling is CSS. The UEE mark is not used.

## Layout (Terminal view)
Dark navy, cyan accents, thin bracket-corner frame lines, subtle CSS scanline/glow; `prefers-reduced-motion` disables animation.
- **Top bar:** editor title, a "Changes saved" pulse after each successful write, signed-in-as, ship nickname + manufacturer + model.
- **Left — category tabs + item grid.** Tabs (our SVG icons): ALL · Weapons (`WeaponGun`) · Turrets (`Turret`) · Missiles (`MissileLauncher`, read-only — missiles aren't tracked) · Shields · Power · Coolers · QD · Radar · Mining/Tractor (`WeaponMining`, `TractorBeam`). A tab filters which ports the rail/prev/next step through (a tab with no ports is disabled). The grid shows **compatible items for the selected port** (`slot-options`), sorted by the type's default rank stat (lower-is-better aware). Card: image (fallback type icon), name, `SIZE n` badge, `IN USE` on the currently fitted item, `STOCK` on the stock item; cheapest price on hover/focus when known.
- **Centre — comparison panel.** Header `CURRENT → CANDIDATE` (e.g. `BOLON → HEMERA`). One row per stat of the type: label, candidate value with unit, delta vs current (`▲` green = better, `▼` red = worse, using lower-is-better), and a bar scaled to the best value among the port's options. Below: manufacturer, grade/class, description, and **Install** (hidden when not editable or candidate == current). With no candidate selected the panel shows the current item.
- **Right — ship visual.** Hero render (vehicle image) dimmed with a scanline treatment as backdrop; **port rail** grouped by type: icon, size, current item, stock/fitted dot; the selected port glows. If positions exist for the vehicle, markers are drawn over the matching view image at `(x, y)` for slots that have a view point, and clicking a marker selects that port.
- **Ship stats sidebar (top right):** mass, dimensions (L × W × H), crew, and port counts per type — from the Wiki vehicle record; missing fields are omitted.
- **Bottom action bar:** `◀ Prev port` · `Next port ▶` · `Reset port` · `Reset ship` · `Classic view`. Keyboard: `A`/`D` prev/next, `R` reset port (with confirm), `Esc` back to Classic; ignored while focus is in an input.
- **Interaction rules:** preview never writes. Install → the existing per-slot fit API; Reset port / Reset ship → existing reset APIs (ship reset asks for confirmation). Read-only for other members' ships unless admin (same rule as Classic): Install/Reset hidden.
- **Footer (whole editor):** "Unofficial fan site — not affiliated with Cloud Imperium Games. Images: Star Citizen Wiki / starcitizen.tools."

## API (hangar-service; same auth as today; `/v1` and `/api/v1` prefixes as today)
1. **`GET /api/v1/catalog/slot-options`** — each option gains optional fields (Classic ignores them): `image` (Wiki `images[0].thumbnail_url`, else `original_url`), `manufacturer` (name), `description` (`en_EN` text), and `stats: [{key, label, value, unit, lowerIsBetter}]` — every stat of the type from `keystats.py` `KEY_STATS` (already a copy of sc-knowledge `COMPONENT_TYPES`; keep-in-sync note stays), in the mapping's order, nulls skipped. The Wiki v2 items list already returns `images` and `description` (verified 2026-10-11), so no per-item fetches. `grade`/`class`/`keyStat`/`cheapestPrice` unchanged.
2. **`GET /api/v1/catalog/vehicles/{uuid}`** — gains optional `image` (first Wiki vehicle image, thumbnail preferred), `dimension: {length, width, height}`, `mass`, `crew: {min, max}` where the Wiki record has them, and `portCounts: {<type>: n}` over the editable slots. Missing → omitted.
3. **Hardpoint positions (read path only).** Firestore `vehiclePositions/{vehicleUuid}`:
   ```json
   {"views": {"top": {"imageUrl": "https://…", "width": 1600, "height": 900}},
    "slots": {"hardpoint_quantum_drive": {"view": "top", "x": 0.52, "y": 0.61},
              "hardpoint_weapon_left": {"xyz": [-3.1, 4.2, 0.4]}},
    "source": "manual", "gameVersion": "4.3.1", "updatedAt": "…", "updatedBy": "…"}
   ```
   `x`,`y` normalised 0–1 on the view image; `xyz` metres in ship space (stored, not drawn yet); slot ids are hangar-service's own (port names joined with `/`). `GET /api/v1/catalog/vehicles/{uuid}/positions` → the document or `{}` (never 404 for a known vehicle). No write endpoint in this project. This JSON is the documented import target for future placed/extracted positions.
4. *(dropped)* item-detail endpoint — not needed (§1).
5. **`POST /api/v1/client-events/image-error`** `{url, context}` — session principals only, same-origin check like other session writes, ≤ 20 per session per minute (in-memory, per instance) → 429; body capped (url ≤ 2048 chars, context ≤ 200). Logs `WARNING hangar: image load failed host=<host> url=<url> context=<context> member=<id>` — never truncated. Returns 204.
6. **CSP:** `img-src` adds `https://cdn.star-citizen.wiki https://media.starcitizen.tools`.

## Front end (`hangar-editor/src`)
- `pages/ShipDetailPage.tsx` keeps data loading + mutations; renders the toggle and `<ClassicShipView>` (today's body moved out unchanged) or `<TerminalShipView>`, both fed the same props (ship, loadout, stock map, editable, fit/reset mutations) so writes can't drift.
- `components/terminal/`: `TerminalShipView` (layout, selected port/tab/candidate state), `CategoryTabs`, `ItemGrid` + `ItemCard`, `ComparePanel`, `PortRail`, `ShipVisual`, `ShipStatsSidebar`, `ActionBar` (buttons + shortcuts), `SafeImage` (lazy `<img>`, fallback icon, one report per URL per page load), `icons.tsx` (our SVGs).
- `lib/terminal.ts` (pure): tab → types, ports for a tab in rail order, prev/next with wrap, stat delta + direction, bar scale vs best, badges, view-toggle persistence helpers.
- `terminal.css` scoped under `.terminal`, CSS variables; no new runtime dependencies.

## Error handling
Catalog/positions failures degrade per panel (rail still works without the vehicle summary; no markers without positions; cards without images show icons). Write errors surface inline like Classic. Image-error reporting is fire-and-forget and never blocks rendering.

## Testing
- **hangar-service (pytest):** slot-options enrichment (image/manufacturer/description/stats per type, lower-is-better, omissions); vehicle summary fields; positions read (`{}` and a populated doc); image-error endpoint (session required, cross-origin 403, rate limit 429, WARNING log with full URL, 204); CSP includes both hosts.
- **Editor (Vitest):** `lib/terminal` (deltas/direction, prev/next wrap, tab filtering, badges, toggle persistence incl. throwing storage); toggle hidden under 900px; Terminal renders cards with IN USE/STOCK; select = preview only; Install → fit; Reset → reset; read-only hides actions; `SafeImage` reports once and falls back; markers only for view points.
- **Live:** owner's ships in Terminal view on hangar.aklabs.io; one deliberately broken image URL → WARNING visible in Cloud Run logs.

## Follow-ups (tracked; next projects, in order)
1. **Position placement tool** — admin click-to-place markers per slot on a chosen view image (FleetYards top/side renders, via a thumbnail/cache proxy since they are 1–11 MB), writing `vehiclePositions`.
2. **Extracted-position importer** — accept the owner's StarBreaker/Blender exports (helper transforms → `xyz`, optionally projected to a view) into `vehiclePositions` with `source: "extracted"`; diff against catalog slot ids and report unmatched slots.
3. **3D / projected view** — draw `xyz` positions (projection onto an orthographic view, or a three.js model view).
4. **Mobile Terminal layout.**
5. **Loose inventory** — items members own but haven't fitted (the in-game grid shows owned items; ours shows compatible catalog items).
