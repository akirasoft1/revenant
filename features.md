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
- **AI Video Generation**: Generate videos using Google's Veo 3.1 (Vertex, via `@google/genai` in Vertex mode); safety-filtered results now tell the user why
- **Text-to-Video Mode**: Generate video from text descriptions alone
- **Single Image Mode**: Animate a single image into a video (image-to-video)
- **Two Image Mode**: Provide first and last frame images for smooth transitions
- **Duration Options**: 4, 6, or 8 second videos
- **Aspect Ratios**: 16:9 (landscape) or 9:16 (portrait)
- **Discord Emoji Support**: Use Discord emojis as source images
- **Progress Updates**: Real-time status updates during generation
- **Usage Tracking**: All generations tracked in MongoDB

### Music Generation (`/musicgen`)
- **Lyria 3.5 Generation**: Generate music using Google's Lyria 3.5 (`lyria-3.5`)
- **Text Prompts**: Describe the music in natural language
- **Lyrics Support**: Provide lyrics with `[Verse]`, `[Chorus]`, `[Bridge]` tags for structured composition
- **Negative Prompts**: Specify what to avoid (e.g., "no vocals"). Composed into the prompt text since Lyria has no structured negative_prompt API field.
- **Visual Inspiration**: Up to 3 reference images to guide the generation style
- **MP3 Output**: Multi-minute audio attachments with duration controllable through the prompt
- **Lyrics Rendering**: Generated lyrics and structure displayed in an embed when provided by the model
- **Usage Tracking**: All generations recorded in MongoDB via CostService
- **Configuration**: `MUSICGEN_ENABLED=true`, `LYRIA_MODEL` (default `lyria-3.5`), `LYRIA_PER_CALL_COST_USD` (default `0.08`, Google's published per-song price)

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
- **Continuity Across Entry Points**: `@mention`, Discord replies and `/chat` all record both the user's message and the bot's reply into the shared history, so a follow-up (including a reply to a `/chat` answer) sees the earlier exchange. Replying to a bot message always tells the model exactly which message you replied to (quoted on your turn), whether it's still in the recent-history window or has scrolled out — so "are they unique?" resolves to the message you replied to, not whatever topic came up most recently.
- **Execution-First Gating**: Sandbox is used only when execution is genuinely required — correct answers to most direct asks come instantly without spawning pods. `TOOL_AVAILABILITY_PREAMBLE` guides the model to invoke `run_in_sandbox` for real network/recon, computing over data it can't derive, or observing real runtime behavior; answering directly is preferred.
- **Native Web Search**: When `AGENT_WEB_SEARCH_ENABLED` (default on) and the agent is running a Gemini-native model, ADK's `google_search` built-in is attached alongside `run_in_sandbox` for current/external facts (news, patch notes, what a web page says) — the sandbox stays reserved for actually executing or probing something, not for scraping the web. Search usage is tracked per turn (`web_search.queries` on the `agent.chat` span).
- **Ephemeral Kata Pods**: Each `run_in_sandbox` call spawns a fresh K8s Job under the `kata-qemu` RuntimeClass — every sandbox pod gets its own tiny QEMU/KVM guest with 2 vCPU, 2 Gi RAM, 256 Mi tmpfs, 300 s wall-clock. The host kernel never executes the workload's syscalls.
- **Multi-language**: Sandbox base image ships python, node, dotnet, go, rust, ollama plus common build/network tools.
- **Egress Policy**: Public internet open; RFC1918, link-local, CGNAT, cluster pod/service CIDRs and the K8s API are denied at the NetworkPolicy layer. Optional Calico flow-log scraping records denied egress events on each trace.
- **Concurrency Caps**: 2 simultaneous executions per user, 15 cluster-wide; over-limit calls return immediately with a typed reason.
- **Per-Turn Tool Budget**: Configurable cap on `run_in_sandbox` calls per agent turn (default 8) so a single message cannot loop infinitely.
- **Reaction Reveal**: React to a bot reply with 🔍 / 📜 / 🐛 to attach the source code, stdout (+stderr if non-empty), or stderr-only of the latest sandbox call.
- **Trace Storage**: Every execution lands in MongoDB `sandbox_executions` with full code/stdout/stderr/egress events. Retention loop demotes traces older than the most recent N per user (default 50) to a thin audit-only form.
- **Graceful Fallback**: When the sidecar is unhealthy or `AGENT_ENABLED=false`, the bot uses the existing direct-OpenAI path. No restart needed to flip.
- **Honest Health**: The sidecar's `Health` RPC reports whether `Chat` is actually working, not merely whether the gRPC port is open — a consecutive-failure circuit breaker (default 3) trips it, and after a cooldown (default 60s) it reports healthy again to admit one trial call, so a recovered backend re-enables the agent path without a restart.
- **Visible Degradation**: A fallback is announced rather than silent, on every chat surface (mention chat, `/chat`, `/chatthread`). Falling through to direct OpenAI names the model that answered instead, an agent turn that came back empty says so rather than claiming the agent was unavailable, and a turn that ran without the channel-voice personality or memory context says that too — in the reply and in the logs. When both the agent and the direct path fail, the error names both.

### Star Citizen knowledge (text + voice)
- **Live Game Data**: A dedicated `sc-knowledge` MCP service backs both channel-voice text chat and voice sessions with live Star Citizen data instead of stale parametric knowledge — items/components and shop prices, ship/vehicle purchase locations and prices, faction reputation/mission info, profitable trade routes, commodity prices, what a location's shops sell (and what's unique to it), and search over the org's own curated guides.
- **Example questions**: "Where can we purchase a V801-12 radar?", "What is the most powerful Size 2 shield generator?", "What is an optimal way to grind Foxwell Enforcement reputation?", "What are some currently profitable trade routes from MIC-L5?", "Are there any ship parts or FPS gear that are only sold at Levski?"
- **Uncovered Questions Go To Search, Not Memory**: When a Star Citizen question falls outside every `sc_*` tool (vehicle loadouts, crafting, lore, patch news), the text agent falls back to live `google_search` (labelled as web-sourced) before ever answering from its own training data, and is instructed to never assert from memory that something is vaulted, removed, not in the game, or relocated — tool and search results always win over memory.
- **Defers to What You're Seeing In-Game**: For game mechanics no tool covers (flight modes, quantum travel, ship systems), the bot searches the web instead of relying on memory — and if you dispute its answer or describe what you're seeing in-game right now, it searches again, and if it still can't confirm, it goes with your observation instead of arguing (text and voice).
- **Works in Voice Too**: The same tools are available as Gemini Live function calls during a live voice conversation, so you can ask Star Citizen questions out loud and get an answer sourced from current game data.
- **Graceful Degradation**: If the knowledge service is unreachable, chat and voice turns continue normally without the tools (no error, no dropped turn) — controlled independently per sidecar by `SC_KNOWLEDGE_ENABLED`.

