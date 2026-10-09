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
| `incompatible` | 422 | item does not fit the slot (type / sub-type / size); `message` says why |
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

**Every `/v1/...` route is also served at `/api/v1/...`** (same handler, same
auth). Service callers use `/v1` on the `run.app` URL; the browser editor uses
`/api/v1` through the load balancer. Browser-only routes:

| Method | Path | Success | Failure |
|---|---|---|---|
| GET | `/api/auth/login?next=/path` | 302 → `https://discord.com/oauth2/authorize?...` (scope `identify`); sets `hangar_oauth_state` (signed, 10 min, `Path=/api/auth`) | 503 `unavailable` if browser login unconfigured |
| GET | `/api/auth/callback?code&state` | 302 → `next` (same-origin path, default `/`); sets `hangar_session`; clears the state cookie | 302 → `/?login_error=<code>`, code ∈ `state_mismatch`, `denied`, `missing_code`, `token_error`, `user_error`, `server_error`; 503 if unconfigured |
| POST | `/api/auth/logout` | 204, clears `hangar_session` | – |
| GET | `/api/me` | `{discordId, username, globalName, avatarUrl, isAdmin}` | 401 `unauthenticated` (no / bad / expired session); 503 if unconfigured |

All four send `Cache-Control: no-store`. `next` must be a same-origin path
(`/…`, not `//host`, no scheme) or it becomes `/`.

`Ship` = `{shipId, vehicleUuid, vehicleName, vehicleClassName, nickname, fitted,
createdAt, updatedAt, updatedBy, ownerName, loadout, loadoutError}` where
`ownerName` is the owner's Discord global name (else username), stored when the
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
  (scope `identify`, redirect `HANGAR_PUBLIC_ORIGIN` + `/api/auth/callback`).
  On success the service sets `hangar_session`: an itsdangerous-signed (HMAC,
  key `HANGAR_SESSION_KEY`, not encrypted) cookie carrying only public profile
  fields `{discordId, username, globalName, avatar, iat}`;
  `HttpOnly; Secure; SameSite=Lax; Path=/`, 30-day max age, no server-side
  store (logout clears the cookie; a leaked cookie is valid until it expires or
  the key rotates). A tampered / expired / other-key cookie is 401.
  A session principal's **acting member is the session's Discord ID**;
  `X-Acting-Member` is ignored. The write rule is the same (own hangar, or an
  admin). **CSRF:** session writes additionally need `Origin` (or, without
  one, `Referer`) on `HANGAR_PUBLIC_ORIGIN`, else 403 `forbidden`. Session
  cookies work on both `/v1` and `/api/v1`.
- If `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` or `HANGAR_SESSION_KEY` is
  missing (or the key is < 32 chars, or the origin is malformed), browser login
  is off: the login routes and `/api/me` answer 503 and cookies are not a
  credential. Service callers keep working (fail closed for browsers only).
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
| `DISCORD_CLIENT_SECRET` | *(empty → browser login off)* | From Secret Manager `hangar-discord-client-secret` (`--set-secrets`) |
| `HANGAR_SESSION_KEY` | *(empty → browser login off)* | Cookie-signing key, ≥ 32 chars; Secret Manager `hangar-session-key`. Rotating it logs everyone out |

## Runtime behaviour

- The Wiki vehicle index (~299 vehicles, 6 requests) is warmed by a background
  task at startup; startup doesn't wait for it and a failure is only logged.
  Catalog data is cached 12h, stale-while-revalidate (not-found entries 10min).
- Cloud Run runs with request-only CPU, so a background refresh may stall
  between requests and finish on the next one. That's accepted: stale catalog
  data is still served, and min-instances 1 keeps the cache warm.
- `GET …/hangar` fetches every owned ship's slots concurrently.

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
