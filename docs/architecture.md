# Architecture

This document is the canonical overview of how the Discord Article Bot is structured. It covers both the runtime software architecture (how Node.js services, the Python agent sidecar, and Discord interact) and the Kubernetes deployment topology (pods, NetworkPolicy egress, secrets, the Kata sandbox runtime).

The diagrams below are Mermaid; they render on GitHub, in most Markdown viewers, and in VS Code with a Mermaid preview extension.

For per-feature documentation see [features.md](../features.md). For deployment commands and operational runbook details see [kubernetes.md](../kubernetes.md) and [k8s/sandbox/README.md](../k8s/sandbox/README.md).

---

## Software architecture

The bot is a single Node.js process (`bot.js`) that orchestrates ~27 services, ~22 slash commands, and 4 event handlers. Optional features (mem0, qdrant, channel context, voice profile, the agent sidecar, each media-gen provider) are guarded behind config flags and skipped cleanly when disabled. All external state lives in three databases.

```mermaid
flowchart LR
    Discord[Discord Gateway / REST]

    subgraph BotProcess[bot.js process]
        direction TB
        Tracing[tracing.js<br/>OpenTelemetry + OpenLLMetry<br/>loaded first]

        subgraph Handlers
            SlashH[SlashCommandHandler]
            ReplyH[ReplyHandler]
            ReactionH[ReactionHandler]
            ImageRetryH[ImageRetryHandler]
        end

        subgraph Chat[Chat surface]
            ChatService
            ChannelContextService
            VoiceProfileService
            Mem0Service
            AgentClient
        end

        subgraph Summarize[Summarization pipeline]
            SummarizationService
            RssService
            LinkwardenPollingService
            FollowUpService
            MessageService
            SourceCredibilityService
        end

        subgraph MediaGen[Media generation]
            ImagenService
            VeoService
            LyriaService
            ElevenLabsMusicService
            ImagePromptAnalyzerService
            CostService[(CostService<br/>per-consumer instance)]
        end

        subgraph SearchAndMemory[Search & memory]
            QdrantService
            VoiceSearchService
            NickMappingService
            CatchMeUpService
            SandboxTraceService
        end

        subgraph RecallV2[Recall v2 - RECALL_V2_ENABLED]
            RecallService
            subgraph RecallModules[services/recall/]
                Adapters[adapters.js<br/>per-source fetch]
                Ranking[ranking.js<br/>recency/importance decay]
                QueryBuilder[queryBuilder.js]
                EvalMetrics[evalMetrics.js]
            end
        end

        MongoService
        TokenService
        LocalLlmService
    end

    subgraph Sidecar[discord-article-bot-agent pod]
        ADK[Python ADK Agent<br/>Gemini 3 Flash default]
        Tool[run_in_sandbox tool]
        Orchestrator[SandboxOrchestrator<br/>k8s_client.py]
    end

    subgraph KataPods[Ephemeral Kata sandbox Jobs]
        SandboxPod[per-call QEMU/KVM guest<br/>runtimeClassName: kata-qemu-runtime-rs<br/>mvilliger/sandbox-base]
    end

    subgraph DataStores[Data stores]
        Mongo[(MongoDB<br/>articles, messages, voice_profiles,<br/>sandbox_executions, token_usage,<br/>recall_ledger, recall_comparisons)]
        Qdrant[(Qdrant<br/>irc_history, channel_conversations,<br/>discord_memories)]
        PG[(Postgres + pgvector<br/>mem0 internal store)]
    end

    subgraph Cloud[External APIs]
        OpenAI[OpenAI API<br/>chat, embeddings]
        Gemini[Google Gemini<br/>image gen]
        Vertex[Google Vertex AI<br/>Veo video gen]
        GCS[(Google Cloud Storage<br/>Veo output)]
        LyriaAPI[Google Lyria<br/>music_v1]
        ElevenLabs[ElevenLabs API<br/>music_v1]
        Linkwarden[Linkwarden<br/>self-hosted]
        Ollama[Ollama<br/>home network 192.168.1.164]
        DT[Dynatrace OTLP<br/>:4318]
    end

    Discord -->|interactions, messages| Handlers
    SlashH --> ChatService
    SlashH --> SummarizationService
    SlashH --> MediaGen
    SlashH --> SearchAndMemory
    ReplyH --> ChatService
    ReplyH --> SummarizationService
    ReactionH --> SandboxTraceService
    ReactionH --> ImageRetryH

    ChatService --> ChannelContextService
    ChatService --> VoiceProfileService
    ChatService --> Mem0Service
    ChatService --> AgentClient
    ChatService --> OpenAI
    ChatService --> QdrantService
    ChatService -.RECALL_V2_ENABLED.-> RecallService
    RecallService --> Adapters
    Adapters --> Mem0Service
    Adapters --> QdrantService
    Adapters --> Mongo
    RecallService --> Ranking
    RecallService --> QueryBuilder

    AgentClient -.gRPC :50051.-> ADK
    ADK --> Tool
    Tool --> Orchestrator
    Orchestrator -.K8s API.-> KataPods
    KataPods --> Cloud
    Orchestrator -.trace doc.-> Mongo

    SummarizationService --> OpenAI
    SummarizationService --> MessageService
    SummarizationService --> SourceCredibilityService
    SummarizationService --> Mongo
    RssService --> SummarizationService
    LinkwardenPollingService --> Linkwarden
    LinkwardenPollingService --> SummarizationService
    FollowUpService --> SummarizationService

    ImagenService --> Gemini
    ImagenService --> Mongo
    VeoService --> Vertex
    VeoService --> GCS
    LyriaService --> LyriaAPI
    LyriaService --> CostService
    ElevenLabsMusicService --> ElevenLabs
    ElevenLabsMusicService --> CostService

    Mem0Service --> Qdrant
    Mem0Service --> PG
    Mem0Service --> OpenAI
    QdrantService --> Qdrant
    QdrantService --> OpenAI
    ChannelContextService --> Qdrant
    ChannelContextService --> Mongo
    ChannelContextService --> Mem0Service
    VoiceProfileService --> QdrantService
    VoiceProfileService --> ChannelContextService
    VoiceProfileService --> Mongo

    VoiceSearchService --> QdrantService
    VoiceSearchService --> VoiceProfileService
    CatchMeUpService --> Mongo
    CatchMeUpService --> VoiceProfileService

    LocalLlmService -.optional fallback.-> Ollama

    Tracing -.OTLP HTTP.-> DT
    BotProcess --> Discord

    classDef store fill:#fef3c7,stroke:#92400e
    class Mongo,Qdrant,PG,GCS,CostService store
    classDef external fill:#dbeafe,stroke:#1e3a8a
    class OpenAI,Gemini,Vertex,LyriaAPI,ElevenLabs,Linkwarden,Ollama,DT external
    classDef sandbox fill:#fee2e2,stroke:#991b1b
    class SandboxPod,Orchestrator sandbox
    classDef recall fill:#f0fdf4,stroke:#166534
    class RecallService,Adapters,Ranking,QueryBuilder,EvalMetrics recall
```

