"""Native google_search on the text agent (Gemini-only, flag-gated), the
prompt text that goes with it, the grounding-query plumbing, and the
Star Citizen honest-fallback prompt rules."""
import asyncio

import pytest
from google.adk.tools import google_search

import src.agent as A
from src.agent import (
    AgentChatResult,
    ChannelVoiceAgent,
    SC_TOOLS_PREAMBLE,
    SC_TOOLS_UNAVAILABLE_NOTE,
    TOOL_AVAILABILITY_PREAMBLE,
    WEB_SEARCH_PREAMBLE,
    sc_tools_preamble,
    sc_tools_unavailable_note,
)
from src.config import load
from src.sc_tools import ScToolsProvider


# --- config flag -----------------------------------------------------------

def _env(monkeypatch, **extra):
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "img")
    for k, v in extra.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)


def test_web_search_flag_defaults_true(monkeypatch):
    _env(monkeypatch, AGENT_WEB_SEARCH_ENABLED=None)
    assert load().agent_web_search_enabled is True


@pytest.mark.parametrize("val", ["false", "0", "no", "False"])
def test_web_search_flag_can_be_disabled(monkeypatch, val):
    _env(monkeypatch, AGENT_WEB_SEARCH_ENABLED=val)
    assert load().agent_web_search_enabled is False


# --- tool attachment -------------------------------------------------------

class _Part:
    def __init__(self, text=None, function_call=None):
        self.text = text
        self.function_call = function_call


class _Content:
    def __init__(self, parts):
        self.parts = parts


class _GM:
    def __init__(self, queries):
        self.web_search_queries = queries


class _Event:
    def __init__(self, text=None, queries=None, content=True):
        self.content = _Content([_Part(text)]) if content else None
        self.grounding_metadata = _GM(queries) if queries is not None else None


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


def _agent(monkeypatch, *, model="gemini-3.8-flash", flag="true", events=None, sc_tools=None):
    _env(monkeypatch, AGENT_MODEL=model, AGENT_WEB_SEARCH_ENABLED=flag)
    captured = {}

    def fake_agent(**kw):
        captured.update(kw)
        return object()
    monkeypatch.setattr(A, "Agent", fake_agent)
    monkeypatch.setattr(A, "InMemoryRunner", _runner_factory(events or [_Event("the reply")]))
    monkeypatch.setattr(A, "_build_generate_content_config", lambda: None)
    ag = ChannelVoiceAgent(config=load(), orchestrator=None, base_system_prompt="BASE", sc_tools=sc_tools)
    return ag, captured


def _chat(ag, **kw):
    return asyncio.run(ag.process_chat(user_id="u", user_message="hi", system_prompt="SYS", **kw))


@pytest.mark.parametrize("model", ["gemini-3.8-flash", "gemini/gemini-3.8-flash", ""])
def test_google_search_attached_for_gemini_with_flag_on(monkeypatch, model):
    ag, cap = _agent(monkeypatch, model=model)
    _chat(ag)
    assert google_search in cap["tools"]
    assert WEB_SEARCH_PREAMBLE in cap["instruction"]


@pytest.mark.parametrize("model", ["openai/gpt-6-luna", "anthropic/claude-opus-4-7"])
def test_google_search_not_attached_for_litellm(monkeypatch, model):
    ag, cap = _agent(monkeypatch, model=model)
    _chat(ag)
    assert google_search not in cap["tools"]
    assert WEB_SEARCH_PREAMBLE not in cap["instruction"]
    assert "google_search" not in cap["instruction"]


def test_google_search_not_attached_when_flag_off(monkeypatch):
    ag, cap = _agent(monkeypatch, flag="false")
    _chat(ag)
    assert google_search not in cap["tools"]
    assert "google_search" not in cap["instruction"]


def test_google_search_not_attached_for_a_non_gemini_model_object(monkeypatch):
    # Decided on the model actually built, not the spec string: ADK raises
    # "Google search tool is not supported for model X" for anything else.
    ag, cap = _agent(monkeypatch)
    monkeypatch.setattr(A, "_build_model", lambda spec: object())
    _chat(ag)
    assert google_search not in cap["tools"]
    assert "google_search" not in cap["instruction"]


def test_google_search_not_attached_for_gemini_object_with_non_gemini_name(monkeypatch):
    # ADK's google_search raises "not supported" unless is_gemini_model(model.model).
    from google.adk.models import Gemini
    ag, cap = _agent(monkeypatch)
    monkeypatch.setattr(A, "_build_model", lambda spec: Gemini(model="my-tuned-endpoint"))
    _chat(ag)
    assert google_search not in cap["tools"]
    assert "google_search" not in cap["instruction"]


