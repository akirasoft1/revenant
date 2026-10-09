"""Member-hangar cases in the SC eval (2026-10-09 member-hangar spec): the
tool-call args plumbing they score on, the member-id-aware hit rule, the
unprompted-hangar-call gate, the roster/system_prompt forwarding, and the
seed script's request plan. No real model, no network."""
import asyncio
import json

import pytest

import src.agent as A
from src.agent import AgentChatResult, ChannelVoiceAgent
from src.config import load
from eval.eval_sc import HANGAR_TOOLS, _case_hit, _chat_kwargs, score_sc
from eval.sc_eval_set import (
    HANGAR_MEMBER_AKIRA,
    HANGAR_MEMBER_MICRO,
    ROSTER_HEADING,
    ROSTER_INSTRUCTION,
    SC_EVAL_SET,
    eval_roster,
    eval_system_prompt,
)


# --- agent: sc_* tool-call args are recorded --------------------------------

class _FC:
    def __init__(self, name, args):
        self.name = name
        self.args = args


class _Part:
    def __init__(self, text=None, function_call=None):
        self.text = text
        self.function_call = function_call


class _Content:
    def __init__(self, parts):
        self.parts = parts


class _Event:
    grounding_metadata = None

    def __init__(self, parts):
        self.content = _Content(parts)


class _SessionService:
    async def create_session(self, **kw):
        return None


def _runner_factory(events):
    class _Runner:
        def __init__(self, *, agent, app_name):
            self.session_service = _SessionService()

        async def run_async(self, **kw):
            for e in events:
                yield e

        async def close(self):
            return None
    return _Runner


def _run_turn(monkeypatch, events):
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "img")
    monkeypatch.setattr(A, "Agent", lambda **kw: object())
    monkeypatch.setattr(A, "InMemoryRunner", _runner_factory(events))
    monkeypatch.setattr(A, "_build_generate_content_config", lambda: None)
    ag = ChannelVoiceAgent(config=load(), orchestrator=None, base_system_prompt="BASE")
    return asyncio.run(ag.process_chat(user_id="u", user_message="hi", system_prompt="SYS"))


def test_process_chat_records_sc_tool_call_args(monkeypatch):
    events = [
        _Event([_Part(function_call=_FC("sc_member_fit_check",
                                        {"member_id": HANGAR_MEMBER_MICRO, "item": "Hemera"}))]),
        _Event([_Part(function_call=_FC("run_in_sandbox", {"code": "x"}))]),  # not sc_*: ignored
        _Event([_Part(function_call=_FC("sc_find_item", None))]),             # no args -> {}
        _Event([_Part("done")]),
    ]
    res = _run_turn(monkeypatch, events)
    assert res.sc_tool_names == ["sc_member_fit_check", "sc_find_item"]
    assert res.sc_tool_calls == [
        {"name": "sc_member_fit_check", "args": {"member_id": HANGAR_MEMBER_MICRO, "item": "Hemera"}},
        {"name": "sc_find_item", "args": {}},
    ]


def test_agent_chat_result_defaults_sc_tool_calls_to_empty():
    assert AgentChatResult("x", [], False).sc_tool_calls == []


# --- scoring ----------------------------------------------------------------

def _r(calls=(), sandbox=0):
    calls = [c if isinstance(c, dict) else {"name": c, "args": {}} for c in calls]
    return AgentChatResult(message_text="x", execution_ids=[], any_failed=False,
                           sc_tool_names=[c["name"] for c in calls], sc_tool_calls=calls,
                           sandbox_attempts=sandbox)


def _call(name, member_id):
    return {"name": name, "args": {"member_id": member_id}}


_MICRO_CASE = {"prompt": "can Micro?", "expect_tool": "sc_member_fit_check",
               "expect_member_id": HANGAR_MEMBER_MICRO, "hangar": True}


def test_hangar_tools_are_the_two_member_tools():
    assert HANGAR_TOOLS == frozenset({"sc_member_hangar", "sc_member_fit_check"})


