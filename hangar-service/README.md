# hangar-service

Per-member Star Citizen ship loadouts. A small FastAPI service on **Cloud Run**
(GCP project `revenant-discord-bot-2`, region `us-central1`) that stores each
Discord member's ships in **Firestore** (`members/{discordId}/ships/{shipId}`)
and derives every ship's component slots from the **Star Citizen Wiki API**.
Callers: the bot's `/hangar` command and sc-knowledge's `sc_member_hangar` /
`sc_member_fit_check` tools (Google ID tokens), and the web editor at
`https://hangar.aklabs.io` (Discord login, signed session cookie).

Specs: `docs/superpowers/specs/2026-10-09-member-hangar-design.md` (service),
`docs/superpowers/specs/2026-10-09-hangar-editor-design.md` (web editor).

## API

All JSON. Everything except `/health` (and its local alias `/healthz`) needs a credential (see Auth).
Errors are always `{"error": <code>, "message": <text>, ...}`:

| Code | HTTP | When |
|---|---|---|
| `invalid_request` | 400 | malformed JSON / missing or bad field / bad member id / unknown item `type` |
| `unauthenticated` | 401 | no / invalid / wrong-audience / non-allow-listed token (`WWW-Authenticate: Bearer`) |
| `forbidden` | 403 | write without `X-Acting-Member`, or acting member is neither the path member nor an admin, or a browser-session write that is not same-origin |
| `not_found` | 404 | unknown ship / vehicle / slot / item, unknown route |
| `ambiguous` | 409 | vehicle text matches several vehicles; body carries `candidates` |
| `limit` | 409 | adding the ship would exceed `HANGAR_MAX_SHIPS_PER_MEMBER` (body carries `limit`, `shipCount`) |
| `incompatible` | 422 | item does not fit the slot (type / sub-type / size); `message` says why |
| `too_large` | 413 | spviewer import body over 2 MB (+64 KiB envelope), or more than 100 rows |
| `busy` | 503 | both import slots of this instance are in use (2 concurrent imports); retry shortly |
| `unavailable` | 503 | Wiki (nothing cached), Firestore, or Google's signing certs unreachable; browser login not configured (`/api/auth/*`, `/api/me`) |
| `unavailable` | 500 | unexpected server error (full stack logged) |

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/health` (alias `/healthz`) | – | `{status, version, vehicleIndexCached}` (no upstream calls, no auth) |
| GET | `/v1/members/{discordId}/hangar` | – | `{member, ships: [Ship]}` |
| POST | `/v1/members/{discordId}/ships` | `{vehicle, nickname?}` | 201 `{ship: Ship}` |
| PATCH | `/v1/members/{discordId}/ships/{shipId}` | `{nickname}` (null clears) | `{ship: Ship}` |
| DELETE | `/v1/members/{discordId}/ships/{shipId}` | – | `{deleted: true, shipId}` |
| PUT | `/v1/members/{discordId}/ships/{shipId}/slots/{slot}` | `{item}` (uuid or exact Wiki name) | `{ship: Ship}` |
| DELETE | `/v1/members/{discordId}/ships/{shipId}/slots/{slot}` | – | `{ship: Ship}` (reset to stock) |
| GET | `/v1/catalog/vehicles?q=&limit=` | – | `{vehicles: [VehicleSummary]}` (≤25) |
| GET | `/v1/catalog/vehicles/{uuid}/slots` | – | `{vehicle: VehicleSummary, slots: [SlotDef]}` |
| GET | `/v1/catalog/items?type=&size=&q=` | – | `{items: [ItemSummary]}` |
| GET | `/v1/members` | – | `{members: [{discordId, shipCount, displayName?}]}` — members with ≥1 ship, sorted by name/ID; `displayName` only when known (see `ownerName`) |
| GET | `/v1/catalog/slot-options?vehicle=<uuid>&slot=<slotId>` | – | `{items: [{uuid, name, type, size, grade, class, keyStat: {name, value, lowerIsBetter} \| null, cheapestPrice?: {price, shop, location}}]}` — see "Item picker" |
| POST | `/v1/import/spviewer/preview[?member=]` | `{file: <spviewer export array>}` | `{rows: [{rowIndex, loadoutName, vehicle: {uuid, name} \| null, patch, changes: [{slot, from: {uuid, name} \| null, to: {uuid, name}}], skipped: [{slot?, reason, detail}], matchingShips: [{shipId, label}]}]}` — nothing stored |
| POST | `/v1/import/spviewer/apply[?member=]` | `{rows: [{rowIndex, mode: "new"\|"existing", shipId?, nickname?}], file}` | `{ships: [Ship], errors: [{rowIndex, error, message}]}` — see "spviewer import" |

**Every `/v1/...` route is also served at `/api/v1/...`** (same handler, same
auth). Service callers use `/v1` on the `run.app` URL; the browser editor uses
`/api/v1` through the load balancer. Browser-only routes:

| Method | Path | Success | Failure |
|---|---|---|---|
| GET | `/api/auth/login?next=/path` | 302 → `https://discord.com/oauth2/authorize?...` (scope `identify guilds.members.read`); sets `__Host-hangar_oauth_state` (signed, 10 min) | 503 `unavailable` if browser login unconfigured |
| GET | `/api/auth/callback?code&state` | 302 → `next` (same-origin path, default `/`); sets `__Host-hangar_session`; clears the state cookie | 302 → `/?login_error=<code>`, code ∈ `state_mismatch`, `denied`, `missing_code`, `token_error`, `user_error`, `not_member` (in no allowed Discord server; no cookie set), `discord_unavailable` (membership lookup got 429/5xx/network error), `server_error`; 503 if unconfigured |
| POST | `/api/auth/logout` | 204, clears `__Host-hangar_session` | 403 `forbidden` unless same-origin (`Origin`/`Referer`) |
| GET | `/api/me` | `{discordId, username, globalName, avatarUrl, isAdmin}` | 401 `unauthenticated` (no / bad / expired session); 503 if unconfigured |

