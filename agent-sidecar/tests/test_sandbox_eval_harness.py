import asyncio
from dataclasses import asdict

from eval.harness import FakeOrchestrator, score


def test_fake_orchestrator_returns_valid_result_and_records():
    fo = FakeOrchestrator()
    r = asyncio.run(fo.run(user_id="u", language="bash", code="echo hi", stdin=None, env={}))
    assert r.exit_code == 0 and r.execution_id
    assert asdict(r)  # dataclass, asdict works (the real tool does this)
    assert fo.calls == 1


def test_score_perfect():
    recs = [("direct", False), ("direct", False), ("sandbox", True), ("sandbox", True)]
    s = score(recs)
    assert s.false_invocation_rate == 0.0
    assert s.false_omission_rate == 0.0
    assert s.n_direct == 2 and s.n_sandbox == 2


def test_score_all_wrong():
    recs = [("direct", True), ("sandbox", False)]
    s = score(recs)
    assert s.false_invocation_rate == 1.0
    assert s.false_omission_rate == 1.0


def test_score_mixed():
    recs = [("direct", True), ("direct", False), ("direct", False), ("sandbox", True)]
    s = score(recs)
    assert abs(s.false_invocation_rate - 1 / 3) < 1e-9
    assert s.false_omission_rate == 0.0
