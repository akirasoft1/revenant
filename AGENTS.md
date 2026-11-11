# Discord Article Bot (revenant) - Development Guidelines

Tool-neutral project instructions, read by Antigravity (`agy`), Codex, Cursor and other agents that support `AGENTS.md`. Claude Code reads them through `CLAUDE.md`, which imports this file. Edit this file, not `CLAUDE.md`.

## Feature Development Workflow (TDD + Build + Deploy)

When implementing new features or fixes, follow this complete workflow:

### 1. Create Feature Branch
```bash
git checkout main && git pull origin main
git checkout -b feat/<feature-name>
# or fix/<issue-name> for bug fixes
```

### 2. TDD: Write Tests First (Red Phase)
- Write failing tests in `__tests__/` that define expected behavior
- Run tests to confirm they fail: `npm test -- --testPathPatterns="<TestFile>"`
- Tests should cover: happy path, edge cases, error handling

### 3. Implement Feature (Green Phase)
- Write minimal code to make tests pass
- Run tests frequently to verify progress
- Commit checkpoints with descriptive messages

### 4. Refactor (if needed)
- Clean up implementation while keeping tests green
- Ensure code follows existing patterns in codebase

### 5. Run Full Test Suite
```bash
npm test
```
All tests must pass before proceeding.

### 6. Update Documentation
- Update `features.md` with new capabilities
- Update `README.md` if user-facing features changed
- Update `AGENTS.md` (or the matching `docs/agents/` guide or per-directory `AGENTS.md`) if development practices changed. Never edit `CLAUDE.md` for content; it only imports these files

### 7. Commit Changes
```bash
git add -A
git commit -m "feat: <description>

<detailed explanation>

<attribution trailer for your agent, if it has one>"
```

### 8. Bump Version
```bash
npm version patch --no-git-tag-version  # for fixes
npm version minor --no-git-tag-version  # for features
git add package.json package-lock.json
git commit -m "chore: bump version to <version>"
```

### 9. Build, Deploy and Verify
Follow "Deployment" → "Deployment Steps" below (one copy of the commands lives there).

### 10. Push Branch and Create PR
```bash
git push -u origin feat/<feature-name>
# Create PR via GitHub (gh auth may be expired)
```

### Checkpoint Commits
For larger features, commit checkpoints along the way:
- After tests are written (even if failing)
- After major implementation milestones
- Before risky refactoring

## Deployment

- **Namespace**: Always deploy to `discord-article-bot` namespace, not `default`
- **Container name**: The deployment container is named `bot`, not `discord-article-bot`
- **Source of truth**: `k8s/overlays/deployed/` (gitignored, contains real secrets)
- **Do NOT use kustomize**: The `k8s/base/` and `k8s/overlays/prod/` are out of sync and contain placeholder secrets
- **Images are PUBLIC; secrets never go in the repo tree.** Docker ignore patterns are root-anchored, so every build context carries `**/`-prefixed secret patterns (`**/.env*`, `**/*key*.json`, `**/*.pem`, `**/*.key`, `**/credentials*.json`, `**/*service_account*`), pinned by `__tests__/dockerignoreSecrets.test.js`. Mint SA keys outside the repo, load them straight into the k8s Secret, and shred the local copy. Why: in Aug 2026 a bare `*-key.json` missed `agent-sidecar/genai-sa-key.json`, which shipped in public bot images (tags built 2026-08-05 to 08-14) and was used for Vertex billing abuse in Nov 2026.

### Deployment Steps

1. Build and push Docker image:
   ```bash
   docker build -t mvilliger/discord-article-bot:<version> .
   docker push mvilliger/discord-article-bot:<version>
   ```

2. Update image version in `k8s/overlays/deployed/deployment.yaml`

3. Apply the deployment:
   ```bash
   kubectl apply -f k8s/overlays/deployed/ -n discord-article-bot
   ```

   Or for image-only updates (still do step 2, so the overlay matches what is running):
   ```bash
   kubectl set image deployment/discord-article-bot bot=mvilliger/discord-article-bot:<version> -n discord-article-bot
   ```

4. Verify rollout:
   ```bash
   kubectl rollout status deployment/discord-article-bot -n discord-article-bot --timeout=120s
   kubectl get pods -n discord-article-bot
   kubectl logs -f deployment/discord-article-bot -n discord-article-bot
   ```