All four send `Cache-Control: no-store`. `next` must be a same-origin path
(`/…`, not `//host`, no scheme) or it becomes `/`.

`Ship` = `{shipId, vehicleUuid, vehicleName, vehicleClassName, nickname, fitted,
createdAt, updatedAt, updatedBy, ownerName, loadout, loadoutError}` where
`ownerName` is the owner's Discord global name (else their nickname in the
allowed server they logged in through, else username), stored when the
owner edits that ship through a browser session (null otherwise — service
writes and admins editing someone else's ship leave it unchanged), and `loadout` is
`[{slot, type, sizeMin, sizeMax, compatibleTypes: [{type, subTypes}], item: {uuid, name} | null, source: "stock"|"fitted"}]`,
or `null` with `loadoutError` `"unavailable"` / `"not_found"` when the
catalog can't supply that ship's slots (the rest of the response still works).
Slot ids contain `/` for nested slots
(`hardpoint_gun_laser_top_left/hardpoint_class_2`); put them in the URL raw or
`%2F`-encoded, both route. Fitting a slot's stock item resets it (`fitted`
holds only changes from stock). Full shapes: `src/app.py`.

**Use `/health`, not `/healthz`, against Cloud Run.** Cloud Run's front end
reserves URL paths ending in `z`, so `/healthz` gets Google's own 404 before it
ever reaches the container. `/healthz` is kept for local and in-cluster parity.

## Catalog rules (Star Citizen Wiki `GET /api/vehicles/{slug|uuid}` → `ports[]`)

- A port is a **slot** when its OWN `editable` is true and its `type` (or,
  for a port empty in stock, one of its `compatible_types`) is in
  `SLOT_TYPES` = QuantumDrive, Shield, PowerPlant, Cooler, Radar, WeaponGun,
  Turret, MissileLauncher, WeaponMining, TractorBeam.
- **Nesting:** ports are walked at every depth and the parent's
  `editable_children` flag is NOT used — live data has S5 turret gimbals with
  `editable_children: false` while the gun inside is `editable: true`. Slot
  ids join the port names with `/` at whatever depth the port sits (no depth
  cap; e.g. three levels deep on the Taurus's manned upper turret:
  `hardpoint_turret_base_upper/hardpoint_weapon_left/hardpoint_class_2`).
- **Refitting a parent hides its stock children** in the effective loadout
  (an explicitly fitted child stays).
- **Missiles are not tracked** (`Missile` isn't a slot type; sc-knowledge's
  fit check answers `not_tracked`). A `MissileLauncher` rack is a slot only
  where the Wiki marks the port editable — on the Taurus and Harbinger the
  racks are `editable: false`, so they don't appear.
