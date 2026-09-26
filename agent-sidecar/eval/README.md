# Sandbox-invocation eval harness

Measures how often the channel-voice agent invokes `run_in_sandbox`, to tune the
agent away from spinning up a pod for asks it could answer directly (a latency
problem). See `docs/superpowers/specs/2026-08-06-sandbox-invocation-tuning-design.md`.

## How it works

The runner builds the **real** `ChannelVoiceAgent` (real `TOOL_AVAILABILITY_PREAMBLE`,
real model) but injects a **fake orchestrator** — so the tool-invocation *decision*
is measured with zero pods spun up. Each labeled prompt is run N times; we score:

- **false-invocation rate** — `direct`-labeled prompts that fired the sandbox (the latency pain; the number we're driving down).
- **false-omission rate** — `sandbox`-labeled prompts that did *not* fire it (the regression guard: don't over-correct into refusing to run things that need it).

## Run it

Requires GEAP creds (the sidecar SA key). From `agent-sidecar/`:

```bash
GOOGLE_APPLICATION_CREDENTIALS=$PWD/genai-sa-key.json \
GOOGLE_GENAI_USE_VERTEXAI=true \
GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 \
GOOGLE_CLOUD_LOCATION=global \
.venv/bin/python -m eval.eval_sandbox_invocation --runs 3 --threshold 0.15
```

Exits nonzero if false-invocation exceeds `--threshold`. `AGENT_MODEL` defaults to
the production model (`gemini-3.8-flash`); override via env to test another.
Cost: ~30 prompts × N runs of `gemini-3.8-flash` — a few cents. Do NOT wire into
CI (needs creds + spend); it's an on-demand tuning tool.

## Context-dependent classes (2026-08-08, unified-chat-context)

Since Task 3, `process_chat` accepts bot-supplied `system_prompt`, `memory_context`,
and `history` — the agent's direct-vs-sandbox decision can depend on that context,
not just the bare prompt. Two classes slipped through the original (context-free)
set because they only look like they need "doing" in isolation:

- **Document/authoring asks** — "draft/craft a doc", "write up X". These read as
  produce-an-artifact requests but are answerable directly (composing text needs
  no execution).
- **Context-dependent asks** — "based on our earlier discussion of X, draft
  section 2(a)." Whether this is answerable directly depends on whether the
  referenced context is actually present in `memory_context`/`history`.

`EVAL_SET` entries for these classes carry an optional `"context"` dict
(`system_prompt`/`memory_context`/`history`) with representative content, and
`_invoked_once(case)` threads it into `process_chat(...)` — without this, the
eval would run these prompts context-free, which doesn't reflect production
(the bot always supplies a context-rich brain) and can score misleadingly.
Entries without a `"context"` key still work: `_invoked_once` defaults to
empty string/list, matching `process_chat`'s own backward-compat fallback.

**A full live run (`--runs`, needs GEAP creds) must score all of these classes
`direct`** — a `direct`-labeled document/authoring or context-dependent prompt
that fires the sandbox is a false-invocation like any other and should be
investigated the same way (prompt tuning first, per the design doc).

## Result (2026-08-06 preamble rewrite)

| metric | before (aggressive preamble) | after (answer-directly-by-default) |
|---|---|---|
| false-invocation | **45.8%** | **0.0%** |
| false-omission | 0.0% | 2.4% (one borderline stochastic case) |

## Production validation (Dynatrace)

The `Chat` handler emits an `agent.chat` span with `sandbox.invoked` (bool) and
`sandbox.call_count` (int). Query the per-turn invocation rate over time to
confirm the offline win holds in real traffic.

## Discord manual test list

Paste these into the channel and eyeball the behavior. `direct` should reply
**instantly, no sandbox**; `sandbox` should visibly run.

**Should answer directly (instant):**
- what's 2 + 7?
- explain how the TCP three-way handshake works
- show me the Python syntax for a list comprehension
- what port does SSH listen on by default?
- reverse the string 'hello' for me
- give me an example of a bash for-loop

**Should run the sandbox:**
- nmap the top 100 ports on scanme.nmap.org and tell me what's open
- what HTTP response headers does https://example.com return?
- compute the sha256 of the exact string 'correct horse battery staple'
- run this and tell me the EXACT output: `import random; random.seed(42); print(random.random())`
- resolve the A records for github.com

## Star Citizen tools eval (hard gate)

Measures whether the channel-voice agent picks the right `sc_*` tool for Star
Citizen questions, and — the part that actually gates the run — that it
**never** answers an SC question by writing code and running it in the
sandbox. Sandbox execution is not just wrong for this data, it's the
scenario the `sc_state`/`SC_TOOLS_PREAMBLE` wiring and the sandbox's own
data-host refusal (see `git log` for "refuse sandbox runs that target Star
Citizen data hosts") exist to prevent — this eval is the regression guard for
that guarantee, spec §6 layer 3 (defense in depth: prompt says don't, the
sandbox refuses the known hosts anyway, and this eval proves the model isn't
even trying).

### How it works

`eval/sc_eval_set.py` (`SC_EVAL_SET`) labels each prompt with the `sc_*` tool
that must be called (`expect_tool`), or `None` for a non-SC control prompt
where no `sc_*` tool may be called at all. `eval/eval_sc.py` builds the
**real** `ChannelVoiceAgent` wired to the **real** sc-knowledge MCP server
(via `build_mcp_toolsets("channel_voice", ...)` + `ScToolsProvider`) but a
**fake** sandbox orchestrator (`eval.harness.FakeOrchestrator`) — so a
sandbox attempt is still counted (via `AgentChatResult.sandbox_attempts`)
without ever spinning up a pod. Each prompt runs `--runs` times and
`score_sc()` reports:

- `tool_hit_rate` — share of SC prompts whose `expect_tool` was actually
  called (from `AgentChatResult.sc_tool_names`).
- `control_false_sc_calls` — count of control prompts that called any
  `sc_*` tool at all (should be 0).
- `sandbox_attempts_total` — sum of sandbox attempts across every prompt in
  the set, SC and control alike (must be 0).

**Preflight, and why it's not optional:** before spending a single model
call, `eval_sc.py` probes the sc-knowledge tools the same way production
does (`ScToolsProvider.enabled` + `await .available()`). Without this check,
a forgotten port-forward (or `SC_KNOWLEDGE_ENABLED` left unset) makes *every*
turn silently run with `sc_state="unavailable"` — no `sc_*` tool ever
attached — and the run finishes with a normal-looking `tool_hit_rate: 0.0%`
scorecard after burning real GEAP spend on all 20 prompts, indistinguishable
from an actual model regression. Preflight failure prints the
`SC_KNOWLEDGE_URL` in effect and the port-forward command to stderr and
exits **2** immediately, before any prompt runs. The same `sc_state` is also
recorded per-result and re-checked after the run: if the probe passed at
preflight but any SC prompt (not a control) ran with `sc_state !=
"available"` — the server went unhealthy mid-run — the scorecard prints a
warning naming the affected prompts and the run exits **2** as well, so a
mid-run outage is never mistaken for a `tool_hit_rate` miss.

### Run it

Requires the sc-knowledge server reachable and GEAP creds. Port-forward the
in-cluster service first:

```bash
kubectl port-forward svc/sc-knowledge 18080:8080 -n discord-article-bot &
```

Then, from `agent-sidecar/`:

```bash
SC_KNOWLEDGE_URL=http://127.0.0.1:18080/mcp \
GOOGLE_APPLICATION_CREDENTIALS=$PWD/genai-sa-key.json \
GOOGLE_GENAI_USE_VERTEXAI=true \
GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 \
GOOGLE_CLOUD_LOCATION=global \
.venv/bin/python -m eval.eval_sc --runs 3 --min-hit 0.9
```

`SC_KNOWLEDGE_ENABLED` and `SC_KNOWLEDGE_URL` are defaulted (`true` /
`http://127.0.0.1:18080/mcp`) to match the port-forward above so the command
above is the common case; override `SC_KNOWLEDGE_URL` if forwarding to a
different local port. `AGENT_MODEL` defaults to the production model
(`gemini-3.8-flash`).

### Exit codes

`python -m eval.eval_sc` exits **2** — "the eval itself couldn't run", never
mistake this for a model result — if:

- Preflight fails: sc tools disabled/unconfigured, or the health probe
  can't reach `SC_KNOWLEDGE_URL` (fix: check the port-forward). No prompts
  run at all in this case.
- Any SC prompt (not a control) executed with `sc_state != "available"` —
  a mid-run outage after preflight passed.

Otherwise it exits **1** if **any** of the three scoring gates hold:

1. `sandbox_attempts_total > 0` — hard gate: any sandbox attempt on ANY
   prompt in the set (SC or control) fails the run outright, regardless of
   `--min-hit`.
2. `tool_hit_rate < --min-hit` (default `0.9`).
3. `control_false_sc_calls > 0` — a control prompt called an `sc_*` tool it
   had no business calling.

Exit **0** only when preflight passed, no mid-run outage occurred, and all
three gates pass.

Do NOT wire into CI (needs creds + spend + a live port-forward); it's an
on-demand tuning/regression tool, run the same way as
`eval_sandbox_invocation.py`.
