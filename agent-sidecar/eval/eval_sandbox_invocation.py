"""Run the real agent (fake orchestrator) over the labeled set and score the
sandbox-invocation decision.

Usage:
  cd agent-sidecar && .venv/bin/python -m eval.eval_sandbox_invocation --runs 3 --threshold 0.15

Requires GEAP env:
  GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 \
  GOOGLE_CLOUD_LOCATION=global GOOGLE_APPLICATION_CREDENTIALS=./genai-sa-key.json
"""
import argparse
import asyncio
import os
import sys

# config.load() requires a few env vars the eval never uses (fake orchestrator,
# no Mongo/k8s). Default them so the harness is self-contained. AGENT_MODEL
# defaults to the production model so the eval measures the real decision.
os.environ.setdefault("MONGO_URI", "mongodb://unused/eval")
os.environ.setdefault("SANDBOX_BASE_IMAGE", "unused")
os.environ.setdefault("AGENT_MODEL", "gemini-3.6-flash")

from src.agent import ChannelVoiceAgent  # noqa: E402
from src.config import load  # noqa: E402
from eval.harness import FakeOrchestrator, score  # noqa: E402
from eval.sandbox_eval_set import EVAL_SET  # noqa: E402

_BASE_PROMPT = "You are a helpful assistant in a private Discord channel."


async def _invoked_once(case: dict) -> bool:
    ctx = case.get("context") or {}
    fo = FakeOrchestrator()
    agent = ChannelVoiceAgent(config=load(), orchestrator=fo, base_system_prompt=_BASE_PROMPT)
    res = await agent.process_chat(
        user_id="eval", user_message=case["prompt"],
        system_prompt=ctx.get("system_prompt", ""), memory_context=ctx.get("memory_context", ""),
        history=ctx.get("history", []))
    return len(res.execution_ids) > 0


async def _run(runs: int):
    records: list[tuple[str, bool]] = []
    per_prompt = []
    for item in EVAL_SET:
        invs = [await _invoked_once(item) for _ in range(runs)]
        per_prompt.append((item, sum(invs) / runs))
        records.extend((item["expect"], inv) for inv in invs)
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
        if item["expect"] == "direct" and rate > 0:
            flag = "  <-- FALSE INVOCATION"
        if item["expect"] == "sandbox" and rate < 1:
            flag = "  <-- FALSE OMISSION"
        print(f"  [{item['expect']:7}] {rate:4.0%}  {item['prompt'][:58]}{flag}")

    print("\n=== scorecard ===")
    print(f"  false-invocation: {s.false_invocation_rate:5.1%}  (target <= {args.threshold:.0%})   over {s.n_direct} direct prompts")
    print(f"  false-omission:   {s.false_omission_rate:5.1%}  (target ~ 0%)             over {s.n_sandbox} sandbox prompts")
    sys.exit(1 if s.false_invocation_rate > args.threshold else 0)


if __name__ == "__main__":
    main()