- Every loadout slot carries `compatibleTypes`; sc-knowledge's fit check
  applies the same compatibility rule as `check_compatible` here (type in
  `compatibleTypes`, sub-types only when the slot lists some and the item's
  isn't `UNDEFINED`, size within range) — change both together.

## Item picker (`/catalog/slot-options`)

- Items = every Wiki item of the slot's compatible types (filtered to
  `SLOT_TYPES`) and sizes that `check_compatible` accepts (same rule as
  fitting: type, sub-type, size). Required tags (e.g. spviewer's
  `VanguardNose`) are not modelled, same as fitting.
- `keyStat` = the per-type stat sc-knowledge's `sc_compare_components` ranks
  by (`src/keystats.py`, **keep in sync** with `COMPONENT_TYPES` in
  `sc-knowledge/src/tools_items.py`): Shield `max_health`, PowerPlant
  `power_segment_generation`, Cooler `coolant_segment_generation`,
  QuantumDrive `speed`, Radar `assignment_range_max`, WeaponGun `dps` (burst).
  Other types (Turret, MissileLauncher, WeaponMining, TractorBeam) → `null`.
  Sorted best first (`lowerIsBetter` respected), no value last, name tiebreak.
- `cheapestPrice` = the cheapest UEX player-reported buy price the Wiki embeds
  in each `v2/items` record (`uex_prices.purchase`, the same data
  sc-knowledge's `_shops` reads) — no UEX item-id mapping, bearer or extra
  call. Cached with the item list (12h). Omitted when unknown / not sold /
  malformed; the picker still works.

## spviewer import (`/import/spviewer/*`)

The editor's snippet exports spviewer.eu's IndexedDB `SCSPVDatabase` →
`vehiclesLoadout` (JSON array). Per row: `vehicleClassName` (= Wiki vehicle
`class_name`), `loadoutName`, `patch`, and `loadoutData` = LZ-string
`compressToEncodedURIComponent` JSON (decoded by the vendored
`src/lzstring.py`; the PyPI `lzstring` is unmaintained and uncapped).

- **The member's choices are in the `selected*` maps, not in `*Ports[].Loadout`.**
  On the real export (`tests/fixtures/spviewer_harbinger.json`) every port's
  `Loadout` is stock, while `selectedShields` / `selectedRadar` /
  `selectedPilotWeapons` / … (keyed `"<index>-<PortName><childPortName>"`,
  names concatenated without a separator; each `selectedX` map is paired with
  its `xPorts` array — `selectedShields` ↔ `shieldPorts`, `selectedMissilesRacks`
  ↔ `missilesRackPorts`, compared case-insensitively without a trailing `s` —
  and an entry whose index doesn't match is ignored unless that array has
  exactly one port) hold the actual loadout — spviewer's
  own `loadoutPerfs` match the `selected*` items (shield pool 20000 = 2 × 7MA
  'Lorica', pilot alpha 1166 = Deadbolt V + 4 × BRVS Repeater). A port with
  no `selected*` entry falls back to its `Loadout` (uuid or class name).
- Slot ids = `PortName`s joined with `/` (identical to hangar slot ids). A
  port is **changed** when its `selected*` item, or else its `Loadout`, matches
  neither spviewer's stock (`BaseLoadout.ClassName`) nor the Wiki's stock item,
  by class name or uuid (a uuid naming the stock item is not a change).
  `Loadout` counts as stock only when it equals one of those, or is the
  `reference` of a stock `selected*` entry; a `Loadout` that differs from stock
  is a change even next to a stock `selected*` entry (a non-stock `selected*`
  entry wins over it). Changed tracked slots resolve the item through the Wiki
  (`v2/items/{uuid|ClassName}`) and must pass `check_compatible`.
- `skipped[].reason` codes: `untracked_slot` (changed port the hangar does not
  track — missiles/torpedoes, gimbal mounts, turrets, paint, flair, flight
  controller, life support, jump drive…), `unknown_item` (Wiki has no such
  item), `incompatible` (`detail` says why), `unknown_vehicle`
  (`vehicleClassName` not in the catalog; `vehicle: null`),
  `unrecognized_format` (row not an object / no `vehicleClassName` /
  `loadoutData` not LZ-string, not JSON, or without `*Ports`), `too_large`
  (decoded `loadoutData` over 2 MB, or over the 16 MB per-request budget),
  `empty_slot` (a tracked slot emptied in spviewer — the hangar can't store
  "empty", so it stays stock), `too_many_lookups` (the request's budget of 64
  DISTINCT Wiki item lookups is spent). A duplicate slot path in a row makes the
  whole row `unrecognized_format`; more than 500 ports makes it `too_large`. An untracked port whose current item is only a
  bare uuid (no `selected*` entry) is not resolved — it can't affect the
  import and would cost a Wiki lookup per mount.
- Caps: body ≤ 2 MB (+64 KiB envelope; 413 `too_large`, checked on
  `Content-Length` and while streaming), ≤ 100 rows (413 `too_large`), ≤ 500
  ports and ≤ 2 MB decoded per row, 16 MB decoded per request, and **64
  distinct Wiki item lookups per request** — the Wiki client's 60/min rate
  limiter is shared with every hangar read (bot, sc-knowledge, editor), so an
  upload must not be able to queue thousands of lookups. Only a uuid or a
  `[A-Za-z0-9_]{1,100}` class name is ever sent to the Wiki (anything else →
  `unknown_item`, no call). Untracked ports never cost a lookup. At most 2
  import requests run at once per instance (503 `busy` otherwise, no
  queueing); decoding runs in a worker thread. Deeply nested JSON → 400 (body)
  or `unrecognized_format` (loadoutData).
- **preview** stores nothing; `matchingShips` = the target member's ships of
  that vehicle (`label` = `nickname (vehicle)` or the vehicle name). Target =
  `?member=` else the acting member (session user / `X-Acting-Member`); any
  authenticated caller may preview.
- **apply** re-decodes the file server side (client-sent changes are ignored)
  and needs the write rule (own hangar, or admin with `?member=`) plus, for
  browser sessions, same-origin. `mode: "new"` creates a ship (nickname
  defaults to `loadoutName`, cut to 64 chars) after `ensure_ship_capacity`
  for all new rows (409 `limit`, nothing written); `mode: "existing"` targets
  one of the member's ships of the same vehicle. Either way the ship's whole
  `fitted` map is **replaced** with the computed changes in one write
  (`replace_fitted`): slots the loadout doesn't change go back to stock.
  Per-row failures don't block other rows and come back in `errors[]` with
  `error` ∈ `unknown_vehicle`, `unrecognized_format`, `too_large`,
  `not_found` (no such ship), `vehicle_mismatch`.

## Auth

Two layers:

1. **Cloud Run edge (invoker IAM ON).** The org enforces domain-restricted
   sharing (`iam.allowedPolicyMemberDomains`), so `--allow-unauthenticated`
   (an `allUsers` invoker binding) FAILS. The service is deployed
   `--no-allow-unauthenticated` with `roles/run.invoker` granted to
   `hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com`. Google's front
   end rejects anything without a valid invoker token before the app runs.
   The project-2 browser editor can't present such a token, so it will need a
   different approach (e.g. `--no-invoker-iam-check`, leaving auth to the app
   alone). That decision is deferred to project 2.
2. **The app**, which re-verifies the same ID token and enforces the
   member write rule:
- **Service callers** send `Authorization: Bearer <Google ID token>`. The token
  is verified with `google.oauth2.id_token.verify_oauth2_token` (Google
  signature, expiry, issuer `accounts.google.com`) for audience
  `HANGAR_AUDIENCE`; additionally `email_verified` must be true and `email`
  must be in `HANGAR_ALLOWED_CALLERS`. Anything else → 401. If
  `HANGAR_AUDIENCE` is empty every token is refused (fail closed).
  Google's certs are cached in-process for 1h; if they can't be fetched the
  request gets 503 `unavailable`, not 401.
- **Writes** need `X-Acting-Member: <discordId>`; allowed when it equals the
  path `discordId` or is in `HANGAR_ADMIN_IDS`. **Reads** of any member are
  allowed for any authenticated caller.
- Credential checks are a chain of pluggable resolvers (`src/auth.py`): the
  Google ID-token resolver first, then (when browser login is configured) the
  Discord session resolver. A valid Bearer token always wins, so service
  behaviour — including `X-Acting-Member` — is unchanged; a bad Bearer token is
  401 even if a valid cookie is present.
- **Browser sessions (web editor).** Discord OAuth2 authorization-code flow
  (scope `identify guilds.members.read`, redirect `HANGAR_PUBLIC_ORIGIN` +
  `/api/auth/callback`).
- **Login gate — server members only.** After fetching the user, the callback
  calls `GET https://discord.com/api/users/@me/guilds/{guild_id}/member` (the
  user's own token) for each guild in `HANGAR_ALLOWED_GUILD_IDS` (sorted; first
  hit wins). 200 = member: the guild id and server nickname are recorded in the
  session. 404/403 = not a member; a 200 member object with `pending: true`
  (membership screening not passed yet) also counts as not a member. No membership anywhere → `/?login_error=not_member`
  and **no session cookie**. If no guild confirmed membership and a lookup hit
  429/5xx/a network error → `/?login_error=discord_unavailable` (try again).
  **Membership is checked only at login.** A member who leaves the server keeps
  a working session until it expires (30 days) — revoke sooner with
  `HANGAR_SESSION_NOT_BEFORE` (everyone re-logs in; the leaver is then refused).
  Removing a guild from `HANGAR_ALLOWED_GUILD_IDS` immediately invalidates every
  session that logged in through it (the session resolver checks `guildId`).
- On success the service sets `__Host-hangar_session`: an itsdangerous-signed (HMAC,
  key `HANGAR_SESSION_KEY`, not encrypted) cookie carrying only public profile
  fields `{discordId, username, globalName, avatar, guildId, nick, iat}`;
  `HttpOnly; Secure; SameSite=Lax; Path=/`, 30-day max age, no server-side
  store (logout clears the cookie; a leaked cookie is valid until it expires,
  the key rotates, or `HANGAR_SESSION_NOT_BEFORE` passes its `iat` — see
  "Session key rotation / revocation"). Both cookies use the `__Host-` prefix
  (`Secure; Path=/`, no `Domain`), so no other subdomain can set or shadow them. A tampered / expired / other-key cookie is 401.
  A session principal's **acting member is the session's Discord ID**;
  `X-Acting-Member` is ignored. The write rule is the same (own hangar, or an
  admin). **CSRF:** session writes additionally need `Origin` (or, without
  one, `Referer`) on `HANGAR_PUBLIC_ORIGIN`, else 403 `forbidden`. Session
  cookies work on both `/v1` and `/api/v1`.
- If `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `HANGAR_SESSION_KEY` or
  `HANGAR_ALLOWED_GUILD_IDS` is missing/empty (or the key is < 32 chars, a guild
  id isn't a snowflake, or the origin is malformed), browser login
  is off: the login routes and `/api/me` answer 503 and cookies are not a
  credential. Service callers keep working (fail closed for browsers only).
- **Response headers:** every response carries
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
  (500s included). `/v1/...` and `/api/...` responses also get
  `Cache-Control: no-store` and `Vary: Cookie`. 500 bodies are generic — the
  detail and full stack are only in the log. An invalid Google token gets a
  bare `invalid ID token`; the google-auth reason is logged with the token
  scrubbed.
- **Log hygiene:** tokens, codes, cookies and secrets are never logged. The
  callback's `?code=&state=` is redacted from uvicorn's access log
  (`src/log_redaction.py`); Discord errors are logged by HTTP status / Discord
  `error` field only.
- Callers mint tokens with audience = the URL they call (`HANGAR_API_URL`),
  and it must equal `HANGAR_AUDIENCE` byte for byte (no trailing slash).
  Cloud Run serves the service at two URLs:
  `https://hangar-service-hvmf2jpuca-uc.a.run.app` and
  `https://hangar-service-278098364045.us-central1.run.app`. `HANGAR_AUDIENCE`
  is currently the **`-uc.a.run.app` form**, so callers must use exactly that
  URL. Tokens minted from the SA JSON key include `email`; impersonated tokens
  need `--include-email`.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `HANGAR_AUDIENCE` | *(empty → all requests 401)* | Expected token audience: this service's URL |
| `HANGAR_ALLOWED_CALLERS` | `hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com` | Comma-separated caller SA emails |
| `HANGAR_ADMIN_IDS` | *(none)* | Comma-separated Discord IDs that may write any member's hangar (same as the bot's `BOT_ADMIN_USER_IDS`) |
| `WIKI_BASE` | `https://api.star-citizen.wiki/api` | Star Citizen Wiki API base |
| `GOOGLE_CLOUD_PROJECT` | *(ADC)* | Firestore project |
| `PORT` | `8080` | Listen port (Cloud Run sets it) |
| `HANGAR_VERSION` | `$K_REVISION` or `dev` | Reported by `/health`, sent in the Wiki User-Agent |
| `HANGAR_STORAGE` | `firestore` | `memory` = non-persistent, **local dev only** (refused when `K_SERVICE` is set, i.e. on Cloud Run) |
| `HANGAR_PUBLIC_ORIGIN` | `https://hangar.aklabs.io` | Web editor origin: CSRF check + OAuth redirect URI (`<origin>/api/auth/callback`). Trailing slash dropped |
| `DISCORD_CLIENT_ID` | *(empty → browser login off)* | Discord application client ID (`1558216042151419935`) |
| `HANGAR_ALLOWED_GUILD_IDS` | *(empty → browser login off)* | Comma-separated Discord server IDs whose members may sign in (production `323349603976216577`). Empty never means "everyone" |
| `DISCORD_CLIENT_SECRET` | *(empty → browser login off)* | From Secret Manager `hangar-discord-client-secret` (`--set-secrets`) |
| `HANGAR_SESSION_KEY` | *(empty → browser login off)* | Cookie-signing key, ≥ 32 chars; Secret Manager `hangar-session-key`. Signs every new session |
| `HANGAR_SESSION_KEY_PREVIOUS` | *(none)* | Previous signing key (≥ 32 chars), still accepted for verification during a rotation; never signs |
| `HANGAR_SESSION_NOT_BEFORE` | *(none)* | Unix seconds: sessions issued (`iat`) before this are rejected — global logout. Malformed (anything but ASCII digits) → browser login off |
| `HANGAR_MAX_SHIPS_PER_MEMBER` | `200` | Ship cap per member (`409 limit` beyond it). Must be a positive integer (startup fails otherwise) |

