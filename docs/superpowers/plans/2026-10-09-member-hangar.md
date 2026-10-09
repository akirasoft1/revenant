# Member Hangar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Per-member Star Citizen ship loadouts in a Cloud Run + Firestore service, queried by the bot through sc-knowledge tools (text + voice) and seeded via a `/hangar` slash command.

**Architecture:** New `hangar-service/` (Python FastAPI) on Cloud Run in `revenant-discord-bot-2` holds `members/{discordId}/ships/{shipId}` in Firestore and a Wiki-API-derived catalog (ships → editable slots → compatible items). It authenticates service callers with Google ID tokens from SA `hangar-api@`. sc-knowledge gains `sc_member_hangar` / `sc_member_fit_check` and a `purchasable_only` filter on `sc_compare_components`; the bot gains `/hangar`.

**Tech Stack:** Python 3.14, FastAPI, google-cloud-firestore, google-auth, httpx, pytest (hangar-service, sc-knowledge); Node.js + discord.js + google-auth-library, Jest 30 (bot).

**Spec:** `docs/superpowers/specs/2026-10-09-member-hangar-design.md` (binding — API paths, document shape, auth rules, error codes, tool names/signatures live there).

## Global Constraints
- Tool names exactly `sc_member_hangar(member_id, ship=None)` and `sc_member_fit_check(member_id, item)`; `sc_compare_components(..., purchasable_only: bool = False)`.
- API paths, Firestore document shape, error codes (`unavailable`, `not_found`, `ambiguous`+`candidates`, `incompatible`, `forbidden`, `unauthenticated`) exactly as the spec.
- Env names: hangar-service `HANGAR_ALLOWED_CALLERS`, `HANGAR_ADMIN_IDS`, `HANGAR_AUDIENCE`, `WIKI_BASE`, `GOOGLE_CLOUD_PROJECT`; callers `HANGAR_API_URL`, `HANGAR_SA_KEY_PATH` (`/var/secrets/hangar/key.json`).
- Never `:latest`; images tagged with git short SHA. Never truncate log messages. Never commit secrets/keys; never touch `k8s/overlays/deployed/` (coordinator does), `OrgGuides/`.
- Stage explicit paths only (never `git add -A`); commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. TDD. Tests: `cd hangar-service && .venv/bin/python -m pytest -q`; `cd sc-knowledge && .venv/bin/python -m pytest -q`; `cd agent-sidecar && .venv/bin/python -m pytest -q`; `cd voice-sidecar && .venv/bin/python -m pytest -q`; bot `npm test`. Record baselines.
- No real network in unit tests (recorded fixtures / fakes). Firestore behind a repository interface with an in-memory fake for tests.

---

