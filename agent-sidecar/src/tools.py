"""ADK tool wrapper around SandboxOrchestrator."""
import logging
import re
from dataclasses import asdict
from typing import Any

from .orchestrator import (
    SandboxOrchestrator,
    UserConcurrencyCap,
    GlobalConcurrencyCap,
)

log = logging.getLogger(__name__)

# Compiled regex, case-insensitive, matching Star Citizen data hosts that
# should be accessed via sc_* tools instead of the sandbox.
SC_DATA_HOST_PATTERN = re.compile(
    r"(uexcorp\.(space|uk)|star-citizen\.wiki|sc-trade\.tools|scunpacked)",
    re.IGNORECASE,
)


class ToolBudgetExceeded(Exception):
    pass


class RunInSandboxTool:
    """Stateful per-turn tool. One instance per agent turn so call_budget
    is scoped to a single user message."""

    def __init__(self, *, orch: SandboxOrchestrator, user_id: str, call_budget: int) -> None:
        self._orch = orch
        self._user_id = user_id
        self._budget = call_budget
        self._used = 0
        self.attempts: int = 0
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
        # Increment attempts FIRST, before any other check.
        self.attempts += 1

        # Check for SC host refusal BEFORE budget and orchestrator.
        # This refusal does NOT consume budget or append to execution_ids/results.
        if SC_DATA_HOST_PATTERN.search(code or "") or SC_DATA_HOST_PATTERN.search(stdin or ""):
            log.info("run_in_sandbox refused: Star Citizen data host in code; use sc_* tools")
            return {
                "exit_code": -4,
                "error": "use_sc_tools",
                "detail": "Star Citizen data is available through the sc_find_item, sc_compare_components, sc_faction_missions, sc_trade_routes, sc_commodity_prices and sc_org_guides tools. Do not fetch it in the sandbox.",
                "execution_id": None,
            }

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
        return asdict(result)