`HANGAR_PUBLIC_ORIGIN` is normalized at load (scheme/host lower-cased, default
port and a lone trailing `/` dropped); a path, query, fragment, userinfo or bad
port turns browser login off.

## Session key rotation / revocation

Sessions are stateless signed cookies, so there is no per-session revoke; use:

- **Routine key rotation (nobody logged out):** add a new version of Secret
  Manager `hangar-session-key`; deploy with `HANGAR_SESSION_KEY` = the new
  version and `HANGAR_SESSION_KEY_PREVIOUS` = the old one. New sessions are
  signed with the new key, existing ones keep working. After 30 days (the
  session max age) every old-key session has expired: drop
  `HANGAR_SESSION_KEY_PREVIOUS` and disable the old secret version.
- **Log everyone out now (suspected leak):** rotate WITHOUT
  `HANGAR_SESSION_KEY_PREVIOUS`, or keep the key and set
  `HANGAR_SESSION_NOT_BEFORE=$(date +%s)` — every session issued before that
  moment is rejected (401); members just log in again. Leave it set (it is
  harmless) or remove it once 30 days have passed.
- **A single member:** there is no per-member revoke; use the global cutoff
  above (everyone re-logs in).
- The OAuth state cookie uses the same keys, so a rotation mid-login at worst
  costs a `state_mismatch` retry.