### Software-flow notes

- **`tracing.js` is required at `bot.js:4` before all other modules.** It wires OpenTelemetry's `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node` + `@traceloop/instrumentation-openai` so every LLM call captures full prompt/completion content as span attributes.
- **`channel-voice` is the only personality.** All chat traffic flows through `ChatService.processChatMessage()`, which optionally:
  - prepends channel-context (recent messages in this channel)
  - applies the voice profile (group communication style learned from IRC + Discord history)
  - injects 3-way mem0 memories (per-user, per-channel-shared, personality-scoped)
  - routes through `AgentClient` (gRPC to the Python sidecar) when `AGENT_ENABLED=true` and the sidecar is healthy, falling through to direct OpenAI when not
- **Centralized ranked recall (v2) — flag-gated via `RECALL_V2_ENABLED`.** When enabled, `ChatService` delegates memory retrieval to `RecallService` instead of its legacy scattered calls. The pipeline is:
  1. **Build query** — `services/recall/queryBuilder.js` derives a semantic query string from the recent conversation.
  2. **Over-retrieve from five sources** — per-source adapters in `services/recall/adapters.js` fan out to: Mem0 personal memories, Mem0 explicit memories, Mem0 shared/channel memories, Qdrant channel semantic hits (`ChannelContextService`), and Qdrant channel facts.
  3. **Exclude / dedupe** — results that appear verbatim in the recent conversation buffer are dropped; duplicates across sources are collapsed.
  4. **Ledger-enrich** — each candidate is looked up in the `recall_ledger` MongoDB collection (lazily upserted on first access) to pull `importanceScore`, `accessCount`, and `lastAccess`. The ledger is pruned daily.
  5. **Rank / decay** — `services/recall/ranking.js` applies a 14-day half-life recency decay combined with the ledger importance + access-count signals; results are sorted descending and truncated to a token/item budget.
  6. **Single injection** — the ranked set is injected as one provenance-tagged `## Memory Context` block in the system prompt.
  - **Legacy fallback**: when `RECALL_V2_ENABLED=false` (default) or when `RecallService` is not wired in, `ChatService` follows the original scattered recall path unchanged.
  - **Shadow mode**: `RECALL_SHADOW_ENABLED=true` runs both pipelines and logs a comparison doc to the `recall_comparisons` MongoDB collection without changing what the model sees. `RECALL_SHADOW_INJECT` promotes the v2 block into the prompt even in shadow mode.
  - **Buffer and few-shot stay separate**: the recent-conversation rolling buffer and voice-profile few-shot examples are assembled outside `RecallService` and are not ranked/decayed.
  - **Offline eval**: `scripts/eval-recall.js` + `services/recall/evalMetrics.js` provide a harness for offline quality measurement.
