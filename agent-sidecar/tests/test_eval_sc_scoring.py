from src.agent import AgentChatResult
from eval.eval_sc import score_sc


def _r(tools, sandbox=0):
    return AgentChatResult(message_text="x", execution_ids=[], any_failed=False, fallback_occurred=False,
                           sc_tool_names=tools, sandbox_attempts=sandbox)


def test_score_counts_hits_controls_and_sandbox():
    recs = [({"prompt": "a", "expect_tool": "sc_find_item"}, _r(["sc_find_item"])),
            ({"prompt": "b", "expect_tool": "sc_trade_routes"}, _r([], sandbox=1)),
            ({"prompt": "c", "expect_tool": None}, _r(["sc_find_item"]))]
    s = score_sc(recs)
    assert s == {"sandbox_attempts_total": 1, "tool_hit_rate": 0.5, "control_false_sc_calls": 1}