def test_case_hit_requires_the_expected_member_id_when_set():
    assert _case_hit(_MICRO_CASE, _r([_call("sc_member_fit_check", HANGAR_MEMBER_MICRO)]))
    # right tool, wrong member (the speaker instead of Micro) is a miss
    assert not _case_hit(_MICRO_CASE, _r([_call("sc_member_fit_check", HANGAR_MEMBER_AKIRA)]))
    # any matching call counts, and whitespace around the id is tolerated
    assert _case_hit(_MICRO_CASE, _r([_call("sc_member_fit_check", HANGAR_MEMBER_AKIRA),
                                      _call("sc_member_fit_check", f" {HANGAR_MEMBER_MICRO} ")]))
    # the id on a DIFFERENT tool doesn't satisfy it
    assert not _case_hit(_MICRO_CASE, _r([_call("sc_member_hangar", HANGAR_MEMBER_MICRO)]))
    # cases without expect_member_id score by tool name alone, as before
    assert _case_hit({"prompt": "p", "expect_tool": "sc_find_item"}, _r(["sc_find_item"]))


def test_score_counts_unprompted_hangar_calls_on_every_non_hangar_case():
    control = {"prompt": "capital of France", "expect_tool": None}
    sc_case = {"prompt": "best S3 shield", "expect_tool": "sc_compare_components"}
    uncovered = {"prompt": "spartan turret", "expect_tool": None, "uncovered_sc": True}
    recs = [
        (_MICRO_CASE, _r([_call("sc_member_fit_check", HANGAR_MEMBER_MICRO)])),   # prompted: fine
        (sc_case, _r(["sc_compare_components", "sc_member_hangar"])),           # unprompted
        (uncovered, _r(["sc_member_fit_check"])),                                # unprompted
        (control, _r(["sc_member_hangar"])),                                     # unprompted + false sc call
    ]
    s = score_sc(recs)
    assert s["unprompted_hangar_calls"] == 3
    assert s["control_false_sc_calls"] == 1
    assert s["tool_hit_rate"] == 1.0
    assert s["sandbox_attempts_total"] == 0


# --- eval set ---------------------------------------------------------------

def _hangar_cases():
    return [c for c in SC_EVAL_SET if c.get("hangar")]


def test_eval_set_has_the_four_hangar_cases():
    by_prompt = {c["prompt"]: c for c in _hangar_cases()}
    akira = f"[Akira · {HANGAR_MEMBER_AKIRA}]: "
    assert set(by_prompt) == {
        akira + "what's a purchasable upgraded shield for my Harbinger?",
        akira + "I just looted a Hemera quantum drive, is it a usable upgrade for any of my ships?",
        akira + "I can't use this Hemera, can Micro?",
        akira + "what's on my Connie?",
    }
    expect = {
        "what's a purchasable upgraded shield for my Harbinger?": ("sc_member_hangar", HANGAR_MEMBER_AKIRA),
        "I just looted a Hemera quantum drive, is it a usable upgrade for any of my ships?":
            ("sc_member_fit_check", HANGAR_MEMBER_AKIRA),
        "I can't use this Hemera, can Micro?": ("sc_member_fit_check", HANGAR_MEMBER_MICRO),
        "what's on my Connie?": ("sc_member_hangar", HANGAR_MEMBER_AKIRA),
    }
    for prompt, case in by_prompt.items():
        tool, member = expect[prompt[len(akira):]]
        assert case["expect_tool"] == tool and case["expect_member_id"] == member
        # the speaker is the roster's current speaker
        assert f"- Akira (Discord {HANGAR_MEMBER_AKIRA})  ← current speaker" in case["system_prompt"]


def test_micro_case_history_establishes_the_hemera_and_roster_names_micro():
    case = next(c for c in _hangar_cases() if c["expect_member_id"] == HANGAR_MEMBER_MICRO)
    assert "Hemera" in case["history"][0]["content"]
    assert case["history"][0]["content"].startswith(f"[Akira · {HANGAR_MEMBER_AKIRA}]: ")
    assert case["history"][0]["role"] == "user" and case["history"][1]["role"] == "assistant"
    assert f"- Micro (Discord {HANGAR_MEMBER_MICRO})" in case["system_prompt"]


def test_eval_set_has_roster_carrying_cases_that_must_not_call_hangar_tools():
    rostered = [c for c in SC_EVAL_SET if c.get("system_prompt") and not c.get("hangar")]
    assert any(c["expect_tool"] is None for c in rostered)              # a plain control
    assert any(c["expect_tool"] == "sc_compare_components" for c in rostered)  # SC, not about own ships
    for c in rostered:
        assert c["prompt"].startswith(f"[Akira · {HANGAR_MEMBER_AKIRA}]: ")


