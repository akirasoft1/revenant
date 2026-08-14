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

**Health means "Chat works", not "the port is open" (`server.py` `ChatCircuitBreaker`):** `Health` used to be a hardcoded `healthy=True`, and the bot's `AgentClient` treats that RPC as its ONLY circuit breaker for the agent path — so the breaker's entire input was whether the gRPC server accepted a connection. That stays true while Vertex/GEAP credentials are revoked or Mongo is unreachable, and every channel-voice turn was then routed into a call guaranteed to fail (up to the 600s `chatDeadlineMs` each when the failure hangs rather than erroring). `Health` now reports a **consecutive-failure breaker over observed `Chat` outcomes** — no I/O in the health path, it only reads state `Chat` recorded. `AGENT_HEALTH_FAILURE_THRESHOLD` (default 3) consecutive failures trip it; any successful `Chat` closes it. **The half-open is load-bearing:** while unhealthy the bot STOPS sending `Chat`, so no success can arrive on its own and a naive breaker would latch unhealthy until a pod restart; after `AGENT_HEALTH_COOLDOWN_SECONDS` (default 60) the breaker reports healthy again to admit a trial `Chat`, and a failed trial re-opens it immediately and restarts the cooldown. Failures counted include every `Chat` exception, the not-configured case, and a turn that returns empty text (the bot already treats an empty turn as failed) — over-counting fails toward the safe direction (falling back to direct OpenAI). Do NOT "fix" health with `healthy = self._agent is not None`: `serve()` builds the agent before `server.start()` with no try/except, so that expression is a tautology in production. **A cancelled `Chat` counts too, and this is subtle enough to be worth stating: `asyncio.CancelledError` inherits from `BaseException`, so an `except Exception` in the handler never sees it — and a client-deadline expiry is delivered to a grpc.aio handler as exactly that.** Without the explicit `except asyncio.CancelledError` in `AgentServicer.Chat`, the most expensive failure mode of all (a backend that accepts the connection and goes silent, burning the bot's full 600s `chatDeadlineMs` on every message) recorded nothing and the breaker never opened. The handler additionally bounds its own turn with `AGENT_CHAT_TIMEOUT_SECONDS` (default 540, deliberately under the bot's 600s deadline) so the sidecar gives up first and the bot gets a real `DEADLINE_EXCEEDED` naming the bound.

**Degradation is announced, never silent:** three paths can hand the user something other than a normal agent reply, and each now says which. (1) Agent RPC failure → `ChatService.chat` falls through to direct OpenAI and attaches `result.fallback` naming the substitute model; the log line names it too. (2) `fallback_occurred` on `ChatResponse` is real plumbing now — the sidecar sets it when a turn ran on the generic `base.txt` instead of the bot's learned channel-voice `system_prompt`. (3) `buildTurnContext` throwing no longer silently strips personality + memory + history: the turn still runs (degraded-but-working is correct) but it is logged at error with the stack and flagged to the user. `bot.js` renders `result.fallback.notice` supplied by ChatService — it used to hardcode "Local LLM unavailable" for every fallback, mislabelling agent failures as a problem in an unrelated feature.

**K8s API timeouts (`k8s_client.py`) — two mechanisms, and the difference matters:** an API server that accepts the connection and goes silent parks the `asyncio.to_thread` worker forever AND holds the orchestrator's `ConcurrencyGate` permit. Permits are global and finite, and every K8s call in the sidecar runs on the default executor (`min(32, cpu+4)` workers), so repeated hangs walked the sandbox to a standstill only a restart cleared.

1. **REST calls** carry an explicit `_request_timeout` (default `(5, 30)`), which works as advertised.
2. **The exec/attach websocket IGNORES `_request_timeout`.** `ws_client.websocket_call` only applies it via `run_forever`, which is reached only when `_preload_content` is true — and we pass `False` (we need the live `WSClient` to write stdin). The hang is inside the `WSClient` constructor: `create_websocket` → `WebSocket.connect()` → `_http._open_socket` does `sock.settimeout(None)`, so connect/TLS/handshake are unbounded blocking reads. Verified empirically against a socket that accepts and never answers: `websocket.setdefaulttimeout()` does NOT fix it (`getdefaulttimeout()` is only read by `create_connection`/`WebSocketApp`), neither does `socket.setdefaulttimeout()` (defeated by the explicit `settimeout(None)`), and there is no seam to pass `sockopt`. What works is `_install_ws_connect_timeout` in `k8s_client.py`: it substitutes `kubernetes.stream.ws_client.WebSocket` with a subclass that defaults the documented `connect(timeout=…)` option. **This is a monkeypatch of a third-party symbol** — if a kubernetes upgrade stops resolving `WebSocket` through that module it silently stops applying, so it returns a bool, logs loudly on failure, and `tests/test_k8s_client_timeouts.py` pins it against a real silent socket.