def test_never_uses_bypass_mode_google_search_tool(monkeypatch):
    # GoogleSearchTool(bypass_multi_tools_limit=True) crashes in ADK 2.10;
    # only the stock module-level instance may be attached.
    ag, cap = _agent(monkeypatch)
    _chat(ag)
    searches = [t for t in cap["tools"] if type(t).__name__ == "GoogleSearchTool"]
    assert searches == [google_search]
    assert not getattr(searches[0], "bypass_multi_tools_limit", False)


# --- prompt text -----------------------------------------------------------

def test_web_search_preamble_content():
    p = WEB_SEARCH_PREAMBLE
    assert "google_search" in p
    for s in ("news", "patch notes", "docs", "training data"):
        assert s in p
    # look-up clause
    assert ("never use run_in_sandbox to scrape web pages or query search engines "
            "to find information") in p
    # carve-out clause: sandbox stays correct for live network behavior/recon,
    # so it doesn't contradict TOOL_AVAILABILITY_PREAMBLE
    assert "The sandbox is still correct when the live network behavior of a specific target" in p
    for s in ("headers", "TLS", "redirects", "raw content of a URL the user named", "recon of a host"):
        assert s in p


def test_web_search_preamble_verbatim():
    assert WEB_SEARCH_PREAMBLE == (
        "You also have google_search. To look up information — news, patch notes, docs, what "
        "sources say about a topic, anything past your training data — use google_search; never "
        "use run_in_sandbox to scrape web pages or query search engines to find information. The "
        "sandbox is still correct when the live network behavior of a specific target is itself "
        "the subject — an HTTP response's status, headers, TLS, redirects or timing, the raw "
        "content of a URL the user named, or recon of a host."
    )


def test_tool_availability_preamble_itself_is_unchanged_and_search_free():
    # The sandbox-last-resort disposition is untouched; the search text only
    # ever rides along as a separate block when the tool is attached.
    assert "google_search" not in TOOL_AVAILABILITY_PREAMBLE
    assert "LAST resort" in TOOL_AVAILABILITY_PREAMBLE


def test_compose_instruction_includes_search_text_only_when_attached():
    a = ChannelVoiceAgent(config=None, orchestrator=None, base_system_prompt="BASE")
    on = a._compose_instruction(system_prompt="S", sc_state="available", web_search=True)
    off = a._compose_instruction(system_prompt="S", sc_state="available", web_search=False)
    assert WEB_SEARCH_PREAMBLE in on and sc_tools_preamble(web_search=True) in on
    assert "google_search" not in off and sc_tools_preamble(web_search=False) in off
    un_on = a._compose_instruction(system_prompt="S", sc_state="unavailable", web_search=True)
    un_off = a._compose_instruction(system_prompt="S", sc_state="unavailable", web_search=False)
    assert sc_tools_unavailable_note(web_search=True) in un_on
    assert "google_search" not in un_off


@pytest.mark.parametrize("web", [True, False])
def test_sc_preamble_lists_location_shops_and_memory_rule(web):
    p = sc_tools_preamble(web_search=web)
    assert "sc_location_shops" in p
    assert "unique to" in p
    assert "years out of date" in p
    for s in ("vaulted", "removed", "not in the game", "located somewhere"):
        assert s in p
    assert "results win" in p
    assert ("tool or search results" in p) is web
    assert ("tool results win" in p) is (not web)
    # never-sandbox rule kept
    assert "never write code or use run_in_sandbox to fetch, compute, or re-rank Star Citizen data" in p
    # the old, dishonest "web search" sentence is gone
    assert "Use web search on top of them" not in p
    assert "clearly-labelled" in p and "possibly outdated" in p
    assert "couldn't confirm" in p


def test_sc_preamble_ordered_policy_names_search_only_when_attached():
    on = sc_tools_preamble(web_search=True)
    off = sc_tools_preamble(web_search=False)
    assert "google_search" in on and "web-sourced" in on
    for s in ("vehicle loadouts", "crafting/blueprints", "lore", "patch news", "location facilities"):
        assert s in on and s in off
    assert on.index("(1)") < on.index("(2)") < on.index("(3)")
    assert on.index("google_search") < on.index("(3)")
    assert "google_search" not in off
    # empty / not_found results fall through too, not only "no tool covers it"
    two_on = on[on.index("(2)"):on.index("(3)")]
    assert "return nothing" in two_on and "not_found" in two_on
    three_on = on[on.index("(3)"):]
    assert three_on.startswith("(3) if that still yields nothing reliable")
    two_off = off[off.index("(2)"):]
    assert "return nothing" in two_off and "not_found" in two_off
    assert "never" in two_off and "memory" in two_off