## Runtime behaviour

- The Wiki vehicle index (~299 vehicles, 6 requests) is warmed by a background
  task at startup; startup doesn't wait for it and a failure is only logged.
  Catalog data is cached 12h, stale-while-revalidate (not-found entries 10min).
- Cloud Run runs with request-only CPU, so a background refresh may stall
  between requests and finish on the next one. That's accepted: stale catalog
  data is still served, and min-instances 1 keeps the cache warm.
- `GET …/hangar` fetches every owned ship's slots concurrently.
- The member directory (`GET …/members`) is cached in-process for 60s; ship
  create/delete invalidate it (renames/fits may show a stale display name for
  up to 60s). Per-instance: another Cloud Run instance may lag up to 60s.

## Local run

```bash
cd hangar-service
uv venv --seed -p 3.13 .venv            # 3.13 locally; the image is 3.14
uv pip install -p .venv/bin/python -r requirements-dev.txt
.venv/bin/python -m pytest -q

HANGAR_STORAGE=memory HANGAR_AUDIENCE=http://localhost:8080 \
  .venv/bin/python -m src.main
# Browser login locally: also set HANGAR_PUBLIC_ORIGIN=http://localhost:<port>,
# DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET (that redirect URI must be registered
# in the Discord app) and a >=32-char HANGAR_SESSION_KEY.
curl localhost:8080/health
# Firestore emulator instead of memory: export FIRESTORE_EMULATOR_HOST=localhost:8681 and drop HANGAR_STORAGE.
```

