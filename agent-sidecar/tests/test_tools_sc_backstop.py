import pytest

from src.tools import RunInSandboxTool, SC_DATA_HOST_PATTERN


class Orch:
    def __init__(self):
        self.calls = 0

    async def run(self, **kw):
        self.calls += 1
        raise AssertionError("orchestrator must not be called")


@pytest.mark.parametrize("code", [
    "import requests; requests.get('https://api.uexcorp.uk/2.0/commodities_routes')",
    "curl -s https://uexcorp.space/api/2.0/items",
    "fetch('https://api.star-citizen.wiki/api/v2/items/V801-12')",
    "wget https://sc-trade.tools/api/x",
    "git clone https://github.com/StarCitizenWiki/scunpacked-data",
])
async def test_sc_hosts_refused_before_orchestrator(code):
    orch = Orch()
    t = RunInSandboxTool(orch=orch, user_id="u", call_budget=5)
    r = await t.run(language="python", code=code)
    assert r["exit_code"] == -4 and r["error"] == "use_sc_tools"
    assert orch.calls == 0 and t.attempts == 1 and t.execution_ids == []


def test_pattern_does_not_match_unrelated_code():
    assert not SC_DATA_HOST_PATTERN.search("print(sum(range(10)))")
    assert not SC_DATA_HOST_PATTERN.search("curl https://example.com/star-citizen-fan-page")


async def test_refusal_does_not_consume_budget():
    class OkOrch:
        async def run(self, **kw):
            from eval.harness import FakeOrchestrator
            return await FakeOrchestrator().run(**kw)
    t = RunInSandboxTool(orch=OkOrch(), user_id="u", call_budget=1)
    await t.run(language="bash", code="curl https://uexcorp.space")
    r = await t.run(language="bash", code="echo hi")
    assert r["exit_code"] == 0 and t.attempts == 2


async def test_refusal_detail_names_every_sc_tool():
    t = RunInSandboxTool(orch=Orch(), user_id="u", call_budget=5)
    r = await t.run(language="bash", code="curl https://uexcorp.space")
    for name in ("sc_find_item", "sc_compare_components", "sc_faction_missions",
                 "sc_trade_routes", "sc_commodity_prices", "sc_org_guides"):
        assert name in r["detail"]
