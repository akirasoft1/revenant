import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from src import server, agent_pb2
from src.observability_agent import ObserveResult
from src.dql_runner import RunDqlResult

class _Ctx:
    async def abort(self, *a, **k):
        raise AssertionError(f"unexpected abort: {a}")

def test_observe_maps_result():
    obs = MagicMock()
    obs.observe = AsyncMock(return_value=ObserveResult("2 errors", "fetch spans", ""))
    servicer = server.AgentServicer(channel_voice_agent=None, observability_agent=obs, config=MagicMock())
    req = agent_pb2.ObserveRequest(user_id="u1", question="errors?")
    resp = asyncio.run(servicer.Observe(req, _Ctx()))
    assert resp.answer_text == "2 errors"
    assert resp.dql_used == "fetch spans"
    assert resp.error == ""

def test_rundql_maps_result():
    servicer = server.AgentServicer(channel_voice_agent=None, observability_agent=None, config=MagicMock())
    with patch("src.server.run_dql", AsyncMock(return_value=RunDqlResult('[{"c":1}]', '["c"]', ""))):
        req = agent_pb2.RunDqlRequest(user_id="u1", query="fetch spans | limit 1")
        resp = asyncio.run(servicer.RunDql(req, _Ctx()))
    assert resp.rows_json == '[{"c":1}]'
    assert resp.columns == '["c"]'