- **Each media-gen service owns its own `CostService` instance.** Per-call costs are surfaced in pod log lines; the `/stats` Discord command reads MongoDB's `token_usage` collection and does not yet surface media-gen rows (see Approach B in `features.md`).
- **Slash commands take services as constructor args** so the same service can be invoked from `bot.js` boot wiring (real services) or from `scripts/registerCommands.js` (passes `null` because it only needs the schema).
- **`SandboxTraceService`** is a read-side companion to the agent sidecar's write path. The agent writes a doc into MongoDB `sandbox_executions` per `run_in_sandbox` call; `ReactionHandler` watches for 🔍 / 📜 / 🐛 reactions on bot replies and asks `SandboxTraceService` for the corresponding artifact.

### When you toggle features

| Flag | Disabling means |
|---|---|
| `AGENT_ENABLED=false` | Channel-voice chats route directly to OpenAI; `run_in_sandbox` is unavailable. The bot does not need the sidecar pod running. |
| `MEM0_ENABLED=false` | No long-term memory; the bot still chats but won't remember anything across sessions. |
| `QDRANT_IRC_ENABLED=false` | `/recall`, `/history`, `/throwback`, voice-informed search, voice profile sampling all go offline. Bot still runs. |
| `CHANNEL_CONTEXT_ENABLED=false` | No passive channel awareness; chats only see their own conversation history. |
| `IMAGEGEN_ENABLED`, `VEO_ENABLED`, `MUSICGEN_ENABLED`, `ELEVENMUSIC_ENABLED` | Each unhooks one slash command and one service. |
| `LINKWARDEN_ENABLED=false` | No article-archive polling; `/summarize` still works with direct URL fetches. |
| `RSS_FEEDS_ENABLED=false` | No automated feed posting. |
| `LOCAL_LLM_ENABLED=false` | No Ollama fallback; cloud-only. |
| `RECALL_V2_ENABLED=false` | ChatService uses the legacy scattered recall path; `RecallService` and the `recall_ledger` are dormant. Shadow logging of old-vs-new blocks is still available independently via `RECALL_SHADOW_ENABLED=true` (logs to `recall_comparisons`; does not change what the model sees unless `RECALL_SHADOW_INJECT=true`). |

---

## Deployment architecture

Everything lives in the `discord-article-bot` Kubernetes namespace. The single bot pod, the single agent sidecar pod, ephemeral Kata sandbox Jobs, and three infrastructure pods (MongoDB, Qdrant, Postgres) make up the namespace footprint at steady state.

