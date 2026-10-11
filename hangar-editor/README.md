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
| `/members/:id/ships/:shipId` | Ship detail: slot table grouped by type (slot, size, current item, stock/fitted badge). **Change** opens the compatible-item picker (sorted by the type's key stat, respecting lower-is-better; filter by text/size; cheapest UEX price when known). **Reset to stock**. On screens ≥ 900px wide a **Classic / Terminal** toggle switches to the Terminal view (see below) |
| `/import` (`?member=<id>` for admins) | spviewer import: export snippet + copy button, upload, per-row preview (changes and skipped reasons), new/existing ship choice, apply, summary. "Update existing" is pre-selected only for a matching ship with no fitted changes (the import is authoritative and resets every other slot to stock); otherwise "New ship" — also when the target hangar can't be fetched (the preview still works, counts are just unknown). A row with a `too_many_lookups` skip is marked "won't be applied — import fewer at once" and any row-level skip "cannot be imported"; both are left out of apply, matching the server, which refuses such rows. Admins reach `?member=<id>` from that member's hangar; the summary names the member with their ID |
| `/import` (same page, second section) | HangarXPLOR (HTF) import: install steps, upload `shiplist.json`, per-row preview with kind badges (New ship / Already imported / Matches a ship you have / Skipped), skipped reasons (unmatched concept ships are "counted in pledge total, not added to hangar"), a link select per `link` row (defaults to the server's first candidate; a ship another row explicitly chose is not offered again), a "not in this file" list with removal checkboxes defaulted from `defaultRemove`, and a banner when the export looks like a partial selection. Apply sends `{file, choices: {links, remove}}` with only the link choices the user changed; the summary shows created/linked/updated/unchanged/removed counts and warns if `ledgerSynced` is false. Hangar cards show an `RSI · LTI · <pledge> · $350.00` badge (or "Added manually"; when the pledge title names a different ship than the one you have -- a CCU, since RSI never renames the pledge, or a package title -- it reads `pledged as <title>`), the hangar shows "$X pledged on ships across N pledges" (currencies joined with " + "), and the ship page header carries the same badge |

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
  **Install**; right: ship stats (mass, L × W × H, crew, ports per type — missing
  fields omitted), the dimmed ship render, hardpoint markers, and the port rail
  grouped by type.
- **Writes:** selecting a card is a preview only. Install = the per-slot fit API;
  Reset port / Reset ship = the existing reset APIs, both after a confirm. Install
  is hidden when the candidate is the current item. Read-only hangars (someone
  else's, unless admin) show no Install/Reset. Missile racks are read-only
  (missiles aren't tracked) and fetch no options. Write failures show inline.
- **Keyboard:** `A` / `D` previous / next port in the current tab (wraps), `R`
  reset port (confirm), `Esc` back to Classic (persisted). Ignored while typing
  in an input/textarea/select/contenteditable or with Ctrl/Meta/Alt held.
- **Images:** item and ship images come from `https://cdn.star-citizen.wiki` and
  `https://media.starcitizen.tools` (the only image hosts the CSP allows). A failed
  image falls back to our type icon and is reported once per URL per page load to
  `POST /api/v1/client-events/image-error` (`{url, context}` where context is
  `card`, `compare`, `hero` or `positions-view`); hangar-service logs it as
  `WARNING hangar: image load failed host=… url=… context=… member=…`.
- **Positions:** `GET /api/v1/catalog/vehicles/{uuid}/positions` (Firestore
  `vehiclePositions/{vehicleUuid}`, `{}` when none). A marker is drawn over the
  matching view image at `(x, y)` (0–1) only for slots with a `view` point; `xyz`
  points are stored but not drawn yet. Clicking a marker selects that port. With
  several views, the selected port's view is shown (chips switch otherwise). No
  positions → no markers; there is no write endpoint yet.

## API

All calls go through `src/api/client.ts` (the only module that knows URLs and wire
shapes; types in `src/api/types.ts`). Same origin, `fetch` with
`credentials: 'same-origin'`, so the `__Host-hangar_session` cookie (HttpOnly; the SPA never reads it and relies on `/api/me`) rides along and the
browser's `Origin` header satisfies the service's CSRF check on writes. Any 401
re-checks `/api/me` and drops back to the sign-in page.

Uses: `GET /api/me`, `POST /api/auth/logout` (same-origin, 204), `GET /api/v1/members`,
`/api/v1/members/{id}/hangar|ships|ships/{shipId}|…/slots/{slot}` (slot ids are
`%2F`-encoded), `GET /api/v1/catalog/vehicles`, `…/vehicles/{uuid}/slots`,
`GET /api/v1/catalog/slot-options?vehicle=&slot=`, and
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
