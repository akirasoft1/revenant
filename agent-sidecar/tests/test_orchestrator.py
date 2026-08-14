import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from src.concurrency import ConcurrencyGate, GateAcquireError
from src.egress_scraper import NoopEgressScraper
from src.orchestrator import (
    SandboxOrchestrator,
    OrchestratorResult,
    UserConcurrencyCap,
    GlobalConcurrencyCap,
)


class FakeK8sClient:
    """In-memory K8s simulator. Tracks created/deleted Jobs and serves canned logs."""
    def __init__(self, *, scripted_logs: str = "", scripted_exit: int = 0,
                 scripted_timeout: bool = False, scripted_oom: bool = False,
                 unschedulable: bool = False, image_pull_failure: bool = False):
        self.scripted_logs = scripted_logs
        self.scripted_exit = scripted_exit
        self.scripted_timeout = scripted_timeout
        self.scripted_oom = scripted_oom
        self.unschedulable = unschedulable
        self.image_pull_failure = image_pull_failure
        self.created_jobs: list[dict] = []
        self.deleted_jobs: list[str] = []

    async def create_job(self, spec: dict) -> str:
        if self.unschedulable:
            raise RuntimeError("unschedulable")
        self.created_jobs.append(spec)
        return f"sandbox-{len(self.created_jobs)}"

    async def wait_pod_ready(self, job_name: str, timeout_s: int) -> str:
        if self.image_pull_failure:
            raise RuntimeError("image_pull")
        return f"{job_name}-pod"

    async def stream_stdin_and_wait(self, pod_name: str, payload: bytes, deadline_s: int) -> tuple[int, str, bool, bool]:
        return self.scripted_exit, self.scripted_logs, self.scripted_timeout, self.scripted_oom

    async def get_pod_node(self, pod_name: str) -> str | None:
        return "node-1"

    async def delete_job(self, job_name: str) -> None:
        self.deleted_jobs.append(job_name)


@pytest.fixture
def gate():
    return ConcurrencyGate(per_user=2, global_=15)


@pytest.fixture
def make_orch(gate):
    def _make(k8s):
        return SandboxOrchestrator(
            k8s=k8s,
            gate=gate,
            egress=NoopEgressScraper(),
            namespace="discord-article-bot",
            sandbox_image="sandbox-base:test",
            wall_clock_seconds=300,
            cpu_limit="2",
            memory_limit="2Gi",
            stdout_storage_cap_bytes=256 * 1024,
        )
    return _make


async def test_happy_path_returns_stdout_and_exit(make_orch):
    k8s = FakeK8sClient(scripted_logs="hello world\n", scripted_exit=0)
    orch = make_orch(k8s)
    result: OrchestratorResult = await orch.run(
        user_id="u1", language="python", code="print('hello world')", stdin=None, env={},
    )
    assert result.exit_code == 0
    assert result.stdout == "hello world\n"
    assert result.stderr == ""
    assert result.timed_out is False
    assert result.oom_killed is False
    assert len(k8s.created_jobs) == 1
    assert len(k8s.deleted_jobs) == 1


async def test_stderr_partitioned_correctly(make_orch):
    k8s = FakeK8sClient(scripted_logs="hi\n__SBSTDERR__:bad\n", scripted_exit=1)
    orch = make_orch(k8s)
    result = await orch.run(user_id="u", language="bash", code="x", stdin=None, env={})
    assert result.stdout == "hi\n"
    assert result.stderr == "bad\n"
    assert result.exit_code == 1


async def test_timeout_marks_timed_out(make_orch):
    k8s = FakeK8sClient(scripted_logs="partial", scripted_exit=124, scripted_timeout=True)
    orch = make_orch(k8s)
    result = await orch.run(user_id="u", language="bash", code="sleep 1000", stdin=None, env={})
    assert result.timed_out is True
    assert result.exit_code == 124


async def test_oom_marks_oom_killed(make_orch):
    k8s = FakeK8sClient(scripted_exit=137, scripted_oom=True)
    orch = make_orch(k8s)
    result = await orch.run(user_id="u", language="python", code="a=' '*10**10", stdin=None, env={})
    assert result.oom_killed is True
    assert result.exit_code == 137


async def test_unschedulable_returns_minus_one(make_orch):
    k8s = FakeK8sClient(unschedulable=True)
    orch = make_orch(k8s)
    result = await orch.run(user_id="u", language="bash", code="x", stdin=None, env={})
    assert result.exit_code == -1
    assert result.orchestrator_error == "unschedulable"


async def test_image_pull_failure_returns_minus_one(make_orch):
    k8s = FakeK8sClient(image_pull_failure=True)
    orch = make_orch(k8s)
    result = await orch.run(user_id="u", language="bash", code="x", stdin=None, env={})
    assert result.exit_code == -1
    assert result.orchestrator_error == "image_pull"


async def test_per_user_cap_raises(make_orch, gate):
    # Pre-fill the gate manually
    async with gate.acquire(user_id="u1"):
        async with gate.acquire(user_id="u1"):
            k8s = FakeK8sClient(scripted_logs="ok", scripted_exit=0)
            orch = make_orch(k8s)
            with pytest.raises(UserConcurrencyCap):
                await orch.run(user_id="u1", language="bash", code="x", stdin=None, env={})


async def test_stdout_capped_at_storage_limit(make_orch):
    big = "a" * 300_000  # exceeds 256KB cap
    k8s = FakeK8sClient(scripted_logs=big, scripted_exit=0)
    orch = make_orch(k8s)
    result = await orch.run(user_id="u", language="bash", code="x", stdin=None, env={})
    assert len(result.stdout) <= 256 * 1024 + 64  # cap + truncation marker
    assert result.stdout_truncated is True


class HangingK8sClient(FakeK8sClient):
    """API server that accepts the call and then never answers."""

    async def wait_pod_ready(self, job_name: str, timeout_s: int) -> str:
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")


def _orch_with_deadline(k8s, gate, deadline_s):
    return SandboxOrchestrator(
        k8s=k8s,
        gate=gate,
        egress=NoopEgressScraper(),
        namespace="discord-article-bot",
        sandbox_image="sandbox-base:test",
        wall_clock_seconds=300,
        cpu_limit="2",
        memory_limit="2Gi",
        overall_deadline_s=deadline_s,
    )


async def test_a_hung_k8s_call_cannot_hold_the_concurrency_permit_forever():
    # A hang used to park inside the gate's `async with` forever. Permits are
    # global and finite, so repeated hangs walked the sandbox to a permanent
    # standstill that only a pod restart cleared.
    gate = ConcurrencyGate(per_user=1, global_=1)
    orch = _orch_with_deadline(HangingK8sClient(), gate, 1)

    result = await asyncio.wait_for(
        orch.run(user_id="u1", language="bash", code="x", stdin=None, env={}),
        timeout=10,
    )
    assert result.orchestrator_error == "orchestrator_timeout"
    assert result.timed_out is True

    # The permit must be back: a fresh execution for the same user (and the
    # single global slot) has to be admitted rather than hitting the cap.
    ok = await asyncio.wait_for(
        SandboxOrchestrator(
            k8s=FakeK8sClient(scripted_logs="fine", scripted_exit=0),
            gate=gate,
            egress=NoopEgressScraper(),
            namespace="discord-article-bot",
            sandbox_image="sandbox-base:test",
            wall_clock_seconds=300,
            cpu_limit="2",
            memory_limit="2Gi",
        ).run(user_id="u1", language="bash", code="x", stdin=None, env={}),
        timeout=10,
    )
    assert ok.stdout == "fine"
