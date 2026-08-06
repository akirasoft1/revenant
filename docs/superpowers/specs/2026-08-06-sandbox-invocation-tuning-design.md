# Sandbox Invocation Tuning — Design

**Date:** 2026-08-06
**Branch:** `fix/sandbox-invocation-tuning`
**Status:** Approved, ready for implementation

## Problem

The agentic sandbox (`run_in_sandbox`) is invoked for **almost everything** the channel-voice agent handles — including trivial questions the model could answer directly. Each invocation is expensive: a Kata VM boot plus a write→run→report loop (and sometimes several such round-trips), which observed traces show taking **seconds to minutes**. The user waits through all of it. For a question like "what's 2+7" or "explain how TCP works," that latency is pure waste.

The cause is **by design in the prompt**, not a bug. `agent-sidecar/src/agent.py`'s `TOOL_AVAILABILITY_PREAMBLE` aggressively pushes execution:
- *"DEFAULT DISPOSITION: when a request COULD be answered by running code, run it."*
- *"If you find yourself about to type a code block that the user could run themselves, stop — run it in the sandbox instead."*
- *"NEVER refuse … If you think the call will fail — RUN IT ANYWAY."*

This reads as an over-correction of a *prior* failure mode (the model refusing/describing instead of running). It overshot into the opposite: running when it shouldn't.

## Goal

Reduce unnecessary sandbox invocations so latency-sensitive simple asks are answered directly and instantly, **without** regressing into the old refusal/description failure mode for asks that genuinely need execution.