### NetworkPolicy Configuration

**IMPORTANT**: This namespace uses a restrictive NetworkPolicy that blocks egress to private IP ranges by default.

When adding a new external service integration (especially services on local/home network IPs like `192.168.x.x`, `10.x.x.x`, `172.16.x.x`):

1. **Update the NetworkPolicy** in `k8s/overlays/deployed/networkpolicy.yaml`
2. Add an egress rule for the specific IP and port:
   ```yaml
   # Example: Allow Local LLM (Ollama) on home network
   - to:
       - ipBlock:
           cidr: 192.168.1.164/32
     ports:
       - protocol: TCP
         port: 11434
   ```
3. Apply the change: `kubectl apply -f k8s/overlays/deployed/networkpolicy.yaml -n discord-article-bot`
4. Restart the pod to re-initialize the service

**Debugging connectivity issues**:
```bash
# Check current NetworkPolicy
kubectl get networkpolicies -n discord-article-bot -o yaml

# Test connectivity from a fresh pod (no NetworkPolicy restrictions)
kubectl run test-curl --rm -it --image=curlimages/curl -- curl http://<ip>:<port>/endpoint
```

## Voice Profile (Channel Voice Personality)

The `channel-voice` personality dynamically learns the group's communication style from IRC history and Discord messages. It requires:
- `VOICE_PROFILE_ENABLED=true`
- Qdrant service enabled (for IRC history sampling + few-shot retrieval)
- Channel Context service enabled (for Discord message sampling)

**Config env vars**: `VOICE_PROFILE_REGEN_HOURS`, `VOICE_PROFILE_SAMPLES_PER_DECADE`, `VOICE_PROFILE_DISCORD_SAMPLES`, `VOICE_PROFILE_ANALYSIS_MODEL`, `VOICE_PROFILE_AB_LOGGING`

**A/B logging**: Set `VOICE_PROFILE_AB_LOGGING=true` to log styled vs. unstyled response comparisons to the `ab_comparisons` MongoDB collection.

**Profile storage**: MongoDB `voice_profiles` collection. Versioned with `previousVersion` for history.

## Recall (v2 centralized ranked recall)

`RecallService` (`services/RecallService.js`) replaces the scattered Mem0 + channel-context recall when `RECALL_V2_ENABLED=true`. It over-retrieves from all sources, dedupes, ranks by recency+importance (Mongo `recall_ledger` holds importance/access/last-access), and injects one `## Memory Context` block. Pure logic in `services/recall/` (ranking, queryBuilder, adapters, evalMetrics).

- **Validate before flipping on**: run `node scripts/eval-recall.js` (offline ranker eval) and enable `RECALL_SHADOW_ENABLED=true` to log old-vs-new to `recall_comparisons`.
- Recent buffer + voice few-shot are intentionally NOT ranked (separate blocks).
- Spec: `docs/superpowers/specs/2026-05-30-centralized-ranked-recall-design.md`.
## Area guides — read the matching file BEFORE changing that area

This file stays under the 24 KB per-file limit that Antigravity enforces, so the long sections live in their own files. Claude Code imports all of the files below through `CLAUDE.md`. Other agents (Antigravity, Codex, Cursor, …) load only this file plus the `AGENTS.md` of the directory they are working in, so open the matching guide yourself:

| Area | Guide | Per-directory notes |
|---|---|---|
| Agent path, `buildTurnContext`, sandbox (Kata), degradation notices | `docs/agents/sandbox.md` | `agent-sidecar/AGENTS.md` |
| Star Citizen knowledge (sc-knowledge MCP, sandbox avoidance, dispute rule) | `docs/agents/star-citizen.md` | `sc-knowledge/AGENTS.md` |
| Member hangar (Cloud Run service, editor, wireframes, chat edits) | `docs/agents/member-hangar.md`, `docs/hangar.md` | `hangar-service/AGENTS.md`, `hangar-editor/AGENTS.md`, `tools/wireframes/AGENTS.md` |
| Voice (bot side + Live sidecar) | `docs/agents/voice-overview.md`, `docs/voice.md` | `voice-sidecar/AGENTS.md`, `services/voice/AGENTS.md` |
| Member identity registry, `/whois`, speaker labels and roster | `docs/agents/member-identity.md` | — |

