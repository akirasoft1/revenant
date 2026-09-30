"""Run the real agent (fake orchestrator, real sc-knowledge MCP server) over
the labeled Star Citizen case set and score tool-selection accuracy, with a
hard gate: any sandbox attempt on one of these prompts fails the run (spec
Section 6, layer 3 -- SC data must never come from the sandbox).

Usage:
  cd agent-sidecar
  kubectl port-forward svc/sc-knowledge 18080:8080 -n discord-article-bot &
  SC_KNOWLEDGE_URL=http://127.0.0.1:18080/mcp \
  GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 \
  GOOGLE_CLOUD_LOCATION=global GOOGLE_APPLICATION_CREDENTIALS=./genai-sa-key.json \
  .venv/bin/python -m eval.eval_sc --runs 3 --min-hit 0.9
"""
import argparse
import asyncio
import os
import sys

# config.load() requires a few env vars the eval never uses (fake
# orchestrator, no Mongo/k8s). Default them so the harness is
# self-contained. AGENT_MODEL defaults to the production model so the eval
# measures the real decision. SC_KNOWLEDGE_ENABLED/URL default to the
# documented port-forward target -- override SC_KNOWLEDGE_URL if forwarding
# to a different local port.
os.environ.setdefault("MONGO_URI", "mongodb://unused/eval")
os.environ.setdefault("SANDBOX_BASE_IMAGE", "unused")
os.environ.setdefault("AGENT_MODEL", "gemini-3.8-flash")
os.environ.setdefault("SC_KNOWLEDGE_ENABLED", "true")
os.environ.setdefault("SC_KNOWLEDGE_URL", "http://127.0.0.1:18080/mcp")

from src.agent import AgentChatResult, ChannelVoiceAgent  # noqa: E402
from src.config import load  # noqa: E402
from src.mcp_registry import build_mcp_toolsets  # noqa: E402
from src.sc_tools import ScToolsProvider, health_url_for  # noqa: E402
from eval.harness import FakeOrchestrator  # noqa: E402
from eval.sc_eval_set import SC_EVAL_SET  # noqa: E402

_BASE_PROMPT = "You are a helpful assistant in a private Discord channel."


def _is_soft_sc(case: dict) -> bool:
    """SC prompts no sc_* tool is expected to answer: `uncovered_sc` (no tool
    covers the topic) and `sc_dispute` (a player disputes a mechanics claim).
    Not controls, not in tool_hit_rate; still in the sandbox gate + outage
    check; reported with the soft NO WEB SEARCH flag."""
    return bool(case.get("uncovered_sc") or case.get("sc_dispute"))


def _chat_kwargs(case: dict) -> dict:
    """process_chat kwargs for one case; `history` only when the case has one."""
    kwargs = {"user_id": "eval", "user_message": case["prompt"]}
    if case.get("history"):
        kwargs["history"] = case["history"]
    return kwargs


def score_sc(records: list[tuple[dict, AgentChatResult]]) -> dict:
    """records: list of (case, result) where case is an SC_EVAL_SET entry
    (`{"prompt": str, "expect_tool": str | None}`) and result is the
    corresponding AgentChatResult.

    - sandbox_attempts_total: sum of `sandbox_attempts` across ALL records --
      the hard gate. SC prompts must be answered via sc_* tools, never the
      sandbox, so any nonzero total fails the run regardless of which
      prompt it came from.
    - tool_hit_rate: share of SC prompts (`expect_tool is not None`) whose
      `expect_tool` appears in `result.sc_tool_names`.
    - control_false_sc_calls: count of control prompts (`expect_tool is
      None` and neither `uncovered_sc` nor `sc_dispute`) that called ANY
      sc_* tool. Uncovered-SC / dispute prompts are excluded here (an sc_*
      attempt on them is reasonable) but still count toward
      sandbox_attempts_total.
    """
    sandbox_attempts_total = sum(r.sandbox_attempts for _, r in records)
    sc_cases = [(c, r) for c, r in records if c.get("expect_tool") is not None]
    hits = sum(1 for c, r in sc_cases if c["expect_tool"] in r.sc_tool_names)
    tool_hit_rate = (hits / len(sc_cases)) if sc_cases else 0.0
    control_false_sc_calls = sum(
        1 for c, r in records
        if c.get("expect_tool") is None and not _is_soft_sc(c) and r.sc_tool_names
    )
    return {
        "sandbox_attempts_total": sandbox_attempts_total,
        "tool_hit_rate": tool_hit_rate,
        "control_false_sc_calls": control_false_sc_calls,
    }


def _build() -> tuple[ChannelVoiceAgent, ScToolsProvider, str]:
    config = load()
    toolsets = build_mcp_toolsets("channel_voice", config)
    sc_tools = ScToolsProvider(toolsets, health_url_for(config.sc_knowledge_url))
    agent = ChannelVoiceAgent(
        config=config,
        orchestrator=FakeOrchestrator(),
        base_system_prompt=_BASE_PROMPT,
        sc_tools=sc_tools,
    )
    return agent, sc_tools, config.sc_knowledge_url


def _preflight_fail(url: str, reason: str) -> None:
    print(f"eval_sc: PREFLIGHT FAILED -- {reason}", file=sys.stderr)
    print(f"  SC_KNOWLEDGE_URL={url}", file=sys.stderr)
    print("  Start the port-forward and retry:", file=sys.stderr)
    print("    kubectl port-forward svc/sc-knowledge 18080:8080 -n discord-article-bot &", file=sys.stderr)
    print("    export SC_KNOWLEDGE_URL=http://127.0.0.1:18080/mcp", file=sys.stderr)
    sys.exit(2)


