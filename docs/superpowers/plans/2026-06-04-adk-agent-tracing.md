# ADK Agent OpenTelemetry Tracing → Dynatrace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the ADK agent sidecar's agent/LLM/tool spans to Dynatrace by wiring ADK 1.31's built-in OpenTelemetry tracing to the in-cluster Dynatrace collector.

**Architecture:** ADK already emits `agent_run → call_llm → execute_tool` spans via its module tracer bound to the global `TracerProvider`; they're dropped today because the agent's `tracing.py` attaches no exporter and the deployment sets no OTLP endpoint (and the NetworkPolicy blocks the collector). We attach an OTLP/HTTP exporter (mirroring the bot), set the endpoint env, and open agent-only egress to the `dynatrace` namespace. No instrumentation library.

**Tech Stack:** Python, `google-adk` 1.31.1, `opentelemetry-sdk`, `opentelemetry-exporter-otlp` (HTTP), Kubernetes (RKE2), Dynatrace.

**Spec:** `docs/superpowers/specs/2026-06-04-adk-agent-tracing-design.md`

**Working dir for Python commands:** `agent-sidecar/` — run pytest as `.venv/bin/python -m pytest …`.

---

## File Structure

- `agent-sidecar/src/tracing.py` — **modify** (rewrite). Build the OTLP/HTTP exporter + resource + provider; install global provider; best-effort/no-op. Decomposed into small pure helpers for testability.
- `agent-sidecar/tests/test_tracing.py` — **create**. Unit tests for the pure helpers + no-op behavior.
- `k8s/overlays/deployed/agent-deployment.yaml` + `k8s/sandbox/agent-deployment.yaml` — **modify**. Add OTEL env.
- `k8s/overlays/deployed/agent-networkpolicy.yaml` + `k8s/sandbox/agent-networkpolicy.yaml` — **modify**. Add `dynatrace` egress.
- `CLAUDE.md` — **modify**. Document agent tracing.

No `requirements.txt` change: the HTTP exporter ships in the already-present `opentelemetry-exporter-otlp`, and `opentelemetry-instrumentation-grpc` (Task 6) is already present.

---

## Task 1: Rewrite `tracing.py` into testable units (HTTP exporter + no-op guard)

**Files:**
- Modify: `agent-sidecar/src/tracing.py`
- Test: `agent-sidecar/tests/test_tracing.py`

- [ ] **Step 1: Write the failing tests**

Create `agent-sidecar/tests/test_tracing.py`:

```python
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider

from src.tracing import (
    _traces_url,
    _build_exporter,
    _build_resource,
    _build_provider,
    setup,
)


class _Cfg:
    """Minimal stand-in for Config: _build_provider only reads otlp_endpoint."""
    def __init__(self, endpoint):
        self.otlp_endpoint = endpoint


def test_traces_url_appends_signal_path():
    assert _traces_url("http://c:4318") == "http://c:4318/v1/traces"


def test_traces_url_idempotent_and_strips_trailing_slash():
    assert _traces_url("http://c:4318/") == "http://c:4318/v1/traces"
    assert _traces_url("http://c:4318/v1/traces") == "http://c:4318/v1/traces"


def test_build_exporter_none_when_no_endpoint():
    assert _build_exporter(None) is None
    assert _build_exporter("") is None


def test_build_exporter_http_when_endpoint_set():
    assert isinstance(_build_exporter("http://c:4318"), OTLPSpanExporter)


def test_build_resource_default_service_name(monkeypatch):
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    assert _build_resource().attributes["service.name"] == "discord-article-bot-agent"


def test_build_resource_honors_env(monkeypatch):
    monkeypatch.setenv("OTEL_SERVICE_NAME", "custom-agent")
    assert _build_resource().attributes["service.name"] == "custom-agent"


def test_build_provider_no_exporter_when_no_endpoint():
    p = _build_provider(_Cfg(None))
    assert isinstance(p, TracerProvider)
    # No-op: nothing attached to the composite span processor.
    assert len(p._active_span_processor._span_processors) == 0


def test_build_provider_attaches_exporter_when_endpoint_set():
    p = _build_provider(_Cfg("http://c:4318"))
    assert len(p._active_span_processor._span_processors) == 1


def test_setup_no_endpoint_does_not_raise():
    # Best-effort: must never crash startup. (set_tracer_provider may warn if
    # already set by another test — that is fine; it must not raise.)
    setup(_Cfg(None))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_tracing.py -q`