**Rules that hold everywhere (short form; the reasons are in the guides):**
- **HARD RULE — extracted game data never enters the repo or an image.** `.glb` exports, `.swf.gz` bundles, anything derived from them, and HangarXPLOR `shiplist.json` exports stay on the owner's machine and in the private model store. Both Docker contexts carry `**/`-prefixed ignore patterns for them; tests build all geometry in code. Never force-add. Details: `docs/agents/member-hangar.md`.
- **Org guides are PRIVATE.** The PDFs in repo-root `OrgGuides/` are synced to a ConfigMap by `scripts/sync-org-guides.sh`. Never commit, bake into an image, or quote their text (titles included) in any doc. Details: `docs/agents/star-citizen.md`.
- **Agent sidecar: single-replica `Recreate`, do not scale** (concurrency state is in-process). `AGENT_ENABLED=false` reverts channel-voice to direct OpenAI. The sandbox is a last-resort tool. Never use `GoogleSearchTool(bypass_multi_tools_limit=True)`, which crashes ADK 2.10.
- **Voice sidecar is `RollingUpdate`**, and its Live model `gemini-3.8-live` serves only in `us-central1` (the agent sidecar stays on `global`). Do NOT `kubectl apply -f k8s/voice/` (placeholder tag); deploy from `k8s/overlays/deployed/`. Restart the voice sidecar after adding or changing an `sc_*` tool.
- **sc-knowledge:** deploy only from the deployed overlay; an in-cluster `421 Invalid Host header` is the server's `SC_ALLOWED_HOSTS` list, not the NetworkPolicy.
- **hangar-service runs on Cloud Run, not the cluster** (project `revenant-discord-bot-2`, `us-central1`). Its invoker IAM check is OFF on purpose, so do not re-enable it. The acting member of a chat edit comes from trusted plumbing, never a tool argument. Running `scripts/registerCommands.js` without `HANGAR_API_URL` silently drops `/hangar`.
- **Images are pinned to a git short SHA or a version, never `:latest`.**

## AI Models (updated 2026-09-26)

- **OpenAI (bot):** `OPENAI_MODEL=gpt-6-luna` everywhere (chat fallback, summaries, catch-me-up, voice-profile analysis, voice search, image-prompt analysis, Mem0 extraction). gpt-4o-mini / gpt-4.1-mini / gpt-5-mini / gpt-5.1 are deprecated. `utils/openaiModels.js` is the single source for the default model id and the price table (old ids are kept in the table because historical Mongo usage rows reference them).
- **gpt-6-* are reasoning models:** they 400 on `temperature` (≠1), `top_p`, and `max_tokens` (chat wants `max_completion_tokens`), and reasoning tokens count against any output cap — a tight cap yields EMPTY text. Never send those params; each call site pins its effort through `reasoningParams()` (which omits effort if someone overrides the model with a non-reasoning one). `OPENAI_REASONING_EFFORT` (default `low`) sets chat effort. `__tests__/openaiCallSites.test.js` pins every call site's request params. tiktoken falls back to `o200k_base` for model ids it doesn't know.
- **openai npm held at 6.x:** `@traceloop/instrumentation-openai` (and the OTel openai instrumentation) only patch `openai >=4 <7`; v7 would silently drop the LLM spans in Dynatrace. Auto-instrumentations' own OpenAI instrumentation is disabled in `tracing.js` so calls aren't traced twice.
- **Gemini (bot, consumer `GEMINI_API_KEY`):** image `gemini-3.1-flash-image`, admin image `gemini-3-pro-image` (GA; the `-preview` ids passed their shutdown dates), music `lyria-3.5` ($0.08/song — note the live model list says `lyria-3.5` although docs call it `lyria-3.5-pro-preview`), test-voice TTS `gemini-3.8-flash-tts` (returns a complete WAV, not raw PCM). Veo stays `veo-3.1-*-001` on Vertex (newest GA) and now goes through `@google/genai` in Vertex mode (`@google-cloud/vertexai` is deprecated and removed).
- **Agent sidecar (GEAP):** `gemini-3.8-flash`. **Voice sidecar:** `gemini-3.8-live` in `us-central1` only (since 2026-10-10; was `gemini-live-2.5-flash` — see `voice-sidecar/AGENTS.md` "Live model").
- **Unchanged on purpose:** embeddings stay `text-embedding-3-small` (switching forces re-embedding every Qdrant collection); ElevenLabs stays `music_v1` (`music_v2*` uses a different, chunk-based composition-plan format — not drop-in).