def test_eval_roster_matches_the_bots_roster_format():
    # services/identity/roster.js formatRoster, verbatim
    assert ROSTER_HEADING == "## People in this conversation"
    assert ROSTER_INSTRUCTION == (
        'Messages are labelled [Name · Discord ID]. "I", "me" and "my" mean the labelled speaker of '
        "that message. Use this list only to work out who is who; don't mention these aliases unless "
        "it matters. Never start your own replies with a label.")
    r = eval_roster([("Akira", HANGAR_MEMBER_AKIRA), ("Micro", HANGAR_MEMBER_MICRO)],
                    current=HANGAR_MEMBER_AKIRA)
    assert r == (f"{ROSTER_HEADING}\n{ROSTER_INSTRUCTION}\n"
                 f"- Akira (Discord {HANGAR_MEMBER_AKIRA})  ← current speaker\n"
                 f"- Micro (Discord {HANGAR_MEMBER_MICRO})")
    sp = eval_system_prompt([("Akira", HANGAR_MEMBER_AKIRA)])
    assert sp.endswith("\n\n" + eval_roster([("Akira", HANGAR_MEMBER_AKIRA)], current=HANGAR_MEMBER_AKIRA))


def test_chat_kwargs_forwards_system_prompt_when_present():
    case = _hangar_cases()[0]
    kw = _chat_kwargs(case)
    assert kw["system_prompt"] == case["system_prompt"]
    assert kw["user_message"] == case["prompt"]
    assert "system_prompt" not in _chat_kwargs({"prompt": "p", "expect_tool": None})


# --- seed script ------------------------------------------------------------

def test_seed_plan_is_exactly_the_three_fixture_ships():
    from eval.seed_hangar_eval import SEED_SHIPS
    assert SEED_SHIPS == [
        (HANGAR_MEMBER_AKIRA, "Vanguard Harbinger", "Harby"),
        (HANGAR_MEMBER_AKIRA, "Constellation Taurus", "Connie"),
        (HANGAR_MEMBER_MICRO, "Avenger Titan", None),
    ]


class _FakeHttp:
    """Records requests; answers like hangar-service."""

    def __init__(self, hangars=None):
        self.calls = []
        self.hangars = hangars or {}

    def request(self, method, url, headers=None, body=None):
        self.calls.append((method, url, dict(headers or {}), body))
        if method == "GET":
            member = url.split("/v1/members/")[1].split("/")[0]
            return 200, {"member": member, "ships": self.hangars.get(member, [])}
        if method == "POST":
            return 201, {"ship": {"shipId": "new"}}
        return 200, {"deleted": True}


def test_seed_posts_each_ship_as_its_owner_with_a_bearer_token():
    from eval.seed_hangar_eval import seed
    http = _FakeHttp()
    seed("https://hangar.example", token="TOK", http=http)
    posts = [c for c in http.calls if c[0] == "POST"]
    assert [(u, json.loads(b)) for _, u, _, b in posts] == [
        (f"https://hangar.example/v1/members/{HANGAR_MEMBER_AKIRA}/ships",
         {"vehicle": "Vanguard Harbinger", "nickname": "Harby"}),
        (f"https://hangar.example/v1/members/{HANGAR_MEMBER_AKIRA}/ships",
         {"vehicle": "Constellation Taurus", "nickname": "Connie"}),
        (f"https://hangar.example/v1/members/{HANGAR_MEMBER_MICRO}/ships",
         {"vehicle": "Avenger Titan", "nickname": None}),
    ]
    for _, url, headers, _ in posts:
        member = url.split("/v1/members/")[1].split("/")[0]
        assert headers["Authorization"] == "Bearer TOK"
        assert headers["X-Acting-Member"] == member
        assert headers["Content-Type"] == "application/json"


def test_seed_is_idempotent_skipping_ships_already_present():
    from eval.seed_hangar_eval import seed
    http = _FakeHttp(hangars={HANGAR_MEMBER_AKIRA: [
        {"shipId": "a", "vehicleName": "Vanguard Harbinger", "nickname": "Harby"}]})
    seed("https://hangar.example", token="TOK", http=http)
    posted = [json.loads(b)["vehicle"] for m, _, _, b in http.calls if m == "POST"]
    assert posted == ["Constellation Taurus", "Avenger Titan"]