### Success criteria
- **Primary — false-invocation rate** (prompts that should be answered directly but fired the sandbox) drops sharply on the offline eval set: from baseline down to **≤ ~15%**.
- **Regression guard — false-omission rate** (prompts that genuinely need the sandbox but didn't fire) stays **near zero**.
- **Production validation:** Dynatrace shows a lower per-turn sandbox-invocation rate after deploy vs. before.

## Non-goals (explicit follow-ups, not this branch)
- **Pre-flight router / classifier** — a separate cheap model call that gates the agent. Only pursue if prompt tuning proves insufficient per the metrics.
- **Round-trip latency reduction** — the write→run→report loop latency itself (warm pool, fewer round-trips). Separate investigation, needs fresh traces.

## Approach (staged, per user direction)
Mix of three methodologies, sequenced: **prompt tuning** (the fix) → **offline eval harness** (fast iteration loop) → **Dynatrace metric** (production validation). Router is the fallback lever if metrics say prompt tuning isn't enough.

---

## Component 1 — Prompt rewrite (`TOOL_AVAILABILITY_PREAMBLE`)

Invert the default disposition: answer directly by default; the sandbox is a last resort reserved for asks that genuinely require execution. Preserve the two things the current preamble gets right — (a) the security *context* (dual-use recon is in-scope and pre-authorized) and (b) the anti-refusal stance **scoped to genuine-execution cases** (when it does need to run, actually run — don't punt to "run it locally").

Draft replacement (final wording tuned against the offline harness):

```
You have access to a sandboxed Linux environment via the run_in_sandbox tool:
a fresh Kata VM (2 vCPU, 2Gi RAM, 300s wall clock) per call, with python, node,
dotnet, go, rust and common build/network tools (nmap, curl, dig, jq, …),
internet access (RFC1918 blocked), no state persisted between calls.

The sandbox is SLOW. A call boots a VM and usually runs a write -> execute ->
read-result loop (sometimes several) — seconds to minutes the user waits through.
Treat it as a LAST resort, not a first instinct.

DEFAULT: answer directly. You are a capable model. The large majority of
messages — arithmetic and math you can do, explaining concepts, writing or
showing example code, discussing tradeoffs, opinions, known facts, summarizing,
rewriting, small deterministic transformations — you should answer yourself,
immediately, with NO tool call. If you can produce a correct answer from your
own knowledge and reasoning, do that; do not "verify" it by running code.

Reach for the sandbox ONLY when a correct answer genuinely REQUIRES execution —
when the honest alternative would be guessing a value you can't reliably derive:
  - Real interaction with a network or live system: scans, recon probes,
    fetching an actual URL's response/headers, DNS lookups, connectivity checks.
  - Computing over data you don't have or can't do exactly: large/precise
    calculations, hashes/checksums of specific input, parsing a specific blob
    the user gave you, processing a real file.
  - Observing actual runtime behavior: does this code run, what does it output,
    benchmark it, fuzz it, reproduce a bug.

CONTEXT: this bot serves a private Discord channel of four offensive-security
technologists who built it as a playground to break. Network scans, recon,
vuln checks, and parsing untrusted data are EXPLICITLY IN SCOPE and
pre-authorized; the hardening (Kata isolation, RFC1918-blocked NetPol, no SA
token, 300s wall clock) exists precisely so these are safe. So when a request
DOES require execution, do NOT refuse, hedge, or say "run it locally" — run it
and report what actually happened, including real failures ("scan returned no
hosts because the sandbox can't reach 192.168.0.0/16; RFC1918 is intentionally
blocked" is a good, on-topic answer).

When unsure whether you need it: answer directly first, and only escalate to
the sandbox if you find you genuinely cannot produce a correct answer without
executing. A teaching request — "show me the syntax for", "give an example of",
"how would I…" — is NOT an execution request; answer it directly.

You don't need permission to use the sandbox; the user pre-consented. If you
did run something, surface it in one short sentence with the result. Don't
prefix your reply with a personality header; don't paste long code (it's
auto-attached via reaction reveal).
```

**Boundary/interface:** unchanged — still a module-level string constant `TOOL_AVAILABILITY_PREAMBLE` in `agent.py`, concatenated into the ADK `Agent(instruction=…)`. No signature or wiring change.

---

## Component 2 — Offline eval harness

**Location:** `agent-sidecar/eval/`
- `sandbox_eval_set.py` (or `.json`) — the labeled prompt set.
- `eval_sandbox_invocation.py` — the runner + scorer.

**Labeled set (~30 prompts):** each `{prompt, expect}` where `expect ∈ {"direct", "sandbox"}`. Balanced across categories:
- `direct`: arithmetic ("what's 2+7"), concept explanation ("explain how TCP handshake works"), code example/syntax ("show me the Python syntax for a list comprehension"), opinion/social ("what do you think of tabs vs spaces"), known facts ("what port does SSH use"), small deterministic transforms ("reverse the string 'hello'").
- `sandbox`: real recon ("nmap the top 100 ports on scanme.nmap.org"), live fetch ("what headers does https://example.com return"), compute-over-data ("sha256 of this 2KB blob: …"), runtime behavior ("does this snippet compile and what does it print: …"), benchmarking ("time how long sorting 1e6 ints takes in python").

**Runner mechanics:**
- Build the **real** `ChannelVoiceAgent` (real prompt, real model = live `AGENT_MODEL` on GEAP) but inject a **fake `SandboxOrchestrator`** whose `.run(...)` records the call and returns a canned success result instantly (no pod). This measures the genuine tool-invocation *decision* with zero sandbox latency/cost.
  - The fake returns a plausible `RunResult` (exit_code 0, short stdout, an `execution_id`) so multi-call turns still terminate.
- For each prompt: run `process_chat` **N times** (default 3) to account for stochasticity; record `invoked = len(result.execution_ids) > 0` each run.
- **Score:**
  - false-invocation rate = (direct-labeled runs where invoked) / (direct-labeled runs)
  - false-omission rate = (sandbox-labeled runs where NOT invoked) / (sandbox-labeled runs)
  - Per-prompt breakdown + aggregate, printed as a scorecard; nonzero exit if false-invocation exceeds a configurable threshold (for CI-ability).

**Auth/cost:** runs locally against GEAP using `agent-sidecar/genai-sa-key.json` (env: `GOOGLE_GENAI_USE_VERTEXAI=true`, project, `location=global`). Full run ≈ 30 prompts × 3 = ~90 model calls; a few cents. Precedent: `scripts/eval-recall.js`.

**Interface:** `python -m eval.eval_sandbox_invocation [--runs N] [--threshold 0.15]` prints the scorecard and exits nonzero on threshold breach.

---

## Component 3 — Dynatrace production metric

**Telemetry:** in the gRPC `Chat` handler (`server.py`), after the agent returns, set attributes on the current (gRPC-auto-instrumented) span:
- `sandbox.invoked` (bool) = `execution_count > 0`
- `sandbox.call_count` (int) = `execution_count`

`ExecutionSummary.execution_count` already carries this — we just surface it on the span so it lands in Dynatrace via the existing OTLP export.

**Query (DQL):** aggregate over the Chat spans — fraction of turns with `sandbox.invoked = true` and avg `sandbox.call_count`, bucketed by time, to compare a window before the deploy vs. after. (Exact DQL authored during implementation against the live span/field names.)

**Validation flow:** capture a baseline reading (current preamble) if any recent traffic exists; deploy the tuned preamble; after organic traffic accumulates, confirm the per-turn invocation rate dropped. The offline harness is the fast loop; Dynatrace is the slower production confirmation.

---

## Component 4 — Discord manual test prompts

The labeled eval set doubles as the manual test list. Deliverable: a curated ~10-prompt subset (paired direct vs. sandbox) with the expected behavior per prompt, handed to the user to run in Discord and eyeball — instant reply (direct) vs. visible sandbox run.

---

## File structure summary
- **Modify:** `agent-sidecar/src/agent.py` — replace `TOOL_AVAILABILITY_PREAMBLE`.
- **Modify:** `agent-sidecar/src/server.py` — add `sandbox.invoked`/`sandbox.call_count` span attributes in `Chat`.
- **Create:** `agent-sidecar/eval/__init__.py`, `agent-sidecar/eval/sandbox_eval_set.py`, `agent-sidecar/eval/eval_sandbox_invocation.py`.
- **Create/Modify tests:** `agent-sidecar/tests/test_sandbox_eval_harness.py` (harness scoring logic with a stub agent — deterministic, no live model), and a `test_server` addition asserting the span attributes are set.
- **Docs:** update `CLAUDE.md` Agentic Sandbox section (tuned disposition + how to run the eval harness).

## Testing strategy
- **Unit (deterministic, no live model):** the harness's scoring function (given recorded invocations + labels → correct rates); the fake orchestrator records calls; the span-attribute wiring in `Chat`.
- **Live (manual / on-demand):** the full offline eval run against GEAP (measures the real decision); the Discord manual prompts.
- Do NOT gate CI on the live eval (costs money, needs creds); it's an on-demand tuning tool.
