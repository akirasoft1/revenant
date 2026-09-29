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


def test_uncovered_sc_prompts_gate_sandbox_but_not_controls_or_hit_rate():
    uncovered = {"prompt": "what turret does the Anvil Spartan have", "expect_tool": None, "uncovered_sc": True}
    recs = [({"prompt": "a", "expect_tool": "sc_find_item"}, _r(["sc_find_item"])),
            (uncovered, _r(["sc_find_item"])),          # an sc call here is fine
            (uncovered, _r([], sandbox=2))]             # but sandbox still gates
    s = score_sc(recs)
    assert s == {"sandbox_attempts_total": 2, "tool_hit_rate": 1.0, "control_false_sc_calls": 0}


def test_eval_set_has_location_shops_and_uncovered_prompts():
    from eval.sc_eval_set import SC_EVAL_SET
    by_prompt = {c["prompt"]: c for c in SC_EVAL_SET}
    levski = by_prompt["are there any ship parts or fps equipment that are unique to Levski (for purchasing that is)?"]
    assert levski["expect_tool"] == "sc_location_shops"
    assert by_prompt["what's sold at Teach's in Levski"]["expect_tool"] == "sc_location_shops"
    for p in ("what turret does the Anvil Spartan have",
              "what can I craft with blueprints in Star Citizen right now"):
        assert by_prompt[p]["expect_tool"] is None and by_prompt[p]["uncovered_sc"] is True
