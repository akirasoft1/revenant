# Member identity grounding — Design

**Date:** 2026-10-09 · **Status:** approved (brainstorming) · **Branch:** `feat/member-identity`

## Problem
The text agent often does not know who is speaking. `buildTurnContext` forwards history turns as bare `{role, content}`, which the agent sidecar renders as `User: …` / `You: …`; the sidecar drops `user_tag`; the current turn is unlabelled. The only names the model sees come from the in-memory recent-channel block in the system prompt, which omits bot replies and never marks the current speaker. Observed failure: someone writes "Akira …" in a message to the bot, Akira then replies, and the bot does not know the replier IS Akira.

There is also no way to say that several names refer to one member (Akira / Akirasoft / Phalabala) or how to address them. The only identity data is `VOICE_SPEAKER_NAMES` (configmap JSON, one spoken name per Discord ID, restart to reload).

## Goal
In every conversation surface — `/chat`, @mentions, replies, and voice — the model knows (1) which member said each message, (2) who is speaking now, and (3) which member any known name/alias in the conversation refers to, with each member's preferred address name. Members manage their own names; admins can manage anyone's.

Out of scope (own spec next): per-member Star Citizen inventory (owned ships + fitted components), exposed as a model-called tool keyed by the same Discord ID. Also out of scope: the direct-OpenAI fallback path (keeps its existing `[Username]:` format).

## Decisions
- **Store:** MongoDB collection `member_identities`, one doc per Discord ID: `{ _id: <discordId>, addressName: string|null, aliases: string[], updatedBy: <discordId>, updatedAt: Date }`. Unique per `_id`.
- **Registry service** `services/MemberIdentityService.js`: in-memory cache of all docs (the member set is ~a dozen), loaded at startup, refreshed after every write and every 60s. Pure helpers live in `services/identity/` (validation, roster selection, labelling) so they are unit-testable without Mongo.
  - `get(discordId) -> {discordId, addressName, aliases} | null` (sync, from cache)
  - `all() -> Array<…>` (sync)
  - `setAddressName(targetId, name, actorId)`, `addAlias(targetId, alias, actorId)`, `removeAlias(targetId, alias, actorId)` → `{ok: true, record} | {ok: false, reason, holderId?}`
- **Validation (names land in prompts AND are spoken):** run through the existing `SpeakerNames.sanitize`; reject if empty after sanitising or without a letter; max 24 chars (sanitize's cap); max 10 aliases per member; **collision rule:** a name (alias OR address name) already held by ANOTHER member — compared case-insensitively against every other member's addressName and aliases — is rejected with `reason: 'taken'` and `holderId`. A member's own addressName may also appear in their aliases (no-op). Adding an existing alias is idempotent.
- **Permissions:** omitted `member` option = self (anyone). Any other target requires `config.discord.adminUserIds` (`BaseSlashCommand.isAdmin`).
- **Resolution order (`SpeakerNames.resolve`)**: registry `addressName` → `VOICE_SPEAKER_NAMES` override → existing Discord-name chain (globalName → nickname → stripped username). Registry is consulted via an optional `identity` dependency passed to `createSpeakerNames({ overrides, identity })`; absent/failed → today's behaviour. The registry name is sanitised like every other candidate.
- **Seeding:** `scripts/seed-member-identities.js` (dry run by default, `--apply`) copies each `VOICE_SPEAKER_NAMES` entry into `addressName` for IDs that have no record yet. Never overwrites. The configmap stays as a fallback layer.

## `/whois` slash command (`commands/slash/WhoisCommand.js`)
| Subcommand | Options | Effect |
|---|---|---|
| `show` | `member?` | Address name + aliases (or "no identity set") |
| `address` | `name`, `member?` | Set address name |
| `alias-add` | `alias`, `member?` | Add alias |
| `alias-remove` | `alias`, `member?` | Remove alias (case-insensitive) |

All replies ephemeral. Non-self target without admin → refusal. `taken` → "‘X’ is already used by <@holderId>." Registered via `commands/slash/index.js`; `scripts/registerCommands.js` picks it up. Mongo unavailable → "Identity storage is unavailable right now."

## Who-said-what plumbing (text and voice)
All built bot-side in `ChatService.buildTurnContext` — no sidecar or proto change.
- **Speaker labels.** Every non-bot history turn's content becomes `[<Name> · <discordId>]: <content>`, where Name = `SpeakerNames`-resolved name (registry first) for the doc's `authorId`, falling back to the stored `authorName`. Bot turns (`isBot`) stay unlabelled assistant turns. Rows without an `authorId` keep their content unlabelled.
- **Current turn.** `currentTurn` (introduced by the reply-target fix) is prefixed with the current speaker's label: `[Akira · 1616…]: <userMessage>` — composed with the existing reply prefix as `[Replying to your earlier message: "…"]\n[Akira · 1616…]: <userMessage>`. Dedupe (`_dropDuplicatedCurrentTurn`) keeps comparing RAW text and runs before labelling. Recall queries and stored content stay raw.
- **Roster.** A block appended to the returned `systemPrompt`:
  ```
  ## People in this conversation
  Messages are labelled [Name · Discord ID]. "I", "me" and "my" mean the labelled speaker of that message. Use this list only to work out who is who; don't mention these aliases unless it matters.
  - Akira (Discord 161644375040983040) — also called Akirasoft, Phalabala; address as Akira  ← current speaker
  ```
  Included members (deduped, current speaker first): the current speaker; every distinct `authorId` among the history window's user turns; and any registry member whose addressName or alias appears as a whole word (case-insensitive, Unicode-aware boundaries) in the history window text or the current message. A member with no registry record appears with their resolved name only. Never the full table. Omitted entirely when there is nothing to list. Cap 20 entries.
- **Voice.** `VoiceService` already calls `buildTurnContext({ userId, userMessage: '' , … })` at session open, so the seeded history gets labels and the system prompt gets the roster automatically (current speaker = session opener). The `[SPEAKER: <name>]` marker's name comes from `SpeakerNames` and therefore from the registry. **Known limitation:** a member who first speaks mid-session gets their address name via the marker but is not added to the session-start roster (aliases not visible until the next session).
- **Failure isolation.** Registry lookups are in-memory and never throw into a turn; if the registry failed to load, labels fall back to stored `authorName` and the roster lists resolved names only.

## Testing
Unit (Jest): validation (sanitise, letter rule, caps, collisions incl. case, alias==own address name), permissions (self vs other vs admin), resolution order in `SpeakerNames`, cache refresh after write, roster selection (participants + mentioned aliases, non-participants excluded, whole-word matching — an alias "Aki" must not match inside "Akirasoft", current speaker first, cap), history labelling (bot turns untouched, missing authorId), currentTurn composition with the reply prefix, the incident replay (history: other user says "Akira, …"; current turn from Akira's ID → label + roster maps alias to the same ID), `/whois` command (all subcommands, ephemeral, refusals, taken message, Mongo unavailable). Real-model: in-cluster replay of the incident through gemini-3.8-flash before and after.

## Docs
CLAUDE.md (Agentic Sandbox "Chat context" + Voice "Speaker Identity"), README (`/whois`, seed script), features.md.
