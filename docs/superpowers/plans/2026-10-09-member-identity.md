# Member Identity Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every chat/voice turn tells the model who said each message, who is speaking now, and which member each known name/alias refers to; members manage their own names via `/whois`.

**Architecture:** A Mongo-backed, in-memory-cached `MemberIdentityService` feeds `SpeakerNames` (address name) and a pure `services/identity/` layer that `ChatService.buildTurnContext` uses to label history/current turns and append a scoped roster to the system prompt. Voice inherits it through its existing `buildTurnContext` call. No sidecar/proto changes.

**Tech Stack:** Node.js (discord.js slash commands, mongodb driver via `MongoService`), Jest 30 (`npm test -- --testPathPatterns="X"`).

**Spec:** `docs/superpowers/specs/2026-10-09-member-identity-design.md` (binding — exact formats, rules and caps live there).

## Global Constraints
- Label format exactly `[<Name> · <discordId>]: <content>` (middle dot U+00B7 with single spaces). Roster heading exactly `## People in this conversation`; roster cap 20; alias cap 10 per member; name length via `SpeakerNames.sanitize` (24).
- Collision: a name held by ANOTHER member (addressName or alias, case-insensitive) → `{ok:false, reason:'taken', holderId}`.
- Self edits for anyone; other targets require `config.discord.adminUserIds` (`BaseSlashCommand.isAdmin`).
- Dedupe of the current turn compares RAW text; stored `channel_messages` content and recall queries stay raw. Bot (`isBot`) turns are never labelled.
- Registry failures never throw into a chat/voice turn (degrade to stored `authorName`, no roster aliases).
- Don't touch `k8s/overlays/deployed/`, `OrgGuides/`, `agent-sidecar/`, `voice-sidecar/`, `sc-knowledge/`. Never truncate log messages. Stage explicit paths only (never `git add -A`). Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Bot suite: `npm test` (record baseline first). Do not bump the version.

---

### Task 1: Identity registry + SpeakerNames integration + seed script

**Files:** create `services/MemberIdentityService.js`, `services/identity/validation.js`, `scripts/seed-member-identities.js`, tests `__tests__/services/MemberIdentityService.test.js`, `__tests__/services/identity/validation.test.js`; modify `services/SpeakerNames.js` (+ its tests), `bot.js` (construct + `load()` the service after Mongo connects, pass `identity` to `createSpeakerNames`, expose `this.memberIdentity` for later tasks), `services/MongoService.js` only if a small accessor (`getCollection(name)` or similar) is needed — prefer existing patterns.

**Interfaces — Produces:**
- `new MemberIdentityService({ mongoService, refreshMs = 60000, now })` with `async load()`, `start()`/`stop()` (refresh timer, unref'd), `get(id) -> {discordId, addressName, aliases} | null`, `all() -> Array`, `isLoaded() -> boolean`, `async setAddressName(targetId, name, actorId)`, `async addAlias(targetId, alias, actorId)`, `async removeAlias(targetId, alias, actorId)` → `{ok:true, record} | {ok:false, reason: 'invalid'|'too_many'|'taken'|'not_found'|'unavailable', holderId?}`. Writes upsert `{_id, addressName, aliases, updatedBy, updatedAt}` then refresh the cache.
- `services/identity/validation.js`: `normalizeName(raw) -> string|null` (sanitize + letter rule), `findHolder(records, name, excludeId) -> discordId|null` (case-insensitive over addressName+aliases), constants `MAX_ALIASES = 10`.
- `createSpeakerNames({ overrides, identity })`: `resolve(user, member)` checks `identity?.get(user.id)?.addressName` first (sanitised, wrapped in try/catch), then existing order.
- Seed script: reads `VOICE_SPEAKER_NAMES` (same parsing as `config.voice.speakerNames`), dry run prints planned inserts, `--apply` inserts only for IDs with no doc; uses the same Mongo URI handling as other scripts in `scripts/`.

- [ ] TDD per spec "Testing" (validation, collisions, caps, idempotent add, remove case-insensitive, unavailable when Mongo missing, cache refresh, SpeakerNames resolution order + registry failure fallback). Full `npm test`. Commit.

### Task 2: Who-said-what labelling + roster in `buildTurnContext`

**Files:** create `services/identity/roster.js` (+ `__tests__/services/identity/roster.test.js`); modify `services/ChatService.js` (+ `__tests__/services/ChatService.buildTurnContext.test.js`, and the regression test for /chat-then-reply if it pins content), `bot.js` (pass `memberIdentity` + `speakerNames` into ChatService — constructor option or setter, follow existing DI style).

**Interfaces — Consumes:** Task 1 `memberIdentity.get/all`, `speakerNames.resolve`. **Produces (pure, in roster.js):**
- `labelFor({ discordId, name }) -> "[<name> · <discordId>]"`
- `selectRosterMembers({ currentSpeakerId, historyDocs, currentText, records, cap = 20 }) -> discordId[]` (current speaker first, then history authors in order of first appearance, then registry members whose addressName/alias appears as a whole word — Unicode-aware, case-insensitive — in history text or currentText; deduped; non-bot only).
- `formatRoster({ entries, currentSpeakerId }) -> string` (exact heading + instruction text from the spec; `''` when no entries).
- In ChatService: user history turns become `labelFor(...) + ": " + content` (Name = speakerNames-resolved for `authorId`, else stored `authorName`; no `authorId` → unlabelled); `currentTurn` = optional reply prefix line + `\n` + current speaker label + `": "` + userMessage (no reply → just labelled userMessage); roster appended to `systemPrompt` (`\n\n` + block) when non-empty. Labelling happens AFTER `_dropDuplicatedCurrentTurn`.

- [ ] TDD per spec (incident replay: other user's message mentions "Akira"; current speaker Akira's ID → current-turn label carries Akira's ID and roster entry for that ID lists aliases + "← current speaker"; non-participant registry members excluded; whole-word; bot turns untouched; missing authorId; registry unavailable → no crash, stored names; voice-style call with `userMessage: ''` still yields labelled history + roster with session opener as current speaker). Full `npm test`. Commit.

### Task 3: `/whois` command + docs

**Files:** create `commands/slash/WhoisCommand.js`, `__tests__/commands/slash/WhoisCommand.test.js` (follow the closest existing slash-command test layout); modify `commands/slash/index.js` (register), wiring in bot.js so the command receives `memberIdentity` (follow how other commands receive services), `CLAUDE.md` (Agentic Sandbox "Chat context (unified)" + Voice "Speaker Identity" sections: registry, resolution order, labels, roster, `/whois`, seed script, voice mid-session limitation), `README.md` (`/whois`, seed script), `features.md`.

**Interfaces — Consumes:** Task 1 service methods and result reasons.

- [ ] Subcommands/options/replies exactly per spec table; all replies ephemeral; non-self without admin → refusal; `taken` → "‘X’ is already used by <@holderId>."; `!memberIdentity.isLoaded()` or `unavailable` → "Identity storage is unavailable right now."; `show` for a member without a record → says none set and shows the name the bot currently uses. TDD. Full `npm test`. Commit.

## Coordinator steps
Full suite; seed dry run then `--apply` (in-cluster, from the bot pod); version bump (minor); build + scan + push bot image; update deployed overlay; deploy; `scripts/registerCommands.js` in the bot pod; in-cluster real-model replay of the incident; push; PR.
