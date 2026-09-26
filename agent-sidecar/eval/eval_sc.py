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
      None`) that called ANY sc_* tool.
    """
    sandbox_attempts_total = sum(r.sandbox_attempts for _, r in records)
    sc_cases = [(c, r) for c, r in records if c.get("expect_tool") is not None]
    hits = sum(1 for c, r in sc_cases if c["expect_tool"] in r.sc_tool_names)
    tool_hit_rate = (hits / len(sc_cases)) if sc_cases else 0.0
    control_false_sc_calls = sum(
        1 for c, r in records if c.get("expect_tool") is None and r.sc_tool_names
    )
    return {
        "sandbox_attempts_total": sandbox_attempts_total,
        "tool_hit_rate": tool_hit_rate,
        "control_false_sc_calls": control_false_sc_calls,
    }


def _build_agent() -> ChannelVoiceAgent:
    config = load()
    toolsets = build_mcp_toolsets("channel_voice", config)
    sc_tools = ScToolsProvider(toolsets, health_url_for(config.sc_knowledge_url))
    return ChannelVoiceAgent(
        config=config,
        orchestrator=FakeOrchestrator(),
        base_system_prompt=_BASE_PROMPT,
        sc_tools=sc_tools,
    )


async def _run(runs: int) -> list[tuple[dict, AgentChatResult]]:
    agent = _build_agent()
    records: list[tuple[dict, AgentChatResult]] = []
    for case in SC_EVAL_SET:
        for _ in range(runs):
            result = await agent.process_chat(user_id="eval", user_message=case["prompt"])
            records.append((case, result))
    return records


def _print_report(records: list[tuple[dict, AgentChatResult]], runs: int, min_hit: float, score: dict) -> None:
    print(f"\n=== per-prompt results (runs={runs}) ===")
    for case in SC_EVAL_SET:
        case_records = [r for c, r in records if c is case]
        expect = case["expect_tool"]
        if expect is not None:
            hit_n = sum(1 for r in case_records if expect in r.sc_tool_names)
            rate = hit_n / len(case_records) if case_records else 0.0
            flag = "  <-- MISS" if rate < 1.0 else ""
            print(f"  [{expect:22}] {rate:4.0%}  {case['prompt'][:58]}{flag}")
        else:
            bad_n = sum(1 for r in case_records if r.sc_tool_names)
            flag = "  <-- FALSE SC CALL" if bad_n else ""
            print(f"  [{'control':22}] {'--':>4}  {case['prompt'][:58]}{flag}")
        sandbox_n = sum(r.sandbox_attempts for r in case_records)
        if sandbox_n:
            print(f"      sandbox_attempts={sandbox_n}  <-- HARD GATE VIOLATION")

    print("\n=== scorecard ===")
    print(f"  tool_hit_rate:          {score['tool_hit_rate']:5.1%}  (target >= {min_hit:.0%})")
    print(f"  control_false_sc_calls: {score['control_false_sc_calls']}  (target 0)")
    print(f"  sandbox_attempts_total: {score['sandbox_attempts_total']}  (hard gate: must be 0)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--min-hit", type=float, default=0.9)
    args = ap.parse_args()

    records = asyncio.run(_run(args.runs))
    score = score_sc(records)
    _print_report(records, args.runs, args.min_hit, score)

    failed = (
        score["sandbox_attempts_total"] > 0
        or score["tool_hit_rate"] < args.min_hit
        or score["control_false_sc_calls"] > 0
    )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