Local Python note: the uv-managed `3.14.0rc2` on the dev box can't import
pydantic (`_eval_type() got an unexpected keyword argument 'prefer_fwd_module'`),
so the venv uses 3.13. The container runs the real 3.14 and the suite passes there too.

## Build and deploy (coordinator)

Prereqs (once): APIs `run`, `firestore`, `artifactregistry` enabled; Firestore
Native DB in `us-central1`; Artifact Registry repo `revenant`; runtime SA
`hangar-runtime@` with `roles/datastore.user`; caller SA `hangar-api@`.
Never `:latest` — tag with the git short SHA.

```bash
SHA=$(git rev-parse --short HEAD)
IMAGE=us-central1-docker.pkg.dev/revenant-discord-bot-2/revenant/hangar-service:$SHA

gcloud auth configure-docker us-central1-docker.pkg.dev
docker build -t "$IMAGE" -f hangar-service/Dockerfile hangar-service/
docker push "$IMAGE"

# ^;^ switches gcloud's env-var delimiter to ';' because HANGAR_ADMIN_IDS contains commas.
# --no-allow-unauthenticated: domain-restricted sharing forbids an allUsers invoker.
gcloud run deploy hangar-service --project revenant-discord-bot-2 \
  --image "$IMAGE" --region us-central1 --no-allow-unauthenticated \
  --service-account hangar-runtime@revenant-discord-bot-2.iam.gserviceaccount.com \
  --min-instances 1 --memory 512Mi \
  --set-env-vars "^;^GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2;HANGAR_ALLOWED_CALLERS=hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com;HANGAR_ADMIN_IDS=<id1>,<id2>;HANGAR_VERSION=$SHA"

# Let the caller SA through Cloud Run's invoker check (once).
gcloud run services add-iam-policy-binding hangar-service --project revenant-discord-bot-2 \
  --region us-central1 \
  --member serviceAccount:hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com \
  --role roles/run.invoker

# First deploy only: the audience is the service URL, known after the deploy.
# status.url is the -uc.a.run.app form -- the one HANGAR_AUDIENCE uses today.
URL=$(gcloud run services describe hangar-service --project revenant-discord-bot-2 \
  --region us-central1 --format='value(status.url)')
gcloud run services update hangar-service --project revenant-discord-bot-2 \
  --region us-central1 --update-env-vars "HANGAR_AUDIENCE=$URL"
# Callers' HANGAR_API_URL must be this same $URL.
# On later deploys add HANGAR_AUDIENCE=$URL to --set-env-vars (it replaces the whole set).
```

Smoke test with a real token, minted from the `hangar-api@` key file
(never commit the key):

```bash
URL=https://hangar-service-hvmf2jpuca-uc.a.run.app   # must equal HANGAR_AUDIENCE
TOKEN=$(python3 -c 'import sys, google.auth.transport.requests as r; from google.oauth2 import service_account as s
c = s.IDTokenCredentials.from_service_account_file(sys.argv[1], target_audience=sys.argv[2]); c.refresh(r.Request()); print(c.token)' \
  /path/to/hangar-api-key.json "$URL")
# Alternative: gcloud auth print-identity-token --impersonate-service-account=hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com \
#   --audiences="$URL" --include-email   (requires roles/iam.serviceAccountTokenCreator on hangar-api@ for your account)

# /health, not /healthz (Cloud Run 404s paths ending in z). With invoker IAM on,
# even /health needs the token at the Cloud Run edge.
curl -s -H "Authorization: Bearer $TOKEN" "$URL/health"
curl -s -H "Authorization: Bearer $TOKEN" "$URL/v1/catalog/vehicles?q=harbinger"
```
