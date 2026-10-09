"""Hangar chat-edit cases in the SC eval (2026-10-09 hangar-chat-edits spec):
the four edit cases, their scoring (edit hit via the edit-tool calls the turn
actually made; `unprompted_hangar_edits` hard gate on every other case), the
per-case user_id, and the seed script's reset-to-known-state. No model, no
network."""
import json

import pytest

from src.agent import AgentChatResult
from eval.eval_sc import EDIT_TOOLS, _case_hit, _chat_kwargs, _sc_prompts_with_outage, score_sc
from eval.sc_eval_set import HANGAR_MEMBER_AKIRA, HANGAR_MEMBER_MICRO, SC_EVAL_SET


def _r(sc=(), edits=(), sc_state="available"):
    return AgentChatResult(
        message_text="x", execution_ids=[], any_failed=False,
        sc_tool_names=list(sc), sc_tool_calls=[{"name": n, "args": {}} for n in sc],
        sc_state=sc_state,
        hangar_edit_calls=[{"name": n, "args": {}, "result": "ok"} for n in edits],
        hangar_edits=len(edits),
    )


def _edit_cases():
    return [c for c in SC_EVAL_SET if c.get("hangar_edit")]


def _by_text(text):
    (c,) = [c for c in _edit_cases() if c["prompt"].endswith(text)]
    return c


def test_edit_tools_are_the_three_spec_names():
    assert EDIT_TOOLS == frozenset({"hangar_fit", "hangar_add_ship", "hangar_reset"})


def test_eval_set_has_the_four_spec_edit_cases():
    assert _by_text("I put the Hemera in my Connie")["expect_tool"] == "hangar_fit"
    assert _by_text("should I put the Hemera in my Connie?")["expect_tool"] is None
    assert _by_text("put a Hemera in Micro's Titan")["expect_tool"] is None
    assert _by_text("I just bought a Cutlass Black")["expect_tool"] == "hangar_add_ship"
    assert len(_edit_cases()) == 5
    for c in _edit_cases():
        # the speaker is the eval member, as the bot would send ChatRequest.user_id
        assert c["user_id"] == HANGAR_MEMBER_AKIRA
        assert c["prompt"].startswith(f"[Akira · {HANGAR_MEMBER_AKIRA}]: ")
    micro = _by_text("put a Hemera in Micro's Titan")
    assert HANGAR_MEMBER_MICRO in micro["system_prompt"]  # roster names Micro


def test_chat_kwargs_uses_the_case_user_id_else_eval():
    c = _by_text("I just bought a Cutlass Black")
    assert _chat_kwargs(c)["user_id"] == HANGAR_MEMBER_AKIRA
    # every other case keeps the non-numeric "eval" id, so a stray edit call
    # there is refused (unknown_speaker) and never writes
    assert _chat_kwargs({"prompt": "p", "expect_tool": None})["user_id"] == "eval"


def test_edit_hit_reads_the_edit_tool_calls():
    fit = _by_text("I put the Hemera in my Connie")
    assert _case_hit(fit, _r(sc=["sc_member_hangar"], edits=["hangar_fit"]))
    assert not _case_hit(fit, _r(sc=["sc_member_hangar"]))
    assert not _case_hit(fit, _r(edits=["hangar_add_ship"]))


def test_unprompted_hangar_edits_counts_edit_calls_on_every_non_edit_case():
    fit = _by_text("I put the Hemera in my Connie")
    should = _by_text("should I put the Hemera in my Connie?")
    micro = _by_text("put a Hemera in Micro's Titan")
    control = {"prompt": "capital of France", "expect_tool": None}
    sc_case = {"prompt": "best S3 shield", "expect_tool": "sc_compare_components"}
    recs = [
        (fit, _r(edits=["hangar_fit"])),                             # expected: fine
        (fit, _r(edits=["hangar_fit", "hangar_add_ship"])),          # other edit tool on an edit case
        (should, _r(sc=["sc_member_fit_check"], edits=["hangar_fit"])),  # advice question -> violation
        (micro, _r(edits=["hangar_fit"])),                           # someone else's ship -> violation
        (control, _r(edits=["hangar_add_ship"])),                    # violation
        (sc_case, _r(sc=["sc_compare_components"])),
    ]
    s = score_sc(recs)
    assert s["unprompted_hangar_edits"] == 4
    # negative edit cases may READ the hangar / call sc_* tools without being
    # false SC calls or unprompted hangar reads
    assert s["control_false_sc_calls"] == 0
    assert s["unprompted_hangar_calls"] == 0


