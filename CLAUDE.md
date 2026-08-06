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

**Sandbox isolation:** Kata Containers, specifically `runtimeClassName: kata-qemu-runtime-rs` (Kata's Rust runtime — statically linked, no glibc coupling). Each `run_in_sandbox` call lands in its own tiny QEMU/KVM guest. Originally specified for gVisor, swapped to Kata on 2026-04-29 because Harvester's immutable SLE Micro host OS makes installing `runsc` impractical, and KubeVirt-on-bare-metal is already the platform's native model. Sandbox pods carry `dynatrace.com/inject: "false"` to keep OneAgent out of ephemeral guests (otherwise PID 1 doesn't release on container exit, ballooning wall-clock per execution to ~120s). See `k8s/sandbox/README.md` for the full Kata install play-by-play including the RKE2 containerd-template patch, the `kvm_amd sev=0` workaround for AMD hosts, and the smoke-test recipe. Cold start adds ~1.5–3s per call (VM boot); the agent prompt is aware of this so the model doesn't think the call hung.

**Toggle:** `AGENT_ENABLED=false` reverts channel-voice to direct OpenAI immediately. The `AgentClient` health-polls every 5s and considers the sidecar unhealthy after 30s without a successful Health response, falling through to direct OpenAI when the sidecar is gone.

**Transient 503 handling:** the Gemini-native path attaches SDK-level exponential backoff (`agent.py` `_gemini_retry_options`: 4 attempts, 0.5→8s, jitter, on `429/500/502/503/504`). New preview models (e.g. `gemini-3.5-flash`) spike 503 "model overloaded" errors; without this each one immediately fell through to the `gpt-5-mini` fallback, silently swapping the model. Retry is at the HTTP-call layer, NOT the agent turn, so sandbox tools are never re-executed. The bot's `AgentClient` chat deadline (600s) comfortably exceeds the ~8s retry budget.

**Gemini backend — Enterprise Agent Platform, NOT the consumer API (since 2026-08-05):** the sidecar's Gemini calls run on the Gemini Enterprise Agent Platform (GEAP, the rebranded Vertex AI, `aiplatform.googleapis.com`), not the consumer AI-Studio endpoint. This moves the `BLOCK_NONE` dual-use security workload onto the enterprise-governed surface (consumer AI-Studio runs Prohibited-Use abuse monitoring even on paid tier — a policy-suspension risk). Wired via env on `agent-deployment.yaml`: `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2`, **`GOOGLE_CLOUD_LOCATION=global`** (the Gemini flash models 404 at `us-central1` on this project — they serve from `global`), `GOOGLE_APPLICATION_CREDENTIALS=/var/secrets/genai/key.json`. ADC comes from SA `agent-genai@revenant-discord-bot-2` (`roles/aiplatform.user`) mounted via the `agent-genai-sa` Secret; `GEMINI_API_KEY` is blanked in the sidecar env so the SDK can't pick the consumer backend. `active_genai_backend()` logs `genai_backend=enterprise` at startup. **ImagenService/LyriaService (the bot, not the sidecar) still use the consumer `GEMINI_API_KEY`** — only the sidecar moved. `mcp` is pinned `<2.0.0` (2.0 dropped `streamablehttp_client`/`mcp.shared.session`).

**Sidecar:** single-replica `Recreate` Deployment — concurrency state is in-process; **do not scale**.

**Tunables (sandbox-config ConfigMap):** `SANDBOX_INLINE_OUTPUT_CHARS`, `SANDBOX_WALL_CLOCK_SECONDS`, `SANDBOX_PER_USER_CONCURRENCY`, `SANDBOX_GLOBAL_CONCURRENCY`, `SANDBOX_MEMORY_LIMIT`, `SANDBOX_CPU_LIMIT`, `SANDBOX_BASE_IMAGE`, `SANDBOX_TRACE_RETENTION_PER_USER`, `SANDBOX_AGENT_TURN_CALL_BUDGET`.

**Reaction reveal:** on a bot reply that ran code, react with 🔍 (source code), 📜 (stdout + stderr if non-empty), or 🐛 (stderr only) to get the artifact attached.

**Trace storage:** MongoDB `sandbox_executions` (one doc per call). The retention loop in the sidecar demotes >N (default 50) traces per user — older docs keep `exit_code`/`stdout`/`stderr`/`duration_ms` but null out `code`, `stdin`, `env_keys`, `egress_events`, `runtime_events`, `agent_rationale`. The `runtime_events` field is empty by default under Kata (no built-in syscall-deny telemetry); the field is reserved for future `auditd`-in-guest signals.

**Manifests:** `k8s/sandbox/` (tracked) — see its README for the kata-deploy prereq, apply order, and the two small edits the bot Deployment + NetworkPolicy need.

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
