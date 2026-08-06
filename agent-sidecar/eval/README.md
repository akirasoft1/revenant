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
the production model (`gemini-3.6-flash`); override via env to test another.
Cost: ~30 prompts × N runs of `gemini-3.6-flash` — a few cents. Do NOT wire into
CI (needs creds + spend); it's an on-demand tuning tool.

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
