# hangar-editor

The web editor for the org's member hangar, at **https://hangar.aklabs.io**.
Members sign in with Discord and manage their Star Citizen ships: add, rename and
remove ships, fit components slot by slot from only-compatible items, reset slots
to stock, browse other members' hangars, and import saved loadouts from
[spviewer](https://www.spviewer.eu). It edits the same Firestore data the bot
reads (through `hangar-service`), so changes show up in `/hangar list` and in the
bot's answers immediately.

Spec: `docs/superpowers/specs/2026-10-09-hangar-editor-design.md`.

Stack: React 18, TypeScript, Vite, TanStack Query, React Router, plain CSS (dark
theme, mobile-friendly). Tests: Vitest + Testing Library (jsdom).

## Pages

| Route | Page |
|---|---|
| (any, signed out) | Landing: "Sign in with Discord" → `/api/auth/login?next=<current path>`. A `?login_error=<code>` from a failed callback is explained (incl. `not_member`: only members of the org's Discord server may sign in, and `discord_unavailable`). `/api/me` 503 → "Login is unavailable right now" |
| `/` | My hangar: ship cards, add ship (catalog search), rename, remove (with confirm) |
| `/members` | Directory of members with at least one ship |
| `/members/:id` | A member's hangar (display names always shown with the Discord ID, since names are user-controlled). Read-only unless it is yours or you are an admin (`/api/me` `isAdmin`) |
| `/members/:id/ships/:shipId` | Ship detail: slot table grouped by type (slot, size, current item, stock/fitted badge). **Change** opens the compatible-item picker (sorted by the type's key stat, respecting lower-is-better; filter by text/size; cheapest UEX price when known). **Reset to stock**. Slots that belong to a fitted item (see "Slots from fitted items" below) are listed like any nested slot, labelled `parent › child`. On screens ≥ 900px wide a **Classic / Terminal** toggle switches to the Terminal view (see below) |
| `/import` (`?member=<id>` for admins) | spviewer import: export snippet + copy button, upload, per-row preview (changes and skipped reasons), new/existing ship choice, apply, summary. "Update existing" is pre-selected only for a matching ship with no fitted changes (the import is authoritative and resets every other slot to stock); otherwise "New ship" — also when the target hangar can't be fetched (the preview still works, counts are just unknown). A row with a `too_many_lookups` skip is marked "won't be applied — import fewer at once" and any row-level skip "cannot be imported"; both are left out of apply, matching the server, which refuses such rows. Admins reach `?member=<id>` from that member's hangar; the summary names the member with their ID |
| `/import` (same page, second section) | HangarXPLOR (HTF) import: install steps, upload `shiplist.json`, per-row preview with kind badges (New ship / Already imported / Matches a ship you have / Skipped), skipped reasons (unmatched concept ships are "counted in pledge total, not added to hangar"), a link select per `link` row (defaults to the server's first candidate; a ship another row explicitly chose is not offered again), a "not in this file" list with removal checkboxes defaulted from `defaultRemove`, and a banner when the export looks like a partial selection. Apply sends `{file, choices: {links, remove}}` with only the link choices the user changed; the summary shows created/linked/updated/unchanged/removed counts and warns if `ledgerSynced` is false. Hangar cards show an `RSI · LTI · <pledge> · $350.00` badge (or "Added manually"; when the pledge title names a different ship than the one you have -- a CCU, since RSI never renames the pledge, or a package title -- it reads `pledged as <title>`), the hangar shows "$X pledged on ships across N pledges" (currencies joined with " + "), and the ship page header carries the same badge |

## Slots from fitted items

Spec: `docs/superpowers/specs/2026-10-11-hangar-item-slots-design.md`. A ship's
`loadout` (from the hangar read) is its RESOLVED slot list: the vehicle's slots,
plus the ports of whatever is fitted — a ball turret fitted in
`hardpoint_weapon_center` adds `hardpoint_weapon_center/hardpoint_weapon_S3_left`
and `…_right`. Those entries carry `dynamic: true` (`LoadoutSlot.dynamic`); they
are not in the stock vehicle's slot list, so they have no "stock:" note and no
`STOCK` badge. Both views treat them as ordinary nested slots (`slotLabel` →
`weapon center › weapon S3 left`); nothing in the editor depends on depth.

- **Picker:** every slot-options request made from a ship page adds
  `&member=<id>&ship=<shipId>` (`getSlotOptions(vehicle, slot, {memberId, shipId})`),
  so the server looks the slot up in that ship's resolved slots — the only way to
  find a dynamic slot. The query key is `slotOptionsKey` =
  `['slot-options', memberId, shipId, vehicleUuid, slot]`: two ships of one model
  never share an entry.
- **After a fit, a slot reset or a whole-ship reset** (`ShipDetailPage`): the
  ship from the response is shown at once, then the hangar query is invalidated
  (child slots appear or disappear with their parent) and so is every cached
  slot-options entry of that ship (`slotOptionsScope`) — a refitted parent changes
  what its children accept.
- **Dropped child fittings:** when a parent changes, the server deletes the child
  fittings whose slot is gone or whose item no longer fits. The fit/reset response
  is read for an optional `dropped` array (`lib/dropped.ts` `parseDropped`, the one
  place that knows its shape: `{slot, item: {name}}` or `{slot, itemName}`; absent
  → nothing) and the page shows one sentence naming them — "Also removed 2 fittings
  that no longer fit: Mantis GT-220 (weapon center › weapon S3 left), …" — above the
  slot tables in Classic and under the top bar in Terminal, until the next write.
- **Terminal selection:** if the selected port no longer exists after a change,
  its nearest surviving ancestor is selected (`survivingSlot` in `lib/terminal.ts`;
  the tab switches to All when that ancestor is not in the open tab); with no
  surviving ancestor, the first port.
- **Wireframe markers:** see `buildMarkers` below — a slot with no position of
  its own sits on its nearest positioned ancestor's marker.

## Terminal view

An alternative ship-detail layout inspired by the in-game loadout terminal
(`src/components/terminal/`, styles in `terminal.css`, scoped under `.terminal`;
our own CSS and inline SVG icons, no game assets). Spec:
`docs/superpowers/specs/2026-10-11-hangar-terminal-view-design.md`.

- **Toggle:** shown only when `matchMedia('(min-width: 900px)')` matches; the
  choice persists in `localStorage` `hangar.shipView` (`"classic" | "terminal"`,
  every access in try/catch, anything else → Classic). Narrow screens always get
  Classic. The Terminal bundle and stylesheet are lazy-loaded on first use. If that chunk
  fails to load (e.g. a tab opened before a deploy), an error boundary falls back to
  Classic for that page load with "Terminal view failed to load — reload the page
  to try again."
- **Layout:** top bar (title, "Changes saved" pulse for 2.5s after a successful
  write, signed-in-as, ship name/manufacturer/model); left: category tabs (a tab
  with no ports is disabled) + a 2-column grid of compatible items for the selected
  port (`slot-options`, best key stat first, `IN USE` / `STOCK` / `SIZE n` badges,
  cheapest price on hover/focus); centre: `CURRENT → CANDIDATE` comparison (per
  stat: value, ▲ green better / ▼ red worse delta respecting lower-is-better, bar
  scaled to the best option; manufacturer, grade/class, description) and
  **Install**; right: the framed **ship panel** (230px tall, full column width) above
  the port rail grouped by type (the rail scrolls). The panel shows the whole ship
  render at full strength (`object-fit: contain`, never cropped) over a blurred,
  darkened `cover` copy of the same image (decorative, `aria-hidden`, never reports
  an image error itself), under a light cyan tint + scanlines; the ship stats (mass,
  L × W × H, crew, ports per type — missing fields omitted) as a translucent overlay
  in the top-right corner (bounded so it never covers the whole image; it shrinks
  in a narrow column via a container query); the manufacturer + model bottom-left.
  No image, or the image fails to load → the large type icon and "No render
  available", no blurred fill.
- **Writes:** selecting a card is a preview only. Install = the per-slot fit API;
  Reset port / Reset ship = the existing reset APIs, both after a confirm. Install
  is hidden when the candidate is the current item. Read-only hangars (someone
  else's, unless admin) show no Install/Reset. Missile racks are read-only
  (missiles aren't tracked) and fetch no options. Write failures show inline.
- **Keyboard:** `A` / `D` previous / next port in the current tab (wraps), `R`
  reset port (confirm), `Esc` back to Classic (persisted). Ignored while typing
  in an input/textarea/select/contenteditable or with Ctrl/Meta/Alt held.
- **Images:** item and ship images come from `https://cdn.star-citizen.wiki`,
  `https://media.starcitizen.tools` and `https://cstone.space` (the only image hosts
  the CSP allows; the server returns only URLs on those hosts, preferring the wiki CDNs
  -- the list is `IMAGE_HOSTS` in `hangar-service/src/catalog.py`). A failed
  image falls back to our type icon and is reported once per URL per page load to
  `POST /api/v1/client-events/image-error` (`{url, context}` where context is
  `card`, `compare`, `hero` or `positions-view`); hangar-service logs it as
  `WARNING hangar: image load failed host=… url=… context=… member=…`.
- **Positions:** `GET /api/v1/catalog/vehicles/{uuid}/positions` (Firestore
  `vehiclePositions/{vehicleUuid}`, `{}` when none). A marker is drawn over the
  matching view image at `(x, y)` (0–1) only for slots with a `view` point; `xyz`
  points are stored but not drawn yet. When a view exists, the ship panel shows that
  view image (with markers) instead of the render. The view figure is sized to the
  view's own aspect ratio (`width / height`, fit by width; the panel scrolls if it
  is taller) and the image fills it exactly, so marker percentages land on the
  rendered image — never on letterbox bars. Clicking a marker selects that port.
  With several views, the selected port's view is shown; a view chip always
  switches, and that choice is kept until you select a port whose marker is in a
  different view (a port with no marker keeps the current view). No positions → no
  markers. `xyz` points (written by a wireframe upload, `source: "extracted"`) are
  drawn only in the wireframe, below.
- **Wireframe ship panel** (spec
  `docs/superpowers/specs/2026-10-11-ship-wireframes-design.md`): when the catalog
  says `vehicle.hasWireframe`, the ship panel shows a rotatable wireframe instead
  of the render, with a `Wireframe | Render` switch (top-left) remembered per
  browser in `localStorage` `hangar.shipVisual` (`"wireframe" | "render"`, default
  wireframe, unreadable storage → wireframe). Ships without a wireframe show the
  render panel exactly as before (no switch).
  - **Layout:** in wireframe mode the panel is taller
    (`clamp(340px, 46vh, 560px)`; render mode stays 230px), the ship column
    becomes the widest of the three (`.t-body:has(.t-shippanel.has-wire)`), and
    an **Expand** button beside the switch lets the wireframe cover the whole
    terminal body (`is-expanded`; `Collapse` or Esc puts it back — while
    expanded, Esc is consumed in the capture phase so it does not also leave the
    Terminal view). Nothing covers the
    wireframe except the ship name (bottom-left) and the switch: the ship stats
    move out of the panel into a compact wrapping strip directly under it
    (`ShipStatsSidebar variant="strip"` — same fields and omission rules, real
    selectable text, scrolls inside itself past ~4 lines, focusable). Render mode
    keeps the top-right stats overlay. The port rail below keeps a minimum height
    (`6.5rem`) and scrolls.
  - **Hidden-line removal (what makes it read as a drawing):** a bundle built by
    tool ≥ 1.1.0 carries, per line, which of 26 baked views can see it. Before
    each draw `stage.ts` blends the baked views near the camera direction
    (`blendViews`: full weight within `VIEW_FULL_DEG` 18°, none past
    `VIEW_NONE_DEG` 38°, best view always 1) and writes each line's alpha
    (`writeLineAlpha`; unseen lines keep `HIDDEN_LINE_ALPHA` 10/255 as a faint
    ghost) into a per-vertex RGBA attribute, only when the camera direction
    moved. So the far side and the underside fade out as the ship turns. Without
    it (older bundles) every line shows through every other and a dense ship is
    a glowing blob — that is what the first deployed version looked like. The
    canvas is also **supersampled** (2× the device pixel ratio, capped at 3) so
    1-pixel GL lines come out finer and smoother.
  - **Level of detail (older bundles; with hidden-line data only the length rule applies):** bundles are
    ordered longest line first, so the viewer draws a prefix
    (`lodLineCount` in `lib/wireframe.ts`, applied by `stage.ts` before every
    draw): only lines at least `MIN_LINE_PX` (2) CSS pixels long on screen, at
    most `MAX_LINES_PER_PX` (40) lines per pixel of the ship's on-screen size,
    never fewer than `MIN_LOD_LINES` (1,500). Line opacity rises a little as
    lines are thinned. A 60,000-line capital ship in a 250 px panel was drawing
    ~240 additive lines per pixel — a glow, not a drawing. Zooming in or
    expanding brings the detail back. A bundle that is not ordered longest
    first is never thinned.
  - **Data:** `getWireframe(uuid)` → `GET /api/v1/models/vehicle/{uuid}/wireframe`,
    the stored `.swf.gz` bytes (served without `Content-Encoding`; 404 → `null`).
    The query is keyed `['wireframe', uuid]` and the request uses
    `cache: 'no-cache'` so the browser revalidates its copy against the server's
    ETag. It is fetched only while the wireframe is the chosen visual. A stored
    bundle is fresh for a day, a 404 (`null`) for 30 s (`wireframeStaleTime`); one
    retry for network/5xx errors, none for 4xx.
  - **No reload needed after an upload:** `ShipPanel` invalidates the query when
    the vehicle's positions object changes identity (an upload rewrites the
    positions) or `hasWireframe` changes, so a replaced model, or one uploaded
    after a cached 404, appears as soon as the page's catalog/positions queries
    refresh. The first positions to arrive on page load are not treated as a
    change. A refetch that returns byte-identical data keeps the old buffer
    (`sameBytes` as `structuralSharing`), so the live viewer and its camera are
    not rebuilt. A viewer failure is remembered per bundle, so a new bundle gets a
    fresh try.
  - **Decode (`src/lib/swf.ts`, no three.js):** gunzip with `DecompressionStream`
    (8 MB ceiling), then `SWF1` + uint32 LE header length + header JSON + int16 LE
    × `lines * 6`; a coordinate is `center + int16 / 32767 × halfExtent` (glTF
    Y-up, metres — the same space as the positions' `xyz`). When the header has
    `views`, one uint32 per line follows and decodes to
    `visibility: {views, masks}`. Malformed input
    rejects with `SwfError`.
  - **Viewer (`src/components/wireframe/`):** `WireframeViewer` (props `bundle`,
    `markers`, `selected`, `onSelect`, plus `onError`, `label`) and
    its scene in `stage.ts`. Additive cyan `LineSegments` at 0.32 opacity on the
    terminal background, `OrbitControls` with damping (drag rotate, wheel zoom,
    right-drag pan), a gentle auto-rotate that stops at the first press, wheel or
    port selection, and double-click on empty space to return to the opening
    view. The opening camera is a three-quarter front view whose distance is
    computed so the ship stays in frame at every angle of the auto-rotation for
    the panel's shape (`orbitFitDistance`), using the full panel.
    Markers (`buildMarkers`: loadout slots with a finite `xyz`, labelled with
    `slotLabel`; a slot with none of its own uses its nearest ancestor's, walking
    the `/`-separated id upward, so the gun slots of a fitted turret share the
    turret's point with distinct ids — the stage picks the closest — and a slot
    with no positioned ancestor gets no marker) are green spheres sized relative to the ship (`markerRadius`);
    the selected one is white, larger and pulsing inside a cyan halo. Hover shows
    the slot label; a click (a press that moves less than 5 px) selects the port.
    Selecting a port — on a marker or in the rail — pans the view (angle and zoom
    kept) 80% of the way from the ship's centre toward it (`FOCUS_BLEND` in
    `stage.ts`, the one constant; 1 would put the port dead centre), so a nose or
    tail port on a long ship comes near the middle with most of the hull still in
    frame. The port
    already selected when the ship opens is highlighted but not panned to. A port
    with no position (its own or an ancestor's) has no marker. `prefers-reduced-motion` turns off
    auto-rotate, the pulse and the pan easing. GL resources are disposed on
    unmount.
  - **Render on demand:** a still wireframe draws nothing. A frame is requested
    only when `needsFrame` (`lib/wireframe.ts`, unit-tested) says so: something
    changed (camera via the controls' `change` event, markers, selection, hover,
    resize), or auto-rotate, the pan easing or the selected marker's pulse is
    running — and never while the canvas is off-screen (`IntersectionObserver`)
    or the document is hidden (`visibilitychange`). Damping keeps requesting
    frames until the camera settles. Note the pulse means frames keep coming
    while a port with a marker is selected and reduced motion is off.
  - **three.js stays out of the main bundle:** `three` is imported only by
    `WireframeViewer.tsx` and `stage.ts`, which `ShipPanel` loads with
    `React.lazy`. `npm run build` emits it as its own `WireframeViewer-*.js` chunk
    (~560 kB, ~140 kB gzip), fetched the first time a wireframe is shown. Keep any
    new three.js code inside `src/components/wireframe/` and never import those
    two modules statically.
  - **Fallbacks — the viewer never blocks the panel:** no `WebGLRenderingContext`
    or no `DecompressionStream`, a bundle that 404s or fails to load, a decode
    error, a WebGL context that cannot be created or is lost, or a viewer chunk
    that fails to load (stale deploy) → the render panel with a short note in
    place of the switch. If `hasWireframe` turns false (model deleted), the panel
    is the plain render panel again with no note.
  - **Tests:** jsdom has no WebGL, so panel tests mock the viewer module
    (`ShipPanel.test.tsx`, `ShipPanel.chunkFail.test.tsx`); decode, markers,
    camera fit and preference helpers are unit-tested (`lib/swf.test.ts`,
    `lib/wireframe.test.ts`, `wireframe/markers.test.ts`) against bundles built in
    the test. The three.js scene itself has no unit test. No real bundle or model
    file may be added to the repo.
| `/admin/models` (admins only; others get the not-found page, nav link hidden) | Ship models: upload wireframe bundles (`.swf.gz`, ≤ 2 MB, picker with `multiple` or drag-and-drop; others rejected in the browser) sent raw as `application/octet-stream` to `POST /api/v1/models`, up to 3 in flight and paced to at least 2 s between starts (~30/min, half the shared Wiki limiter, so the bot's hangar lookups keep working; ~220 ships take about 8 minutes; the page shows an ETA), with a running `N / M uploaded, K failed` line, per-file compact rows (expand for missing/ambiguous slot lists), a summary (matched ships / no matching ship / failures with the server message) and **Retry failed** (continues past failures). Below, the stored-models table (`GET /api/v1/models`): click-to-sort by ship / lines / uploaded, text filter, counts of matched/missing/ambiguous slots, **Preview** (lazy three.js viewer in a dialog, models with a ship only) and **Delete** (confirm; `DELETE /api/v1/models/vehicle/{className}`). After a drained upload batch or a delete the `models`, `vehicle-slots`, `vehicle-positions` and `wireframe` query caches are invalidated so an open ship page updates without a reload |

## API

All calls go through `src/api/client.ts` (the only module that knows URLs and wire
shapes; types in `src/api/types.ts`). Same origin, `fetch` with
`credentials: 'same-origin'`, so the `__Host-hangar_session` cookie (HttpOnly; the SPA never reads it and relies on `/api/me`) rides along and the
browser's `Origin` header satisfies the service's CSRF check on writes. Any 401
re-checks `/api/me` and drops back to the sign-in page.

Uses: `GET /api/me`, `POST /api/auth/logout` (same-origin, 204), `GET /api/v1/members`,
`/api/v1/members/{id}/hangar|ships|ships/{shipId}|…/slots/{slot}` (slot ids are
`%2F`-encoded), `GET /api/v1/catalog/vehicles`, `…/vehicles/{uuid}/slots`,
`GET /api/v1/catalog/slot-options?vehicle=&slot=&member=&ship=` (`member` and
`ship` always sent from a ship page),
`GET /api/v1/models/vehicle/{uuid}/wireframe` (binary), and
`POST /api/v1/import/spviewer/preview|apply`. The import requests send the
uploaded file parsed, as JSON `{file: [...]}` / `{rows, file}`; the server
re-decodes it and never trusts client-side changes. Uploads over 2 MB are refused
in the browser before sending. A 409 `limit` (ship cap, `{limit, shipCount}`) from adding or
importing ships is shown as a "hangar limit reached" message.

## Develop

Node **22.12+** (Vite 8 / Vitest 5; `.nvmrc` says 22; the image builds on Node 24).

```bash
cd hangar-editor
npm ci
npm run dev        # http://localhost:5173, proxies /api -> http://localhost:8080
```

Run `hangar-service` locally on 8080 for the proxy (see `hangar-service/README.md`
"Local run"; `HANGAR_STORAGE=memory`). For a real Discord login through the dev
server:

- start the service with `HANGAR_PUBLIC_ORIGIN=http://localhost:5173` (the OAuth
  redirect URI and the CSRF origin check both derive from it), plus
  `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, a 32+ character `HANGAR_SESSION_KEY`
  and `HANGAR_ALLOWED_GUILD_IDS`;
- register `http://localhost:5173/api/auth/callback` as an OAuth2 redirect URI on the
  Discord application.

The session cookie is `__Host-`-prefixed and `Secure`. Browsers accept that on
`http://localhost`, but not on other plain-HTTP hosts. Without the browser-login
env, `/api/me` answers 503 and the editor shows "Login is unavailable right now".

## Test and build

```bash
npm test           # vitest run (jsdom) -- the bot's root Jest run ignores hangar-editor/
npm run typecheck
npm run build      # tsc --noEmit + vite build -> dist/
```

`dist/` holds `index.html`, `favicon.svg` and content-hashed `assets/*.js|css`.
The three.js wireframe viewer is a separate lazy chunk (`WireframeViewer-*.js`);
the chunk-size warning limit in `vite.config.ts` is raised for that chunk only
because it is never part of the initial load.

**Dynatrace RUM:** set `VITE_DT_RUM_SRC` at build time to the RUM JavaScript tag's
`src` URL, and a `<script>` is prepended to `<head>`. Unset or empty means no tag.

## How it is served

There is no separate host. `hangar-service`'s image builds this app in a Node
stage and copies `dist/` into the Python image. One image, tagged with the git
short SHA, ships the API and the editor together. The service serves:

- `/assets/*` with `Cache-Control: public, max-age=31536000, immutable` (the names are hashed)
- root files such as `favicon.svg` with a 1-hour cache
- `index.html` with `Cache-Control: no-cache` for any GET outside `/api`, `/v1`, `/health`, `/healthz` and `/assets` that isn't a file, so client routes like `/members/123` work on reload
- a Content-Security-Policy on the document: same-origin scripts and styles only (the Vite build has no inline code), images from self, `data:` and `https://cdn.discordapp.com` (avatars), `frame-ancestors 'none'`. **If you add RUM** (`VITE_DT_RUM_SRC`), also set `HANGAR_RUM_ORIGINS` on the service to the script and beacon origins, or the CSP blocks them. Anything new that loads from another origin (fonts, images) needs the CSP in `hangar-service/src/static_site.py` widened.
- `/version.txt`: the image's git SHA

Build the image from the repo root: `docker build -f hangar-service/Dockerfile --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t <image>:<sha> .`

`https://hangar.aklabs.io` reaches it through a global external HTTPS load
balancer (managed cert) and a serverless NEG. See the spec, plus
`hangar-service/README.md` and `hangar-service/scripts/setup-domain.sh`.
