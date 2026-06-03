"""ADK tool wrapper around SandboxOrchestrator."""
import logging
from dataclasses import asdict
from typing import Any

from .orchestrator import (
    SandboxOrchestrator,
    UserConcurrencyCap,
    GlobalConcurrencyCap,
)
from .trace_store import ExecutionRecord

log = logging.getLogger(__name__)


class ToolBudgetExceeded(Exception):
    pass


class RunInSandboxTool:
    """Stateful per-turn tool. One instance per agent turn so call_budget
    is scoped to a single user message."""

    def __init__(
        self,
        *,
        orch: SandboxOrchestrator,
        user_id: str,
        call_budget: int,
        user_tag: str = "",
        channel_id: str = "",
        guild_id: str = "",
        parent_interaction_id: str = "",
        trace_store=None,
    ) -> None:
        self._orch = orch
        self._user_id = user_id
        self._budget = call_budget
        self._user_tag = user_tag
        self._channel_id = channel_id
        self._guild_id = guild_id
        self._parent_interaction_id = parent_interaction_id
        self._trace_store = trace_store
        self._used = 0
        self.execution_ids: list[str] = []
        self.results: list[Any] = []

    async def run(
        self,
        *,
        language: str,
        code: str,
        stdin: str | None = None,
        env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if self._used >= self._budget:
            raise ToolBudgetExceeded()
        self._used += 1
        try:
            result = await self._orch.run(
                user_id=self._user_id,
                language=language,
                code=code,
                stdin=stdin,
                env=env or {},
            )
        except UserConcurrencyCap:
            return {"exit_code": -2, "error": "user_concurrency_cap", "execution_id": None}
        except GlobalConcurrencyCap:
            return {"exit_code": -2, "error": "global_concurrency_cap", "execution_id": None}
        self.execution_ids.append(result.execution_id)
        self.results.append(result)
        if self._trace_store is not None:
            await self._persist(result, language, code, stdin, env)
        return asdict(result)

    async def _persist(self, result, language, code, stdin, env) -> None:
        """Persist an ExecutionRecord. A persistence failure must never break
        the chat — the sandbox result is already in hand — so we log and move
        on rather than letting Mongo trouble surface to the user."""
        rec = ExecutionRecord(
            execution_id=result.execution_id,
            parent_interaction_id=self._parent_interaction_id,
            user_id=self._user_id,
            user_tag=self._user_tag,
            channel_id=self._channel_id,
            guild_id=self._guild_id,
            agent_turn_index=self._used - 1,
            agent_rationale=None,
            language=language,
            code=code,
            stdin=stdin,
            env_keys=sorted((env or {}).keys()),
            exit_code=result.exit_code,
            stdout=result.stdout,
            stderr=result.stderr,
            stdout_truncated=result.stdout_truncated,
            stderr_truncated=result.stderr_truncated,
            duration_ms=result.duration_ms,
            schedule_wait_ms=result.schedule_wait_ms,
            timed_out=result.timed_out,
            oom_killed=result.oom_killed,
            orchestrator_error=result.orchestrator_error,
            egress_events=result.egress_events,
            runtime_events=[],
            resource_usage={},
            pod_name=result.pod_name,
            node_name=result.node_name,
        )
        try:
            await self._trace_store.record(rec)
        except Exception:  # noqa: BLE001
            log.warning(
                "failed to persist sandbox execution trace %s", result.execution_id, exc_info=True
            )
