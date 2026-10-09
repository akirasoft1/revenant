# Hangar chat edits (text + voice) — Design

**Date:** 2026-10-09 · **Status:** approved (chat) · **Branch:** `feat/hangar-chat-edits`
**Project 3 of 3** of the member hangar (project 1: `2026-10-09-member-hangar-design.md`; project 2: `2026-10-09-hangar-editor-design.md`).

## Goal
Members record hangar changes by talking to the bot — "I put the Hemera in my Connie", "I just bought a Cutlass Black", "put my Harbinger's shields back to stock" — in text chat and in voice. The bot writes immediately and reads back exactly what changed.

## Decisions (owner-approved)
- **Surfaces:** text (agent sidecar) AND voice (voice sidecar).
- **Write-then-read-back:** clear statements of something the speaker did are applied at once; the reply states the change ("Connie's quantum drive: Bolon → Hemera"). No pending-confirmation store.
- **Own hangar only, bound in code — never by the model.** The acting member is the real speaker supplied by trusted plumbing, NOT a tool argument:
  - text: `ChatRequest.user_id` (the Discord ID the bot sends for the turn's author) → bound into the per-turn tool instances (same pattern as `RunInSandboxTool(user_id=…)`);
  - voice: the current floor holder's Discord ID from `SetSpeaker.user_id` (tracked per session in the sidecar; cleared on an empty SetSpeaker); before the first SetSpeaker, the session's `SessionStart.user_id` (the opener). Unknown speaker → the tool refuses ("I can't tell whose hangar to edit").
  - Admins get no cross-member chat edits (use the web editor). "Put a Hemera in Micro's Titan" → the tool has no member parameter, so it can only touch the speaker's hangar; the prompt tells the model to say chat edits only apply to your own hangar.
- **Server-side fit resolution:** new hangar-service endpoint `POST /v1/members/{id}/fit` (also `/api/v1/...`; service-token auth with `X-Acting-Member`, same write rule) body `{ship: str, item: str, slot?: str}`:
  - resolve `ship` within the member's hangar with the SAME rules as sc-knowledge's `sc_member_hangar` (exact nickname → nickname fuzzy → owned model name/token/shorthand like "Connie") — move/duplicate that resolver into hangar-service (`src/ship_resolve.py`) with a keep-in-sync note; ambiguous → 409 `ambiguous` with `candidates:[{shipId,label}]`; none → 404 `not_found` listing the member's ships.
  - resolve `item` via the catalog (name/uuid/class name); unknown → 404 `not_found`.
  - find the ship's slots compatible with the item (`check_compatible`). `slot` may be a slot id, or `"all"` (every compatible slot), or a friendly hint (e.g. "left", "1", "nose") matched against compatible slot ids. Exactly one compatible slot (or a resolved hint / "all") → write via the existing per-slot path; several and no slot → 409 `choose_slot` with `slots:[{slot, current:{name}, size}]`; none → 422 `incompatible` with a reason (size mismatch vs no slot type).
  - response `{ship:{shipId,label}, changes:[{slot, from:{name}, to:{name}}]}` (no-op when already fitted → `changes: []`, `unchanged: true`).
  - Also `POST /v1/members/{id}/ships/{shipRef}/reset` `{slot?: str|"all"}` resolving `shipRef` like `ship` above (reset one slot or all to stock), and ship add reuses the existing `POST /ships`.
- **Tools (both surfaces, same names/semantics):**
  - `hangar_fit(ship, item, slot=None)` → `/fit`.
  - `hangar_add_ship(vehicle, nickname=None)` → `POST /ships`.
  - `hangar_reset(ship, slot)` → reset endpoint; `slot` is a slot id/hint, or `"all"` to put the whole ship back to stock (required — the model asks if the user didn't say which).
  - Each returns the server JSON (or `{error, message, candidates|slots}`); never raises. 5s timeout. Writes send `X-Acting-Member: <bound speaker id>`.
- **Prompt (agent `sc_tools_preamble` both variants + voice `SC_VOICE_NOTE`/mechanics note — one short sentence each):** call the hangar edit tools ONLY when the speaker states they DID something to their own ships (bought, fitted, swapped, sold back to stock); never for hypotheticals or advice questions ("should I…", "would X be better…"); on `choose_slot`/`ambiguous` ask a short follow-up; after a write, state exactly what changed; edits only ever apply to the speaker's own hangar.
- **Credentials:** the agent and voice sidecars get the existing `hangar-api-sa` Secret mounted (`/var/secrets/hangar/key.json`) + `HANGAR_API_URL` (exact audience `https://hangar-service-hvmf2jpuca-uc.a.run.app`); `hangar-api@` is already an allowed caller. Flags `HANGAR_EDITS_ENABLED` (default true when `HANGAR_API_URL` set) on both sidecars.
- **Observability:** `agent.chat` span attr `hangar.edits` (count) and an INFO log per write (member id, ship, slot, from→to) — never truncated.

## Testing
- hangar-service: fit resolution (single slot, choose_slot, "all", hint, incompatible size vs type, unknown ship/item, ambiguous ship, already-fitted no-op), reset one/all, permissions (X-Acting-Member must equal member), shorthand parity tests.
- agent-sidecar: tools bound to request user_id (model cannot target another member — no such parameter), error passthrough, span attr; eval cases: "I put the Hemera in my Connie" → `hangar_fit`; "should I put the Hemera in my Connie?" → no edit tool; "put a Hemera in Micro's Titan" → no write to Micro; "I just bought a Cutlass Black" → `hangar_add_ship`; existing gates unchanged.
- voice-sidecar: declarations present when enabled; tool call uses current SetSpeaker user id; opener fallback; cleared speaker → refusal; handled locally (never MCP).
- Live: seeded test member, real-model text turns, voice smoke with a synthetic speaker id.

## Docs
CLAUDE.md (Member hangar: chat edits, binding rule, endpoints), READMEs, features.md.