```mermaid
flowchart TB
    External[Internet]
    Ollama2[Ollama @ 192.168.1.164<br/>home network]

    subgraph Cluster[Kubernetes cluster - Harvester / RKE2]
        subgraph DTNS[dynatrace namespace]
            DTIngest[telemetry-ingest svc<br/>OTLP :4318]
        end

        subgraph LWNS[linkwarden namespace]
            LW[Linkwarden :3000]
        end

        subgraph NS[namespace: discord-article-bot]
            direction TB

            subgraph BotPod[discord-article-bot Deployment - 1 replica - Recreate]
                Bot[mvilliger/discord-article-bot]
                BotSA[ServiceAccount: discord-article-bot]
                BotSvc[Service :8080 - health]
            end

            subgraph AgentPod[discord-article-bot-agent Deployment - 1 replica - Recreate]
                Agent[mvilliger/discord-article-bot-agent]
                AgentSA[ServiceAccount: agent-sa<br/>Role: agent-sandbox-orchestrator<br/>create/get/list/delete Jobs+Pods]
                AgentSvc[Service :50051 - gRPC]
            end

            subgraph SBPods[Ephemeral sandbox Jobs - per call]
                Sandbox[mvilliger/sandbox-base<br/>runtimeClassName: kata-qemu-runtime-rs<br/>2 vCPU / 2 Gi RAM / 256 Mi tmpfs<br/>300s wall clock]
                SBSA[ServiceAccount: sandbox-sa<br/>no token mount]
            end

            subgraph Infra[Stateful infra]
                Mongo2[(MongoDB :27017<br/>mongo:6.0)]
                Qdrant2[(Qdrant :6333 / :6334<br/>qdrant/qdrant:v1.12.4)]
                PG2[(postgres-mem0 :5432<br/>pgvector/pgvector:pg16)]
            end

            CM[ConfigMap<br/>discord-article-bot-config]
            CMS[ConfigMap<br/>sandbox-config]
            CMP[ConfigMap<br/>discord-article-bot-prompt]
            Sec[Secret<br/>discord-article-bot-secrets<br/>DISCORD_TOKEN, OPENAI_API_KEY,<br/>GEMINI_API_KEY, ELEVENLABS_API_KEY,<br/>MONGO_PASSWORD, service-account JSON]
            NP[NetworkPolicy<br/>discord-article-bot - bot]
            ANP[NetworkPolicy<br/>agent-egress - sidecar]
            SNP[NetworkPolicy<br/>sandbox-egress - per-call pod]
        end
    end

    BotPod -->|envFrom| CM
    BotPod -->|env| Sec
    BotPod -->|env| CMS
    BotPod -->|file mount| CMP
    BotPod -->|file mount /var/secrets/google| Sec
    AgentPod -->|envFrom| CMS
    AgentPod -->|env| Sec
    NP -.policy.-> BotPod
    ANP -.policy.-> AgentPod
    SNP -.policy.-> SBPods

    BotPod -.gRPC :50051.-> AgentPod
    AgentPod -.K8s API.-> SBPods
    SBPods -.public internet only.-> External
    BotPod --> Mongo2
    BotPod --> Qdrant2
    AgentPod --> Mongo2
    AgentPod --> Qdrant2
    PG2 -.used internally by.-> Mongo2

    BotPod -->|OTLP HTTP| DTIngest
    BotPod -->|API :3000| LW
    BotPod -.optional.-> Ollama2
    BotPod -->|gateway / REST 443| External
    AgentPod -->|443| External

    classDef pod fill:#dcfce7,stroke:#166534
    class Bot,Agent,Sandbox pod
    classDef store fill:#fef3c7,stroke:#92400e
    class Mongo2,Qdrant2,PG2 store
    classDef policy fill:#fee2e2,stroke:#991b1b
    class NP,ANP,SNP policy
    classDef cfg fill:#e0e7ff,stroke:#3730a3
    class CM,CMS,CMP,Sec cfg
```

### Deployment notes

