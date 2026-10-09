# hangar-service

Per-member Star Citizen ship loadouts. A small FastAPI service on **Cloud Run**
(GCP project `revenant-discord-bot-2`, region `us-central1`) that stores each
Discord member's ships in **Firestore** (`members/{discordId}/ships/{shipId}`)
and derives every ship's component slots from the **Star Citizen Wiki API**.
Callers: the bot's `/hangar` command, sc-knowledge's `sc_member_hangar` /
`sc_member_fit_check` tools, and the agent and voice sidecars' chat-edit tools
`hangar_fit` / `hangar_add_ship` / `hangar_reset` (Google ID tokens), and the web editor at
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
| `ambiguous` | 409 | vehicle text matches several vehicles; body carries `candidates` (chat edits: ship text matches several of the member's ships, `candidates: [{shipId, label}]`) |
| `choose_slot` | 409 | chat edits: several slots fit and the `slot` hint didn't pick one; body carries `ship`, `slots: [{slot, type, size, current: {name}}]` |
| `limit` | 409 | adding the ship would exceed `HANGAR_MAX_SHIPS_PER_MEMBER` (body carries `limit`, `shipCount`) |
| `incompatible` | 422 | item does not fit the slot (type / sub-type / size); `message` says why (chat fit: + `reason` `size_mismatch` \| `no_slot`) |
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
| POST | `/v1/members/{discordId}/fit` | `{ship, item, slot?}` (free text) | `{member, ship: {shipId, label, vehicle}, item: {uuid, name, type, size}, changes: [Change], unchanged}` — see "Chat edits" |
| POST | `/v1/members/{discordId}/ships/{shipRef}/reset` | `{slot?}` (body optional) | `{member, ship: {shipId, label, vehicle}, changes: [Change], unchanged}` — see "Chat edits" |
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

## Chat edits (`/fit`, `/ships/{shipRef}/reset`)

The bot's agent and voice sidecars record "I put the Hemera in my Connie" /
"put my Harbinger's shields back to stock" through these two writes, sending
the real speaker as `X-Acting-Member` (same write rule as every other write:
acting member == path member, or an admin; browser sessions need a
same-origin request). The server does ALL resolution; every resolution error
is returned before anything is written, and each request makes at most ONE
write (`update_slots`: one Firestore update setting / deleting exactly the
target `fitted.<slot>` fields), so a multi-slot change is all-or-nothing,
never wipes other slots edited concurrently, and `changes` is exactly the
written set (logged only after the write succeeds).
The callers bind `X-Acting-Member` from trusted plumbing, never from a tool
argument (agent: `ChatRequest.user_id`; voice: the current `SetSpeaker.user_id`,
else the session opener), and their tools have no member parameter — see
`CLAUDE.md` "Member hangar" → "Chat edits".

- **Ship** (`ship`, `shipRef`): an exact `shipId`, else free text resolved
  within the member's own hangar by `src/ship_resolve.py` — exact nickname →
  nickname fuzzy → exact model → model tokens/prefixes with community
  shorthand (`SHIP_SHORTHAND`: "Connie" → Constellation, "cutty", "msr", …) →
  model fuzzy. **KEEP IN SYNC** with `sc-knowledge/src/tools_hangar.py`
  (`sc_member_hangar` reads with the same rules and labels);
  `tests/test_ship_resolve.py` fails if the copies drift. Several → 409
  `ambiguous` `field: "ship"`, `candidates: [{shipId, label}]`; none → 404
  `not_found` `field: "ship"` with `owned: [{shipId, label}]`. Labels: `"Nickname" (Model)`, else the model
  name, plus `(ship <id>)` when two would read the same.
- **Item** (`/fit` only, `src/item_resolve.py`, shared by text and voice):
  exact catalog lookup (uuid / exact Wiki name / class name); else drop
  leading "my/the", possessives and component-type words ("the hemera
  quantum drive" → "Hemera", types → QuantumDrive) and retry exact; else
  score a pool = `catalog.items(type)` for the spoken type(s), or every type
  the ship's slots accept: exact casefold name → every word a whole token or
  ≥3-char prefix of the name (quotes stripped: "lorica" → `7MA 'Lorica'`) →
  fuzzy ratio ≥ 85 with a 5-point lead ("hemra" → Hemera). Ties prefer items
  that fit one of the ship's slots (type + size). Several → 409 `ambiguous`
  `field: "item"`, `candidates: [{uuid, name, type, size}]` (≤5); none → 404
  `not_found` `field: "item"`, `suggestions: [name]` (≤3, score ≥ 60). The
  response's `item.matchedBy` is `"exact"` or `"fuzzy"`, `item.name` the
  canonical name. Cold pool lists cost one Wiki fetch per type (then cached
  12h).
- **Target slots** (`/fit`): the ship's visible slots `check_compatible`
  accepts; a mount of another type (Turret gimbal) that also accepts the item
  is skipped when a fitting child is visible. None → 422 `incompatible` with
  `reason` `size_mismatch` (+ `slots` it would go in, by size) or `no_slot`.
  `slot` (`src/slot_hint.py`):
  - omitted: exactly one compatible slot → it; several → 409 `choose_slot`;
  - `"all"` / `"every"` / `"everything"` / `"each"` → every compatible slot;
    `"both"` → only when exactly two remain, else 409 `choose_slot`;
  - an exact slot id (case-insensitive) → that slot (incompatible → 422);
  - a hint matched against slot-id tokens. Position words are equivalence
    sets — {top, upper}, {bottom, lower, under}, {front, nose, fwd, forward},
    {left, port, l}, {right, starboard, r}, {rear, back, aft} — so "top left"
    and "upper left" both hit `hardpoint_gun_laser_top_left/...`. Number words
    "two".."six" / "first".."sixth" are digits; "one" only after a type word
    ("shield one"), otherwise filler ("the top left one"). Numbers compare
    numerically ("1" == "001"), and tokens
    every candidate shares — e.g. the `hardpoint_class_2` suffix on all
    Harbinger nose guns — are ignored first, so "2" means `..._fixed_002`).
    Component words filter by type ("shield 2", "left cooler", "qd"); a
    plural one ("shields", "both coolers") selects every slot it leaves. One
    match → it; several → 409 `choose_slot`; none → 409 `choose_slot` listing
    every compatible slot.
- **Writes**: one `update_slots` call for every target slot, with the same
  stock rule as `PUT .../slots/{slot}` (fitting the stock item deletes the
  override). Slots already holding the
  item are skipped; nothing to change → `changes: []`, `unchanged: true`.
- **Reset** (`slot` omitted / `"all"` / id / hint): resets slots to stock.
  Only non-stock slots matter: a ship with nothing fitted is always
  `unchanged`; omitted `slot` → the one refitted slot, or 409 `choose_slot`
  listing the refitted slots; `"all"` → every refitted slot in one write; a
  hint matching several slots narrows to the refitted ones (one → it, several
  → `choose_slot`, none → `unchanged`); no match → `choose_slot` listing the
  refitted slots; `"both"` alone → the refitted slots when there are at most
  two, else `choose_slot`. Fitted ids the catalog no longer has (renamed in a
  patch, or the whole vehicle gone from the catalog) are resettable by exact
  id and by `"all"` (`to` names are then null).
- `Change` = `{slot, from: {name, uuid}, to: {name, uuid}}` (`from` is the
  previously effective item, `to` the new one — the stock item for a reset;
  `null` names for an empty slot or an orphaned slot's stock).
- One INFO log line per changed slot (`hangar: chat fit:` / `hangar: chat
  reset:` with member, ship, slot, from -> to, acting member) and one for a
  no-op.

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
  "empty", so it stays stock), `too_many_lookups` (the request's budget of 32
  DISTINCT Wiki item lookups is spent). A duplicate slot path in a row makes the
  whole row `unrecognized_format`; more than 500 ports makes it `too_large`. An untracked port whose current item is only a
  bare uuid (no `selected*` entry) is not resolved — it can't affect the
  import and would cost a Wiki lookup per mount.
- Caps: body ≤ 2 MB (+64 KiB envelope; 413 `too_large`, checked on
  `Content-Length` and while streaming), ≤ 100 rows (413 `too_large`), ≤ 500
  ports and ≤ 2 MB decoded per row, 16 MB decoded per request, and **32
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
  `not_found` (no such ship), `vehicle_mismatch`, `too_many_lookups`.
  **A row whose analysis is incomplete is never written** — because apply is
  authoritative, writing it would reset the unresolved slots to stock and wipe
  the ship's existing fittings. That covers a row-level failure, any slot
  skipped with `too_many_lookups` (error `too_many_lookups`, "apply fewer
  loadouts at once"), and any row-level skip such as a non-empty `selected*`
  map with no matching `*Ports` array (`unrecognized_format`, detail
  `unknown selection category <name>`, logged at WARNING).
- The request body is read (and capped) **before** an import slot is taken,
  so a slow upload never holds one of the 2 slots.

## Auth

Two layers:

1. **Cloud Run edge: invoker IAM check OFF (`--no-invoker-iam-check`).** The
   org enforces domain-restricted sharing (`iam.allowedPolicyMemberDomains`),
   so `--allow-unauthenticated` (an `allUsers` invoker binding) FAILS — and a
   browser can't present a Google invoker token anyway. The service (this one
   only; the org policy is untouched) is therefore updated with
   `--no-invoker-iam-check`: Cloud Run lets every request through to the app,
   and **the app's own authentication is the only gate**. Nothing changed for
   the bot and sc-knowledge: they still call the `run.app` URL with Google ID
   tokens for the exact audience `https://hangar-service-hvmf2jpuca-uc.a.run.app`.
   Every `/v1` and `/api/v1` route stays authenticated. Open without credentials
   (none return member data): `/health`, `/healthz`, `/version.txt`, the static
   editor, and the login routes `/api/auth/login|callback|logout` plus `/api/me`
   (401 without a session). Both `run.app` URLs are just as public as
   `hangar.aklabs.io` — never rely on the load balancer for access control.
   The `roles/run.invoker` binding for `hangar-api@` stays in place (harmless,
   and needed again if the check is ever turned back on).
2. **The app**, which verifies Google ID tokens (service callers) and
   Discord sessions (browsers) and enforces the member write rule:
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
| `HANGAR_VERSION` | image build arg `GIT_SHA` (else `$K_REVISION` or `dev`) | Reported by `/health` and `/version.txt`, sent in the Wiki User-Agent |
| `HANGAR_STATIC_DIR` | `/app/static` in the image; locally `../hangar-editor/dist` | The built web editor. Missing / no `index.html` → the API still works, editor paths 404 (one WARNING at startup) |
| `HANGAR_RUM_ORIGINS` | *(none)* | Comma/space-separated https origins (Dynatrace RUM script CDN + beacon endpoint) added to the SPA CSP's `script-src` and `connect-src`. Only needed when the image was built with `VITE_DT_RUM_SRC`; non-https entries are ignored with a WARNING |
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

## Web editor (static SPA)

The load balancer sends every path of `https://hangar.aklabs.io` to this
service, which serves the built `hangar-editor` (`HANGAR_STATIC_DIR`) next to
the API (`src/static_site.py`):

- `/assets/*` (Vite's content-hashed bundles): `Cache-Control: public,
  max-age=31536000, immutable`. A missing asset is a JSON 404, never HTML.
- Other real files at the root (`favicon.svg`): `public, max-age=3600`.
- Any other GET/HEAD not under `/api`, `/v1`, `/health`, `/healthz` or
  `/assets` → `index.html` with `Cache-Control: no-cache`, so client routes
  (`/members/…`, `/import`) survive a reload and a deploy is picked up on the
  next navigation. The fallback hooks the router's 404, so API routing is
  unchanged (unknown `/v1` paths are JSON 404s, wrong methods 405).
- The document carries `Content-Security-Policy: default-src 'self';
  script-src 'self'; style-src 'self'; img-src 'self'
  https://cdn.discordapp.com data:; connect-src 'self'; font-src 'self';
  object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors
  'none'` (+ `HANGAR_RUM_ORIGINS` on script/connect). The Vite build has no
  inline script or style, so no `'unsafe-inline'`. Every response also keeps
  the security headers (HSTS, nosniff, `X-Frame-Options: DENY`, …).
- Dot segments, dotfiles and anything resolving outside the static dir are
  never served.
- `GET /version.txt` → `HANGAR_VERSION` (the image's git short SHA), `no-cache`.

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

Prereqs (once): APIs `run`, `firestore`, `artifactregistry`, `secretmanager`
enabled; Firestore Native DB in `us-central1`; Artifact Registry repo
`revenant`; runtime SA `hangar-runtime@` with `roles/datastore.user` and
`roles/secretmanager.secretAccessor` on the secrets `hangar-discord-client-secret`
and `hangar-session-key`; caller SA `hangar-api@`. Never `:latest` — tag with
the git short SHA.

**One image = API + web editor.** `hangar-service/Dockerfile` is multi-stage:
`node:24-slim` runs `npm ci && npm run build` in `hangar-editor/`, then the
`python:3.14-slim` stage copies `dist/` to `/app/static` (non-root uid 10001).
The **build context is the repo root**, filtered by
`hangar-service/Dockerfile.dockerignore` — an allow-list (`*`, then only
`hangar-service/requirements.txt`, `hangar-service/src/**` and the
`hangar-editor/` sources; `node_modules`, `dist`, `**/.env*`,
`**/*key*.json`, `OrgGuides` always excluded). Docker uses that file instead of
the root `.dockerignore` because it sits next to the Dockerfile.

```bash
SHA=$(git rev-parse --short HEAD)
IMAGE=us-central1-docker.pkg.dev/revenant-discord-bot-2/revenant/hangar-service:$SHA

gcloud auth configure-docker us-central1-docker.pkg.dev
# From the REPO ROOT (note the trailing "."). Optional RUM:
#   --build-arg VITE_DT_RUM_SRC=<script src>  (+ HANGAR_RUM_ORIGINS at deploy)
docker build -f hangar-service/Dockerfile --build-arg GIT_SHA=$SHA -t "$IMAGE" .
docker push "$IMAGE"

# ^;^ switches gcloud's env-var delimiter to ';' because HANGAR_ADMIN_IDS contains commas.
# --no-invoker-iam-check: domain-restricted sharing forbids an allUsers invoker
# and browsers can't send invoker tokens, so the app's auth is the only gate.
# --memory 1Gi: up to 2 concurrent spviewer imports (~150-250 MB each) + caches.
gcloud run deploy hangar-service --project revenant-discord-bot-2 \
  --image "$IMAGE" --region us-central1 --no-invoker-iam-check \
  --service-account hangar-runtime@revenant-discord-bot-2.iam.gserviceaccount.com \
  --min-instances 1 --memory 1Gi \
  --set-secrets DISCORD_CLIENT_SECRET=hangar-discord-client-secret:latest,HANGAR_SESSION_KEY=hangar-session-key:latest \
  --set-env-vars "^;^GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2;HANGAR_ALLOWED_CALLERS=hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com;HANGAR_ADMIN_IDS=<id1>,<id2>;HANGAR_VERSION=$SHA;HANGAR_AUDIENCE=https://hangar-service-hvmf2jpuca-uc.a.run.app;DISCORD_CLIENT_ID=1558216042151419935;HANGAR_ALLOWED_GUILD_IDS=323349603976216577;HANGAR_PUBLIC_ORIGIN=https://hangar.aklabs.io"
# --set-env-vars replaces the whole set: always pass every var above.
# Callers' HANGAR_API_URL must equal HANGAR_AUDIENCE (the -uc.a.run.app URL).
```

First-time history: the service was first deployed with invoker IAM on
(`--no-allow-unauthenticated` + `roles/run.invoker` for `hangar-api@`) and
`HANGAR_AUDIENCE` set from `status.url` after that first deploy. The binding is
still there; the invoker check itself is now off.

**Domain + load balancer:** `hangar-service/scripts/setup-domain.sh` creates
(idempotently — every step is "create if missing") the Cloud DNS zone
`zone-hangar-aklabs-io`, static IP `hangar-editor-ip`, the `A` record, the
managed certificate `hangar-editor-cert`, serverless NEG `hangar-editor-neg` →
`hangar-service`, backend `hangar-editor-backend`, URL map `hangar-editor-lb`,
HTTPS proxy/rule `hangar-editor-https-proxy`/`hangar-editor-https-rule`, and the
HTTP→HTTPS redirect (`hangar-editor-http-redirect`, `hangar-editor-http-proxy`,
`hangar-editor-http-rule`), then runs `gcloud run services update
hangar-service --no-invoker-iam-check`. When it creates the zone it prints the
NS records and pauses until they are added at the `aklabs.io` DNS provider.
The managed cert stays `PROVISIONING` until DNS resolves to the LB IP
(`gcloud compute ssl-certificates describe hangar-editor-cert --global`).

Smoke test with a real token, minted from the `hangar-api@` key file
(never commit the key):

```bash
URL=https://hangar-service-hvmf2jpuca-uc.a.run.app   # must equal HANGAR_AUDIENCE
TOKEN=$(python3 -c 'import sys, google.auth.transport.requests as r; from google.oauth2 import service_account as s
c = s.IDTokenCredentials.from_service_account_file(sys.argv[1], target_audience=sys.argv[2]); c.refresh(r.Request()); print(c.token)' \
  /path/to/hangar-api-key.json "$URL")
# Alternative: gcloud auth print-identity-token --impersonate-service-account=hangar-api@revenant-discord-bot-2.iam.gserviceaccount.com \
#   --audiences="$URL" --include-email   (requires roles/iam.serviceAccountTokenCreator on hangar-api@ for your account)

# /health, not /healthz (Cloud Run 404s paths ending in z). Open since the
# invoker check is off; the /v1 routes still need the token.
curl -s "$URL/health"
curl -s https://hangar.aklabs.io/health https://hangar.aklabs.io/version.txt   # through the LB
curl -s -H "Authorization: Bearer $TOKEN" "$URL/v1/catalog/vehicles?q=harbinger"
```