def test_cleanup_deletes_every_ship_of_both_fixture_members_only():
    from eval.seed_hangar_eval import cleanup
    http = _FakeHttp(hangars={
        HANGAR_MEMBER_AKIRA: [{"shipId": "a1"}, {"shipId": "a2"}],
        HANGAR_MEMBER_MICRO: [{"shipId": "m1"}],
    })
    cleanup("https://hangar.example", token="TOK", http=http)
    deletes = [(u, h["X-Acting-Member"]) for m, u, h, _ in http.calls if m == "DELETE"]
    assert deletes == [
        (f"https://hangar.example/v1/members/{HANGAR_MEMBER_AKIRA}/ships/a1", HANGAR_MEMBER_AKIRA),
        (f"https://hangar.example/v1/members/{HANGAR_MEMBER_AKIRA}/ships/a2", HANGAR_MEMBER_AKIRA),
        (f"https://hangar.example/v1/members/{HANGAR_MEMBER_MICRO}/ships/m1", HANGAR_MEMBER_MICRO),
    ]


def test_seed_raises_on_a_non_2xx_response():
    from eval.seed_hangar_eval import HangarSeedError, seed

    class _Fail(_FakeHttp):
        def request(self, method, url, headers=None, body=None):
            if method == "POST":
                return 409, {"error": "ambiguous", "candidates": [{"label": "X"}]}
            return super().request(method, url, headers, body)
    with pytest.raises(HangarSeedError, match="409"):
        seed("https://hangar.example", token="TOK", http=_Fail())


def test_fixture_member_ids_are_fake_numeric_discord_ids():
    assert HANGAR_MEMBER_AKIRA == "100000000000000001"
    assert HANGAR_MEMBER_MICRO == "100000000000000002"


# --- final review fixes -------------------------------------------------------

def test_purchasable_followup_detects_compare_after_hangar():
    from eval.eval_sc import _purchasable_followup
    hangar = {"name": "sc_member_hangar", "args": {"member_id": HANGAR_MEMBER_AKIRA}}
    good = {"name": "sc_compare_components", "args": {"type": "shield", "size": 2, "purchasable_only": True}}
    unfiltered = {"name": "sc_compare_components", "args": {"type": "shield", "size": 2}}
    assert _purchasable_followup(_r([hangar, good]))
    assert not _purchasable_followup(_r([hangar, unfiltered]))
    assert not _purchasable_followup(_r([good, hangar]))          # compare must FOLLOW the hangar call
    assert not _purchasable_followup(_r([hangar]))
    assert _purchasable_followup(_r([hangar, unfiltered, good]))


def test_uc1_case_asks_for_the_purchasable_followup_flag_only():
    flagged = [c for c in SC_EVAL_SET if c.get("expect_purchasable_compare")]
    assert [c["prompt"] for c in flagged] == [
        f"[Akira · {HANGAR_MEMBER_AKIRA}]: what's a purchasable upgraded shield for my Harbinger?"]


def test_purchasable_followup_is_not_a_scoring_gate():
    uc1 = next(c for c in SC_EVAL_SET if c.get("expect_purchasable_compare"))
    s = score_sc([(uc1, _r([_call("sc_member_hangar", HANGAR_MEMBER_AKIRA)]))])
    assert s["tool_hit_rate"] == 1.0 and set(s) == {
        "sandbox_attempts_total", "tool_hit_rate", "control_false_sc_calls", "unprompted_hangar_calls"}


def test_report_prompt_strips_the_speaker_label():
    from eval.eval_sc import _display_prompt
    assert _display_prompt({"prompt": f"[Akira · {HANGAR_MEMBER_AKIRA}]: what's on my Connie?"}) == \
        "what's on my Connie?"
    assert _display_prompt({"prompt": "where can I buy a Scorpius"}) == "where can I buy a Scorpius"
    assert _display_prompt({"prompt": "[not a label] hi"}) == "[not a label] hi"


def test_seed_script_docs_name_the_sc_knowledge_pod_only():
    import eval.seed_hangar_eval as seed_mod
    doc = seed_mod.__doc__
    assert "deploy/sc-knowledge" in doc
    assert "bot image" in doc  # says why not the bot pod