### Task 1: hangar-service core (catalog, loadout logic, repository)
**Files:** create `hangar-service/` with `pyproject.toml`/`requirements.txt`/`requirements-dev.txt` (mirror sc-knowledge's layout + `.venv` setup), `src/catalog.py` (Wiki client + slot parsing + item listing, 12h TTL stale-on-error cache), `src/loadout.py` (effective-loadout merge, slot compatibility, vehicle resolution exact/fuzzy/ambiguous), `src/repository.py` (`ShipRepository` interface; `FirestoreShipRepository`; `InMemoryShipRepository`), tests + a recorded Wiki fixture for the Constellation Taurus vehicle and a small items fixture.
**Produces:** `Catalog.vehicle(uuid_or_slug)`, `Catalog.search_vehicles(q, limit=25)`, `Catalog.slots(vehicle_uuid) -> [Slot(name, type, size_min, size_max, compatible_types, stock_item)]`, `Catalog.items(type, size=None, q=None)`; `effective_loadout(slots, fitted) -> [ {slot, type, sizeMin, sizeMax, item:{uuid,name}, source} ]`; `check_compatible(slot, item) -> None | reason`; `resolve_vehicle(query, candidates) -> match | ambiguous(candidates) | not_found`; repository CRUD per the spec document shape.
- [ ] TDD per spec Testing (parsing incl. nested `parent/child` slots and the component-type allowlist; merge; compatibility; resolution). Commit.

### Task 2: hangar-service API, auth, container
**Files:** `hangar-service/src/app.py` (FastAPI app + routes per spec), `src/auth.py` (Google ID-token verification via `google.oauth2.id_token.verify_oauth2_token`, audience `HANGAR_AUDIENCE`, email allow-list; acting-member + admin write rule), `src/config.py`, `Dockerfile` (`python:3.14-slim`, non-root, `PORT` from env), `README.md` (env, auth, deploy commands), tests (FastAPI TestClient with the in-memory repo + a fake token verifier).
**Consumes:** Task 1. **Produces:** the HTTP API exactly per spec.
- [ ] TDD: every route happy + error path; auth (missing/invalid/wrong-audience/disallowed email → 401; non-self non-admin write → 403; reads of others OK); `/healthz` unauthenticated with no upstream calls; 409 ambiguous with candidates; 422 incompatible slot item. `docker build -q -f hangar-service/Dockerfile hangar-service/` succeeds. Commit.

### Task 3: sc-knowledge hangar tools
**Files:** `sc-knowledge/src/hangar.py` (client: ID token minted from `HANGAR_SA_KEY_PATH` via google-auth `service_account.IDTokenCredentials`, cached until near expiry; 3s timeout; 30s response cache), `src/tools_hangar.py` (ship shorthand resolution within a member's hangar; fit-check verdicts per spec), `src/tools_items.py` (`purchasable_only`), `src/server.py` (register `sc_member_hangar`, `sc_member_fit_check`; docstrings say: only for questions about a member's own ships; `member_id` = Discord ID from labels/roster; "my" = labelled speaker), `src/config.py` (new env), `requirements.txt` (+google-auth), tests with a fake hangar client.
**Consumes:** Task 2 API JSON. **Produces:** the two MCP tools + filter.
- [ ] TDD: "Connie" → only Constellation owned; ambiguous between two Constellations → candidates; nickname wins; fit-check upgrade/downgrade/same/sidegrade + `size_mismatch` vs `no_slot` reasons; another member's id works; unavailable → `error("unavailable")`; `purchasable_only` excludes items without a UEX shop price. Full suite. Commit.

### Task 4: bot `/hangar` command
**Files:** `services/HangarClient.js` (google-auth-library `JWT`/`GoogleAuth` `getIdTokenClient(HANGAR_API_URL)` from `HANGAR_SA_KEY_PATH`; JSON errors surfaced as `{ok:false, error, candidates?}`; never throws to callers), `commands/slash/HangarCommand.js` (subcommands/options per spec; autocomplete for `ship` — catalog for `add`, target's hangar for `rename`/`remove`), registration in `commands/slash/index.js`, `bot.js`, `scripts/registerCommands.js`, `config/config.js` (`hangar.apiUrl`, `hangar.saKeyPath`; command registered only when `HANGAR_API_URL` is set), `package.json` (+google-auth-library if absent), tests.
- [ ] TDD: each subcommand; autocomplete; self vs other vs admin; `X-Acting-Member` header always set to the invoking user; ambiguous → reply lists candidates; unavailable message. Full `npm test`. Commit.

### Task 5: prompts, eval, docs
**Files:** `agent-sidecar/src/agent.py` (one sentence in `sc_tools_preamble` both variants: hangar tools only for questions about a member's own ships; member_id from labels/roster), `voice-sidecar/src/live_bridge.py` (same, short, in `SC_VOICE_NOTE`), pinned-text tests in both sidecars, `agent-sidecar/eval/sc_eval_set.py` + `eval_sc.py` (hangar cases with a seeded-member fixture: expect_tool `sc_member_hangar` / `sc_member_fit_check`; history/labels so "my" resolves; controls must not call hangar tools), `CLAUDE.md` (new "Member hangar" subsection under Star Citizen: service, auth, data model, tools, `/hangar`, limitations, future items from the spec), `README.md`, `features.md`, `sc-knowledge/README.md`.
- [ ] TDD for prompt text; all sidecar suites green. Commit.

## Coordinator steps
GCP: enable `run`, `firestore`, `artifactregistry`, `secretmanager`, `iamcredentials` APIs; create Firestore Native DB (`us-central1`); Artifact Registry repo `revenant` (docker, `us-central1`); runtime SA `hangar-runtime@` with `roles/datastore.user`; caller SA `hangar-api@` + JSON key → k8s Secret `hangar-api-sa` (never written to the repo). Build/push hangar-service image to Artifact Registry; `gcloud run deploy hangar-service --allow-unauthenticated --service-account hangar-runtime@…` with env; set `HANGAR_AUDIENCE` to the service URL. Mount the secret + env into sc-knowledge and the bot (deployed overlays); NetworkPolicy egress to `*.run.app` 443 if restricted; build/deploy sc-knowledge, agent, voice (lockstep sandbox-base), bot (minor bump); `registerCommands.js`; seed test data; in-cluster eval + real-model check of the three use-case questions; delete test data; PR.