def test_negative_edit_cases_are_not_in_tool_hit_rate():
    should = _by_text("should I put the Hemera in my Connie?")
    fit = _by_text("I put the Hemera in my Connie")
    s = score_sc([(should, _r(sc=["sc_member_fit_check"])), (fit, _r(edits=["hangar_fit"]))])
    assert s["tool_hit_rate"] == 1.0


def test_edit_cases_count_in_the_outage_check():
    should = _by_text("should I put the Hemera in my Connie?")
    assert _sc_prompts_with_outage([(should, _r(sc_state="unavailable"))]) == [should["prompt"]]


# --- seed: reset to a known state -------------------------------------------

class _FakeHttp:
    def __init__(self, hangars=None):
        self.calls = []
        self.hangars = hangars or {}

    def request(self, method, url, headers=None, body=None):
        self.calls.append((method, url, dict(headers or {}), body))
        if method == "GET":
            member = url.split("/v1/members/")[1].split("/")[0]
            return 200, {"member": member, "ships": self.hangars.get(member, [])}
        if method == "POST" and url.endswith("/reset"):
            return 200, {"changes": [], "unchanged": False}
        if method == "POST":
            return 201, {"ship": {"shipId": "new"}}
        return 200, {"deleted": True}


def test_seed_resets_the_eval_members_to_exactly_the_fixture():
    from eval.seed_hangar_eval import seed
    base = "https://hangar.example"
    http = _FakeHttp(hangars={
        HANGAR_MEMBER_AKIRA: [
            {"shipId": "h", "vehicleName": "Vanguard Harbinger", "nickname": "Harby", "fitted": {}},
            {"shipId": "c", "vehicleName": "Constellation Taurus", "nickname": "Connie",
             "fitted": {"hardpoint_quantum_drive": "uuid-hemera"}},          # refitted by an edit case
            {"shipId": "x", "vehicleName": "Cutlass Black", "nickname": None, "fitted": {}},  # added by one
            {"shipId": "c2", "vehicleName": "Constellation Taurus", "nickname": "Connie", "fitted": {}},  # dup
        ],
        HANGAR_MEMBER_MICRO: [{"shipId": "t", "vehicleName": "Avenger Titan", "nickname": None}],
    })
    seed(base, token="TOK", http=http)
    writes = [(m, u, h.get("X-Acting-Member"), json.loads(b) if b else None)
              for m, u, h, b in http.calls if m != "GET"]
    a = f"{base}/v1/members/{HANGAR_MEMBER_AKIRA}"
    assert writes == [
        ("DELETE", f"{a}/ships/x", HANGAR_MEMBER_AKIRA, None),
        ("DELETE", f"{a}/ships/c2", HANGAR_MEMBER_AKIRA, None),
        ("POST", f"{a}/ships/c/reset", HANGAR_MEMBER_AKIRA, {"slot": "all"}),
    ]


def test_seed_from_empty_adds_all_three_and_resets_nothing():
    from eval.seed_hangar_eval import seed
    http = _FakeHttp()
    seed("https://hangar.example", token="TOK", http=http)
    assert [m for m, *_ in http.calls if m != "GET"] == ["POST"] * 3
    assert not any(u.endswith("/reset") for _, u, _, _ in http.calls)


def test_seed_raises_when_a_reset_fails():
    from eval.seed_hangar_eval import HangarSeedError, seed

    class _Fail(_FakeHttp):
        def request(self, method, url, headers=None, body=None):
            if url.endswith("/reset"):
                return 503, {"error": "unavailable"}
            return super().request(method, url, headers, body)
    http = _Fail(hangars={HANGAR_MEMBER_AKIRA: [
        {"shipId": "c", "vehicleName": "Constellation Taurus", "nickname": "Connie", "fitted": {"a": "b"}}]})
    with pytest.raises(HangarSeedError, match="503"):
        seed("https://hangar.example", token="TOK", http=http)


def test_eval_set_has_an_imperative_own_ship_edit_case():
    c = _by_text("put my Harbinger's shields back to stock")
    assert c["expect_tool"] == "hangar_reset"
    assert c["user_id"] == HANGAR_MEMBER_AKIRA


def test_reset_hangar_fixture_strips_a_trailing_slash_for_audience_and_base():
    from types import SimpleNamespace
    import eval.eval_sc as eval_sc
    calls = []
    eval_sc.reset_hangar_fixture(
        SimpleNamespace(hangar_api_url="https://h.example/", hangar_sa_key_path="/k"),
        seed_fn=lambda base, token: calls.append((base, token)),
        mint=lambda aud, key: f"tok:{aud}")
    assert calls == [("https://h.example", "tok:https://h.example")]