- **Image lockstep.** Every deploy pins image tags to git short-SHAs (project rule: no `:latest`). The agent sidecar image (`discord-article-bot-agent`) and the sandbox base image (`sandbox-base`) move in lockstep — both must be rebuilt and bumped together when either changes.
- **`k8s/overlays/deployed/` is gitignored.** It's the live source-of-truth for what's running. Tracked manifests live in `k8s/sandbox/` (agent + sandbox parts) — see [`k8s/sandbox/README.md`](../k8s/sandbox/README.md) for the Kata install play-by-play.
- **Sandbox isolation is Kata, not gVisor.** Originally specified as gVisor; switched to `kata-qemu-runtime-rs` (Kata's Rust runtime, statically linked) on 2026-04-29 because Harvester's immutable SLE Micro OS makes `runsc` installation impractical, and KubeVirt-on-bare-metal is the platform's native model. Each `run_in_sandbox` call spawns a Kubernetes Job whose pod boots a tiny QEMU/KVM guest, runs the workload, and is torn down. Cold start: ~1.5–3s per call.
- **Sandbox pods carry `dynatrace.com/inject: "false"`.** Without this annotation, OneAgent injection holds PID 1 and ballooned wall-clock-per-execution to ~120s. The annotation is in the sandbox Job template.
- **NetworkPolicy egress posture.**
  - **Bot pod**: DNS, MongoDB:27017, Qdrant:6333/6334, agent sidecar:50051, Dynatrace OTLP:4317/4318, Linkwarden:3000, Ollama @ `192.168.1.164:11434`, public internet 80/443 (with RFC1918 explicitly denied)
  - **Agent sidecar**: DNS, MongoDB, Qdrant, K8s API server (`10.53.0.1` ClusterIP and control-plane IPs on 443/6443), public internet :443 (RFC1918 denied)
  - **Sandbox pods**: DNS + public internet :80/:443 only — every RFC1918 range is denied, including the cluster's own pod CIDR (`10.52/16`), service CIDR (`10.53/16`), the host network, and the K8s API itself
- **Single-replica `Recreate` strategy** on both the bot and the agent sidecar. The bot's conversation state and the sidecar's concurrency limits are in-process — do not scale either to >1 replica.

---

## Open architectural follow-ups

These are flagged in `features.md` and across the now-archived superpowers specs (`done-todos/2026-05-15-*.md`). The biggest is **Approach B**, which has been deferred through three feature ships and is now the standing follow-up.

- **Approach B — `MediaGenBase` refactor.** `ImagenService`, `VeoService`, `LyriaService`, and `ElevenLabsMusicService` duplicate noticeable plumbing (enabled checks, error shaping, attachment handling, per-call cost override). Lift the common bits into a base class. While doing this, hoist a single `CostService` instance into `bot.js` and inject it into every consumer (today each media-gen service constructs its own), so cumulative cost figures are unified.
- **MongoDB-backed media-gen records for `/stats`.** Today `/stats` reads `token_usage` and does not include flat-fee media-gen rows. Wire media-gen records into MongoDB so they appear in `/stats` alongside token costs.
- **OpenTelemetry SDK major bump.** `@opentelemetry/auto-instrumentations-node` (0.52.x) and `@opentelemetry/sdk-node` (0.56.x) have a high-severity advisory (GHSA-q7rr-3cgh-j5r3) that requires a coordinated major bump. Deferred from PR #76.
- **`@tootallnate/once` chain.** Pulled by `@google-cloud/storage` → `teeny-request` → `http-proxy-agent@5`. Fixing requires either an override that breaks `http-proxy-agent@5`'s peer range or downgrading `@google-cloud/storage` 7.x → 5.x. Deferred from PR #76.
- **Slash-command unit tests.** No existing pattern under `__tests__/commands/slash/`. Slash commands are smoke-tested manually in Discord today.
- **MediaGen integration checklist.** PR #79 hit a deploy trap: `secret.yaml` got the new key but `deployment.yaml` was missing the `valueFrom: secretKeyRef` binding needed to expose the env var to the pod. Adding a "files to touch when adding a new secret-backed service" checklist to the implementer notes for the next media-gen plan would catch this.
- **Voice-profile regen-pipeline hardening.** The local prompt-tuning tool at `scripts/prompt-tuning/` (see [`scripts/prompt-tuning/README.md`](../scripts/prompt-tuning/README.md)) lets you iterate on the `personalities/channel-voice.js` template offline and commit when satisfied. The longer-term regen-pipeline improvements (synthesis prompt tightening, topic-bleed filter on the auto-generated voice profile, eval-gated rotation) are still outstanding — addressed when we want continuous quality rather than periodic manual tuning.
- **Qdrant index startup catch-up (remaining).** In-memory buffer rehydration from MongoDB now ships (see `services/ChannelContextService._rehydrateBufferFromMongoDB`), but the Qdrant semantic index is still vulnerable to unclean shutdowns dropping up to 5 minutes of messages (`CHANNEL_CONTEXT_BATCH_INTERVAL` minutes). A startup catch-up that pulls `channel_messages` newer than the latest Qdrant point per channel and batch-indexes them would close this gap.
