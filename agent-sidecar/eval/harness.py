"""Offline eval harness for the sandbox-invocation decision.

Runs the real ChannelVoiceAgent (real prompt + model) against a fake
orchestrator so the tool-invocation *decision* is measured without spinning up
any pods.
"""
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
            execution_id=f"fake-{self.calls}",
            exit_code=0,
            stdout="(fake sandbox output)",
            stderr="",
            stdout_truncated=False,
            stderr_truncated=False,
            duration_ms=1,
            schedule_wait_ms=0,
            timed_out=False,
            oom_killed=False,
            orchestrator_error=None,
            egress_events=[],
            pod_name="fake",
            node_name=None,
        )


@dataclass
class ScoreCard:
    false_invocation_rate: float
    false_omission_rate: float
    n_direct: int
    n_sandbox: int


def score(records: list[tuple[str, bool]]) -> ScoreCard:
    """records: list of (expect, invoked). expect in {'direct', 'sandbox'}.

    false_invocation_rate = share of 'direct' prompts that fired the sandbox.
    false_omission_rate   = share of 'sandbox' prompts that did NOT fire it.
    """
    direct = [inv for exp, inv in records if exp == "direct"]
    sandbox = [inv for exp, inv in records if exp == "sandbox"]
    fi = (sum(direct) / len(direct)) if direct else 0.0
    fo = (sum(not inv for inv in sandbox) / len(sandbox)) if sandbox else 0.0
    return ScoreCard(
        false_invocation_rate=fi,
        false_omission_rate=fo,
        n_direct=len(direct),
        n_sandbox=len(sandbox),
    )
