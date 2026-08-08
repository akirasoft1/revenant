# Discord Article Bot - Development Guidelines

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
- Update `CLAUDE.md` if development practices changed

### 7. Commit Changes
```bash
git add -A
git commit -m "feat: <description>

<detailed explanation>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

### 8. Bump Version
```bash
npm version patch --no-git-tag-version  # for fixes
npm version minor --no-git-tag-version  # for features
git add package.json package-lock.json
git commit -m "chore: bump version to <version>"
```

### 9. Build and Push Docker Image
```bash
docker build -t mvilliger/discord-article-bot:<version> .
docker push mvilliger/discord-article-bot:<version>
```

### 10. Deploy to Kubernetes
```bash
kubectl set image deployment/discord-article-bot bot=mvilliger/discord-article-bot:<version> -n discord-article-bot
kubectl rollout status deployment/discord-article-bot -n discord-article-bot --timeout=120s
```

### 11. Verify Deployment
```bash
kubectl get pods -n discord-article-bot
kubectl logs -f deployment/discord-article-bot -n discord-article-bot
```

### 12. Push Branch and Create PR
```bash
git push -u origin feat/<feature-name>
# Create PR via GitHub (gh auth may be expired)
```

### Checkpoint Commits
For larger features, commit checkpoints along the way:
- After tests are written (even if failing)
- After major implementation milestones
- Before risky refactoring

---

## Important Notes
- **Development Methodology**: Follow Test-Driven Development (TDD) practices. Write tests before implementing features or fixes.

## Deployment

- **Namespace**: Always deploy to `discord-article-bot` namespace, not `default`
- **Container name**: The deployment container is named `bot`, not `discord-article-bot`
- **Source of truth**: `k8s/overlays/deployed/` (gitignored, contains real secrets)
- **Do NOT use kustomize**: The `k8s/base/` and `k8s/overlays/prod/` are out of sync and contain placeholder secrets

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

   Or for image-only updates:
   ```bash
   kubectl set image deployment/discord-article-bot bot=mvilliger/discord-article-bot:<version> -n discord-article-bot
   ```

4. Verify rollout:
   ```bash
   kubectl rollout status deployment/discord-article-bot -n discord-article-bot
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

## Agentic Sandbox

When `AGENT_ENABLED=true`, channel-voice chats are routed through the Python agent sidecar (`discord-article-bot-agent`). The sidecar is an ADK Agent with one tool — `run_in_sandbox` — that spawns ephemeral pods per execution and returns `{exit_code, stdout, stderr, duration_ms, egress_events, runtime_events}` to the model. Other personalities are unaffected.

**Chat context (unified):** Both the text agent path (`ChatRequest`) and voice Live path (`SessionStart`) forward the same three context fields to the sidecar:
- `system_prompt`: the dynamic channel-voice personality with `{VOICE_INSTRUCTIONS}` substituted from the live voice profile
- `memory_context`: the ranked `RecallService` block (Mem0 + channel semantic + channel facts, deduplicated and ranked by recency + importance)
- `history`: recent conversation turns as `[{role, content}, ...]`, sourced bot-inclusively from `MongoService.getRecentChannelMessages` (the `channel_messages` MongoDB collection)

Built by one shared method: `ChatService.buildTurnContext({...}) -> { systemPrompt, memoryBlock, historyTurns }`. The sidecar runs the bot's `system_prompt` (generic `base.txt` is fallback-only when `system_prompt` is empty). The sandbox executor itself still receives no memory or history — context is injected at the model turn only, not the tool layer. `run_in_sandbox` remains a last-resort tool gated by `TOOL_AVAILABILITY_PREAMBLE`. Note: agent-sidecar `requirements.txt` floors were raised (grpcio≥1.80.0, grpcio-tools≥1.80.0, protobuf≥6.31.1) to match regenerated stubs.

**Token-trim split (deliberate, not DRY debt):** `buildTurnContext` forwards `memoryBlock`/`historyTurns` to the unified agent path UNTRIMMED — no legacy `config.recall.promptMaxTokens` cap — because Gemini's ~1M-token context window doesn't need it; volume is already bounded by RecallService's own budget (`maxItems`/`tokenBudget`) plus the `channelContext.promptRecentCount` history cap. The direct-OpenAI path (`ChatService.chat`'s fallthrough, used when the sidecar is disabled/unhealthy or for non-channel-voice personalities) INTENTIONALLY keeps `_buildGroupSystemPrompt`'s `promptMaxTokens` trim, since it's the unhappy-path fallback on a smaller-window, cost-sensitive model.

