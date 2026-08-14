# Revenant - Features

> **Note:** Article summarization is a legacy capability — retained for backwards compatibility but de-emphasized. The bot's current focus is AI chat in a learned channel voice, conversation and long-term memory, IRC history recall, an agentic code-execution sandbox, and image/video/music generation.

## Implemented Features

### Chat
- **Channel Voice**: Bot uses a learned group communication style as its voice, dynamically generated from IRC history and Discord messages
- **Simple Interface**: Just `/chat <message>` — no personality picker needed
- **Prompt Display**: Responses show the user's original prompt before the AI reply
- **Image Vision**: Attach images to chat messages for analysis and discussion
- **Web Search**: Bot can search the web for current information when needed
- **Per-user Token Tracking**: Usage recorded per user
- **Catch Me Up**: `/tldr` sends a DM summarizing what happened while you were away — articles, trends, and chat highlights from channels you've been active in, styled in the group's voice

### Conversation Memory
- **Channel-Scoped Memory**: All users in a channel share a conversation with each personality
- **Multi-User Awareness**: Personalities know who said what (`[Username]: message` format)
- **Conversation Limits**:
  - Maximum 100 messages per conversation
  - Maximum 150,000 tokens per conversation
  - 30-minute idle timeout
- **Resume Capability**: `/chatresume` to continue expired conversations
- **List Conversations**: `/chatlist` to see your resumable conversations
- **Admin Reset**: `/chatreset` for "bot admin" role to clear conversations

### AI Memory (Mem0)
- **Long-Term Memory**: Bot remembers facts and preferences about users across conversations
- **Automatic Extraction**: Mem0 extracts relevant facts from conversations using GPT-4o-mini
- **Semantic Search**: Relevant memories retrieved via vector similarity search
- **Per-User Memories**: Each Discord user has their own memory store
- **Shared Channel Memories**: Channel-wide facts visible to ALL users in that channel
- **3-Way Memory Search**: Parallel retrieval of personality, explicit, and shared channel memories
- **Personality-Scoped**: Memories can be filtered by personality for relevant context
- **Graceful Degradation**: Bot works normally if memory service (Qdrant) is unavailable
- **GDPR Compliance**: Users can request deletion of all their memories

