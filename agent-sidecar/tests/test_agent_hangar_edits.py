"""Hangar chat edits on the text agent: the three edit tools are attached per
turn bound to the turn's user_id, only when edits are enabled and Star
Citizen notes are in play; the prompt sentence rides in both SC notes (both
web_search variants) only when the tools are attached; the result carries the
successful-edit count."""
import asyncio
import json

import httpx
import pytest

import src.agent as A
from src.agent import (
    SC_HANGAR_EDIT_RULE,
    SC_HANGAR_EDIT_RULE_UNAVAILABLE,
    SC_HANGAR_RULE,
    SC_HANGAR_UNAVAILABLE,
    SC_TOOLS_PREAMBLE,
    SC_TOOLS_UNAVAILABLE_NOTE,
    AgentChatResult,
    ChannelVoiceAgent,
    TOOL_AVAILABILITY_PREAMBLE,
    sc_tools_preamble,
    sc_tools_unavailable_note,
)
from src.config import load
from src.hangar_edit import EDIT_TOOL_NAMES, HangarEditClient

AKIRA = "100000000000000001"


class _Tokens:
    async def token(self):
        return "tok"


FIT_OK = {"ship": {"shipId": "s1", "label": "Connie"},
          "changes": [{"slot": "qd", "from": {"name": "Bolon"}, "to": {"name": "Hemera"}}],
          "unchanged": False}


def _hangar_client(seen):
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=FIT_OK)
    return HangarEditClient("https://h.example", _Tokens(), transport=httpx.MockTransport(handler))


class _Provider:
    def __init__(self, up=True):
        self._up = up
        self.enabled = True
        self.toolsets = []

    async def available(self):
        return self._up


class _SessionService:
    async def create_session(self, **kw):
        return None


def _agent(monkeypatch, *, sc_tools=None, hangar=None, flag="true", call=None):
    """`call`: optional (tool_name, kwargs) the fake runner executes against
    the attached tool, as the model would, before yielding a reply."""
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "img")
    monkeypatch.setenv("AGENT_WEB_SEARCH_ENABLED", flag)
    captured = {}

    def fake_agent(**kw):
        captured.update(kw)
        return object()

    class _Runner:
        def __init__(self, *, agent, app_name):
            self.session_service = _SessionService()

        async def run_async(self, **kw):
            if call:
                name, kwargs = call
                fn = next(t for t in captured["tools"] if getattr(t, "__name__", None) == name)
                await fn(**kwargs)

            class _E:
                grounding_metadata = None
                content = type("C", (), {"parts": [type("P", (), {"text": "done", "function_call": None})()]})()
            yield _E()

        async def close(self):
            return None

    monkeypatch.setattr(A, "Agent", fake_agent)
    monkeypatch.setattr(A, "InMemoryRunner", _Runner)
    monkeypatch.setattr(A, "_build_generate_content_config", lambda: None)
    ag = ChannelVoiceAgent(config=load(), orchestrator=None, base_system_prompt="BASE",
                           sc_tools=sc_tools, hangar_edits=hangar)
    return ag, captured


def _chat(ag, user_id=AKIRA):
    return asyncio.run(ag.process_chat(user_id=user_id, user_message="hi", system_prompt="SYS"))


def _names(tools):
    return [getattr(t, "__name__", None) for t in tools]


# --- prompt sentence ----------------------------------------------------------

def test_edit_rule_covers_every_spec_point():
    r = SC_HANGAR_EDIT_RULE
    for name in EDIT_TOOL_NAMES:
        assert name in r
    low = r.lower()
    assert "only when" in low and "did" in low.lower()
    assert "should i" in low  # hypotheticals/advice excluded
    # owner ruling: an explicit request to update the speaker's OWN hangar is an edit
    assert "asks you to update" in low or "asks to update" in low
    # a write that may have landed is never blindly repeated
    assert "maybe_applied" in r and "sc_member_hangar" in r
    assert "choose_slot" in r and "ambiguous" in r
    assert "exactly what changed" in low
    assert "canonical item name" in low  # a fuzzy item match must be visible
    assert "which" in low  # on ambiguous: ask which candidate
    assert "own hangar" in low and "anyone else" in low
    # one sentence
    assert r.count(". ") == 0 and r.endswith(".")


@pytest.mark.parametrize("web", [True, False])
def test_sc_preamble_carries_the_edit_rule_once_only_when_edits_attached(web):
    with_edits = sc_tools_preamble(web_search=web, hangar_edits=True)
    assert with_edits.count(SC_HANGAR_EDIT_RULE) == 1
    # right after the read-side hangar rule
    assert with_edits.index(SC_HANGAR_RULE) < with_edits.index(SC_HANGAR_EDIT_RULE) \
        < with_edits.index("For ANY Star Citizen question")
    without = sc_tools_preamble(web_search=web)
    assert SC_HANGAR_EDIT_RULE not in without
    assert "hangar_fit" not in without
    assert with_edits.replace(f"{SC_HANGAR_EDIT_RULE} ", "") == without


