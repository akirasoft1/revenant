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
    assert s == {"sandbox_attempts_total": 1, "tool_hit_rate": 0.5, "control_false_sc_calls": 1,
                 "unprompted_hangar_calls": 0, "unprompted_hangar_edits": 0}


def test_uncovered_sc_prompts_gate_sandbox_but_not_controls_or_hit_rate():
    uncovered = {"prompt": "what turret does the Anvil Spartan have", "expect_tool": None, "uncovered_sc": True}
    recs = [({"prompt": "a", "expect_tool": "sc_find_item"}, _r(["sc_find_item"])),
            (uncovered, _r(["sc_find_item"])),          # an sc call here is fine
            (uncovered, _r([], sandbox=2))]             # but sandbox still gates
    s = score_sc(recs)
    assert s == {"sandbox_attempts_total": 2, "tool_hit_rate": 1.0, "control_false_sc_calls": 0,
                 "unprompted_hangar_calls": 0, "unprompted_hangar_edits": 0}


def test_eval_set_has_location_shops_and_uncovered_prompts():
    from eval.sc_eval_set import SC_EVAL_SET
    by_prompt = {c["prompt"]: c for c in SC_EVAL_SET}
    levski = by_prompt["are there any ship parts or fps equipment that are unique to Levski (for purchasing that is)?"]
    assert levski["expect_tool"] == "sc_location_shops"
    assert by_prompt["what's sold at Teach's in Levski"]["expect_tool"] == "sc_location_shops"
    for p in ("what turret does the Anvil Spartan have",
              "what can I craft with blueprints in Star Citizen right now"):
        assert by_prompt[p]["expect_tool"] is None and by_prompt[p]["uncovered_sc"] is True


# --- sc_dispute (2026-09-29 voice incident) ---------------------------------

_DISPUTE = {"prompt": "that's not true, recheck your sources", "expect_tool": None, "sc_dispute": True,
            "history": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}


def test_sc_dispute_gates_sandbox_but_not_controls_or_hit_rate():
    recs = [({"prompt": "a", "expect_tool": "sc_find_item"}, _r(["sc_find_item"])),
            (_DISPUTE, _r(["sc_find_item"])),          # an sc call is not a false control call
            (_DISPUTE, _r([], sandbox=1))]             # but the sandbox hard gate still applies
    s = score_sc(recs)
    assert s == {"sandbox_attempts_total": 1, "tool_hit_rate": 1.0, "control_false_sc_calls": 0,
                 "unprompted_hangar_calls": 0, "unprompted_hangar_edits": 0}


def test_eval_set_has_the_quantum_drive_dispute_case():
    from eval.sc_eval_set import SC_EVAL_SET
    disputes = [c for c in SC_EVAL_SET if c.get("sc_dispute")]
    assert len(disputes) == 1
    case = disputes[0]
    assert case["expect_tool"] is None and not case.get("uncovered_sc")
    assert case["prompt"] == ("that's not true, my engines max at 205 and when I spool the quantum "
                              "drive to 100% I can go 1000 m/s. recheck your sources")
    assert case["history"] == [
        {"role": "user", "content": "what's the difference between enabling the quantum drive and "
                                    "just flying at 1000 m/s?"},
        {"role": "assistant", "content": "you don't need the quantum drive to go 1000 m/s — that's just "
                                         "your normal thrusters or afterburner; the quantum drive is only "
                                         "for jumping."},
    ]


def test_chat_kwargs_forwards_history_only_when_present():
    from eval.eval_sc import _chat_kwargs
    assert _chat_kwargs({"prompt": "p", "expect_tool": None}) == {
        "user_id": "eval", "user_message": "p"}
    assert _chat_kwargs(_DISPUTE) == {
        "user_id": "eval", "user_message": _DISPUTE["prompt"], "history": _DISPUTE["history"]}