**Sandbox isolation:** Kata Containers, specifically `runtimeClassName: kata-qemu-runtime-rs` (Kata's Rust runtime — statically linked, no glibc coupling). Each `run_in_sandbox` call lands in its own tiny QEMU/KVM guest. Originally specified for gVisor, swapped to Kata on 2026-04-29 because Harvester's immutable SLE Micro host OS makes installing `runsc` impractical, and KubeVirt-on-bare-metal is already the platform's native model. Sandbox pods carry `dynatrace.com/inject: "false"` to keep OneAgent out of ephemeral guests (otherwise PID 1 doesn't release on container exit, ballooning wall-clock per execution to ~120s). See `k8s/sandbox/README.md` for the full Kata install play-by-play including the RKE2 containerd-template patch, the `kvm_amd sev=0` workaround for AMD hosts, and the smoke-test recipe. Cold start adds ~1.5–3s per call (VM boot); the agent prompt is aware of this so the model doesn't think the call hung.

**Toggle:** `AGENT_ENABLED=false` reverts channel-voice to direct OpenAI immediately. The `AgentClient` health-polls every 5s and considers the sidecar unhealthy after 30s without a successful Health response, falling through to direct OpenAI when the sidecar is gone.

**Transient 503 handling:** the Gemini-native path attaches SDK-level exponential backoff (`agent.py` `_gemini_retry_options`: 4 attempts, 0.5→8s, jitter, on `429/500/502/503/504`). New preview models (e.g. `gemini-3.5-flash`) spike 503 "model overloaded" errors; without this each one immediately fell through to the `gpt-5-mini` fallback, silently swapping the model. Retry is at the HTTP-call layer, NOT the agent turn, so sandbox tools are never re-executed. The bot's `AgentClient` chat deadline (600s) comfortably exceeds the ~8s retry budget.

**Gemini backend — Enterprise Agent Platform, NOT the consumer API (since 2026-08-05):** the sidecar's Gemini calls run on the Gemini Enterprise Agent Platform (GEAP, the rebranded Vertex AI, `aiplatform.googleapis.com`), not the consumer AI-Studio endpoint. This moves the `BLOCK_NONE` dual-use security workload onto the enterprise-governed surface (consumer AI-Studio runs Prohibited-Use abuse monitoring even on paid tier — a policy-suspension risk). Wired via env on `agent-deployment.yaml`: `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2`, **`GOOGLE_CLOUD_LOCATION=global`** (the Gemini flash models 404 at `us-central1` on this project — they serve from `global`), `GOOGLE_APPLICATION_CREDENTIALS=/var/secrets/genai/key.json`. ADC comes from SA `agent-genai@revenant-discord-bot-2` (`roles/aiplatform.user`) mounted via the `agent-genai-sa` Secret; `GEMINI_API_KEY` is blanked in the sidecar env so the SDK can't pick the consumer backend. `active_genai_backend()` logs `genai_backend=enterprise` at startup. **ImagenService/LyriaService (the bot, not the sidecar) still use the consumer `GEMINI_API_KEY`** — only the sidecar moved. `mcp` is pinned `<2.0.0` (2.0 dropped `streamablehttp_client`/`mcp.shared.session`).