@pytest.mark.parametrize("web", [True, False])
def test_unavailable_note_keeps_edits_coherent(web):
    with_edits = sc_tools_unavailable_note(web_search=web, hangar_edits=True)
    assert with_edits.count(SC_HANGAR_EDIT_RULE_UNAVAILABLE) == 1
    assert SC_HANGAR_EDIT_RULE not in with_edits
    # never promise a tool that isn't attached: no sc_* tool is named at all
    assert "sc_member_hangar" not in with_edits and "sc_" not in with_edits
    assert SC_HANGAR_UNAVAILABLE in with_edits
    # lookups are down but recording still works -- the note must not tell the
    # model hangars are wholly unreachable without saying edits still work
    assert "can still" in with_edits.lower()
    without = sc_tools_unavailable_note(web_search=web)
    assert "hangar_fit" not in without


def test_legacy_constants_stay_edit_free():
    assert SC_TOOLS_PREAMBLE == sc_tools_preamble(web_search=False, hangar_edits=False)
    assert SC_TOOLS_UNAVAILABLE_NOTE == sc_tools_unavailable_note(web_search=False, hangar_edits=False)
    assert "hangar_fit" not in SC_TOOLS_PREAMBLE + SC_TOOLS_UNAVAILABLE_NOTE


def test_compose_instruction_off_still_byte_identical_even_with_edits_flag():
    a = ChannelVoiceAgent(config=None, orchestrator=None, base_system_prompt="BASE")
    assert a._compose_instruction(system_prompt="SYS", sc_state="off", hangar_edits=True) \
        == f"SYS\n\n{TOOL_AVAILABILITY_PREAMBLE}"


# --- attachment ---------------------------------------------------------------

@pytest.mark.parametrize("up,web", [(True, True), (True, False), (False, True), (False, False)])
def test_edit_tools_attached_with_sc_notes_when_enabled(monkeypatch, up, web):
    seen = []
    ag, cap = _agent(monkeypatch, sc_tools=_Provider(up), hangar=_hangar_client(seen),
                     flag="true" if web else "false")
    _chat(ag)
    for n in EDIT_TOOL_NAMES:
        assert n in _names(cap["tools"])
    assert (SC_HANGAR_EDIT_RULE if up else SC_HANGAR_EDIT_RULE_UNAVAILABLE) in cap["instruction"]
    if not up:
        assert "sc_member_hangar" not in cap["instruction"]


def test_edit_tools_not_attached_when_disabled(monkeypatch):
    ag, cap = _agent(monkeypatch, sc_tools=_Provider(True), hangar=None)
    _chat(ag)
    assert not set(EDIT_TOOL_NAMES) & set(_names(cap["tools"]))
    assert "hangar_fit" not in cap["instruction"]


def test_edit_tools_not_attached_when_sc_off(monkeypatch):
    # no SC note at all -> no rule to govern the write tools -> not attached
    ag, cap = _agent(monkeypatch, sc_tools=None, hangar=_hangar_client([]))
    _chat(ag)
    assert not set(EDIT_TOOL_NAMES) & set(_names(cap["tools"]))
    assert "hangar_fit" not in cap["instruction"]


def test_edit_tool_writes_to_the_turn_authors_hangar(monkeypatch):
    seen = []
    ag, _ = _agent(monkeypatch, sc_tools=_Provider(True), hangar=_hangar_client(seen),
                   call=("hangar_fit", {"ship": "my Connie", "item": "Hemera"}))
    res = _chat(ag, user_id="424242")
    (req,) = seen
    assert req.url.path == "/v1/members/424242/fit"
    assert req.headers["X-Acting-Member"] == "424242"
    assert json.loads(req.content)["ship"] == "my Connie"
    assert res.hangar_edits == 1
    assert res.hangar_edit_calls == [{"name": "hangar_fit",
                                      "args": {"ship": "my Connie", "item": "Hemera", "slot": None},
                                      "result": "ok"}]


def test_unknown_speaker_turn_refuses_and_counts_no_edit(monkeypatch):
    seen = []
    ag, _ = _agent(monkeypatch, sc_tools=_Provider(True), hangar=_hangar_client(seen),
                   call=("hangar_add_ship", {"vehicle": "Cutlass Black"}))
    res = _chat(ag, user_id="eval")
    assert seen == []
    assert res.hangar_edits == 0
    assert res.hangar_edit_calls[0]["result"] == "unknown_speaker"


def test_result_defaults_have_no_edits():
    r = AgentChatResult(message_text="x", execution_ids=[], any_failed=False)
    assert r.hangar_edits == 0
    assert r.hangar_edit_calls == []


def test_unavailable_edit_rule_variant():
    r = SC_HANGAR_EDIT_RULE_UNAVAILABLE
    for name in EDIT_TOOL_NAMES:
        assert name in r
    assert "sc_" not in r
    low = r.lower()
    assert "maybe_applied" in r and "may have saved" in low and "check their hangar later" in low
    assert "don't repeat it" in low
    assert "should i" in low and "own hangar" in low and "canonical item name" in low
    assert r.count(". ") == 0 and r.endswith(".")
    # identical to the attached rule except the maybe_applied clause
    assert r.split("after a maybe_applied")[0] == SC_HANGAR_EDIT_RULE.split("after a maybe_applied")[0]