@pytest.mark.parametrize("web", [True, False])
def test_sc_unavailable_note_rules(web):
    n = sc_tools_unavailable_note(web_search=web)
    assert ("google_search" in n) is web
    assert "run_in_sandbox" in n
    assert "vaulted" in n and "results win" in n
    assert ("tool or search results" in n) is web
    assert ("tool results win" in n) is (not web)


def test_legacy_constants_are_the_no_search_variants():
    assert SC_TOOLS_PREAMBLE == sc_tools_preamble(web_search=False)
    assert SC_TOOLS_UNAVAILABLE_NOTE == sc_tools_unavailable_note(web_search=False)


def test_sc_available_turn_gets_search_variant_of_sc_preamble(monkeypatch):
    class _Provider:
        enabled = True
        toolsets = []

        async def available(self):
            return True
    ag, cap = _agent(monkeypatch, sc_tools=_Provider())
    _chat(ag)
    assert sc_tools_preamble(web_search=True) in cap["instruction"]


# --- grounding-query plumbing ---------------------------------------------

def test_web_search_queries_counted_from_grounding_metadata(monkeypatch, caplog):
    events = [
        _Event(queries=["levski shops"], content=False),  # grounding w/o content still counted
        _Event("partial", queries=["star citizen 4.3 patch", "anvil spartan turret"]),
        _Event("final answer", queries=None),
    ]
    ag, _ = _agent(monkeypatch, events=events)
    with caplog.at_level("INFO", logger="src.agent"):
        res = _chat(ag)
    assert res.web_search_queries == 3
    assert res.message_text == "final answer"
    assert any("web_search.queries=3" in r.getMessage() for r in caplog.records)


def test_web_search_queries_zero_and_no_log_when_none(monkeypatch, caplog):
    ag, _ = _agent(monkeypatch, events=[_Event("hi", queries=[]), _Event("there")])
    with caplog.at_level("INFO", logger="src.agent"):
        res = _chat(ag)
    assert res.web_search_queries == 0
    assert not any("web_search.queries" in r.getMessage() for r in caplog.records)


def test_agent_chat_result_defaults_web_search_queries_to_zero():
    assert AgentChatResult("x", [], False).web_search_queries == 0


# --- disputed / uncertain game mechanics (2026-09-29 voice incident) --------
# The model argued ~10 times from stale memory about quantum-drive speed while
# the player described NAV-mode behaviour they were seeing live. Mechanics are
# outside every sc_* tool, so the rule has to name search (when attached) and
# otherwise tell the model to defer rather than repeat itself.

SC_DISPUTE_RULE_SEARCH = (
    "Game mechanics (flight modes, quantum travel, how ship systems behave, anything the sc_* "
    "tools don't cover): look them up with google_search rather than answering from memory. "
    "If a player disputes your claim or describes what they are seeing in-game right now, "
    "search again before repeating it; if you still can't confirm it, defer to the player's "
    "live observation — never argue a game mechanic from memory."
)
SC_DISPUTE_RULE_NO_SEARCH = (
    "Game mechanics (flight modes, quantum travel, how ship systems behave) change between "
    "patches: if a player disputes a mechanics claim or describes what they are seeing in-game "
    "right now, don't repeat the claim from memory — say you can't verify it live and defer to "
    "their observation."
)


@pytest.mark.parametrize("builder", [sc_tools_preamble, sc_tools_unavailable_note])
def test_sc_dispute_rule_search_variant(builder):
    text = builder(web_search=True)
    assert SC_DISPUTE_RULE_SEARCH in text
    assert SC_DISPUTE_RULE_NO_SEARCH not in text


@pytest.mark.parametrize("builder", [sc_tools_preamble, sc_tools_unavailable_note])
def test_sc_dispute_rule_no_search_variant(builder):
    text = builder(web_search=False)
    assert SC_DISPUTE_RULE_NO_SEARCH in text
    assert SC_DISPUTE_RULE_SEARCH not in text
    assert "google_search" not in text and "search again" not in text


def test_legacy_constants_carry_the_no_search_dispute_rule():
    for text in (SC_TOOLS_PREAMBLE, SC_TOOLS_UNAVAILABLE_NOTE):
        assert SC_DISPUTE_RULE_NO_SEARCH in text
        assert "google_search" not in text