async def _preflight(sc_tools: ScToolsProvider, sc_knowledge_url: str) -> None:
    """Fail fast and loud, BEFORE any model call, if the sc-knowledge tools
    aren't actually reachable. Without this, a forgotten port-forward (or
    SC_KNOWLEDGE_ENABLED left unset) makes every turn silently run with
    sc_state "unavailable" -- no sc_* tool attached at all -- and the run
    finishes with a normal-looking 0% tool_hit_rate scorecard,
    indistinguishable from a real model regression, only after burning real
    GEAP spend on every prompt in the set. Exit code 2 (distinct from the
    gate-failure exit 1) means "the eval itself couldn't run", not "the
    model failed the eval"."""
    if not sc_tools.enabled:
        _preflight_fail(
            sc_knowledge_url,
            "sc tools disabled or unconfigured -- SC_KNOWLEDGE_ENABLED is not true, "
            "or no sc-knowledge toolsets were built",
        )
    if not await sc_tools.available():
        _preflight_fail(sc_knowledge_url, "health probe or MCP sc_* tool listing failed -- sc-knowledge is unreachable or its /mcp path is rejecting requests")


def _sc_prompts_with_outage(records: list[tuple[dict, AgentChatResult]]) -> list[str]:
    """Prompts among the *SC* prompts (expect_tool is not None, or flagged
    uncovered_sc / sc_dispute) whose result
    ran with sc_state != "available" -- i.e. sc-knowledge went unhealthy
    partway through the run (the health-probe TTL expired into an outage
    after preflight passed). Without this check these turns look like
    ordinary tool misses in tool_hit_rate rather than the infra problem they
    actually are."""
    return [
        c["prompt"] for c, r in records
        if (c.get("expect_tool") is not None or _is_soft_sc(c)) and r.sc_state != "available"
    ]


async def _run(runs: int) -> list[tuple[dict, AgentChatResult]]:
    agent, sc_tools, sc_knowledge_url = _build()
    await _preflight(sc_tools, sc_knowledge_url)
    records: list[tuple[dict, AgentChatResult]] = []
    for case in SC_EVAL_SET:
        for _ in range(runs):
            result = await agent.process_chat(**_chat_kwargs(case))
            records.append((case, result))
    return records


def _print_report(records: list[tuple[dict, AgentChatResult]], runs: int, min_hit: float,
                   score: dict, outages: list[str]) -> None:
    print(f"\n=== per-prompt results (runs={runs}) ===")
    for case in SC_EVAL_SET:
        case_records = [r for c, r in records if c is case]
        expect = case["expect_tool"]
        states = ",".join(sorted({r.sc_state for r in case_records})) if case_records else "?"
        searches = ",".join(str(getattr(r, "web_search_queries", 0)) for r in case_records)
        if expect is not None:
            hit_n = sum(1 for r in case_records if expect in r.sc_tool_names)
            rate = hit_n / len(case_records) if case_records else 0.0
            flag = "  <-- MISS" if rate < 1.0 else ""
            print(f"  [{expect:22}] {rate:4.0%}  sc_state={states:<12} {case['prompt'][:50]}{flag}")
        elif _is_soft_sc(case):
            label = "sc-dispute" if case.get("sc_dispute") else "uncovered-sc"
            called = ",".join(sorted({n for r in case_records for n in r.sc_tool_names})) or "none"
            no_search = sum(1 for r in case_records if not getattr(r, "web_search_queries", 0))
            # Soft signal, not a gate: an uncovered SC question -- or a player
            # disputing a mechanics claim -- should normally go to
            # google_search rather than an unconfirmed-memory answer.
            flag = f"  <-- NO WEB SEARCH in {no_search}/{len(case_records)} runs" if no_search else ""
            print(f"  [{label:22}] {'--':>4}  sc_state={states:<12} {case['prompt'][:50]}  sc_calls={called}{flag}")
        else:
            bad_n = sum(1 for r in case_records if r.sc_tool_names)
            flag = "  <-- FALSE SC CALL" if bad_n else ""
            print(f"  [{'control':22}] {'--':>4}  sc_state={states:<12} {case['prompt'][:50]}{flag}")
        print(f"      web_search.queries per run: [{searches}]")
        sandbox_n = sum(r.sandbox_attempts for r in case_records)
        if sandbox_n:
            print(f"      sandbox_attempts={sandbox_n}  <-- HARD GATE VIOLATION")

    print("\n=== scorecard ===")
    print(f"  tool_hit_rate:          {score['tool_hit_rate']:5.1%}  (target >= {min_hit:.0%})")
    print(f"  control_false_sc_calls: {score['control_false_sc_calls']}  (target 0)")
    print(f"  sandbox_attempts_total: {score['sandbox_attempts_total']}  (hard gate: must be 0)")
    if outages:
        print(f"  WARNING: {len(outages)} SC prompt run(s) executed with sc tools NOT available "
              f"(sc_state != 'available') -- these results are not a valid model measurement:")
        for p in outages:
            print(f"    - {p}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--min-hit", type=float, default=0.9)
    args = ap.parse_args()

    records = asyncio.run(_run(args.runs))
    score = score_sc(records)
    outages = _sc_prompts_with_outage(records)
    _print_report(records, args.runs, args.min_hit, score, outages)

    if outages:
        # A mid-run outage invalidates the measurement itself -- report it
        # distinctly from a gate failure (exit 1) so it's never mistaken for
        # a model regression.
        sys.exit(2)

    failed = (
        score["sandbox_attempts_total"] > 0
        or score["tool_hit_rate"] < args.min_hit
        or score["control_false_sc_calls"] > 0
    )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
