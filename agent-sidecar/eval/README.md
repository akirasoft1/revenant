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
where no `sc_*` tool may be called at all. Prompts flagged `uncovered_sc` are Star Citizen questions no `sc_*` tool covers (stock vehicle loadouts, crafting — a member's own loadout is covered by the hangar tools): they are excluded from `tool_hit_rate` and `control_false_sc_calls`, but still count toward the sandbox hard gate and the mid-run outage check, and the report prints a soft `NO WEB SEARCH in N/M runs` flag when the model answered them without `google_search` (a hint it may have answered from memory — not a failing gate). Prompts flagged `sc_dispute` are scored the same way (same exclusions, same sandbox/outage gates, same soft `NO WEB SEARCH` flag, labelled `sc-dispute` in the report) but carry an optional `history` list of `{role, content}` turns that `eval_sc.py` forwards to `process_chat(history=...)`: the replayed exchange has the bot asserting a Star Citizen mechanic from stale memory (1000 m/s is "just afterburner", quantum drive is "only for jumping") and the prompt is the player disputing it from what they see in-game. The expected behaviour — per the dispute rule in the SC preamble — is to search again (or defer to the player's observation), not to repeat the claim; a `NO WEB SEARCH` flag on it means the model argued from memory (2026-09-29 voice incident). Any case may carry `history`; cases without it run as single-turn prompts exactly as before. `eval/eval_sc.py` builds the
**real** `ChannelVoiceAgent` wired to the **real** sc-knowledge MCP server
(via `build_mcp_toolsets("channel_voice", ...)` + `ScToolsProvider`) but a
**fake** sandbox orchestrator (`eval.harness.FakeOrchestrator`) — so a
sandbox attempt is still counted (via `AgentChatResult.sandbox_attempts`)
without ever spinning up a pod. Each prompt runs `--runs` times and
`score_sc()` reports:

- `tool_hit_rate` — share of SC prompts whose `expect_tool` was actually
  called (from `AgentChatResult.sc_tool_names`).
- `control_false_sc_calls` — count of control prompts that called any
  `sc_*` tool at all (should be 0). The member-hangar tools are `sc_*` too,
  so a control calling one counts here.
- `unprompted_hangar_calls` — count of runs of any case NOT flagged `hangar`
  (controls, other SC prompts, uncovered/dispute) that called
  `sc_member_hangar` or `sc_member_fit_check` (should be 0; see below).
- `sandbox_attempts_total` — sum of sandbox attempts across every prompt in
  the set, SC and control alike (must be 0).

**Preflight, and why it's not optional:** before spending a single model
call, `eval_sc.py` probes the sc-knowledge tools the same way production
does (`ScToolsProvider.enabled` + `await .available()`). Without this check,
a forgotten port-forward (or `SC_KNOWLEDGE_ENABLED` left unset) makes *every*
turn silently run with `sc_state="unavailable"` — no `sc_*` tool ever
attached — and the run finishes with a normal-looking `tool_hit_rate: 0.0%`
scorecard after burning real GEAP spend on every prompt in the set, indistinguishable
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

Otherwise it exits **1** if **any** of the four scoring gates hold:

1. `sandbox_attempts_total > 0` — hard gate: any sandbox attempt on ANY
   prompt in the set (SC or control) fails the run outright, regardless of
   `--min-hit`.
2. `tool_hit_rate < --min-hit` (default `0.9`).
3. `control_false_sc_calls > 0` — a control prompt called an `sc_*` tool it
   had no business calling.
4. `unprompted_hangar_calls > 0` — a member's ships were looked up for a
   question that wasn't about them.

Exit **0** only when preflight passed, no mid-run outage occurred, and all
four gates pass.

### Member-hangar cases (2026-10-09)

Cases flagged `hangar: True` exercise `sc_member_hangar` /
`sc_member_fit_check` (spec `docs/superpowers/specs/2026-10-09-member-hangar-design.md`)
against the **real** hangar-service on Cloud Run, reached through the real
sc-knowledge. They read two **fake** members (no Discord account has these
ids):

| member id | name in the eval | ships (nickname) |
|---|---|---|
| `100000000000000001` | Akira (the speaker) | Vanguard Harbinger ("Harby"), Constellation Taurus ("Connie") |
| `100000000000000002` | Micro | Avenger Titan |

Each case mirrors what the bot sends in production
(`ChatService.buildTurnContext`): the prompt carries the speaker label
(`[Akira · 100000000000000001]: …`) and the case's `system_prompt` is the
base prompt plus the "People in this conversation" roster in the exact
`services/identity/roster.js` format (`eval_system_prompt()` in
`sc_eval_set.py`; a unit test pins the format). `eval_sc.py` forwards
`system_prompt` and `history` to `process_chat`.

| prompt (after the label) | expect_tool | expect_member_id |
|---|---|---|
| what's a purchasable upgraded shield for my Harbinger? | `sc_member_hangar` | …001 |
| I just looted a Hemera quantum drive, is it a usable upgrade for any of my ships? | `sc_member_fit_check` | …001 |
| I can't use this Hemera, can Micro? (history establishes the Hemera; roster maps Micro) | `sc_member_fit_check` | …002 |
| what's on my Connie? | `sc_member_hangar` | …001 |

A hangar case is a **hit** only when the expected tool was called with the
expected `member_id` argument (`AgentChatResult.sc_tool_calls` records each
sc_* call's name and args) — a fit check on Akira's ships for the Micro
question is a miss. The report prints the `member_ids` the model actually
used. The UC1 case (`expect_purchasable_compare`) also gets a **soft** flag —
`NO purchasable_only COMPARE after the hangar call in N/M runs` — when no
`sc_compare_components(purchasable_only=True)` call followed the
`sc_member_hangar` call; it is reported, never gated. The report's prompt
column strips the `[Name · id]: ` label. Two more roster-carrying cases are NOT about anyone's ships (a size-3
shield ranking that expects `sc_compare_components`, and a dinner question
control); together with every other non-hangar case they feed
`unprompted_hangar_calls`.

**Seed before, clean up after.** `eval/seed_hangar_eval.py` is standalone
(stdlib + google-auth), so pipe it into the **sc-knowledge** pod, which
mounts the `hangar-api-sa` key, has `HANGAR_API_URL`, and has Python +
google-auth. Not the bot pod: it mounts the key too, but the bot image is
Node-only (no Python, no google-auth).

```bash
# piped over stdin: no kubectl cp, works on a read-only root filesystem
kubectl exec -i -n discord-article-bot deploy/sc-knowledge -- \
  python - --seed < agent-sidecar/eval/seed_hangar_eval.py
# ... run the eval ...
kubectl exec -i -n discord-article-bot deploy/sc-knowledge -- \
  python - --cleanup < agent-sidecar/eval/seed_hangar_eval.py
```

It mints an ID token from `HANGAR_SA_KEY_PATH` (default
`/var/secrets/hangar/key.json`) with audience `HANGAR_API_URL` and writes
through the real API as each member (`X-Acting-Member` = the member's own
id, so no admin id is needed). `--seed` is idempotent (skips a model the
member already owns); `--cleanup` deletes every ship of both fake members.
Exit 1 names the failing request and its HTTP status/body; exit 2 means
`HANGAR_API_URL` is unset. Without seeding, the model still calls the
hangar tools (so `tool_hit_rate` still measures selection), but the answers
are about an empty hangar. The sc-knowledge response cache is 30s, so wait
that long after seeding if a probe already read the hangar.

Do NOT wire into CI (needs creds + spend + a live port-forward); it's an
on-demand tuning/regression tool, run the same way as
`eval_sandbox_invocation.py`.
