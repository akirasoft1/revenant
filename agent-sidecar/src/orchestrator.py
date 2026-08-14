"""SandboxOrchestrator — drives Job lifecycle for one execution."""
import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

from .concurrency import ConcurrencyGate, GateAcquireError
from .egress_scraper import EgressScraper
from .job_template import build_job_spec
from .log_partition import partition_logs

log = logging.getLogger(__name__)


class K8sClient(Protocol):
    async def create_job(self, spec: dict) -> str: ...
    async def wait_pod_ready(self, job_name: str, timeout_s: int) -> str: ...
    async def stream_stdin_and_wait(self, pod_name: str, payload: bytes, deadline_s: int) -> tuple[int, str, bool, bool]: ...
    async def get_pod_node(self, pod_name: str) -> str | None: ...
    async def delete_job(self, job_name: str) -> None: ...


@dataclass
class OrchestratorResult:
    execution_id: str
    exit_code: int
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    duration_ms: int
    schedule_wait_ms: int
    timed_out: bool
    oom_killed: bool
    orchestrator_error: str | None
    egress_events: list[dict[str, Any]]
    pod_name: str
    node_name: str | None


class UserConcurrencyCap(Exception):
    pass


class GlobalConcurrencyCap(Exception):
    pass


_TRUNC_MARKER = "\n...[truncated by sandbox storage cap]..."


def _truncate(s: str, cap: int) -> tuple[str, bool]:
    if len(s) <= cap:
        return s, False
    return s[:cap] + _TRUNC_MARKER, True


class SandboxOrchestrator:
    def __init__(
        self,
        *,
        k8s: K8sClient,
        gate: ConcurrencyGate,
        egress: EgressScraper,
        namespace: str,
        sandbox_image: str,
        wall_clock_seconds: int,
        cpu_limit: str,
        memory_limit: str,
        stdout_storage_cap_bytes: int = 256 * 1024,
        overall_deadline_s: int | None = None,
    ) -> None:
        self._k8s = k8s
        self._gate = gate
        self._egress = egress
        self._namespace = namespace
        self._image = sandbox_image
        self._wall_clock = wall_clock_seconds
        self._cpu = cpu_limit
        self._memory = memory_limit
        self._cap = stdout_storage_cap_bytes
        # Hard ceiling on one execution, measured while the concurrency permit
        # is held. The per-call `_request_timeout` in LiveK8sClient is the real
        # fix for a hung API server; this is the backstop for anything that
        # stalls without raising, so a permit can never be held indefinitely.
        # Generous by design: it must not fire before the pod's own
        # activeDeadlineSeconds (== wall_clock) has produced a real result.
        self._overall_deadline = (
            overall_deadline_s if overall_deadline_s is not None else wall_clock_seconds + 120
        )

    async def run(
        self,
        *,
        user_id: str,
        language: str,
        code: str,
        stdin: str | None,
        env: dict[str, str],
    ) -> OrchestratorResult:
        execution_id = uuid.uuid4().hex
        try:
            # ConcurrencyGate.acquire releases the permit in a `finally`, so an
            # exception can never leak one; the remaining leak was a call that
            # never returns at all, which `wait_for` now bounds. On timeout the
            # permit is released, the model gets a real (failed) result instead
            # of the bot's 600s chat deadline, and the orphaned Job cleans
            # itself up via activeDeadlineSeconds + ttlSecondsAfterFinished.
            async with self._gate.acquire(user_id=user_id, wait=False):
                try:
                    return await asyncio.wait_for(
                        self._do_run(execution_id, user_id, language, code, stdin, env),
                        timeout=self._overall_deadline,
                    )
                except asyncio.TimeoutError:
                    log.error(
                        "sandbox execution %s for user %s exceeded the %ds orchestrator deadline; "
                        "abandoning it and releasing the concurrency permit",
                        execution_id, user_id, self._overall_deadline,
                    )
                    return OrchestratorResult(
                        execution_id=execution_id, exit_code=-1, stdout="", stderr="",
                        stdout_truncated=False, stderr_truncated=False,
                        duration_ms=self._overall_deadline * 1000,
                        schedule_wait_ms=0, timed_out=True, oom_killed=False,
                        orchestrator_error="orchestrator_timeout",
                        egress_events=[], pod_name="", node_name=None,
                    )
        except GateAcquireError as e:
            if e.scope == "user":
                raise UserConcurrencyCap from e
            raise GlobalConcurrencyCap from e

    async def _do_run(
        self,
        execution_id: str,
        user_id: str,
        language: str,
        code: str,
        stdin: str | None,
        env: dict[str, str],
    ) -> OrchestratorResult:
        spec = build_job_spec(
            execution_id=execution_id,
            user_id=user_id,
            image=self._image,
            wall_clock_seconds=self._wall_clock,
            cpu_limit=self._cpu,
            memory_limit=self._memory,
            env=env,
            namespace=self._namespace,
        )

        t_start = time.monotonic()
        scrape_start = datetime.now(tz=timezone.utc)
        try:
            job_name = await self._k8s.create_job(spec)
        except Exception as e:
            return OrchestratorResult(
                execution_id=execution_id, exit_code=-1, stdout="", stderr="",
                stdout_truncated=False, stderr_truncated=False, duration_ms=0,
                schedule_wait_ms=0, timed_out=False, oom_killed=False,
                orchestrator_error="unschedulable" if "unschedulable" in str(e) else str(e),
                egress_events=[], pod_name="", node_name=None,
            )

        try:
            t_ready_start = time.monotonic()
            try:
                pod_name = await self._k8s.wait_pod_ready(job_name, timeout_s=30)
            except Exception as e:
                return OrchestratorResult(
                    execution_id=execution_id, exit_code=-1, stdout="", stderr="",
                    stdout_truncated=False, stderr_truncated=False, duration_ms=0,
                    schedule_wait_ms=int((time.monotonic() - t_ready_start) * 1000),
                    timed_out=False, oom_killed=False,
                    orchestrator_error="image_pull" if "image_pull" in str(e) else str(e),
                    egress_events=[], pod_name="", node_name=None,
                )
            schedule_wait_ms = int((time.monotonic() - t_ready_start) * 1000)

            payload = json.dumps({"language": language, "code": code, "stdin": stdin}).encode()
            exit_code, raw_logs, timed_out, oom_killed = await self._k8s.stream_stdin_and_wait(
                pod_name, payload, deadline_s=self._wall_clock,
            )
            stdout, stderr = partition_logs(raw_logs)
            stdout, stdout_trunc = _truncate(stdout, self._cap)
            stderr, stderr_trunc = _truncate(stderr, self._cap)

            node_name = await self._k8s.get_pod_node(pod_name)
            scrape_end = datetime.now(tz=timezone.utc)
            egress_events = await self._egress.scrape(
                pod_ip=pod_name, start=scrape_start, end=scrape_end,
            )

            return OrchestratorResult(
                execution_id=execution_id,
                exit_code=exit_code,
                stdout=stdout, stderr=stderr,
                stdout_truncated=stdout_trunc, stderr_truncated=stderr_trunc,
                duration_ms=int((time.monotonic() - t_start) * 1000),
                schedule_wait_ms=schedule_wait_ms,
                timed_out=timed_out, oom_killed=oom_killed,
                orchestrator_error=None,
                egress_events=egress_events,
                pod_name=pod_name, node_name=node_name,
            )
        finally:
            try:
                await self._k8s.delete_job(job_name)
            except Exception:
                pass  # cleanup best-effort
