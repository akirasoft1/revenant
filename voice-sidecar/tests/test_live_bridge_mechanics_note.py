"""The disputed-mechanics rule must reach EVERY voice session exactly once.

It rides inside SC_VOICE_NOTE when the sc_* declarations are attached; when
they are not (sc-knowledge off/unavailable, empty declarations, or the
search-only connect fallback) a standalone SC_MECHANICS_VOICE_NOTE carries
the same rule -- Google Search is always attached on the Live config, so the
search variant always applies. Never both.
"""
import contextlib

from google.genai import types

from src import voice_pb2
from src.live_bridge import (CONTROL_NOTE, SC_MECHANICS_RULE, SC_MECHANICS_VOICE_NOTE,
                             SC_VOICE_NOTE, LiveBridge)

from .test_live_bridge_tools import FakeExecutor, ToolSession, _converse_briefly

START = voice_pb2.SessionStart(user_id="u", system_prompt="PERSONA")
SEARCH_ONLY = [types.Tool(google_search=types.GoogleSearch())]


def _factory(session=None):
    @contextlib.asynccontextmanager
    async def make(model, config):
        yield session
    return make


def _bridge(*, sc=None, control=True, factory=None, **kw):
    return LiveBridge(factory or _factory(), model="m", default_voice="Puck",
                      sc_executor=sc, control_tools_enabled=control, **kw)


def _rule_count(instruction):
    return (instruction or "").count(SC_MECHANICS_RULE)


def test_rule_is_shared_verbatim_by_both_notes():
    assert SC_MECHANICS_RULE in SC_VOICE_NOTE
    assert SC_MECHANICS_RULE in SC_MECHANICS_VOICE_NOTE
    assert "sc_*" not in SC_MECHANICS_VOICE_NOTE  # never promises tools that aren't attached
    assert "Star Citizen" in SC_MECHANICS_VOICE_NOTE


def test_sc_attached_carries_sc_note_only():
    for control in (True, False):
        cfg = _bridge(sc=FakeExecutor(), control=control)._live_config(START)
        assert SC_VOICE_NOTE in cfg.system_instruction
        assert SC_MECHANICS_VOICE_NOTE not in cfg.system_instruction
        assert _rule_count(cfg.system_instruction) == 1


def test_sc_absent_carries_standalone_note_once():
    for sc in (None, FakeExecutor(declarations=[])):
        for control in (True, False):
            cfg = _bridge(sc=sc, control=control)._live_config(START)
            assert cfg.system_instruction.startswith("PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE)
            assert SC_VOICE_NOTE not in cfg.system_instruction
            assert _rule_count(cfg.system_instruction) == 1
            assert (CONTROL_NOTE in cfg.system_instruction) is control


def test_sc_absent_without_persona_still_gets_the_note():
    cfg = _bridge(control=False)._live_config(voice_pb2.SessionStart(user_id="u"))
    assert cfg.system_instruction == "\n\n" + SC_MECHANICS_VOICE_NOTE
    assert cfg.tools == SEARCH_ONLY


async def test_search_only_fallback_rederives_notes():
    session = ToolSession([])
    opens = []

    @contextlib.asynccontextmanager
    async def make(model, config):
        opens.append(config)
        if any(d.name == "sc_find_item" for t in config.tools for d in (t.function_declarations or [])):
            raise RuntimeError("400 INVALID_ARGUMENT: bad sc schema")
        yield session

    await _converse_briefly(_bridge(sc=FakeExecutor(), factory=make, max_reconnects=0))
    assert len(opens) == 2
    assert SC_VOICE_NOTE in opens[0].system_instruction
    assert SC_MECHANICS_VOICE_NOTE not in opens[0].system_instruction
    # fallback: SC note dropped, standalone mechanics note added, exactly once
    assert SC_VOICE_NOTE not in opens[1].system_instruction
    assert opens[1].system_instruction == ("PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE
                                           + "\n\n" + CONTROL_NOTE)
    assert _rule_count(opens[1].system_instruction) == 1