### Member hangar (per-member ship loadouts)
- **Your ships, your loadouts**: each member's Star Citizen ships (with optional nicknames) and what is fitted in every component slot — stock, or changed from stock — are stored in `hangar-service` (FastAPI + Firestore on Cloud Run); component slots come from the Star Citizen Wiki
- **Ask about them in chat or voice**: "what's a purchasable upgraded shield for my Harbinger?" (finds your current shield, then ranks better ones of that size that shops sell right now — `sc_compare_components(purchasable_only=True)`), "I just looted a Hemera quantum drive, is it a usable upgrade for any of my ships?" (per-ship, per-slot `upgrade`/`downgrade`/`sidegrade`/`same` verdicts, plus which ships can't take it and why), "can Micro use it?" (someone else's ships), "what's on my Connie?" (nicknames and shorthand like "Connie" resolve)
- **Only when asked**: ship data is fetched by tool only for questions about a member's own ships — never injected into prompts or mentioned unprompted; "my" means whoever is speaking, other members resolve via the identity roster
- **`/hangar`**: `list [member]`, `add ship [nickname] [member]` (catalog autocomplete), `rename ship nickname [member]`, `remove ship [member]` — ephemeral; anyone can list anyone's hangar, edits are self-only unless you're a bot admin
- **Graceful degradation**: a hangar outage returns "unavailable" to the model (the turn continues) and "Hangar service is unavailable right now." to `/hangar`
- **Limitations / planned**: no loadout editing yet (slot changes exist in the API; a web loadout editor and chat edits like "I put the Hemera in my Connie" are the next two projects); missiles aren't tracked; no loose inventory (items in storage); no org-wide queries ("who has a ship that fits a size-2 quantum drive?"); optional spviewer import into the editor