## Mem0 v3 + Qdrant 1.18 (since 2026-09-26)

- **mem0ai v3 renamed the payload owner keys** `userId`/`agentId`/`runId` → `user_id`/`agent_id`/`run_id`. Memories written by v2 are invisible to v3 lookups until migrated: `node scripts/migrate-mem0-v3-payload.js` (dry run) then `--apply` (port-forward Qdrant first). It adds the new keys and keeps the old ones for rollback; safe to re-run.
- v3 API: `search()`/`getAll()` take `{ topK, filters: { user_id, agent_id, run_id } }`. `Mem0Service` keeps `getAll` at 100 (v3 default 20 would truncate `/memories`) and searches with `threshold: 0` (plain top-k, as before).
- v3 creates `discord_memories_entities` alongside the main collection, logs once that keyword search is disabled on the pre-existing collection (semantic search unaffected), and would phone home to PostHog — `MEM0_TELEMETRY` defaults to `false` in code.
- **Qdrant server is 1.18.x.** Upgrade ONE MINOR VERSION AT A TIME (storage compat is only guaranteed across one minor); 1.16 is the mandatory RocksDB→Gridstore bridge before 1.17+. After each restart a collection can show `grey` (optimizations queued but not triggered) — a no-op `PATCH /collections/<name>` with `{"optimizers_config":{}}` kicks it. The deployment is `Recreate` (RWO PVC) with 8 CPU / 8Gi limits: at 2 CPU / 4Gi an `irc_history` (~378k × 1536) segment merge ran pegged near the memory ceiling. Take per-collection snapshots (`POST /collections/<c>/snapshots`, then download) before any server upgrade — the in-pod `/qdrant/snapshots` dir is not on the PVC.

## Embedding Data Quality Validation

Run the validation script to check health of all Qdrant collections:

```bash
kubectl port-forward svc/qdrant 6333:6333 -n discord-article-bot &
node scripts/validate-embeddings.js        # Read-only check
node scripts/validate-embeddings.js --fix  # Delete expired points
```

Checks: expired point accumulation, required payload fields, content quality, indexing status, duplicate detection.

## Slash Command Development Guidelines

When creating or modifying slash commands:

1. **Service method signatures**: Verify correct method names and parameter order by checking the service implementation
   - Example: `resetConversation(channelId, personalityId)` - channelId comes first
   - Example: `listUserConversations(userId, guildId)` - requires guildId parameter

2. **Service enabled checks**: Optional services (Mem0, Qdrant, etc.) need `isEnabled()` checks at the start of execute()
   ```javascript
   if (!this.mem0Service.isEnabled()) {
     await this.sendReply(interaction, {
       content: 'Memory feature is not enabled on this bot.',
       ephemeral: true
     });
     return;
   }
   ```

3. **Error handling patterns**: Some errors should not have "Error:" prefix
   - Conversation limit reasons ('expired', 'message_limit', 'token_limit') are informational, not errors

4. **Formatter usage**: Use service formatters (e.g., `qdrantService.formatResult()`) for consistent output

## Discord Embed Limits

- Embed field name: max 256 characters
- Embed field value: max 1024 characters (NOT 4000)
- Empty field values cause validation errors - always provide fallback text

## Testing

- Slash command tests need to mock all service methods including `isEnabled()`
- Global slash commands take up to 1 hour to propagate; use `DISCORD_TEST_GUILD_ID` for faster testing

## Debugging Common Issues

### Duplicate Messages / Multiple Replies

**ALWAYS CHECK FIRST**: Are there multiple bot instances running with the same Discord token?

```bash
# Check ALL namespaces for bot deployments
kubectl get pods -A | grep -i discord
kubectl get deployments -A | grep -i discord
```

Multiple instances with the same token will ALL receive Discord events and ALL respond, causing:
- Duplicate replies (different content if conversation contexts differ)
- One reply faster than the other
- Replies with stale/old conversation context

**Root cause example (Dec 2025)**: A forgotten deployment in `default` namespace ran alongside the production deployment in `discord-article-bot` namespace for 10 days, causing duplicate replies to every message.
