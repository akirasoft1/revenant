# ADK Agent OpenTelemetry Tracing → Dynatrace

**Date:** 2026-06-04
**Status:** Approved (design)
**Component:** `agent-sidecar` (Python ADK agent)

## Goal

Export the ADK agent sidecar's LLM and tool activity as OpenTelemetry `gen_ai`
spans to Dynatrace, so a chat turn's reasoning loop (agent → model calls →
sandbox tool calls) is visible in Grail. Today the agent is a Dynatrace blind
spot: the bot exports spans, but the sidecar's gemini calls and `run_in_sandbox`
calls exist only in logs. This blind spot is what made the 2026-06-03 "hammering
loop" investigation impossible to do from observability (we could see the bot's
`Agent/Chat` gRPC span hit 263s, but not the ~10 internal model calls or why).

## Approach: native ADK tracing (no instrumentation library)

ADK ≥1.17 (we run 1.31.1) has **built-in** OTel instrumentation: `google.adk`
emits an agent-run root span with child `call_llm` spans and child tool-execution
spans, under OTel GenAI semantic conventions, via its module tracer
(`google.adk.telemetry.tracer`) bound to the global `TracerProvider`. These
spans are created today but **dropped**, because the agent's `tracing.py` never
attaches an exporter (the agent deployment sets no OTLP endpoint env).

The fix is therefore wiring, not instrumentation: attach an OTLP exporter to the
global provider and point the agent at the same in-cluster Dynatrace collector
the bot already uses. No Traceloop / OpenInference dependency.

(Considered and rejected: **Traceloop OpenLLMetry** — the Dynatrace example's
path, but LLM-focused, replaces the tracer provider, heavier dep, and our env
uses an in-cluster collector not direct-to-tenant; **OpenInference ADK
instrumentor** — a third-party dep doing what ADK now does natively.)

## Data flow

```
ADK agent run (root span)
  └─ call_llm span (gemini-3.5-flash)        ← N of these in a loop
  └─ tool span (run_in_sandbox)              ← child of a call_llm
        ↓ global TracerProvider
   BatchSpanProcessor → OTLP/HTTP exporter
        ↓
   telemetry-ingest.dynatrace.svc.cluster.local:4318  (in-cluster DT collector)
        ↓
   Dynatrace Grail   (service.name = discord-article-bot-agent)
```

## Changes (≈5 files)

1. **`agent-sidecar/src/tracing.py`** — when `config.otlp_endpoint` is set,
   attach `BatchSpanProcessor(OTLPSpanExporter)` to the global provider and set
   it via `trace.set_tracer_provider`. Switch the exporter from gRPC to
   **HTTP/protobuf (port 4318)** to mirror the bot exactly (the bot proves this
   path). Set `service.name` from `OTEL_SERVICE_NAME` (default
   `discord-article-bot-agent`). Keep the no-op-when-unset behavior. Wrap setup
   so a tracing misconfiguration can never crash agent startup. `config.py`
   already reads `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` —
   no config change needed.

2. **`k8s/overlays/deployed/agent-deployment.yaml`** + **`k8s/sandbox/agent-deployment.yaml`** (tracked template) — add env:
   - `OTEL_SERVICE_NAME: "discord-article-bot-agent"`
   - `OTEL_EXPORTER_OTLP_ENDPOINT: "http://telemetry-ingest.dynatrace.svc.cluster.local:4318"`

3. **`k8s/overlays/deployed/agent-networkpolicy.yaml`** + tracked template —
   add an egress rule to the `dynatrace` namespace on TCP 4317/4318, mirroring
   the bot's `networkpolicy.yaml`. **Required:** the agent's only public-egress
   rule excludes RFC1918, and the collector is a ClusterIP, so without this rule
   the spans are silently dropped at the NetworkPolicy.

4. **Bonus (best-effort): unified cross-process trace.** Activate the
   already-present `opentelemetry-instrumentation-grpc` server instrumentation so
   the agent extracts the W3C `traceparent` from the bot's gRPC call and nests
   its spans under the bot's `Agent/Chat` span — one trace where a slow turn
   visibly fans out into N `call_llm` children. If context does not propagate
   cleanly, the agent still emits its own self-rooted trace (no loss); this
   enhancement is independently revertable.

## Security boundary: sandbox isolation is untouched

This change edits **only** `agent-networkpolicy.yaml` (`podSelector: app:
discord-article-bot-agent` — the trusted sidecar). The ephemeral sandbox **job
pods** are governed by the separate `sandbox-networkpolicy.yaml`
(`podSelector: app.kubernetes.io/component: sandbox`; `ingress: []`; egress only
to public internet minus RFC1918, plus DNS). That lockdown — the actual
agentic-sandbox security boundary — is **not** modified. Sandbox pods gain no new
egress and cannot reach the Dynatrace collector or any in-cluster service.

## Error handling

Tracing is strictly best-effort. `BatchSpanProcessor` exports asynchronously off
the request path and never blocks or fails a chat. `tracing.setup` is guarded so
an exporter/endpoint misconfiguration logs and continues rather than crashing
startup. With no endpoint configured (local dev), setup is a complete no-op.

## Testing

- **Unit (`tracing.py`):** with an endpoint set, `setup` attaches a span
  processor/exporter to the provider; with no endpoint, it is a no-op (no
  processor); the resource carries `service.name`.
- **Live verification (the real proof):** after deploy, trigger an agent chat,
  then query Dynatrace via dtctl for `call_llm` + agent-run spans from service
  `discord-article-bot-agent`; confirm a multi-call turn shows N `call_llm`
  children — i.e. the loop is finally legible from observability.

## Out of scope (YAGNI)

- Metrics/logs export (traces only, matching the bot's `OTEL_METRICS_EXPORTER=none`).
- Traceloop / OpenInference instrumentation libraries.
- Dynatrace-driven retry/model tuning (separate future project — this spec is its
  prerequisite: you cannot tune from signals you do not export).

## Open item to confirm during implementation

Whether ADK 1.31 gates LLM prompt/completion **content** on a flag/env. If so,
enable it — this is a private bot and the message/tool content is what makes a
loop diagnosable. If content is on by default, no action.