### Member Identity (who said what)
- **Registry**: Mongo `member_identities` holds each member's preferred address name and aliases, cached in memory (3s startup retry, 60s refresh, serialised writes); it is the first layer of `SpeakerNames` resolution, so chat, recall, `/tldr` and voice `[SPEAKER:]` markers all use it
- **`/whois`**: `show`, `address`, `alias-add`, `alias-remove` (ephemeral); anyone edits themselves, admins edit anyone; names validated (letters required, 2+ characters, longer names shortened to 24, no 15+ digit runs, max 10 aliases) and unique across members
- **Speaker labels**: history and the current turn are labelled `[Name · discordId]: …` so first-person messages are attributed to the right person; bot turns stay unlabelled
- **Roster**: a `## People in this conversation` block (current speaker first, participants plus members mentioned by name or alias, cap 20) maps names and aliases to Discord IDs; works for text and voice (voice limitation: mid-session newcomers are not in the roster)
- **Seeding**: `scripts/seed-member-identities.js` seeds address names from `VOICE_SPEAKER_NAMES` (dry run by default, never overwrites)

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
- **Search Visibility**: Each voice turn logs how many Google Search queries grounded it (and the full queries), with per-session totals on the session END log line and span — so "did it actually look that up?" is answerable from logs, not guessed from citation markers
- **Graceful Degradation**: `/voice` reports unavailable if the sidecar is unreachable or `VOICE_ENABLED=false`; no restart needed to flip
- **Multi-User Voice**: Per-speaker wake-word and VAD gates detect each speaker independently in group channels; active-speaker floor control lets the first waker hold the floor while others queue as "waiting" (without audio being sent to the model, preventing crosstalk); voice transcripts are attributed to the floor-holder's real Discord `userId` for proper credit in `/tldr` and recall
- **Speaker Identity & Preferred Names**: The bot knows who is speaking in voice channels and addresses people by their preferred names via in-context markers; name resolution uses overridable entries (global name, guild nickname, username); preferred names also appear in text chat and memory recall so friends aren't attributed as `inc1067`
- **Human-Like Turn Deferral**: If someone tries to talk while the bot is mid-reply to another speaker, the bot notices and, once it's done talking, acknowledges them by name before handing the floor over — instead of silently ignoring them (behind a flag, off by default pending real-world tuning)
- **Voice Control Commands**: Say "thanks jarvis, that's all" to end a conversation (after the bot's short spoken confirmation), or "go quiet for ten minutes" to end it AND have the bot ignore the wake word from everyone in the channel until the deadline (1–120 min, defaults to 15). Detected two ways — a Gemini Live function tool the model can call, and a bot-side phrase backstop that works even without model cooperation — either is enough, and repeated/combined commands are handled idempotently (e.g. "quiet" upgrades a pending "end"). Commands must start what you say (after at most a wake phrase, "please", "thanks", or "can you"), so ordinary sentences like "how do I mute" or "don't end the conversation yet" don't trigger them. The bot waits for its spoken confirmation to be generated and finish playing before acting, with a 10-second safety ceiling — if playback is still running at that point, it can be cut short. `/voice resume` ends quiet mode early
- **Deferred**: idle auto-leave, dynamic (non-static) voice-profile injection into the Live system prompt, session compression/resumption for longer conversations (Plan 2b), and self-service speaker names via `/voice name` command so users set their own preferred spoken names (Phase 4)

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

### Member hangar follow-ups
- [ ] **Web loadout editor** (project 2): Discord-OAuth browser editor on hangar-service for bulk-seeding loadouts; needs a public-access approach other than Cloud Run invoker IAM.
- [ ] **Chat edits** (project 3): "I put the Hemera in my Connie" records the change via the existing slot `PUT`.
- [ ] **Loose inventory**, **org-wide queries**, **spviewer import** (from a member's own exported `SCSPVDatabase`/`vehiclesLoadout` rows).

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
