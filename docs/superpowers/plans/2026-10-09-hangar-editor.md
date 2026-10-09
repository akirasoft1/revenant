# Hangar Web Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `https://hangar.aklabs.io` — Discord-login web editor for member hangars (ships, slot-by-slot fitting, other members' hangars, spviewer import), served by a GCP load balancer → Cloud Run `hangar-service`, which serves both the API and the built SPA (a public GCS bucket is blocked by the org's domain restriction).

**Architecture:** `hangar-service` (FastAPI) gains Discord OAuth + signed-cookie sessions as a second credential resolver, `/api/v1` aliases, a member directory, compatible-item options per slot, and spviewer import (LZ-string decode → slot diff vs stock). New `hangar-editor/` React SPA. Infra scripted like the owner's home-build app (Cloud DNS zone, LB, managed cert, serverless NEG) minus the backend bucket.

**Tech Stack:** Python 3.14 FastAPI, itsdangerous, httpx, lzstring (or vendored decoder), pytest; React 18 + TS + Vite + TanStack Query + React Router + Vitest; gcloud.

**Spec:** `docs/superpowers/specs/2026-10-09-hangar-editor-design.md` (binding — routes, cookie attributes, import semantics, secrets names live there). Project-1 spec for context: `docs/superpowers/specs/2026-10-09-member-hangar-design.md`.

## Global Constraints
- Public origin `https://hangar.aklabs.io` (`HANGAR_PUBLIC_ORIGIN`); redirect URI `https://hangar.aklabs.io/api/auth/callback`; `DISCORD_CLIENT_ID=1558216042151419935`; secrets via Secret Manager only: `hangar-discord-client-secret` (env `DISCORD_CLIENT_SECRET`), `hangar-session-key` (env `HANGAR_SESSION_KEY`). Never read or print `.env_sc_hanger`; never log tokens/cookies/codes/secrets; never truncate logs.
- Cookie `hangar_session`: signed, `HttpOnly; Secure; SameSite=Lax; Path=/`, 30-day max age. OAuth state cookie `hangar_oauth_state` short-lived (10 min).
- Session principals: acting member = session Discord ID; `X-Acting-Member` ignored for them; writes require same-origin `Origin`/`Referer`. Service-token behaviour (bot, sc-knowledge) unchanged, including the `/v1` paths and the exact token audience.
- Every existing `/v1/...` route also served at `/api/v1/...`; `/health` stays unauthenticated.
- Import never trusts client-sent changes; caps: upload ≤ 2 MB, decompressed ≤ 2 MB per row.
- Images tagged git short SHA; never `:latest`. Stage explicit paths only (never `git add -A`). Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. TDD. Suites: `cd hangar-service && .venv/bin/python -m pytest -q` (baseline 264 passed / 8 skipped), `cd hangar-editor && npm test`, bot `npm test` (baseline 1594). No deploys or gcloud mutations by implementers.

---

### Task 1: hangar-service — Discord OAuth, sessions, `/api` prefix, `/api/me`, members directory
**Files:** `hangar-service/src/session.py` (sign/verify), `src/discord_oauth.py` (authorize URL, code exchange, user fetch — httpx, injectable transport), `src/auth.py` (add `DiscordSessionResolver` to the chain; principal kind `session`; CSRF same-origin check helper), `src/app.py` (auth routes, `/api/me`, `/api/v1/members`, dual-prefix registration for all `/v1` routes, set `ownerName` on ship writes from session principals), `src/config.py` (new env), `requirements.txt`, tests.
- [ ] TDD per spec Testing (OAuth flow with fake Discord incl. state mismatch/token error/user error → `/?login_error=…`; session tamper/expiry; acting member = session id, header ignored; non-same-origin write → 403 `forbidden`; dual prefixes; directory). Commit.

### Task 2: hangar-service — slot options + spviewer import
**Files:** `src/keystats.py` (per-type key stat mapping copied from sc-knowledge `tools_items.py` COMPONENT_TYPES, keep-in-sync comment), `src/prices.py` (optional UEX `items_prices` cheapest buy price, cached, failure → omitted), `src/spviewer.py` (decode, walk ports, diff vs stock, resolve items by uuid or class name via the Wiki catalog, compatibility via `check_compatible`), `src/app.py` routes `GET /api/v1/catalog/slot-options`, `POST /api/v1/import/spviewer/preview`, `POST /api/v1/import/spviewer/apply`; fixture `tests/fixtures/spviewer_harbinger.json` (copy of `/mnt/c/Users/akira/Downloads/spviewer-loadouts.json`), tests.
**Consumes:** Task 1 principals/permissions.
- [ ] TDD per spec (real fixture → Harbinger resolves, zero changes; synthetic modified loadout → QD change, nose gun change via uuid, missile → skipped untracked, unknown item → skipped, undecodable → `unrecognized_format`; apply new/existing, authoritative reset; caps; permissions). Commit.

### Task 3: `hangar-editor/` SPA
**Files:** new Vite React TS app per spec pages; `src/api/*` (fetch wrappers with credentials, 401 → login), components, `vite.config.ts` (dev proxy `/api` → local hangar-service), Vitest tests, `README.md`.
**Consumes:** Task 1/2 routes and JSON shapes (read their reports).
- [ ] Tests for picker filter/sort, import preview, auth gating; `npm run build` succeeds. Commit.

### Task 4: SPA serving, image, infra scripts, bot footer, docs
**Files:** `hangar-service/src/app.py` (static SPA serving per spec: hashed assets long-cache, SPA fallback to `index.html` no-cache for non-API GETs, `/version.txt`), `hangar-service/Dockerfile` (multi-stage: node:24-slim builds `hangar-editor` → copy `dist` into the python image; build context = repo root) + `hangar-service/Dockerfile.dockerignore` (allow only `hangar-service/` and `hangar-editor/` sources; exclude `.env*`, keys, `node_modules`, `.venv`, `OrgGuides/`), README build command; `hangar-service/scripts/setup-domain.sh` (Cloud DNS zone `hangar.aklabs.io`, print NS + pause, static IP, managed cert, serverless NEG → `hangar-service`, backend service, URL map default → API backend, HTTPS proxy + forwarding rule, HTTP→HTTPS redirect; idempotent; `gcloud run services update hangar-service --no-invoker-iam-check`); bot `commands/slash/HangarCommand.js` list footer from `HANGAR_EDITOR_URL` + `config/config.js` + tests; docs (CLAUDE.md, READMEs, features.md).
- [ ] TDD for static serving + footer; `docker build` from repo root succeeds and the image contains no `.env*`/key files; scripts pass `bash -n`. Commit.

## Coordinator steps
Grant done: secrets + accessor. Deploy hangar-service with new env/secrets (`--set-secrets`) and `--no-invoker-iam-check`; verify bot/sc-knowledge still work; run `setup-domain.sh` (owner adds NS records); wait for cert ACTIVE; bot version bump + deploy; live login/edit/import test with the owner; PR.
