# Hangar Chat Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Members record hangar changes by chat (text + voice); the bot writes immediately to the SPEAKER's own hangar and reads back the change.

**Architecture:** hangar-service gains `POST /v1/members/{id}/fit` and `POST /v1/members/{id}/ships/{shipRef}/reset` (server-side ship/item/slot resolution). The agent sidecar and voice sidecar each get three local tools (`hangar_fit`, `hangar_add_ship`, `hangar_reset`) bound in code to the trusted speaker ID, calling hangar-service with the `hangar-api@` ID token.

**Tech Stack:** Python 3.14 FastAPI (hangar-service), google-adk function tools (agent sidecar), google-genai Live function declarations (voice sidecar), google-auth, httpx, pytest.

**Spec:** `docs/superpowers/specs/2026-10-09-hangar-chat-edits-design.md` (binding).

## Global Constraints
- The acting member is NEVER a tool argument: text = `ChatRequest.user_id`; voice = current `SetSpeaker.user_id`, else `SessionStart.user_id`; unknown → refuse.
- Tool names exactly `hangar_fit(ship, item, slot=None)`, `hangar_add_ship(vehicle, nickname=None)`, `hangar_reset(ship, slot)`; writes send `X-Acting-Member`; 5s timeout; never raise.
- `HANGAR_API_URL` = `https://hangar-service-hvmf2jpuca-uc.a.run.app` exactly (token audience); key `HANGAR_SA_KEY_PATH=/var/secrets/hangar/key.json`; flag `HANGAR_EDITS_ENABLED`.
- Error codes from the service: `ambiguous`(+candidates), `choose_slot`(+slots), `not_found`, `incompatible`, `forbidden`, `unavailable`, `invalid_request`.
- Never truncate logs; never log tokens/secrets; never open `.env*` files. Stage explicit paths only; commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. TDD. Suites: `cd hangar-service && .venv/bin/python -m pytest -q` (baseline 685 passed / 12 skipped), `cd agent-sidecar && .venv/bin/python -m pytest -q`, `cd voice-sidecar && .venv/bin/python -m pytest -q`. No deploys.

---

### Task 1: hangar-service fit + reset endpoints
**Files:** `hangar-service/src/ship_resolve.py` (port sc-knowledge's ship resolution from `sc-knowledge/src/tools_hangar.py` incl. SHIP_SHORTHAND, keep-in-sync comment both ways), `src/app.py` (routes under both prefixes, write rule + CSRF helper as other writes), tests.
- [ ] TDD per spec Testing (hangar-service bullet). Commit.

### Task 2: agent-sidecar edit tools + prompt + eval
**Files:** `agent-sidecar/src/hangar_edit.py` (client: ID token from key file, cached; tool functions bound per turn to user_id), `src/agent.py` (attach tools per turn when enabled; one prompt sentence in `sc_tools_preamble` both variants), `src/server.py` (span attr `hangar.edits`), `src/config.py`, eval cases in `agent-sidecar/eval/sc_eval_set.py` (+ seed script support for a Constellation Taurus "Connie" on the eval member), tests.
- [ ] TDD; eval cases per spec. Commit.

### Task 3: voice-sidecar edit tools + docs
**Files:** `voice-sidecar/src/hangar_edit.py` (same client shape), `src/live_bridge.py` (track current speaker user id from SetSpeaker + opener fallback; declare the three tools when enabled; handle locally like control tools; send FunctionResponse to the CURRENT session; one short sentence in the voice notes), `src/config.py`, tests; docs: CLAUDE.md, READMEs, features.md.
- [ ] TDD. Commit.

## Coordinator steps
Deploy hangar-service; mount `hangar-api-sa` + env on agent and voice sidecar deployed overlays; build/deploy agent (+sandbox-base lockstep) and voice; seed eval member; in-cluster eval + live text turns; voice smoke; cleanup; PR.
