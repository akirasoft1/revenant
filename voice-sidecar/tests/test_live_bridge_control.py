"""Voice control tools (end_conversation / go_quiet), handled LOCALLY in the
sidecar: never sent to the sc-knowledge executor, answered with an ok
FunctionResponse on the CURRENT session, and surfaced to the bot as a
`VoiceServerEvent(control=Control(...))`. Spec:
docs/superpowers/specs/2026-09-27-voice-control-commands-design.md."""
import asyncio
import contextlib
import logging

from google.genai import types

from src import voice_pb2
from src.live_bridge import (CONTROL_NOTE, CONTROL_TOOL_DECLARATIONS, SC_MECHANICS_VOICE_NOTE,
                              SC_VOICE_NOTE, LiveBridge,
                             _ResumeState, _SessionRef, _SessionStats)
from tests.test_live_bridge_tools import (FC, FakeExecutor, ToolSession, _converse_briefly,
                                          _factory, _rejecting_factory, _tool_call_msg)

SEARCH_ONLY = [types.Tool(google_search=types.GoogleSearch())]


def _bridge(session=None, *, control=True, sc=None, factory=None, **kw):
    return LiveBridge(factory or _factory(session), model="m", default_voice="Puck",
                      sc_executor=sc, control_tools_enabled=control, **kw)


def _fd_names(cfg):
    return [d.name for t in (cfg.tools or []) if t.function_declarations
            for d in t.function_declarations]


async def _run_pump_emitting(bridge, session, wait=0.1, session_ref=None):
    if session_ref is None:
        session_ref = _SessionRef()
        session_ref.session = session
    out = []

    async def emit(ev):
        out.append(ev)
    task = asyncio.create_task(
        bridge._pump_server(session, emit, _SessionStats(), _ResumeState(), session_ref))
    await asyncio.sleep(wait)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    return out


def _controls(out):
    return [e.control for e in out if e.WhichOneof("event") == "control"]


# ---- declarations --------------------------------------------------------

def test_control_declarations_shape():
    by_name = {d.name: d for d in CONTROL_TOOL_DECLARATIONS}
    assert list(by_name) == ["end_conversation", "go_quiet"]
    assert by_name["go_quiet"].parameters_json_schema == {
        "type": "object", "properties": {"minutes": {"type": "number"}}}
    assert by_name["end_conversation"].parameters_json_schema is None
    assert by_name["end_conversation"].parameters is None
    for d in CONTROL_TOOL_DECLARATIONS:
        assert d.description and len(d.description) > 20


def test_live_config_declares_control_tools_without_sc():
    cfg = _bridge()._live_config(voice_pb2.SessionStart(user_id="u", system_prompt="PERSONA"))
    assert cfg.tools[0] == SEARCH_ONLY[0]
    fd_tools = [t for t in cfg.tools if t.function_declarations]
    assert len(fd_tools) == 1
    assert _fd_names(cfg) == ["end_conversation", "go_quiet"]
    assert cfg.system_instruction == "PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE + "\n\n" + CONTROL_NOTE


def test_live_config_control_tools_share_the_tool_with_sc_and_come_first():
    cfg = _bridge(sc=FakeExecutor())._live_config(
        voice_pb2.SessionStart(user_id="u", system_prompt="PERSONA"))
    fd_tools = [t for t in cfg.tools if t.function_declarations]
    assert len(fd_tools) == 1
    assert _fd_names(cfg) == ["end_conversation", "go_quiet", "sc_find_item"]
    assert cfg.system_instruction == "PERSONA\n\n" + SC_VOICE_NOTE + "\n\n" + CONTROL_NOTE


def test_live_config_control_tools_present_when_sc_has_no_declarations():
    cfg = _bridge(sc=FakeExecutor(declarations=[]))._live_config(
        voice_pb2.SessionStart(user_id="u", system_prompt="PERSONA"))
    assert _fd_names(cfg) == ["end_conversation", "go_quiet"]
    assert cfg.system_instruction == "PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE + "\n\n" + CONTROL_NOTE


def test_live_config_flag_off_and_sc_off_is_search_only_plus_mechanics_note():
    start = voice_pb2.SessionStart(user_id="u", system_prompt="PERSONA")
    off = _bridge(control=False)._live_config(start)
    legacy = LiveBridge(_factory(None), model="m", default_voice="Puck")._live_config(start)
    assert off.tools == SEARCH_ONLY
    assert off.system_instruction == "PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE
    assert off == legacy


def test_live_config_flag_off_with_sc_is_today_sc_config():
    start = voice_pb2.SessionStart(user_id="u", system_prompt="PERSONA")
    cfg = _bridge(control=False, sc=FakeExecutor())._live_config(start)
    assert _fd_names(cfg) == ["sc_find_item"]
    assert cfg.system_instruction == "PERSONA\n\n" + SC_VOICE_NOTE