`SandboxOrchestrator.run` bounds one execution (`overall_deadline_s`, default `wall_clock + 120`) inside the gate, returning `orchestrator_error="orchestrator_timeout"`, **plus** a separate `cleanup_deadline_s` (default 30s) on the `delete_job` in `_do_run`'s `finally`: `asyncio.wait_for` cancels the task and then waits for that `finally` before raising, so without its own bound a slow cleanup extends the permit hold past the deadline. An abandoned Job cleans itself up via `activeDeadlineSeconds` + `ttlSecondsAfterFinished`. Note the orchestrator deadline releases the *permit*, not the *thread*: `asyncio.to_thread` futures cannot be cancelled, so unwinding the worker thread is the job of the request-level bounds above — which is exactly why the websocket one had to be made real rather than assumed.

**Transient 503 handling:** the Gemini-native path attaches SDK-level exponential backoff (`agent.py` `_gemini_retry_options`: 4 attempts, 0.5→8s, jitter, on `429/500/502/503/504`). New preview models (e.g. `gemini-3.5-flash`) spike 503 "model overloaded" errors; without this each one immediately fell through to the `gpt-5-mini` fallback, silently swapping the model. Retry is at the HTTP-call layer, NOT the agent turn, so sandbox tools are never re-executed. The bot's `AgentClient` chat deadline (600s) comfortably exceeds the ~8s retry budget.

**Gemini backend — Enterprise Agent Platform, NOT the consumer API (since 2026-08-05):** the sidecar's Gemini calls run on the Gemini Enterprise Agent Platform (GEAP, the rebranded Vertex AI, `aiplatform.googleapis.com`), not the consumer AI-Studio endpoint. This moves the `BLOCK_NONE` dual-use security workload onto the enterprise-governed surface (consumer AI-Studio runs Prohibited-Use abuse monitoring even on paid tier — a policy-suspension risk). Wired via env on `agent-deployment.yaml`: `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2`, **`GOOGLE_CLOUD_LOCATION=global`** (the Gemini flash models 404 at `us-central1` on this project — they serve from `global`), `GOOGLE_APPLICATION_CREDENTIALS=/var/secrets/genai/key.json`. ADC comes from SA `agent-genai@revenant-discord-bot-2` (`roles/aiplatform.user`) mounted via the `agent-genai-sa` Secret; `GEMINI_API_KEY` is blanked in the sidecar env so the SDK can't pick the consumer backend. `active_genai_backend()` logs `genai_backend=enterprise` at startup. **ImagenService/LyriaService (the bot, not the sidecar) still use the consumer `GEMINI_API_KEY`** — only the sidecar moved. `mcp` is pinned `<2.0.0` (2.0 dropped `streamablehttp_client`/`mcp.shared.session`).

