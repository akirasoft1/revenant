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
| `/members/:id` | A member's hangar. Read-only unless it is yours or you are an admin (`/api/me` `isAdmin`) |
| `/members/:id/ships/:shipId` | Ship detail: slot table grouped by type (slot, size, current item, stock/fitted badge). **Change** opens the compatible-item picker (sorted by the type's key stat, respecting lower-is-better; filter by text/size; cheapest UEX price when known). **Reset to stock** |
| `/import` | spviewer import: export snippet + copy button, upload, per-row preview (changes and skipped reasons), new/existing ship choice, apply, summary |

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
"Local run"; `HANGAR_STORAGE=memory`). Discord login needs browser-login env on
the service and a redirect URI registered for your local origin. Without it,
`/api/me` answers 503 and the editor shows "Login is unavailable right now".

## Test and build

```bash
npm test           # vitest run (jsdom)
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

- `/assets/*` with long-cache headers (the names are hashed)
- `index.html` with `Cache-Control: no-cache` for any non-API GET that isn't a file, so client routes like `/members/123` work on reload

`https://hangar.aklabs.io` reaches it through a global external HTTPS load
balancer (managed cert) and a serverless NEG. See the spec, plus
`hangar-service/README.md` and `hangar-service/scripts/setup-domain.sh`.