def test_control_note_is_short_and_names_both_tools():
    assert "end_conversation" in CONTROL_NOTE and "go_quiet" in CONTROL_NOTE
    assert CONTROL_NOTE.count(". ") <= 2


# ---- tool-call handling --------------------------------------------------

async def test_end_conversation_answers_ok_and_emits_control_without_executor(caplog):
    session = ToolSession([_tool_call_msg(FC("c1", "end_conversation", {}))])
    ex = FakeExecutor()
    with caplog.at_level(logging.INFO):
        out = await _run_pump_emitting(_bridge(session, sc=ex), session)
    rs = session.responses()
    assert len(rs) == 1 and rs[0].id == "c1" and rs[0].name == "end_conversation"
    assert rs[0].response["ok"] is True and rs[0].response["action"] == "end"
    assert ex.calls == []
    ctl = _controls(out)
    assert len(ctl) == 1 and ctl[0].action == "end" and ctl[0].seconds == 0
    assert "voice: control end (0s) via tool" in caplog.text


async def test_go_quiet_converts_minutes_to_seconds(caplog):
    session = ToolSession([_tool_call_msg(FC("q1", "go_quiet", {"minutes": 10}))])
    ex = FakeExecutor()
    with caplog.at_level(logging.INFO):
        out = await _run_pump_emitting(_bridge(session, sc=ex), session)
    rs = session.responses()
    assert len(rs) == 1 and rs[0].id == "q1" and rs[0].name == "go_quiet"
    assert rs[0].response == {"ok": True, "action": "quiet", "minutes": 10}
    assert ex.calls == []
    ctl = _controls(out)
    assert len(ctl) == 1 and ctl[0].action == "quiet" and ctl[0].seconds == 600
    assert "voice: control quiet (600s) via tool" in caplog.text


async def test_go_quiet_rounds_fractional_minutes():
    session = ToolSession([_tool_call_msg(FC("q1", "go_quiet", {"minutes": 2.5}))])
    out = await _run_pump_emitting(_bridge(session), session)
    assert _controls(out)[0].seconds == 150
    session = ToolSession([_tool_call_msg(FC("q2", "go_quiet", {"minutes": 0.0125}))])
    out = await _run_pump_emitting(_bridge(session), session)
    assert _controls(out)[0].seconds == 1          # round(0.75)


async def test_go_quiet_missing_or_invalid_minutes_is_zero_seconds():
    for args in (None, {}, {"minutes": None}, {"minutes": "ten"}, {"minutes": -5},
                 {"minutes": float("nan")}, {"minutes": float("inf")}, {"minutes": True}):
        session = ToolSession([_tool_call_msg(FC("q", "go_quiet", args))])
        out = await _run_pump_emitting(_bridge(session), session)
        ctl = _controls(out)
        assert len(ctl) == 1 and ctl[0].action == "quiet" and ctl[0].seconds == 0, args
        rs = session.responses()
        assert len(rs) == 1 and rs[0].response["ok"] is True, args


async def test_go_quiet_numeric_string_minutes_is_accepted():
    session = ToolSession([_tool_call_msg(FC("q", "go_quiet", {"minutes": "20"}))])
    out = await _run_pump_emitting(_bridge(session), session)
    assert _controls(out)[0].seconds == 1200


async def test_go_quiet_huge_minutes_does_not_overflow_int32():
    session = ToolSession([_tool_call_msg(FC("q", "go_quiet", {"minutes": 1e12}))])
    out = await _run_pump_emitting(_bridge(session), session)
    assert _controls(out)[0].seconds == 2**31 - 1


async def test_control_and_sc_calls_in_one_message_are_routed_separately():
    session = ToolSession([_tool_call_msg(FC("a", "sc_find_item", {"name": "x"}),
                                          FC("b", "go_quiet", {"minutes": 1}))])
    ex = FakeExecutor()
    out = await _run_pump_emitting(_bridge(session, sc=ex), session)
    assert ex.calls == [("sc_find_item", {"name": "x"})]
    assert sorted(r.id for r in session.responses()) == ["a", "b"]
    assert [c.seconds for c in _controls(out)] == [60]


async def test_control_response_dropped_if_session_replaced_but_control_still_emitted():
    # The user's intent is real even if a reconnect swapped the session; the
    # bot enforces idempotently. Only the FunctionResponse must not leak into
    # a session that never saw the call id.
    session = ToolSession([_tool_call_msg(FC("c1", "end_conversation", {}))])
    ref = _SessionRef()
    ref.session = object()
    out = await _run_pump_emitting(_bridge(session), session, session_ref=ref)
    assert session.responses() == []
    assert [c.action for c in _controls(out)] == ["end"]


class _HangingToolResponseSession(ToolSession):
    """send_tool_response never returns (a half-dead stream)."""

    async def send_tool_response(self, *, function_responses):
        self.tool_responses.append((None, list(function_responses)))
        await asyncio.Event().wait()