**Sandbox disposition — answer-directly-by-default (since 2026-08-06):** `TOOL_AVAILABILITY_PREAMBLE` in `agent.py` treats the sandbox as a LAST resort — the model answers most asks directly (instant) and only invokes `run_in_sandbox` when a correct answer genuinely requires execution (real network/recon, computing over data it can't derive, observing real runtime behavior). This was a latency fix: the old preamble pushed "when in doubt, run it," which fired a pod for ~46% of direct questions. Tune/verify with the offline eval harness (`agent-sidecar/eval/`, see its README) — it runs the real agent against a fake orchestrator and scores false-invocation / false-omission. The `Chat` handler emits `sandbox.invoked` / `sandbox.call_count` on an `agent.chat` span for Dynatrace to track the production invocation rate. Follow-up if prompt tuning proves insufficient: a pre-flight router/classifier.

**Sidecar:** single-replica `Recreate` Deployment — concurrency state is in-process; **do not scale**.

**Tunables (sandbox-config ConfigMap):** `SANDBOX_INLINE_OUTPUT_CHARS`, `SANDBOX_WALL_CLOCK_SECONDS`, `SANDBOX_PER_USER_CONCURRENCY`, `SANDBOX_GLOBAL_CONCURRENCY`, `SANDBOX_MEMORY_LIMIT`, `SANDBOX_CPU_LIMIT`, `SANDBOX_BASE_IMAGE`, `SANDBOX_TRACE_RETENTION_PER_USER`, `SANDBOX_AGENT_TURN_CALL_BUDGET`. Health-breaker knobs (sidecar env, defaults are sane): `AGENT_HEALTH_FAILURE_THRESHOLD` (3), `AGENT_HEALTH_COOLDOWN_SECONDS` (60), `AGENT_CHAT_TIMEOUT_SECONDS` (540 — must stay under the bot's 600s `chatDeadlineMs`).

**Reaction reveal:** on a bot reply that ran code, react with 🔍 (source code), 📜 (stdout + stderr if non-empty), or 🐛 (stderr only) to get the artifact attached.

**Trace storage:** MongoDB `sandbox_executions` (one doc per call). The retention loop in the sidecar demotes >N (default 50) traces per user — older docs keep `exit_code`/`stdout`/`stderr`/`duration_ms` but null out `code`, `stdin`, `env_keys`, `egress_events`, `runtime_events`, `agent_rationale`. The `runtime_events` field is empty by default under Kata (no built-in syscall-deny telemetry); the field is reserved for future `auditd`-in-guest signals.

**Manifests:** `k8s/sandbox/` (tracked) — see its README for the kata-deploy prereq, apply order, and the two small edits the bot Deployment + NetworkPolicy need.

## Voice (discord-article-bot-voice sidecar)

When `VOICE_ENABLED=true`, `/voice join` puts the bot in a Discord voice channel and routes audio through a **second, separate** Python gRPC sidecar — `discord-article-bot-voice` — that hosts one Gemini Live session per active voice channel. It is a distinct Deployment from the agent sandbox sidecar (`discord-article-bot-agent`): they solve different problems and have opposite scaling needs.

**New-sidecar rationale (RollingUpdate/scalable vs. the agent sidecar's Recreate/do-not-scale):** the agent sidecar keeps sandbox-orchestration concurrency state in-process, so it must stay single-replica `Recreate` and never scale. The voice sidecar instead holds long-lived, real-time gRPC audio streams for as long as the bot sits in a voice channel — a `Recreate` rollout would drop every live call. It ships as its own `RollingUpdate`, horizontally scalable Deployment (`k8s/voice/voice-deployment.yaml`) for exactly that reason.

**Reuses `agent-genai-sa` (no new secrets):** the voice sidecar's Gemini Live calls run on the same GEAP/Vertex backend as the agent sidecar — `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2`, `GOOGLE_CLOUD_LOCATION=global`, ADC via the `agent-genai-sa` Secret mounted at `/var/secrets/genai/key.json`, `GEMINI_API_KEY` blanked. `serviceAccountName: agent-sa` is reused too. Nothing new to provision in the cluster.

**`dynatrace.com/inject` — deliberately left enabled:** unlike the ephemeral Kata sandbox pods (which disable injection because PID 1 doesn't release cleanly, ballooning per-call wall clock), this is a long-lived, observability-first service — same posture as the agent sidecar's deployed manifest, which also does not set the annotation. Both OneAgent and the sidecar's own OTLP spans reach Dynatrace.

**Wake word (openWakeWord, keyless/offline, per-speaker):** audio is only forwarded to the Live model after openWakeWord detects the wake phrase locally (`VOICE_WAKE_WORD` label, default `"hey jarvis"`). No API key — the ONNX models run in-process via `onnxruntime-node`. This keeps ambient channel audio private and avoids streaming/billing on conversation the bot wasn't addressed in. The three-stage chain (melspectrogram → embedding → wake model) and its exact mel-frontend params (1280-sample frames, 5 mels/frame, 76-frame window at stride 8, `x/10+2` mel transform, int16-range float32 input) are ported from the `openwakeword_wasm` reference and vendored in `models/openwakeword/` (Apache-2.0). Four pretrained phrases: hey jarvis, alexa, hey mycroft, hey rhasspy. Tunables: `VOICE_WAKE_MODEL`, `VOICE_MEL_MODEL`, `VOICE_EMBEDDING_MODEL`, `VOICE_WAKE_THRESHOLD` (default 0.5). **Per-speaker gates:** one wake-gate set is built lazily per Discord `userId` (via `_perUser`), so each speaker in a multi-user channel has their own independent detection; the module-level ONNX session cache shares model weights across all speakers to avoid duplication. Note: `onnxruntime-node`'s `session.run` is async while the `WakeWordGate` contract is sync, so the engine runs the ONNX chain on an async queue and surfaces detections via a flag `process()` reads on the next call (sub-frame <80 ms lag).

**Voice Activity Detection (Silero VAD, per-speaker):** per-speaker neural VAD (Silero v5.1, `services/voice/SileroVad.js`, via `onnxruntime-node`) detects speech on 512-sample / 32 ms windows at 16 kHz, replacing the fixed mean-abs energy gate. One VAD instance runs per Discord `userId` (lazily created via `_perUser`), carrying its own stateful context tensor across chunks; the module-level ONNX session cache shares model weights across speakers. Endpointing is now a correct **Gemini Hybrid VAD**: once a turn opens, audio streams continuously (including trailing silence) so Gemini's server-side VAD sees real end-of-speech as a fallback; client-side `SileroVad.speechEnd` fires an early `audio_stream_end` that finalizes after `VOICE_SPEECH_END_SILENCE_MS`. Silero model vendored at `models/silero/silero_vad.onnx` (MIT). Tunables: `VOICE_VAD_THRESHOLD` (default 0.5), `VOICE_VAD_MIN_SPEECH_FRAMES` (2, ~64 ms), `VOICE_VAD_MIN_SILENCE_FRAMES` (24, ~768 ms), `VOICE_VAD_MODEL` (path).

**Session longevity — sliding-window context compression + resumption:** Audio-only Gemini Live sessions naturally cap at ~15 minutes because audio accrues ~25 tokens/s, and the Live context window fills. **Sliding-window context compression** removes this cap by storing a server-side resumption handle and compressing the session's context history once token count exceeds the trigger threshold. Trigger via `VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS` (default 25000). **Session resumption** stores that handle and, on a dropped connection or a `GoAway` pre-disconnect warning from the server, transparently reconnects using it — the handle carries all conversation context, so re-seeding is not needed and no error surfaces to the bot. A failed (re)open itself (expired/consumed handle, a transient GEAP 503 spike) is retried with exponential backoff + jitter (0.5s → 4s cap) against the same reconnect budget rather than surfacing immediately as a fatal error. Resumption is capped at `VOICE_MAX_SESSION_RECONNECTS` (default 5) reconnection attempts total, covering both successful-session reconnects and failed-open retries; disable the feature entirely with `VOICE_SESSION_RESUMPTION_ENABLED=false`. **Note:** there is a mid-reconnect audio gap of ~1–3s (a full Live-session open) — frames arriving while no session is open are dropped, not buffered, because replaying stale audio after a resume would read as current speech; a dropped `audio_stream_end` (turn-finalize signal) is the one exception — it's replayed once immediately after the new session lands, since the bot won't resend it on its own. **Prerequisite to observe any of this:** `VoiceService._tick` force-ends the session at `VOICE_MAX_SESSION_SECONDS` (default 600s in `config/config.js`) regardless of resumption — at that default the ~15-min Live cap is never the binding constraint, so `VOICE_MAX_SESSION_SECONDS` must be raised for session longevity to matter in practice (it remains the cost guard; the default is intentionally left unchanged here).

**Turn rhythm:** wake → reply → "hot" follow-up window (`VOICE_FOLLOWUP_WINDOW_MS`, default raised to 60s in the deployed configmap; **each reply resets it**, so a back-and-forth needs no re-wake) → idle (`VOICE_IDLE_TIMEOUT_MS` tears the session down). `VOICE_MAX_SESSION_SECONDS` is a hard belt-and-suspenders cap independent of idle/follow-up timing.

**Active-speaker floor control:** in multi-user voice channels, the first speaker to wake the bot holds the floor (`FloorControl.js`); only the floor-holder's audio is forwarded to Gemini Live. When a second speaker talks, they are detected as "waiting" (`FloorControl.waiting()`), logged to observability, but their audio is withheld from the model — preventing crosstalk and keeping the conversation coherent. The floor is released when the session idles or ends. This design enables human-like deferral interactions in later phases: Phase 4 will lean on `FloorControl.waiting()` to craft replies that acknowledge waiting speakers ("let me finish with Alice, then I'll get to Bob").

**Per-speaker transcript attribution:** voice transcripts are authored with the floor-holder's real Discord `userId` (not the placeholder `'voice-user'`), so `/tldr` and centralized recall show who actually spoke — essential for multi-user channels.

**Pre-roll buffer:** while idle, `VoiceService` keeps a rolling ~3s pre-roll (`MAX_PREROLL_FRAMES`) of 16k PCM. On wake it captures that buffer (plus any audio arriving during the ~3s session-open startup) into `g.pending` and flushes it into the Live session right after `sendStart`, so a first-turn question spoken in the same breath as the wake phrase ("hey jarvis, what's 2+2") isn't lost in the wake→session gap. The wake-phrase audio is sent through too (harmless; reads as address).

**`/voice listen` (admin override):** `VoiceSessionMachine.forceListen()` opens a session immediately with NO wake word and sets a `_continuous` flag so `turnComplete` stays "hot" with no teardown timer — continuous listening (no re-wake between questions) until `/voice leave` or the `VOICE_MAX_SESSION_SECONDS` cap. Gated to `BOT_ADMIN_USER_IDS` in `commands/slash/voice.js`. `listen()` grants the active-speaker floor (see below) to the invoking admin as part of opening the session — `forceListen()` alone never sets a holder, and without an explicit grant the floor-arbitration check in `_handleUserPcm`'s active branch withholds every speaker's audio unconditionally, so the session opens but nothing is ever forwarded to the model. As a result listen mode streams only the invoking admin's audio; any other speaker is withheld exactly as in a normal (wake-triggered) session. **With `VOICE_DEFERRAL_ENABLED=true` that stops being true after the first interjection:** the Phase 4 acknowledgment releases the floor, and the re-take path grants it to whoever speaks next — so a listen session silently becomes multi-speaker (one speaker at a time, floor passing between them) the first time someone qualifies as a waiter. Often desirable, but an admin running a controlled single-speaker demo should turn the deferral flag off for it, or expect the floor to move. Genuine per-speaker/simultaneous multi-speaker listen mode remains unimplemented.

**Web-search grounding:** the Live config sets `tools=[google_search]` (server-side grounding, no client tool-response plumbing) so the model answers factual/game questions from the live web. The voice-only system-prompt note (built in `VoiceService._appendVoicePersona` from the wake word) tells it to answer to the wake name and to USE search proactively rather than deflecting ("I don't play that game").

**Reuses the `channel-voice` personality prompt:** `config.voice.systemPrompt` is wired from the same learned channel-voice system prompt used for text chat (falls back to `VOICE_SYSTEM_PROMPT` if set), so spoken replies match the group's learned communication style.

**Memory in, transcripts out:** recall context feeds into voice turns the same way it does text chat, and every voice exchange is written into the MongoDB message store as a transcript — it shows up in `/tldr` and centralized ranked recall like any other message.

**Speaker Identity & Name Resolution (Phase 3):** the bot knows who is speaking in voice channels and addresses people by their preferred names. The `SpeakerNames` resolver (`services/SpeakerNames.js`) turns a Discord user into a name suitable for TTS (text-to-speech) by trying, in order: (1) an explicit override from `VOICE_SPEAKER_NAMES` config; (2) Discord's `globalName` (the account-wide displayable name); (3) per-guild `nickname` (server-specific override); (4) `username` with trailing digit runs stripped (`inc1067` → `inc`) to reduce redundancy; (5) `null` (omit the name marker). All candidates are **sanitised** (emoji removed, `™`/`(tm)`/bracketed-tag patterns stripped, zero-width chars removed, whitespace collapsed, capped at 24 chars) **because the names are read aloud** — an unsanitised nickname like `Macroplastics by Bic(tm)` would be voiced literally. The override is authoritative: it is only discarded if sanitisation yields empty (a letterless override like `007` is honoured). **The VOICE path skips the nickname layer:** `VoiceService._perUser` calls `resolve(user, null)` — it has no per-guild `member` object to pass (voice sessions are keyed by Discord `userId`, not a guild-scoped message), so candidate (3) above never applies there. The chat/recall path (`bot.js`) does pass `message.member` and gets the full nickname layer. Practical effect: the same person can be resolved as their server nickname "Dave" in `/tldr`/chat but as their `globalName`-or-username fallback "dave42" in voice. The resolver feeds three systems: (1) **voice in-context markers** — on speaker change, the bot sends `[SPEAKER: <name>]` via the Live sidecar's `send_client_content` immediately before that speaker's next audio, context-only (not read aloud); (2) **chat and recall** — `/tldr`, channel context, and ranked recall use the same resolver so friends stop appearing as `inc1067` in text too (previously-stored rows keep their old names — no backfill); (3) **transcript attribution** — voice exchanges land in MongoDB with the floor-holder's real `userId`, not a placeholder. **Version lock (critical):** the in-context `[SPEAKER: …]` marker mechanism relies on `send_client_content` with `turn_complete=False`, which is **supported on `gemini-live-2.5-flash` but restricted on Gemini 3.x Live** — do not upgrade `VOICE_LIVE_MODEL` without revisiting spec §5.4 or the markers will be silently dropped.

**Human-like turn deferral (Phase 4 — "announce and release"):** when a second speaker talks while someone else holds the floor, their audio is withheld (as before) but no longer silently dropped — once the bot finishes speaking, it acknowledges the waiter by name in its own voice, then releases the floor so whoever speaks next takes it. **The trigger is playback drain (`_botIsSpeaking(g)` going false in `_tick`), never `turnComplete`** — `turnComplete` only means the Live model finished *generating*, and Gemini Live streams audio faster than real-time, so on a ~12s reply the model is done in ~2s while the bot is still talking for seconds after. Firing on `turnComplete` would cut the bot off mid-word. **The floor is released, not handed over:** handing it to someone the bot hasn't actually heard risks a deaf bot or a transcript filed under the wrong person, so `_tick` calls `g.floor.release()` and a companion re-take path in `_handleUserPcm` grants it to the next speaker — that re-take path is what makes "the next person to speak takes the floor" actually true; without it every speaker's audio, including the invited one's, would stay withheld until the follow-up window or session cap. **The re-take is level-triggered AND playback-guarded, and neither half is safe alone:** it fires on `vad.speaking` (not just the `justStarted` rising edge) because with `VOICE_VAD_MIN_SILENCE_FRAMES` ≈768ms an edge-only trigger strands anyone already mid-utterance — including a holder whose floor was released out from under them when server VAD endpointed them early (the same edge-vs-level bug as the 2026-08-14 outage documented in the holder branch). But a bare level trigger would let the bot's own acknowledgment, re-entering a laptop-speaker mic, seize the *unheld* floor and stream the bot's voice back as user input — so the re-take also requires `!_botIsSpeaking(g)`. It is additionally gated on `deferralEnabled`: the branch is provably dead with the flag off, so gating costs nothing and makes "flag off is byte-identical" structural rather than resting on an unpinned invariant a future `release()` site could quietly break. **Qualification requires a continuous overlapping utterance:** the per-user context tracks `withheldMs` (all withheld speech, cumulative) and a per-utterance `waitingMs` that is folded into `waitingPeakMs` on speech end, and the threshold is compared against `max(waitingPeakMs, waitingMs)` — the peak of any *single* utterance, plus whatever is in progress. A session-cumulative counter was wrong: three separate 300ms bursts would clear a 700ms bar no single burst ever reached, which is exactly the cough/backchannel/echo case the threshold exists to reject. (Do not "simplify" this by resetting on speech end — the acknowledgment is evaluated in `_tick` *after* the utterance ends, so a plain reset makes the value 0 at evaluation time and the feature never fires at all.) Only the overlap figure is thresholded, because the common case of someone talking into silence is not "trying to interject," it's just talking after the bot already finished. **`VOICE_ALLOW_BARGE_IN=true` is a hard prerequisite for any of this, not a nicety:** with barge-in off — which is the *code* default, though production sets it true — the half-duplex gate in `_handleUserPcm` returns before the non-holder accrual runs whenever the bot is producing audio, so overlap can never accrue, the acknowledgment can never fire, and the measurement log prints `0ms ... overlapping bot playback` on every single line, voiding the measurement-first rollout spec §5 makes a precondition. Non-overlapping withheld speech (`withheldMs`) still accrues, so the log looks alive while the number that matters is structurally pinned at zero. **`VOICE_DEFERRAL_MIN_SPEECH_MS` (default 700) is a placeholder, not a trusted value** — the withheld-speech debug log (`VoiceService.js` near the non-holder branch) prints all three figures (total withheld, this utterance's overlap, longest single overlapping utterance **of the current turn**) specifically so the real threshold can be set from the **longest-single-utterance** number in logged data — not the cumulative one, which will read far higher (headphones vs. laptop-speaker echo re-entering a mic is the failure mode this measurement is guarding against) before the flag is flipped on. **Critical when reading those numbers: ~768ms of the figure is VAD hangover, not speech.** `SileroVad` latches `speaking: true` until `VOICE_VAD_MIN_SILENCE_FRAMES` (24 × 32ms) of sub-threshold audio has passed, and the accrual counts every chunk while that latch is open — so as long as packets keep arriving (Discord's `AfterSilence` is 800ms, so they usually do) a **64ms** utterance accrues **~760ms**, and a 320ms one accrues ~1020ms. Measured, not theorised. Consequence: at the 700 default the threshold rejects *nothing* — any utterance the VAD detects at all clears it, which quietly voids spec §5's "coughs, one-word backchannels, and echo bursts do not earn an announcement" and §10's top-listed mitigation. Treat ~768ms as the **noise floor** of the logged figure; a bar that means anything wants to sit materially above it (~1300–1500ms ≈ 500–700ms of genuinely voiced speech). The logged numbers are self-consistent with the production check (same code path), so a threshold read off logs is not *wrong* — it is just measuring latch-open time, not speech. The alternative is a code change to discount the hangover (accrue only while the silence run is zero, or subtract `minSilenceFrames × 32ms` when folding the peak) — a parked follow-up. The `[SYSTEM: …]` nudge is injected by the sidecar with `turn_complete=True` (unlike the Phase 3 `[SPEAKER: …]` marker's `turn_complete=False`) because a reply is actually wanted here; its phrasing is delegated to the learned channel-voice persona rather than scripted, so the acknowledgment stays in character — the persona clause that explains `[SYSTEM:` lines is itself gated on `VOICE_DEFERRAL_ENABLED` so the prompt never describes a mechanism that can't fire. **Qualification is scoped to the turn it was earned against:** opening a new turn clears every speaker's `waitingMs`/`waitingPeakMs` (not `withheldMs`, which is the session-scoped measurement total), because a turn can end without its drain-time acknowledgment ever firing — the holder makes any sound before playback drains, the machine goes `hot`→`active`, and the check is skipped. Without the turn-boundary clear, a waiter who qualified against turn N and has been silent (or has left) ever since is named at the drain of turn N+1, apologising for talking over a reply two turns old. Spec §9's rejection of TTLs was about the waiting *queue*, not a missed drain. The `FloorControl` waiting set itself is untouched: a stale waiter stays listed but can no longer clear the threshold. **The floor is only released if the nudge actually went out:** `VoiceClient.sendAcknowledgeWaiting` returns a boolean and `_tick` latches/releases/clears only on `true`, retrying with exponential backoff (1s→30s) otherwise. That boolean is *not* a delivery receipt — grpc-js reports a write to a half-dead duplex as an async `'error'` event rather than a synchronous throw, so a nudge can still be lost with the send reporting success; a sidecar→bot confirmation for `AcknowledgeWaiting` is the real fix and is a parked follow-up. An empty `SetSpeaker` (`{userId: '', displayName: ''}`) now **clears** `current_speaker`/`pending_speaker` on the sidecar instead of being ignored — this closes a hazard Phase 3 flagged but couldn't reach (with exactly one floor holder per session, the speaker never legitimately went to "unknown"; a released-then-retaken floor breaks that invariant). Tunables: `VOICE_DEFERRAL_ENABLED` (default **false**, the kill switch — off is byte-identical to pre-Phase-4 behaviour with exactly one asterisk: the withheld-speech *debug log*'s "longest single utterance" figure is now per-turn rather than per-session, deliberately, because the measurement has to measure the quantity production thresholds on. No send, floor, or prompt change with the flag off) and `VOICE_DEFERRAL_MIN_SPEECH_MS` (default 700 — **almost certainly too low; see the ~768ms noise floor above before tuning it**). Spec: `docs/superpowers/specs/2026-08-14-voice-phase4-deferral-design.md`.

**`VOICE_SPEAKER_NAMES` (bot env):** optional JSON `{"<userId>":"<spoken name>", …}` providing name overrides. Example: `{"123456789":"Mike","987654321":"Alex"}`. Malformed JSON is tolerated (falls back to `{}`). **Requires a pod restart to reload.** Stored in the deployed configmap. Names are sanitised the same way as resolver candidates (emoji/tags removed, 24-char cap, etc.), so an override like `😂 LOL 😂` is sanitised to `"lol"` and then matched/honoured if non-empty.

The sidecar emits markers via `send_client_content(..., turn_complete=False)` immediately **before that speaker's next audio** so the marker is context only and not read aloud. The prompt tells the model these `[SPEAKER: …]` lines are out-of-band metadata **never to read aloud**, and to address people by name when natural (e.g. "Hey Mike, …" or "Great question, Alex"). Markers are counted as `speaker_markers` in the session END log.

**Tunables (bot env):** `VOICE_ENABLED`, `VOICE_GRPC_ADDR`, `VOICE_WAKE_WORD`, `VOICE_WAKE_MODEL`, `VOICE_MEL_MODEL`, `VOICE_EMBEDDING_MODEL`, `VOICE_WAKE_THRESHOLD`, `VOICE_LIVE_VOICE`, `VOICE_FOLLOWUP_WINDOW_MS`, `VOICE_IDLE_TIMEOUT_MS`, `VOICE_MAX_SESSIONS`, `VOICE_MAX_SESSION_SECONDS`, `VOICE_SYSTEM_PROMPT`, `VOICE_SPEAKER_NAMES`, `VOICE_VAD_THRESHOLD`, `VOICE_VAD_MIN_SPEECH_FRAMES`, `VOICE_VAD_MIN_SILENCE_FRAMES`, `VOICE_VAD_MODEL`, `VOICE_ALLOW_BARGE_IN`, `VOICE_DEFERRAL_ENABLED`, `VOICE_DEFERRAL_MIN_SPEECH_MS` (a non-positive or non-numeric value is rejected at config load with a warning and falls back to 700 — a 0 bar would announce every named waiter on their first speech frame). **Sidecar env:** `VOICE_LIVE_MODEL`, `VOICE_DEFAULT_VOICE`, `VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS`, `VOICE_SESSION_RESUMPTION_ENABLED`, `VOICE_MAX_SESSION_RECONNECTS`, `GRPC_LISTEN_ADDR`.

**Bot image base — Debian slim (glibc), NOT Alpine:** `@discordjs/voice` ^0.19.0 requires Node ≥22.12. The repo-root `Dockerfile` uses `node:22-slim` (Debian/glibc), NOT `node:22-alpine` (musl): `onnxruntime-node` (the openWakeWord engine) ships glibc-only prebuilt binaries (`libc.so.6`/`libm.so.6`, GLIBC_* symbol versions) with no musl variant, so it fails to load on Alpine. Any manual/local run of the bot needs Node ≥22.12.0 on glibc.

**Deploy checklist:** (1) run the Task 1 GEAP pre-flight probe and set the confirmed model as `VOICE_LIVE_MODEL` in the deployed overlay (never the `REPLACE_WITH_VALIDATED_MODEL` placeholder from the tracked manifest); (2) confirm the bot image is rebuilt from the `node:22-slim` (glibc) `Dockerfile` before flipping `VOICE_ENABLED=true` — the vendored openWakeWord ONNX models are baked into the image (no key/secret or PVC needed); (3) apply from the **deployed overlay**, never the tracked manifests — `kubectl apply -f k8s/overlays/deployed/voice-deployment.yaml -f k8s/overlays/deployed/voice-service.yaml -f k8s/overlays/deployed/voice-networkpolicy.yaml -n discord-article-bot` (or, for an image-only change, `kubectl set image deployment/discord-article-bot-voice voice=mvilliger/discord-article-bot-voice:<sha> -n discord-article-bot`) — then redeploy the bot and run `scripts/registerCommands.js`. **Do NOT run `kubectl apply -f k8s/voice/`:** the tracked `voice-deployment.yaml` is pinned to the literal placeholder `REPLACE_WITH_SHA`, which does not exist on Docker Hub, so applying it rewrites the live image to a broken tag and the rollout stalls in `ImagePullBackOff` (RollingUpdate keeps the old pod alive, so it presents as a 120s timeout rather than an instant outage — but the deployment is now pinned to a tag that will fail on the next reschedule). The same apply also reverts the deployed Service and NetworkPolicy to their tracked placeholder forms. This is the same `k8s/overlays/deployed/` source-of-truth rule stated above, which the voice checklist previously contradicted; (4) if the session-longevity work (compression + resumption) is meant to be observable, raise `VOICE_MAX_SESSION_SECONDS` above its 600s default first — otherwise `VoiceService._tick`'s hard cap ends the session before the ~15-min Live limit it's meant to work around is ever reached; (5) **before gathering any Phase 4 deferral measurements or flipping `VOICE_DEFERRAL_ENABLED=true`, confirm `VOICE_ALLOW_BARGE_IN=true` is set in the deployed configmap.** It is a prerequisite, not a nicety: the half-duplex gate returns before the overlap accrual, so with barge-in off the qualifying figure is pinned at zero, the acknowledgment can never fire, and every measurement line reads `0ms ... overlapping bot playback`. Production sets it true today, but nothing enforces it.

**Deferred follow-ups (not yet implemented):** idle auto-leave (channel currently requires `/voice leave`), dynamic (session-time, non-static) voice-profile injection into the Live system prompt, playback jitter smoothing (occasional; likely a jitter buffer + proper 24k→48k resampler), and self-service speaker names via `/voice name @user <spoken name>` command (Phase 4 — move the override table from the configmap to MongoDB so users set their own preferred spoken names; the configmap seed layer remains as the default).

**Manifests:** `k8s/voice/` (tracked) — see its README for the apply order, the required bot ConfigMap/Secret/NetworkPolicy edits, and the build/push command.

**Layer-4 real-model smoke test (speaker identity):** `scripts/smoke-voice-identity.js` opens ONE real `Converse` gRPC session against a port-forwarded sidecar and drives a scripted two-speaker conversation using two distinct synthesized voices (`scripts/gen-test-voices.js` TTS fixtures, auto-generated into gitignored `voice-fixtures/` if missing), so the three things that are only observable against the real model get checked without Discord or a second human: the model never reads the `[SPEAKER: ...]` marker aloud (critical — non-zero exit if it does), it actually uses the speaker names, one question doesn't produce more than one full reply, and each input transcript is printed next to the speaker that was current when it arrived for a human eyeball on attribution. Run with `kubectl port-forward svc/discord-article-bot-voice 50051:50051 -n discord-article-bot &` then `node scripts/smoke-voice-identity.js`. Against a sidecar build that predates `SetSpeaker` the marker is silently dropped server-side, so NAMES USED legitimately FAILs there — the script says so rather than crashing.

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