Expected: FAIL — `ImportError: cannot import name '_traces_url' from 'src.tracing'` (the helpers don't exist yet).

- [ ] **Step 3: Rewrite `tracing.py`**

Replace the entire contents of `agent-sidecar/src/tracing.py` with:

```python
"""OpenTelemetry exporter setup; no-op when no OTLP endpoint configured.

google-adk emits agent_run / call_llm / execute_tool spans via its module
tracer bound to the global TracerProvider, so installing this provider with an
OTLP exporter is all that's needed for the agent's reasoning loop to appear in
Dynatrace. We export over OTLP/HTTP to the in-cluster Dynatrace collector,
mirroring the bot (telemetry-ingest.dynatrace.svc:4318).
"""
import logging
import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .config import Config

log = logging.getLogger(__name__)

_DEFAULT_SERVICE_NAME = "discord-article-bot-agent"


def _traces_url(base: str) -> str:
    """Append the OTLP/HTTP traces signal path to a base endpoint, idempotently.

    The HTTP exporter (unlike env-based config) does NOT auto-append the signal
    path when given an explicit endpoint, so we do it here. `config.otlp_endpoint`
    is the base OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://host:4318).
    """
    base = base.rstrip("/")
    return base if base.endswith("/v1/traces") else base + "/v1/traces"


def _build_exporter(endpoint: str | None):
    """OTLP/HTTP span exporter for `endpoint`, or None when unset (no-op export)."""
    if not endpoint:
        return None
    return OTLPSpanExporter(endpoint=_traces_url(endpoint))


def _build_resource() -> Resource:
    service_name = os.environ.get("OTEL_SERVICE_NAME") or _DEFAULT_SERVICE_NAME
    return Resource.create({"service.name": service_name})


def _build_provider(config: Config) -> TracerProvider:
    provider = TracerProvider(resource=_build_resource())
    exporter = _build_exporter(config.otlp_endpoint)
    if exporter is not None:
        provider.add_span_processor(BatchSpanProcessor(exporter))
    return provider


def setup(config: Config) -> None:
    """Install the global TracerProvider. Best-effort: never crash startup."""
    try:
        trace.set_tracer_provider(_build_provider(config))
        if config.otlp_endpoint:
            log.info("OTLP tracing enabled -> %s", config.otlp_endpoint)
    except Exception:  # noqa: BLE001
        log.warning("tracing setup failed; continuing without traces", exc_info=True)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_tracing.py -q`
Expected: PASS (9 passed).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `cd agent-sidecar && .venv/bin/python -m pytest -q`
Expected: PASS — all prior tests + the 9 new ones.

- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/src/tracing.py agent-sidecar/tests/test_tracing.py
git commit -m "feat(agent): OTLP/HTTP tracing exporter, no-op when unset"
```

---

## Task 2: Add OTEL env to the agent deployment (deployed + tracked)

**Files:**
- Modify: `k8s/overlays/deployed/agent-deployment.yaml` (the `env:` list under container `agent`, after the `SANDBOX_BASE_IMAGE` entry)
- Modify: `k8s/sandbox/agent-deployment.yaml` (same location)

- [ ] **Step 1: Edit the deployed manifest**

In `k8s/overlays/deployed/agent-deployment.yaml`, the `env:` list currently ends with the `SANDBOX_BASE_IMAGE` entry, immediately followed by `envFrom:`. Insert these two env entries right before `envFrom:` (keep indentation identical — 12 spaces before `- name:`):

```yaml
            - name: OTEL_SERVICE_NAME
              value: "discord-article-bot-agent"
            - name: OTEL_EXPORTER_OTLP_ENDPOINT
              value: "http://telemetry-ingest.dynatrace.svc.cluster.local:4318"
```

- [ ] **Step 2: Mirror the same two entries into the tracked template**

Apply the identical insertion in `k8s/sandbox/agent-deployment.yaml` (same `env:`-before-`envFrom:` position).

- [ ] **Step 3: Verify both files**

Run: `grep -n "OTEL_" k8s/overlays/deployed/agent-deployment.yaml k8s/sandbox/agent-deployment.yaml`
Expected: each file shows `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_ENDPOINT`.

- [ ] **Step 4: Commit** (the deployed overlay is gitignored; only the tracked template commits — that is expected)

```bash
git add k8s/sandbox/agent-deployment.yaml
git commit -m "feat(agent): point agent OTLP at in-cluster Dynatrace collector"
```

---

## Task 3: Open agent egress to the Dynatrace collector (deployed + tracked)

**Files:**
- Modify: `k8s/overlays/deployed/agent-networkpolicy.yaml` (append to the `egress:` list)
- Modify: `k8s/sandbox/agent-networkpolicy.yaml` (same)

This adds egress for the **agent sidecar only** (`podSelector: app: discord-article-bot-agent`). It does NOT touch `sandbox-networkpolicy.yaml`; sandbox job isolation is unchanged.

- [ ] **Step 1: Append the egress rule to the deployed manifest**

At the end of the `egress:` list in `k8s/overlays/deployed/agent-networkpolicy.yaml`, append (match existing 4-space list indentation under `egress:`):

```yaml
    # Dynatrace OpenTelemetry collector (telemetry-ingest service) for OTLP traces
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: dynatrace
      ports:
        - { protocol: TCP, port: 4317 }  # OTLP gRPC (unused; allowed for parity with bot)
        - { protocol: TCP, port: 4318 }  # OTLP HTTP (what the agent uses)
```

- [ ] **Step 2: Mirror into the tracked template**

Apply the identical append to `k8s/sandbox/agent-networkpolicy.yaml`.

- [ ] **Step 3: Verify both files**

Run: `grep -n "4318\|dynatrace" k8s/overlays/deployed/agent-networkpolicy.yaml k8s/sandbox/agent-networkpolicy.yaml`
Expected: each shows the `dynatrace` namespaceSelector and port `4318`.

- [ ] **Step 4: Commit**

```bash
git add k8s/sandbox/agent-networkpolicy.yaml
git commit -m "feat(agent): allow agent egress to Dynatrace OTLP collector"
```

---

## Task 4: Confirm/enable ADK LLM message-content capture

ADK records `call_llm` spans, but prompt/completion **content** may be gated (OTel GenAI instrumentations commonly default content off for privacy). For this private bot we want content — it's what makes a loop legible.

**Files:**
- Possibly modify: `k8s/overlays/deployed/configmap-sandbox.yaml` + `k8s/sandbox/configmap-sandbox.yaml` (add one env)

- [ ] **Step 1: Inspect ADK's content-capture behavior in the running pod**

```bash
N=discord-article-bot
AGENT=$(kubectl get pods -n $N --no-headers | grep 'discord-article-bot-agent' | grep Running | awk '{print $1}' | head -1)
kubectl exec -n $N $AGENT -c agent -- python -c "
import inspect, google.adk.telemetry as t
src = inspect.getsource(inspect.getmodule(t))
import subprocess
" 2>/dev/null
# Search the installed ADK for the content-capture gate:
kubectl exec -n $N $AGENT -c agent -- sh -c "grep -rniE 'capture.?content|message_content|CAPTURE_MESSAGE|log.?prompts|include_content' /usr/local/lib/python3.12/site-packages/google/adk/ | head -20"
```
Expected: reveals either an env var (e.g. `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`) or a code default. Note the exact flag name.

- [ ] **Step 2: Decide and (if gated) add the env**

- If content is captured by default → no change; check this box and move on.
- If gated behind an env flag → add it to BOTH `k8s/overlays/deployed/configmap-sandbox.yaml` and `k8s/sandbox/configmap-sandbox.yaml`, e.g.:

```yaml
  # Capture LLM prompt/completion content on call_llm spans (private bot).
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true"
```
(Use the EXACT flag name found in Step 1; the line above is the OTel-standard name and is the most likely match.)

- [ ] **Step 3: Commit (only if a flag was added)**

```bash
git add k8s/sandbox/configmap-sandbox.yaml
git commit -m "feat(agent): capture LLM message content on ADK spans"
```

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (Agentic Sandbox section)

- [ ] **Step 1: Add a tracing note**

In `CLAUDE.md`, under the Agentic Sandbox section, add a paragraph:

```markdown
**Tracing:** the agent sidecar exports OTel spans to the in-cluster Dynatrace collector (`telemetry-ingest.dynatrace.svc:4318`, OTLP/HTTP) as service `discord-article-bot-agent` — ADK's native `agent_run → call_llm → execute_tool` waterfall. Configured via `OTEL_EXPORTER_OTLP_ENDPOINT` on the agent deployment; `agent-networkpolicy.yaml` allows the collector egress (sandbox-job isolation is unaffected). No-op when the endpoint env is unset (local dev). Query in Dynatrace via dtctl: `fetch spans | filter dt.service.name == "discord-article-bot-agent"`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(agent): document agent OTLP tracing"
```

---

## Task 6 (bonus, independently revertable): gRPC cross-process trace nesting

Make the agent extract the W3C `traceparent` from the bot's gRPC `Chat` call so the agent's spans nest under the bot's `Agent/Chat` span — one trace where a slow turn fans out into its `call_llm` children. If propagation doesn't work, the agent still self-roots its trace (no loss), so this is safe to drop.

**Files:**
- Modify: `agent-sidecar/src/tracing.py` (extend `setup`)

- [ ] **Step 1: Instrument the grpc.aio server in `setup`**

In `agent-sidecar/src/tracing.py`, add to the imports:

```python
from opentelemetry.instrumentation.grpc import GrpcAioInstrumentorServer
```

Then in `setup`, inside the `try`, after `trace.set_tracer_provider(...)` and gated on the endpoint (only instrument when exporting), add:

```python
        if config.otlp_endpoint:
            GrpcAioInstrumentorServer().instrument()
```

So the body becomes:

```python
    try:
        trace.set_tracer_provider(_build_provider(config))
        if config.otlp_endpoint:
            GrpcAioInstrumentorServer().instrument()
            log.info("OTLP tracing enabled -> %s", config.otlp_endpoint)
    except Exception:  # noqa: BLE001
        log.warning("tracing setup failed; continuing without traces", exc_info=True)
```

(`setup` is called in `server.py:serve()` BEFORE `grpc.aio.server()` is created, which is required for the instrumentor to take effect.)

- [ ] **Step 2: Run the full suite (instrumentation import must not break anything)**

Run: `cd agent-sidecar && .venv/bin/python -m pytest -q`
Expected: PASS. (`test_setup_no_endpoint_does_not_raise` still passes — instrumentation is gated on the endpoint, so the no-endpoint path is unaffected.)

- [ ] **Step 3: Commit**

```bash
git add agent-sidecar/src/tracing.py
git commit -m "feat(agent): nest agent spans under bot Agent/Chat via grpc context"
```

---

## Task 7: Build, deploy, and verify spans live

**Files:** none (build/deploy/verify)

- [ ] **Step 1: Capture the release SHA**

```bash
cd /home/ubuntu/workspace/revenant
SHA=$(git rev-parse --short HEAD); echo "SHA=$SHA"
```

- [ ] **Step 2: Build + push the agent image; retag sandbox-base in lockstep**

```bash
cd agent-sidecar && docker build -t mvilliger/discord-article-bot-agent:$SHA . && docker push mvilliger/discord-article-bot-agent:$SHA
docker tag mvilliger/sandbox-base:a3b06e8 mvilliger/sandbox-base:$SHA && docker push mvilliger/sandbox-base:$SHA
cd /home/ubuntu/workspace/revenant
```
Expected: both pushes succeed (digests printed). (Docker must be logged in as `mvilliger`.)

- [ ] **Step 3: Bump both image tags in the deployed manifest (lockstep rule)**

```bash
sed -i "s|discord-article-bot-agent:a3b06e8|discord-article-bot-agent:$SHA|" k8s/overlays/deployed/agent-deployment.yaml
sed -i "s|sandbox-base:a3b06e8|sandbox-base:$SHA|" k8s/overlays/deployed/agent-deployment.yaml
```
(Also update `k8s/sandbox/agent-deployment.yaml` tags to `$SHA` and commit that tracked file.)

- [ ] **Step 4: Apply configmap (if Task 4 added one), networkpolicy, deployment; roll out**

```bash
N=discord-article-bot
kubectl apply -f k8s/overlays/deployed/configmap-sandbox.yaml -n $N
kubectl apply -f k8s/overlays/deployed/agent-networkpolicy.yaml -n $N
kubectl apply -f k8s/overlays/deployed/agent-deployment.yaml -n $N
kubectl rollout status deployment/discord-article-bot-agent -n $N --timeout=120s
```
Expected: `successfully rolled out`.

- [ ] **Step 5: Confirm clean startup + tracing enabled log**

```bash
AGENT=$(kubectl get pods -n $N --no-headers | grep 'discord-article-bot-agent' | grep Running | awk '{print $1}' | head -1)
kubectl logs -n $N $AGENT -c agent --since=120s | grep -iE "OTLP tracing enabled|agent LLM resolved|Traceback|Error" | tail
```
Expected: `OTLP tracing enabled -> http://telemetry-ingest...:4318`, resolved model line, no tracebacks.

- [ ] **Step 6: Trigger an agent chat, then verify spans in Dynatrace via dtctl**

Send a Discord message to the bot that uses the agent (channel-voice), ideally one that runs sandbox code. Then (using the keyring-free dtctl invocation from `reference_dtctl_dynatrace_access`):

```bash
DTQ() { env DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-bus" timeout 60 dtctl query -f - -o json --plain; }
DTQ <<'EOF'
fetch spans, from:now()-30m
| filter dt.service.name == "discord-article-bot-agent"
| summarize cnt=count(), by:{span.name}
| sort cnt desc
| limit 20
EOF
```
Expected: rows for ADK span names (e.g. `agent_run [channel_voice]`, `call_llm`, `execute_tool run_in_sandbox` — exact names per ADK 1.31). If empty after ~2 min, check: pod log for exporter errors, NetworkPolicy applied, and that a chat actually hit the agent.

- [ ] **Step 7: Verify the loop is now legible (per-turn call_llm count)**

```bash
DTQ <<'EOF'
fetch spans, from:now()-2h
| filter dt.service.name == "discord-article-bot-agent" and span.name == "call_llm"
| summarize calls=count(), by:{trace.id}
| sort calls desc
| limit 10
EOF
```
Expected: each `trace.id` (one chat turn) shows its `call_llm` count — a hammering turn would show many. This is the payoff: the loop is finally visible from observability.

- [ ] **Step 8: Push the branch + update PR**

```bash
git push -u origin feat/agent-otel-tracing
```
(Open a PR against `main` — or against `fix/agent-503-retry` if PR #85 hasn't merged — via `gh pr create`.)

---

## Self-Review

**Spec coverage:**
- "Wire OTLP exporter / no-op when unset / HTTP/4318 / service.name" → Task 1. ✓
- "OTEL env on agent deployment" → Task 2. ✓
- "Dynatrace egress on agent NetworkPolicy (required)" → Task 3. ✓
- "Confirm ADK content flag (open item)" → Task 4. ✓
- "Bonus: gRPC cross-process nesting, revertable" → Task 6. ✓
- "Error handling: best-effort, no-op, guarded" → Task 1 `setup` try/except + `test_setup_no_endpoint_does_not_raise`. ✓
- "Testing: unit + live verification" → Task 1 (unit), Task 7 (live). ✓
- "Sandbox isolation untouched" → Task 3 scope note (agent-networkpolicy only). ✓
- "Docs" → Task 5. ✓

**Placeholder scan:** No TBD/TODO. Task 4 Step 2 is conditional-by-design (depends on Step 1's finding) with the exact likely flag given — not a placeholder. All code/commands are complete.

**Type/name consistency:** `_traces_url`, `_build_exporter`, `_build_resource`, `_build_provider`, `setup` are defined in Task 1 and referenced consistently in tests and Task 6. `config.otlp_endpoint` matches `config.py`. Service name `discord-article-bot-agent` consistent across Tasks 1/2/5/7. Image base tag `a3b06e8` matches current prod for the lockstep retag.