async def test_control_event_is_emitted_before_the_tool_response_is_sent():
    # The bot is idempotent, so emitting first costs nothing; awaiting the
    # send first let a hung send_tool_response delay -- or, if the pump is
    # torn down, lose -- the user's command.
    session = _HangingToolResponseSession([_tool_call_msg(FC("c1", "go_quiet", {"minutes": 10}))])
    out = await _run_pump_emitting(_bridge(session), session)
    assert [(c.action, c.seconds) for c in _controls(out)] == [("quiet", 600)]
    assert [fr.id for fr in session.responses()] == ["c1"]  # the send was still attempted


async def test_control_event_precedes_the_tool_response_in_time():
    order = []
    session = ToolSession([_tool_call_msg(FC("c1", "end_conversation", {}))])
    real_send = session.send_tool_response

    async def send(*, function_responses):
        order.append("response")
        await real_send(function_responses=function_responses)
    session.send_tool_response = send
    bridge = _bridge(session)
    ref = _SessionRef()
    ref.session = session

    async def emit(ev):
        if ev.WhichOneof("event") == "control":
            order.append("control")
    task = asyncio.create_task(
        bridge._pump_server(session, emit, _SessionStats(), _ResumeState(), ref))
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert order == ["control", "response"]


async def test_control_names_with_flag_off_keep_todays_handling():
    session = ToolSession([_tool_call_msg(FC("c1", "end_conversation", {}))])
    out = await _run_pump_emitting(_bridge(session, control=False), session)
    rs = session.responses()
    assert len(rs) == 1 and rs[0].response["error"] == "tools_unavailable"
    assert _controls(out) == []
    session = ToolSession([_tool_call_msg(FC("c1", "end_conversation", {}))])
    ex = FakeExecutor()
    out = await _run_pump_emitting(_bridge(session, control=False, sc=ex), session)
    assert session.responses()[0].response["error"] == "unknown_tool"
    assert ex.calls == [] and _controls(out) == []


async def test_control_event_reaches_bot_through_converse():
    session = ToolSession([_tool_call_msg(FC("c1", "go_quiet", {"minutes": 3}))])
    out = await _converse_briefly(_bridge(session))
    ctl = _controls(out)
    assert len(ctl) == 1 and ctl[0].action == "quiet" and ctl[0].seconds == 180
    assert len(session.responses()) == 1


# ---- connect fallback ----------------------------------------------------

async def test_sc_fallback_keeps_control_tools(caplog):
    session = ToolSession([])
    opens = []

    def rejects_sc(config):
        return "sc_find_item" in _fd_names(config)

    @contextlib.asynccontextmanager
    async def make(model, config):
        opens.append(config)
        if rejects_sc(config):
            raise RuntimeError("400 INVALID_ARGUMENT: bad sc schema")
        yield session

    bridge = _bridge(sc=FakeExecutor(), factory=make, max_reconnects=0)
    with caplog.at_level(logging.INFO):
        out = await _converse_briefly(bridge)
    assert len(opens) == 2
    assert _fd_names(opens[0]) == ["end_conversation", "go_quiet", "sc_find_item"]
    assert _fd_names(opens[1]) == ["end_conversation", "go_quiet"]
    assert opens[1].system_instruction == "PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE + "\n\n" + CONTROL_NOTE
    assert not any(e.WhichOneof("event") == "error" for e in out)
    assert "sc_fallbacks=1" in caplog.text


async def test_open_rejected_with_only_control_tools_falls_back_to_none(caplog):
    session = ToolSession([])
    opens = []
    bridge = _bridge(factory=_rejecting_factory(session, opens), max_reconnects=0)
    with caplog.at_level(logging.INFO):
        out = await _converse_briefly(bridge)
    assert len(opens) == 2
    assert _fd_names(opens[0]) == ["end_conversation", "go_quiet"]
    assert opens[1].tools == SEARCH_ONLY
    assert opens[1].system_instruction == "PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE
    assert not any(e.WhichOneof("event") == "error" for e in out)
    warn = [r for r in caplog.records
            if r.levelno == logging.WARNING and "control" in r.getMessage()]
    assert len(warn) == 1


async def test_both_rejected_cascades_sc_then_control_then_search_only():
    session = ToolSession([])
    opens = []
    bridge = _bridge(sc=FakeExecutor(), factory=_rejecting_factory(session, opens),
                     max_reconnects=0)
    out = await _converse_briefly(bridge)
    assert [_fd_names(o) for o in opens] == [
        ["end_conversation", "go_quiet", "sc_find_item"], ["end_conversation", "go_quiet"], []]
    assert not any(e.WhichOneof("event") == "error" for e in out)


async def test_control_fallback_is_single_shot_then_budget_applies():
    session = ToolSession([])
    opens = []
    bridge = _bridge(factory=_rejecting_factory(session, opens, reject_open_numbers={1, 2, 3}),
                     max_reconnects=0)
    out = await _converse_briefly(bridge)
    assert len(opens) == 2
    assert any(e.WhichOneof("event") == "error" for e in out)
