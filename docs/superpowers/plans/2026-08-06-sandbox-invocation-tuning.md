# Sandbox Invocation Tuning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the channel-voice agent from invoking `run_in_sandbox` for asks it could answer directly (a latency problem), without regressing into refusing/describing asks that genuinely need execution.

**Architecture:** Build an offline eval harness first (it's the tuning instrument), baseline the current prompt, rewrite `TOOL_AVAILABILITY_PREAMBLE` iterating against the harness, add a Dynatrace span attribute for production validation, then ship. Spec: `docs/superpowers/specs/2026-08-06-sandbox-invocation-tuning-design.md`.

**Tech Stack:** Python 3.12, `google-adk`, `google-genai` (GEAP), OpenTelemetry, pytest. Sidecar image `mvilliger/discord-article-bot-agent`.

## Global Constraints
- **Sidecar only.** No bot-side changes.
- Offline harness runs the **real** model (`AGENT_MODEL` on GEAP) but a **fake orchestrator** — zero pods. Local run auth: `agent-sidecar/genai-sa-key.json`, env `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2`, `GOOGLE_CLOUD_LOCATION=global`.
- Orchestrator result type is `OrchestratorResult` (fields: `execution_id, exit_code, stdout, stderr, stdout_truncated, stderr_truncated, duration_ms, schedule_wait_ms, timed_out, oom_killed, orchestrator_error, egress_events, pod_name, node_name`). `orch.run(*, user_id, language, code, stdin, env)` is the signature.
- Success: offline **false-invocation ≤ ~15%**, **false-omission ≈ 0**; Dynatrace shows lower per-turn sandbox rate post-deploy.
- Run sidecar tests with the venv: `cd agent-sidecar && .venv/bin/python -m pytest`.
- No `:latest` tags; sidecar image pinned to git short-SHA. Do not scale the single-replica sidecar.

---

### Task 1: Fake orchestrator + scorer (pure, TDD)

**Files:**
- Create: `agent-sidecar/eval/__init__.py` (empty)
- Create: `agent-sidecar/eval/harness.py`
- Test: `agent-sidecar/tests/test_sandbox_eval_harness.py`

**Interfaces:**
- Produces: `FakeOrchestrator` (async `run(...)` → canned `OrchestratorResult`, records calls); `score(records) -> ScoreCard` where `records: list[tuple[str, bool]]` of `(expect, invoked)` and `ScoreCard` has `false_invocation_rate: float`, `false_omission_rate: float`, `n_direct: int`, `n_sandbox: int`.

- [ ] **Step 1: Write the failing test**

```python
# agent-sidecar/tests/test_sandbox_eval_harness.py
import asyncio
from dataclasses import asdict
from eval.harness import FakeOrchestrator, score

def test_fake_orchestrator_returns_valid_result_and_records():
    fo = FakeOrchestrator()
    r = asyncio.run(fo.run(user_id="u", language="bash", code="echo hi", stdin=None, env={}))
    assert r.exit_code == 0 and r.execution_id
    assert asdict(r)  # dataclass, asdict works (tool does this)
    assert fo.calls == 1

def test_score_perfect():
    # (expect, invoked)
    recs = [("direct", False), ("direct", False), ("sandbox", True), ("sandbox", True)]
    s = score(recs)
    assert s.false_invocation_rate == 0.0
    assert s.false_omission_rate == 0.0
    assert s.n_direct == 2 and s.n_sandbox == 2

def test_score_all_wrong():
    recs = [("direct", True), ("sandbox", False)]
    s = score(recs)
    assert s.false_invocation_rate == 1.0
    assert s.false_omission_rate == 1.0

def test_score_mixed():
    recs = [("direct", True), ("direct", False), ("direct", False), ("sandbox", True)]
    s = score(recs)
    assert abs(s.false_invocation_rate - 1/3) < 1e-9
    assert s.false_omission_rate == 0.0
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_sandbox_eval_harness.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.harness'`

- [ ] **Step 3: Implement `eval/harness.py`**

```python
"""Offline eval harness for the sandbox-invocation decision.

Runs the real ChannelVoiceAgent (real prompt + model) against a fake
orchestrator so the tool-invocation *decision* is measured without spinning
up any pods."""
from dataclasses import dataclass

from src.orchestrator import OrchestratorResult


class FakeOrchestrator:
    """Stands in for SandboxOrchestrator. Records invocations and returns a
    canned success instantly so multi-call turns still terminate."""

    def __init__(self) -> None:
        self.calls = 0

    async def run(self, *, user_id, language, code, stdin, env):  # noqa: ANN001
        self.calls += 1
        return OrchestratorResult(
            execution_id=f"fake-{self.calls}", exit_code=0,
            stdout="(fake sandbox output)", stderr="",
            stdout_truncated=False, stderr_truncated=False, duration_ms=1,
            schedule_wait_ms=0, timed_out=False, oom_killed=False,
            orchestrator_error=None, egress_events=[], pod_name="fake", node_name=None,
        )


@dataclass
class ScoreCard:
    false_invocation_rate: float
    false_omission_rate: float
    n_direct: int
    n_sandbox: int


def score(records: list[tuple[str, bool]]) -> ScoreCard:
    """records: list of (expect, invoked). expect in {'direct','sandbox'}."""
    direct = [inv for exp, inv in records if exp == "direct"]
    sandbox = [inv for exp, inv in records if exp == "sandbox"]
    fi = (sum(direct) / len(direct)) if direct else 0.0          # direct but invoked
    fo = (sum(not inv for inv in sandbox) / len(sandbox)) if sandbox else 0.0  # sandbox but not invoked
    return ScoreCard(false_invocation_rate=fi, false_omission_rate=fo,
                     n_direct=len(direct), n_sandbox=len(sandbox))
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_sandbox_eval_harness.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/eval/__init__.py agent-sidecar/eval/harness.py agent-sidecar/tests/test_sandbox_eval_harness.py
git commit -m "feat(eval): fake orchestrator + scorer for sandbox-invocation eval"
```

---

### Task 2: Labeled prompt set + runner

**Files:**
- Create: `agent-sidecar/eval/sandbox_eval_set.py`
- Create: `agent-sidecar/eval/eval_sandbox_invocation.py` (CLI runner)

**Interfaces:**
- Consumes: `FakeOrchestrator`, `score` (Task 1); `ChannelVoiceAgent` (`src.agent`).
- Produces: `EVAL_SET: list[dict]` (`{"prompt": str, "expect": "direct"|"sandbox", "manual": bool}`); a `main()` that runs each prompt `--runs` times and prints a scorecard, exit nonzero if `false_invocation_rate > --threshold`.

- [ ] **Step 1: Create the labeled set** (`sandbox_eval_set.py`)

```python
"""Labeled prompts for the sandbox-invocation decision. `manual=True` marks the
curated subset handed to the user for live Discord verification."""

EVAL_SET = [
    # --- should answer DIRECTLY (no sandbox) ---
    {"prompt": "what's 2 + 7?", "expect": "direct", "manual": True},
    {"prompt": "explain how the TCP three-way handshake works", "expect": "direct", "manual": True},
    {"prompt": "show me the Python syntax for a list comprehension", "expect": "direct", "manual": True},
    {"prompt": "what port does SSH listen on by default?", "expect": "direct", "manual": True},
    {"prompt": "tabs or spaces? what's your take", "expect": "direct", "manual": False},
    {"prompt": "reverse the string 'hello' for me", "expect": "direct", "manual": True},
    {"prompt": "what's the difference between TCP and UDP?", "expect": "direct", "manual": False},
    {"prompt": "give me an example of a bash for-loop", "expect": "direct", "manual": True},
    {"prompt": "what does the chmod 755 permission mean?", "expect": "direct", "manual": False},
    {"prompt": "roughly how many seconds are in a week?", "expect": "direct", "manual": False},
    {"prompt": "summarize what a reverse proxy does in two sentences", "expect": "direct", "manual": False},
    {"prompt": "what's the CIDR notation for a /24 subnet mask?", "expect": "direct", "manual": False},
    {"prompt": "write a regex that matches an IPv4 address (just show it)", "expect": "direct", "manual": False},
    {"prompt": "how would I structure a Python package? just describe it", "expect": "direct", "manual": False},
    {"prompt": "what's your opinion on rust vs go for CLI tools?", "expect": "direct", "manual": False},

    # --- genuinely needs the SANDBOX ---
    {"prompt": "nmap the top 100 ports on scanme.nmap.org and tell me what's open", "expect": "sandbox", "manual": True},
    {"prompt": "what HTTP response headers does https://example.com return?", "expect": "sandbox", "manual": True},
    {"prompt": "compute the sha256 of the exact string 'correct horse battery staple'", "expect": "sandbox", "manual": True},
    {"prompt": "does this compile and what does it print: print(sum(i*i for i in range(10)))", "expect": "sandbox", "manual": True},
    {"prompt": "resolve the A records for github.com", "expect": "sandbox", "manual": True},
    {"prompt": "benchmark how long it takes python to sort a list of 1,000,000 random ints", "expect": "sandbox", "manual": False},
    {"prompt": "curl https://httpbin.org/uuid and show me the uuid it returns", "expect": "sandbox", "manual": False},
    {"prompt": "generate 5 random UUIDs using python and list them", "expect": "sandbox", "manual": False},
    {"prompt": "what's the current time in the sandbox (run `date -u`)?", "expect": "sandbox", "manual": False},
    {"prompt": "count how many primes there are below 100000", "expect": "sandbox", "manual": False},
    {"prompt": "check if TCP port 443 on cloudflare.com is reachable from the sandbox", "expect": "sandbox", "manual": False},
    {"prompt": "parse this and tell me the max value: [3,1,4,1,5,9,2,6,5,3,5]", "expect": "sandbox", "manual": False},
    {"prompt": "what version of openssl is installed in the sandbox?", "expect": "sandbox", "manual": False},
    {"prompt": "fuzz this function with 100 random inputs and report any crash: def f(x): return 10//x", "expect": "sandbox", "manual": False},
    {"prompt": "download https://example.com and tell me the exact byte length of the body", "expect": "sandbox", "manual": False},
]
```

- [ ] **Step 2: Create the runner** (`eval_sandbox_invocation.py`)

```python
"""Run the real agent (fake orchestrator) over the labeled set and score the
sandbox-invocation decision. Usage:
  cd agent-sidecar && .venv/bin/python -m eval.eval_sandbox_invocation --runs 3 --threshold 0.15
Requires GEAP env (GOOGLE_GENAI_USE_VERTEXAI=true, project, location=global,
GOOGLE_APPLICATION_CREDENTIALS=./genai-sa-key.json)."""
import argparse
import asyncio
import sys

from src.agent import ChannelVoiceAgent
from src.config import load
from eval.harness import FakeOrchestrator, score
from eval.sandbox_eval_set import EVAL_SET

_BASE_PROMPT = "You are a helpful assistant in a private Discord channel."


async def _invoked_once(prompt: str) -> bool:
    fo = FakeOrchestrator()
    agent = ChannelVoiceAgent(config=load(), orchestrator=fo, base_system_prompt=_BASE_PROMPT)
    res = await agent.process_chat(user_id="eval", user_message=prompt)
    return len(res.execution_ids) > 0


async def _run(runs: int):
    records = []
    per_prompt = []
    for item in EVAL_SET:
        invs = []
        for _ in range(runs):
            invs.append(await _invoked_once(item["prompt"]))
        rate = sum(invs) / runs
        per_prompt.append((item, rate))
        for inv in invs:
            records.append((item["expect"], inv))
    return records, per_prompt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--threshold", type=float, default=0.15)
    args = ap.parse_args()

    records, per_prompt = asyncio.run(_run(args.runs))
    s = score(records)
    print(f"\n=== per-prompt invocation rate (runs={args.runs}) ===")
    for item, rate in per_prompt:
        flag = ""
        if item["expect"] == "direct" and rate > 0: flag = "  <-- FALSE INVOCATION"
        if item["expect"] == "sandbox" and rate < 1: flag = "  <-- FALSE OMISSION"
        print(f"  [{item['expect']:7}] {rate:4.0%}  {item['prompt'][:60]}{flag}")
    print(f"\n=== scorecard ===")
    print(f"  false-invocation: {s.false_invocation_rate:.1%}  (target <= {args.threshold:.0%})   over {s.n_direct} direct prompts")
    print(f"  false-omission:   {s.false_omission_rate:.1%}  (target ~ 0%)              over {s.n_sandbox} sandbox prompts")
    sys.exit(1 if s.false_invocation_rate > args.threshold else 0)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Smoke-check import (no live model call)**

Run: `cd agent-sidecar && .venv/bin/python -c "from eval.eval_sandbox_invocation import main; from eval.sandbox_eval_set import EVAL_SET; print(len(EVAL_SET), 'prompts')"`
Expected: `30 prompts`

- [ ] **Step 4: Commit**

```bash
git add agent-sidecar/eval/sandbox_eval_set.py agent-sidecar/eval/eval_sandbox_invocation.py
git commit -m "feat(eval): labeled sandbox-decision set + scoring runner"
```

---

### Task 3: Baseline the CURRENT preamble

**Files:** none (measurement only)

- [ ] **Step 1: Run the harness against the current (aggressive) preamble**

```bash
cd /home/ubuntu/workspace/revenant/agent-sidecar
GOOGLE_APPLICATION_CREDENTIALS=$PWD/genai-sa-key.json GOOGLE_GENAI_USE_VERTEXAI=true \
GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 GOOGLE_CLOUD_LOCATION=global \
.venv/bin/python -m eval.eval_sandbox_invocation --runs 3 --threshold 1.0
```
Record the baseline false-invocation and false-omission rates (this documents the "before"). `--threshold 1.0` so it never fails here.

---

### Task 4: Rewrite `TOOL_AVAILABILITY_PREAMBLE` (iterate against harness)

**Files:**
- Modify: `agent-sidecar/src/agent.py` (replace the `TOOL_AVAILABILITY_PREAMBLE` string, lines ~164-222)
- Test: `agent-sidecar/tests/test_agent_model.py` (add a guard test on the new disposition)

**Interfaces:** unchanged — `TOOL_AVAILABILITY_PREAMBLE` stays a module-level str concatenated into `Agent(instruction=…)`.

- [ ] **Step 1: Write the guard test (failing)**

```python
# add to tests/test_agent_model.py
from src.agent import TOOL_AVAILABILITY_PREAMBLE

def test_preamble_inverts_to_answer_directly():
    p = TOOL_AVAILABILITY_PREAMBLE.lower()
    # new disposition present
    assert "answer directly" in p
    assert "last resort" in p
    # old aggressive disposition gone
    assert "when a request could be answered by running code, run it" not in p
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_agent_model.py -k preamble -v`
Expected: FAIL (old preamble still present)

- [ ] **Step 3: Replace the preamble** with the draft from the spec (`docs/superpowers/specs/2026-08-06-sandbox-invocation-tuning-design.md`, Component 1). Keep it a `"""..."""`-`.strip()` module constant exactly as today.

- [ ] **Step 4: Run the guard test — verify pass**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_agent_model.py -k preamble -v`
Expected: PASS

- [ ] **Step 5: Re-run the harness; iterate wording until targets met**

```bash
cd /home/ubuntu/workspace/revenant/agent-sidecar
GOOGLE_APPLICATION_CREDENTIALS=$PWD/genai-sa-key.json GOOGLE_GENAI_USE_VERTEXAI=true \
GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 GOOGLE_CLOUD_LOCATION=global \
.venv/bin/python -m eval.eval_sandbox_invocation --runs 3 --threshold 0.15
```
Target: exit 0 (false-invocation ≤ 15%) AND false-omission ≈ 0%. If false-omission rises, the wording over-corrected — restore more "when it DOES need execution, run it" emphasis and re-run. Iterate the string only; do not touch the harness.

- [ ] **Step 6: Full sidecar suite green**

Run: `cd agent-sidecar && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add agent-sidecar/src/agent.py agent-sidecar/tests/test_agent_model.py
git commit -m "fix(sidecar): invert sandbox disposition to answer-directly-by-default

Rewrites TOOL_AVAILABILITY_PREAMBLE: sandbox is a last resort for asks that
genuinely require execution; simple asks answered directly. Verified via the
offline eval harness (false-invocation <=15%, false-omission ~0%)."
```

---

### Task 5: Dynatrace telemetry span

**Files:**
- Modify: `agent-sidecar/src/server.py` (`Chat` handler)
- Test: `agent-sidecar/tests/test_server_chat_span.py`

**Interfaces:** `Chat` wraps the agent call in a `tracer.start_as_current_span("agent.chat")` and sets `sandbox.invoked` / `sandbox.call_count`.

- [ ] **Step 1: Write the failing test**

```python
# agent-sidecar/tests/test_server_chat_span.py
import asyncio
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from src import server as srv
from src.agent import AgentChatResult
from src import agent_pb2

class _FakeAgent:
    def __init__(self, n): self._n = n
    async def process_chat(self, *, user_id, user_message):
        return AgentChatResult(message_text="ok", execution_ids=[f"e{i}" for i in range(self._n)], any_failed=False)

class _Ctx:
    async def abort(self, *a, **k): raise AssertionError("should not abort")

def _run_chat(n_exec):
    exporter = InMemorySpanExporter()
    provider = TracerProvider(); provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    servicer = srv.AgentServicer(channel_voice_agent=_FakeAgent(n_exec))
    asyncio.run(servicer.Chat(agent_pb2.ChatRequest(user_id="u", user_message="hi"), _Ctx()))
    return exporter.get_finished_spans()

def test_chat_span_records_sandbox_invoked_true():
    spans = _run_chat(2)
    s = [x for x in spans if x.name == "agent.chat"][0]
    assert s.attributes["sandbox.invoked"] is True
    assert s.attributes["sandbox.call_count"] == 2

def test_chat_span_records_sandbox_invoked_false():
    spans = _run_chat(0)
    s = [x for x in spans if x.name == "agent.chat"][0]
    assert s.attributes["sandbox.invoked"] is False
    assert s.attributes["sandbox.call_count"] == 0
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_server_chat_span.py -v`
Expected: FAIL — no span named `agent.chat`.

- [ ] **Step 3: Implement in `server.py`**

Add near the top-level imports:
```python
from opentelemetry import trace
_tracer = trace.get_tracer(__name__)
```
Wrap the agent call in `Chat` (replace the existing `result = await self._agent.process_chat(...)` block):
```python
        with _tracer.start_as_current_span("agent.chat") as span:
            try:
                result = await self._agent.process_chat(
                    user_id=request.user_id,
                    user_message=request.user_message,
                )
            except Exception as e:  # noqa: BLE001
                log.exception("Chat handler failed")
                await context.abort(grpc.StatusCode.INTERNAL, str(e))
                return agent_pb2.ChatResponse()
            n = len(result.execution_ids)
            span.set_attribute("sandbox.invoked", n > 0)
            span.set_attribute("sandbox.call_count", n)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd agent-sidecar && .venv/bin/python -m pytest tests/test_server_chat_span.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Full suite green**

Run: `cd agent-sidecar && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/src/server.py agent-sidecar/tests/test_server_chat_span.py
git commit -m "feat(sidecar): emit sandbox.invoked/call_count on agent.chat span for Dynatrace"
```

---

### Task 6: Docs + Discord test-prompt deliverable

**Files:**
- Modify: `CLAUDE.md` (Agentic Sandbox section)
- Create: `agent-sidecar/eval/README.md`

- [ ] **Step 1: `eval/README.md`** — how to run the harness (env + command), what the scorecard means, and the curated `manual=True` prompts as the Discord test list with expected behavior (instant vs. runs).

- [ ] **Step 2: CLAUDE.md** — in the Agentic Sandbox section, note the disposition is now answer-directly-by-default (sandbox = last resort), point to the eval harness (`agent-sidecar/eval/`), and mention the `sandbox.invoked`/`sandbox.call_count` span attributes for Dynatrace.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md agent-sidecar/eval/README.md
git commit -m "docs: sandbox disposition tuned; eval harness + Discord test prompts"
```

---

### Task 7: Build, deploy, verify, hand off

**Files:**
- Modify: `k8s/overlays/deployed/agent-deployment.yaml` (image tag; gitignored)

- [ ] **Step 1: Build + push** the sidecar at the new git SHA (from `agent-sidecar/`, explicit `-f Dockerfile`). Verify the image is key-free before push.
- [ ] **Step 2: Deploy** (`kubectl set image` / apply the deployed overlay) and wait for rollout; confirm `genai_backend=enterprise` still logs and the pod is Ready.
- [ ] **Step 3: Live sanity** — one direct prompt ("what's 2+7") and one sandbox prompt ("run `date -u` in a sandbox") via the gRPC `Chat` path (`kubectl exec`); confirm the direct one has `executions: 0` and the sandbox one `executions: 1`.
- [ ] **Step 4: Provide the Dynatrace DQL** to track `sandbox.invoked` rate per turn over time (authored against the live `agent.chat` span field names), and hand the user the `manual=True` Discord prompt list.

---

## Follow-ups (out of scope)
- Pre-flight router/classifier — only if metrics show prompt tuning is insufficient.
- Round-trip latency reduction (warm pool / fewer round-trips) — separate, needs fresh traces.