### Centralized Ranked Recall (v2)
- **One recall step**: `RecallService` queries all content sources (Mem0 personal/explicit/shared, channel semantic hits, channel facts), dedupes across them, ranks by recency + importance with a 14-day decay half-life and access-count boosting, bounds to a token/item budget, and emits a single provenance-tagged `## Memory Context` block.
- **Recall ledger**: MongoDB `recall_ledger` tracks per-memory importance, access count, and last-access (the signals Mem0 doesn't expose), lazily populated and pruned by expiry.
- **Recent buffer + voice few-shot stay separate**: verbatim recency and style grounding are not run through the ranker; a cross-block exclusion-set prevents the buffer and semantic hits from double-injecting.
- **Validation**: offline eval harness (`scripts/eval-recall.js`) over `eval/recall/*.json`, plus `recall_comparisons` A/B shadow logging.
- **Flags**: `RECALL_V2_ENABLED` (default off), `RECALL_SHADOW_ENABLED`, `RECALL_SHADOW_INJECT`.

### Multiplayer Chat
- **Participant Awareness**: Bot tracks who's active in each channel (30-minute window)
- **Multi-User Context**: System prompt includes list of active participants and their recent topics
- **@Mention Entry**: Mention the bot (`@BotName`) to start a conversation with default personality
- **Seamless Replies**: Reply to any bot message to continue the conversation naturally
- **Shared Context**: All users in a channel see the same conversation history per personality

### Image Generation (Nano Banana)
- **AI Image Generation**: Generate images from text prompts using Google's Gemini API
- **Admin Premium Model**: Bot admins (`BOT_ADMIN_USER_IDS`) automatically use a premium model (`IMAGEGEN_ADMIN_MODEL`) for higher quality generation
- **Reference Image Support**: Use existing images or Discord emojis as reference
- **Aspect Ratio Support**: 10 supported ratios (1:1, 16:9, 9:16, etc.)
- **Per-User Cooldowns**: Configurable cooldown to prevent abuse
- **Usage Tracking**: All generations tracked in MongoDB (including which model was used)
- **Safety Filters**: Relies on Gemini's built-in content safety with detailed logging of FinishReason (SAFETY, IMAGE_SAFETY, IMAGE_PROHIBITED_CONTENT), BlockedReason, blockReasonMessage, and safety ratings
- **Auto-Retry**: When generation fails (non-safety), AI automatically retries with a simplified prompt before falling back to interactive suggestions
- **Interactive Fallback**: If auto-retry also fails, react with 1️⃣ 2️⃣ 3️⃣ to retry with suggested prompts, ❌ to dismiss
- **Failure Analysis**: Detailed analysis of why prompts fail (safety, rate limits, etc.)
- **Learning Loop**: Retry attempts tracked in MongoDB to improve future suggestions
- **Reply to Regenerate**: Reply to a generated image with feedback to create an enhanced version (aspect ratio directives are stripped to prevent conflicts with the image generation API)

### Video Generation (Veo)
- **AI Video Generation**: Generate videos using Google's Veo 3.1
- **Text-to-Video Mode**: Generate video from text descriptions alone
- **Single Image Mode**: Animate a single image into a video (image-to-video)
- **Two Image Mode**: Provide first and last frame images for smooth transitions
- **Duration Options**: 4, 6, or 8 second videos
- **Aspect Ratios**: 16:9 (landscape) or 9:16 (portrait)
- **Discord Emoji Support**: Use Discord emojis as source images
- **Progress Updates**: Real-time status updates during generation
- **Usage Tracking**: All generations tracked in MongoDB

### Music Generation (`/musicgen`)
- **Lyria 3 Pro Generation**: Generate music using Google's Lyria 3 Pro (`lyria-3-pro-preview`)
- **Text Prompts**: Describe the music in natural language
- **Lyrics Support**: Provide lyrics with `[Verse]`, `[Chorus]`, `[Bridge]` tags for structured composition
- **Negative Prompts**: Specify what to avoid (e.g., "no vocals"). Composed into the prompt text since Lyria has no structured negative_prompt API field.
- **Visual Inspiration**: Up to 3 reference images to guide the generation style
- **MP3 Output**: Multi-minute audio attachments with duration controllable through the prompt
- **Lyrics Rendering**: Generated lyrics and structure displayed in an embed when provided by the model
- **Usage Tracking**: All generations recorded in MongoDB via CostService
- **Configuration**: `MUSICGEN_ENABLED=true`, `LYRIA_MODEL` (default `lyria-3-pro-preview`), `LYRIA_PER_CALL_COST_USD` (default `0.06`, placeholder pending finalized Google pricing)

**Note on `/stats`**: Cost tracking per generation is recorded through CostService and surfaced in cumulative cost logs. The `/stats` command reads from MongoDB's token-usage leaderboard and does NOT include media-gen records today. Wiring media-gen rows into MongoDB for `/stats` display is part of the Approach B refactor (see `docs/superpowers/specs/2026-05-15-lyria-music-generation-design.md`).

**TODO: Approach B refactor.** `ImagenService` / `VeoService` / `LyriaService` duplicate noticeable plumbing (enabled checks, image fetching, attachment construction, error shaping). Worth extracting a `MediaGenBase` once Lyria has soaked. See `docs/superpowers/specs/2026-05-15-lyria-music-generation-design.md` ("Approach B").

### ElevenLabs Music Generation (`/elevenmusic`)

Parallel music generation surface via ElevenLabs' `POST /v1/music` (Compose Music). Shipped alongside `/musicgen` (Lyria) for A/B comparison.

**Inputs**
- `prompt` (required) — description of the music
- `duration` (optional, 3–600s) — default 90 seconds (matches Lyria Pro for apples-to-apples comparison)
- `instrumental` (optional, boolean) — `force_instrumental: true` when no lyrics
- `lyrics` (optional) — triggers an under-the-hood switch to ElevenLabs' `composition_plan` mode (the only API path that accepts lyrics)

**Output**
- MP3 audio attachment, duration controlled by the `duration` option

**Config**
- `ELEVENMUSIC_ENABLED=true`
- `ELEVENLABS_MUSIC_MODEL` (default `music_v1`)
- `ELEVENLABS_DEFAULT_DURATION_SECONDS` (default `90`)
- `ELEVENLABS_PER_CALL_COST_USD` (default `0.10`, placeholder pending verified pricing)
- `ELEVENLABS_API_KEY` (secret)

**Cost tracking**
- Each call recorded through `CostService.recordMediaGen('elevenlabs-music-v1', user)` and surfaced in the bot's cumulative cost log lines. Not surfaced in `/stats` today (same gap as Lyria — needs MongoDB-backed media-gen records, part of Approach B).

**TODO: Approach B refactor (louder now).** `ImagenService` / `VeoService` / `LyriaService` / `ElevenLabsMusicService` duplicate noticeable plumbing. Worth extracting a `MediaGenBase` now that four services share the same shape. See `docs/superpowers/specs/2026-05-15-elevenlabs-music-generation-design.md` ("Approach B").

### Channel Context Tracking
- **Passive Recording**: Opt-in per-channel message tracking (non-blocking)
- **3-Tier Architecture**: Hot (recent messages in memory), warm (batch-indexed to Qdrant), cold (Mem0 memory extraction)
- **Semantic Search**: Vector-based search through channel conversation history
- **Context Injection**: Channel context automatically injected into personality chat system prompts
- **Admin Controls**: `/channeltrack` command for enabling/disabling per channel
- **Configurable Retention**: Adjustable retention period and batch indexing interval
- **Startup Cleanup**: Expired messages purged from Qdrant on bot startup (prevents accumulation across pod restarts)
- **Startup buffer rehydration**: On bot startup, the per-channel hot buffer is repopulated from MongoDB's `channel_messages` collection, so the bot has immediate conversation context after a pod restart instead of waiting for 10+ new messages to arrive.
- **Tunable prompt window**: `CHANNEL_CONTEXT_PROMPT_RECENT_COUNT` controls how many of the buffered messages get injected into the chat prompt's recent-conversation block (independent of the buffer cap `CHANNEL_CONTEXT_RECENT_COUNT`).

### Voice Profile (Channel Voice Personality)
- **Dynamic Style Learning**: Analyzes IRC history (378k+ conversations) and Discord messages to build a communication style profile
- **Stratified Sampling**: Samples across decades to capture style evolution
- **Two-Phase LLM Analysis**: Batch analysis of conversation chunks, then synthesis into unified voice profile
- **Few-Shot Examples**: Injects topically relevant real conversation snippets into prompts for style grounding
- **Periodic Regeneration**: Profile regenerated every 24h (configurable)
- **A/B Logging**: Optional side-by-side comparison logging of styled vs. unstyled responses
- **Default Personality**: Channel Voice becomes the default when enabled, cascading to Uncensored then Friendly

### Agentic Sandbox (channel-voice + run_in_sandbox)
- **ADK Agent Sidecar**: Channel-voice chats route through a Python sidecar that wraps a `google-adk` Agent. The agent has one tool (`run_in_sandbox`) for autonomous code execution.
- **Unified Chat Context**: Both text and voice paths feed the same `system_prompt` (dynamic channel-voice with live profile), `memory_context` (ranked recall), and `history` (recent turns) to the sidecar via a shared `ChatService.buildTurnContext` builder. Sandbox executor does not receive memory/history — context goes to the model turn only.
- **Execution-First Gating**: Sandbox is used only when execution is genuinely required — correct answers to most direct asks come instantly without spawning pods. `TOOL_AVAILABILITY_PREAMBLE` guides the model to invoke `run_in_sandbox` for real network/recon, computing over data it can't derive, or observing real runtime behavior; answering directly is preferred.
- **Ephemeral Kata Pods**: Each `run_in_sandbox` call spawns a fresh K8s Job under the `kata-qemu` RuntimeClass — every sandbox pod gets its own tiny QEMU/KVM guest with 2 vCPU, 2 Gi RAM, 256 Mi tmpfs, 300 s wall-clock. The host kernel never executes the workload's syscalls.
- **Multi-language**: Sandbox base image ships python, node, dotnet, go, rust, ollama plus common build/network tools.
- **Egress Policy**: Public internet open; RFC1918, link-local, CGNAT, cluster pod/service CIDRs and the K8s API are denied at the NetworkPolicy layer. Optional Calico flow-log scraping records denied egress events on each trace.
- **Concurrency Caps**: 2 simultaneous executions per user, 15 cluster-wide; over-limit calls return immediately with a typed reason.
- **Per-Turn Tool Budget**: Configurable cap on `run_in_sandbox` calls per agent turn (default 8) so a single message cannot loop infinitely.
- **Reaction Reveal**: React to a bot reply with 🔍 / 📜 / 🐛 to attach the source code, stdout (+stderr if non-empty), or stderr-only of the latest sandbox call.
- **Trace Storage**: Every execution lands in MongoDB `sandbox_executions` with full code/stdout/stderr/egress events. Retention loop demotes traces older than the most recent N per user (default 50) to a thin audit-only form.
- **Graceful Fallback**: When the sidecar is unhealthy or `AGENT_ENABLED=false`, the bot transparently uses the existing direct-OpenAI path. No restart needed to flip.

### Voice Channel Conversation
- **Live Voice Sessions**: `/voice join` puts the bot in your current voice channel; it listens for a wake phrase ("hey jarvis" by default) and replies out loud via a dedicated Gemini Live session
- **Dedicated Sidecar**: A separate Python gRPC sidecar (`discord-article-bot-voice`, distinct from the agent sandbox sidecar) hosts the Live session per active voice channel — `RollingUpdate` and horizontally scalable, since it holds long-lived real-time audio streams (unlike the agent sidecar's single-replica `Recreate`)
- **Wake Word Gate**: openWakeWord (keyless, offline ONNX models via `onnxruntime-node`) detects the wake phrase locally before any audio is sent to the Live model, keeping ambient conversation private and cutting bandwidth/cost. Four pretrained phrases available: hey jarvis, alexa, hey mycroft, hey rhasspy
- **Neural Voice Activity Detection**: Silero VAD (per-stream, 512-sample / 32 ms windows on `onnxruntime-node`) detects speech, replacing the fixed energy gate. Endpointing is now a correct **Gemini Hybrid VAD**: audio streams continuously so Gemini's server-side VAD sees trailing silence as a fallback, with client-side VAD firing an early `audio_stream_end`
- **Turn Rhythm**: wake → reply → brief "hot" follow-up window (no wake word needed) → idle, with a configurable hard session-length cap as a cost guard
- **Unified Chat Context & In-Voice Memory**: The channel-voice system prompt (dynamic, with live profile substituted) is passed into the Live session, so spoken replies match the same learned communication style as text chat. Ranked recall context (Mem0 + channel semantic + facts) and recent conversation history are available to voice turns via the same shared `ChatService.buildTurnContext` builder used for text; in-voice replies are memory-aware just like text responses.
- **Barge-in / Interruption**: Configurable barge-in support so the bot's own playback can be interrupted by the user speaking
- **Memory In, Transcripts Out**: Recall context feeds into voice turns the same way it does text chat; every voice exchange lands in the MongoDB message store as a transcript, feeding `/tldr` and recall just like text messages
- **Long-Running Sessions**: Sliding-window context compression removes the ~15-minute audio-only session limit, and transparent session resumption reconnects seamlessly when a connection drops or the server sends a pre-disconnect warning
- **Graceful Degradation**: `/voice` reports unavailable if the sidecar is unreachable or `VOICE_ENABLED=false`; no restart needed to flip
- **Multi-User Voice**: Per-speaker wake-word and VAD gates detect each speaker independently in group channels; active-speaker floor control lets the first waker hold the floor while others queue as "waiting" (without audio being sent to the model, preventing crosstalk); voice transcripts are attributed to the floor-holder's real Discord `userId` for proper credit in `/tldr` and recall
- **Deferred**: idle auto-leave, dynamic (non-static) voice-profile injection into the Live system prompt, model identity-awareness so the bot knows in-context who's speaking (Phase 3), session compression/resumption for longer conversations (Plan 2b), and human-like deferral responses acknowledging waiting speakers (Phase 4)

### Monitoring & Observability
- **OpenTelemetry Tracing**: Distributed tracing for Dynatrace
- **OpenLLMetry Integration**: Captures full LLM request/response content in traces via `gen_ai.*` attributes
- **Token Usage Tracking**: Per-user consumption in MongoDB
- **Cost Tracking**: Real-time token and cost breakdown

### Additional Features
- **Reply to Continue**: Reply directly to bot messages to continue conversations naturally
- **Article Follow-up Questions**: Reply to summaries to ask follow-up questions about the article
- **RSS Feed Monitoring**: Auto-post from configured feeds
- **Follow-up Tracker**: Mark stories for updates (📚 reaction)
- **Related Articles**: Suggests similar previously shared articles

### Legacy — Article Summarization & Archiving

#### Core Summarization
- **Reaction-based Summarization**: React with 📰 to trigger summarization
- **Command-based Summarization**: `/summarize <url>` and `/resummarize <url>`
- **Duplicate Detection**: Notifies if article was previously shared
- **Force Re-summarization**: Bypass duplicate check with `/resummarize`

#### Content Analysis
- **Topic Detection**: Automatically tags articles with topics
- **Sentiment Analysis**: Emoji reactions based on article mood
- **Reading Time Estimator**: Calculates estimated reading time
- **Source Credibility**: Star ratings for known sources

#### Linkwarden Integration
- **Self-hosted Archiving**: Archive articles via Linkwarden
- **Paywall Bypass**: Browser extension captures authenticated content
- **Automatic Polling**: Monitors collection for new links
- **Multiple Formats**: Supports readable, monolith, and PDF archives

---

## Backlog / planned

The "planned" section below reflects items that have NOT yet shipped. Anything previously listed here that's now in production has been moved to `done-todos/` (the archived implementation plans) or struck through.

### Architectural follow-ups
- [ ] **Approach B — `MediaGenBase` refactor.** Imagen / Veo / Lyria / ElevenLabs duplicate noticeable plumbing (enabled checks, error shaping, attachment handling, per-call cost override). Lift into a shared base; while at it, hoist a single `CostService` instance to `bot.js` and inject everywhere.
- [ ] **MongoDB-backed media-gen records for `/stats`.** Today `/stats` reads `token_usage` only; media-gen flat-fee rows are surfaced in pod logs but don't appear in the leaderboard. Wire them in.
- [ ] **OpenTelemetry SDK major bump.** `@opentelemetry/auto-instrumentations-node` 0.52.x and `@opentelemetry/sdk-node` 0.56.x carry GHSA-q7rr-3cgh-j5r3 (high, Prometheus crash). Coordinated major bump deferred from CVE PR #76.
- [ ] **`@tootallnate/once` chain.** High-sev via `@google-cloud/storage` → `teeny-request` → `http-proxy-agent@5`. Fixing requires breaking-change library swaps. Deferred.
- [ ] **Slash-command unit tests.** No `__tests__/commands/slash/` pattern exists; commands are smoke-tested manually in Discord. Worth introducing.
- [ ] **Files-to-touch checklist for new secret-backed services.** PR #79 missed `deployment.yaml`'s `valueFrom: secretKeyRef` binding for `ELEVENLABS_API_KEY` and the bot booted with the service disabled. Catch this for the next media-gen plan.
- [ ] **Voice-profile regen-pipeline hardening.** The local prompt-tuning tool at `scripts/prompt-tuning/` ships for offline iteration on `personalities/channel-voice.js`. Pipeline-side improvements (synthesis prompt updates, topic-bleed filter, eval-gated rotation) remain TODO — addressed when we want continuous quality rather than periodic manual tuning.

### Chat / personality
- [ ] **More personality archetypes beyond `channel-voice`.** All other personalities were removed in v2.8.x; reintroducing distinct ones is a backlog item.
- [ ] **Custom personality creation via commands.**

### Digests
- [ ] **Digests channel feature.** Blocked on a dedicated Discord channel being set up; see project memory.

### Reviving deferred plans
- [ ] **Analytics dashboard.** The full plan lives at `docs/analytics-dashboard-plan.md` (the only `*-plan.md` doc not moved to `done-todos/`). Nothing in the codebase implements it today.

---

## Shipped (cross-reference)

For the full history of completed initiatives — including the implementation plans and design specs that drove each one — see `done-todos/`:

- `done-todos/LINKWARDEN_INTEGRATION_PLAN.md` — Linkwarden integration
- `done-todos/VEO_IMPLEMENTATION_PLAN.md` — Veo video generation
- `done-todos/chat_memory_todos.md` — channel-scoped chat memory
- `done-todos/mem0-memory-integration-plan.md` — long-term memory via mem0
- `done-todos/mem0-hybrid-local-llm.md` — hybrid Ollama + OpenAI mem0 config
- `done-todos/irc-vectordb-ingestion-plan.md` — IRC log → Qdrant pipeline
- `done-todos/2026-04-28-agentic-sandbox-skills-runtime-design.md` — agentic sandbox spec
- `done-todos/2026-04-28-agentic-sandbox-skills-runtime.md` — agentic sandbox plan
- `done-todos/2026-05-15-lyria-music-generation-design.md` — Lyria spec
- `done-todos/2026-05-15-lyria-music-generation.md` — Lyria plan
- `done-todos/2026-05-15-elevenlabs-music-generation-design.md` — ElevenLabs spec
- `done-todos/2026-05-15-elevenlabs-music-generation.md` — ElevenLabs plan