**Sandbox disposition — answer-directly-by-default (since 2026-08-06):** `TOOL_AVAILABILITY_PREAMBLE` in `agent.py` treats the sandbox as a LAST resort — the model answers most asks directly (instant) and only invokes `run_in_sandbox` when a correct answer genuinely requires execution (real network/recon, computing over data it can't derive, observing real runtime behavior). This was a latency fix: the old preamble pushed "when in doubt, run it," which fired a pod for ~46% of direct questions. Tune/verify with the offline eval harness (`agent-sidecar/eval/`, see its README) — it runs the real agent against a fake orchestrator and scores false-invocation / false-omission. The `Chat` handler emits `sandbox.invoked` / `sandbox.call_count` on an `agent.chat` span for Dynatrace to track the production invocation rate. Follow-up if prompt tuning proves insufficient: a pre-flight router/classifier.

**Sidecar:** single-replica `Recreate` Deployment — concurrency state is in-process; **do not scale**.

**Tunables (sandbox-config ConfigMap):** `SANDBOX_INLINE_OUTPUT_CHARS`, `SANDBOX_WALL_CLOCK_SECONDS`, `SANDBOX_PER_USER_CONCURRENCY`, `SANDBOX_GLOBAL_CONCURRENCY`, `SANDBOX_MEMORY_LIMIT`, `SANDBOX_CPU_LIMIT`, `SANDBOX_BASE_IMAGE`, `SANDBOX_TRACE_RETENTION_PER_USER`, `SANDBOX_AGENT_TURN_CALL_BUDGET`.

**Reaction reveal:** on a bot reply that ran code, react with 🔍 (source code), 📜 (stdout + stderr if non-empty), or 🐛 (stderr only) to get the artifact attached.

**Trace storage:** MongoDB `sandbox_executions` (one doc per call). The retention loop in the sidecar demotes >N (default 50) traces per user — older docs keep `exit_code`/`stdout`/`stderr`/`duration_ms` but null out `code`, `stdin`, `env_keys`, `egress_events`, `runtime_events`, `agent_rationale`. The `runtime_events` field is empty by default under Kata (no built-in syscall-deny telemetry); the field is reserved for future `auditd`-in-guest signals.

**Manifests:** `k8s/sandbox/` (tracked) — see its README for the kata-deploy prereq, apply order, and the two small edits the bot Deployment + NetworkPolicy need.

## Voice (discord-article-bot-voice sidecar)

When `VOICE_ENABLED=true`, `/voice join` puts the bot in a Discord voice channel and routes audio through a **second, separate** Python gRPC sidecar — `discord-article-bot-voice` — that hosts one Gemini Live session per active voice channel. It is a distinct Deployment from the agent sandbox sidecar (`discord-article-bot-agent`): they solve different problems and have opposite scaling needs.

**New-sidecar rationale (RollingUpdate/scalable vs. the agent sidecar's Recreate/do-not-scale):** the agent sidecar keeps sandbox-orchestration concurrency state in-process, so it must stay single-replica `Recreate` and never scale. The voice sidecar instead holds long-lived, real-time gRPC audio streams for as long as the bot sits in a voice channel — a `Recreate` rollout would drop every live call. It ships as its own `RollingUpdate`, horizontally scalable Deployment (`k8s/voice/voice-deployment.yaml`) for exactly that reason.

**Reuses `agent-genai-sa` (no new secrets):** the voice sidecar's Gemini Live calls run on the same GEAP/Vertex backend as the agent sidecar — `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2`, `GOOGLE_CLOUD_LOCATION=global`, ADC via the `agent-genai-sa` Secret mounted at `/var/secrets/genai/key.json`, `GEMINI_API_KEY` blanked. `serviceAccountName: agent-sa` is reused too. Nothing new to provision in the cluster.

**`dynatrace.com/inject` — deliberately left enabled:** unlike the ephemeral Kata sandbox pods (which disable injection because PID 1 doesn't release cleanly, ballooning per-call wall clock), this is a long-lived, observability-first service — same posture as the agent sidecar's deployed manifest, which also does not set the annotation. Both OneAgent and the sidecar's own OTLP spans reach Dynatrace.

**Wake word (openWakeWord, keyless/offline):** audio is only forwarded to the Live model after openWakeWord detects the wake phrase locally (`VOICE_WAKE_WORD` label, default `"hey jarvis"`). No API key — the ONNX models run in-process via `onnxruntime-node`. This keeps ambient channel audio private and avoids streaming/billing on conversation the bot wasn't addressed in. The three-stage chain (melspectrogram → embedding → wake model) and its exact mel-frontend params (1280-sample frames, 5 mels/frame, 76-frame window at stride 8, `x/10+2` mel transform, int16-range float32 input) are ported from the `openwakeword_wasm` reference and vendored in `models/openwakeword/` (Apache-2.0). Four pretrained phrases: hey jarvis, alexa, hey mycroft, hey rhasspy. Tunables: `VOICE_WAKE_MODEL`, `VOICE_MEL_MODEL`, `VOICE_EMBEDDING_MODEL`, `VOICE_WAKE_THRESHOLD` (default 0.5). Note: `onnxruntime-node`'s `session.run` is async while the `WakeWordGate` contract is sync, so the engine runs the ONNX chain on an async queue and surfaces detections via a flag `process()` reads on the next call (sub-frame <80 ms lag).

**Turn rhythm:** wake → reply → brief "hot" follow-up window (`VOICE_FOLLOWUP_WINDOW_MS`, no wake word needed) → idle (`VOICE_IDLE_TIMEOUT_MS` tears the session down). `VOICE_MAX_SESSION_SECONDS` is a hard belt-and-suspenders cap independent of idle/follow-up timing.

**Reuses the `channel-voice` personality prompt:** `config.voice.systemPrompt` is wired from the same learned channel-voice system prompt used for text chat (falls back to `VOICE_SYSTEM_PROMPT` if set), so spoken replies match the group's learned communication style.

**Memory in, transcripts out:** recall context feeds into voice turns the same way it does text chat, and every voice exchange is written into the MongoDB message store as a transcript — it shows up in `/tldr` and centralized ranked recall like any other message.

**Tunables (bot env):** `VOICE_ENABLED`, `VOICE_GRPC_ADDR`, `VOICE_WAKE_WORD`, `VOICE_WAKE_MODEL`, `VOICE_MEL_MODEL`, `VOICE_EMBEDDING_MODEL`, `VOICE_WAKE_THRESHOLD`, `VOICE_LIVE_VOICE`, `VOICE_FOLLOWUP_WINDOW_MS`, `VOICE_IDLE_TIMEOUT_MS`, `VOICE_MAX_SESSIONS`, `VOICE_MAX_SESSION_SECONDS`, `VOICE_SYSTEM_PROMPT`. **Sidecar env:** `VOICE_LIVE_MODEL`, `VOICE_DEFAULT_VOICE`, `GRPC_LISTEN_ADDR`.

**Bot image base — Debian slim (glibc), NOT Alpine:** `@discordjs/voice` ^0.19.0 requires Node ≥22.12. The repo-root `Dockerfile` uses `node:22-slim` (Debian/glibc), NOT `node:22-alpine` (musl): `onnxruntime-node` (the openWakeWord engine) ships glibc-only prebuilt binaries (`libc.so.6`/`libm.so.6`, GLIBC_* symbol versions) with no musl variant, so it fails to load on Alpine. Any manual/local run of the bot needs Node ≥22.12.0 on glibc.

**Deploy checklist:** (1) run the Task 1 GEAP pre-flight probe and set the confirmed model as `VOICE_LIVE_MODEL` in the deployed overlay (never the `REPLACE_WITH_VALIDATED_MODEL` placeholder from the tracked manifest); (2) confirm the bot image is rebuilt from the `node:22-slim` (glibc) `Dockerfile` before flipping `VOICE_ENABLED=true` — the vendored openWakeWord ONNX models are baked into the image (no key/secret or PVC needed); (3) `kubectl apply -f k8s/voice/ -n discord-article-bot`, then redeploy the bot and run `scripts/registerCommands.js`.

**Deferred follow-ups (not yet implemented):** idle auto-leave (channel currently requires `/voice leave`), per-speaker transcript author fields (multi-user voice channels currently attribute transcripts without per-speaker identity), and dynamic (session-time, non-static) voice-profile injection into the Live system prompt.

**Manifests:** `k8s/voice/` (tracked) — see its README for the apply order, the required bot ConfigMap/Secret/NetworkPolicy edits, and the build/push command.

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

4. **Default values**: All chat commands should default to `friendly` personality when none specified

5. **Formatter usage**: Use service formatters (e.g., `qdrantService.formatResult()`) for consistent output

## Discord Embed Limits

- Embed field name: max 256 characters
- Embed field value: max 1024 characters (NOT 4000)
- Empty field values cause validation errors - always provide fallback text

## Testing

- Run `npm test` before deployment
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

### Local LLM Fallback Behavior

When the local Ollama instance becomes unavailable mid-runtime, the bot automatically falls back to the cloud provider:

- **Circuit breaker**: After a connection error (ECONNREFUSED, ETIMEDOUT, etc.), `LocalLlmService` is marked temporarily unavailable for 60 seconds
- **Fallback personality**: The `uncensored` personality defines `fallbackPersonality: 'friendly'` — when local LLM fails, the request is retried with the `friendly` personality via OpenAI
- **User notification**: A visual notice (warning emoji) is shown to the user when fallback occurs
- **Recovery**: After the 60-second cooldown, the next request optimistically tries the local LLM again
- **Custom fallbacks**: Any `useLocalLlm: true` personality can define its own `fallbackPersonality` field

## File Locations

- Slash commands: `commands/slash/`
- Base command class: `commands/base/BaseSlashCommand.js`
- Services: `services/`
- Tests: `__tests__/`
