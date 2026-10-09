"""Voice hangar chat edits (spec 2026-10-09-hangar-chat-edits-design.md).

hangar_fit / hangar_add_ship / hangar_reset are LOCAL tools: declared to Live
only when an editor is configured, answered in the sidecar (never the MCP
executor), and bound to the CURRENT SPEAKER's Discord id from trusted
plumbing -- SetSpeaker.user_id, else the SessionStart opener. The tools have
no member parameter, so the model cannot pick whose hangar it edits."""
import asyncio
import contextlib
import logging

from google.genai import types

from src import voice_pb2
from src.live_bridge import (CONTROL_NOTE, HANGAR_EDIT_NOTE, HANGAR_TOOL_DECLARATIONS,
                             SC_DISPUTE_TAIL, SC_MECHANICS_VOICE_NOTE, SC_VOICE_NOTE, LiveBridge,
                             _ResumeState, _SessionRef, _SessionStats)
from tests.test_live_bridge_tools import (FC, FakeExecutor, ToolSession, _factory,
                                          _rejecting_factory, _tool_call_msg)

SEARCH_ONLY = [types.Tool(google_search=types.GoogleSearch())]
START = voice_pb2.SessionStart(user_id="111", system_prompt="PERSONA")


class FakeEditor:
    def __init__(self, result=None, delay=0.0, exc=None):
        self.calls = []
        self.result = result if result is not None else {
            "ship": {"shipId": "s1", "label": "Constellation Taurus"},
            "changes": [{"slot": "hardpoint_quantum_drive", "from": {"name": "Bolon"},
                         "to": {"name": "Hemera"}}],
            "unchanged": False}
        self.delay = delay
        self.exc = exc

    async def call(self, name, member_id, args):
        self.calls.append((name, member_id, dict(args)))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        return self.result


def _bridge(session=None, *, editor=None, control=True, sc=None, factory=None, **kw):
    return LiveBridge(factory or _factory(session), model="m", default_voice="Puck",
                      sc_executor=sc, control_tools_enabled=control, hangar_editor=editor, **kw)


def _fd_names(cfg):
    return [d.name for t in (cfg.tools or []) if t.function_declarations
            for d in t.function_declarations]


def _ref(session, *, opener=None, speaker=None, cleared=False):
    ref = _SessionRef()
    ref.session = session
    ref.speaker.opener_id = opener
    if speaker is not None:
        ref.speaker.set(speaker)
    if cleared:
        ref.speaker.clear()
    return ref


async def _run_pump(bridge, session, ref, wait=0.1, stats=None):
    stats = stats or _SessionStats()

    async def emit(ev): pass
    task = asyncio.create_task(bridge._pump_server(session, emit, stats, _ResumeState(), ref))
    await asyncio.sleep(wait)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    return stats


# ---- declarations ----------------------------------------------------------

def test_declarations_shape_has_no_member_parameter():
    by_name = {d.name: d for d in HANGAR_TOOL_DECLARATIONS}
    assert list(by_name) == ["hangar_fit", "hangar_add_ship", "hangar_reset"]
    assert by_name["hangar_fit"].parameters_json_schema["required"] == ["ship", "item"]
    assert set(by_name["hangar_fit"].parameters_json_schema["properties"]) == {"ship", "item", "slot"}
    assert by_name["hangar_add_ship"].parameters_json_schema["required"] == ["vehicle"]
    assert set(by_name["hangar_add_ship"].parameters_json_schema["properties"]) == {
        "vehicle", "nickname"}
    assert by_name["hangar_reset"].parameters_json_schema["required"] == ["ship", "slot"]
    assert set(by_name["hangar_reset"].parameters_json_schema["properties"]) == {"ship", "slot"}
    for d in HANGAR_TOOL_DECLARATIONS:
        props = d.parameters_json_schema["properties"]
        assert not any("member" in p.lower() or "user" in p.lower() or "discord" in p.lower()
                       for p in props)
        assert "own" in d.description


def test_declarations_absent_without_editor():
    cfg = _bridge()._live_config(START)
    assert not any(n.startswith("hangar_") for n in _fd_names(cfg))
    assert HANGAR_EDIT_NOTE not in cfg.system_instruction


def test_declarations_present_with_editor_and_sc_off():
    cfg = _bridge(editor=FakeEditor())._live_config(START)
    assert _fd_names(cfg) == ["end_conversation", "go_quiet",
                              "hangar_fit", "hangar_add_ship", "hangar_reset"]
    assert len([t for t in cfg.tools if t.function_declarations]) == 1
    assert cfg.system_instruction == ("PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE + "\n\n"
                                      + CONTROL_NOTE + "\n\n" + HANGAR_EDIT_NOTE)


def test_declarations_share_the_tool_with_sc_and_control():
    cfg = _bridge(editor=FakeEditor(), sc=FakeExecutor())._live_config(START)
    assert _fd_names(cfg) == ["end_conversation", "go_quiet",
                              "hangar_fit", "hangar_add_ship", "hangar_reset", "sc_find_item"]
    assert len([t for t in cfg.tools if t.function_declarations]) == 1
    assert cfg.system_instruction.count(HANGAR_EDIT_NOTE) == 1
    assert SC_VOICE_NOTE in cfg.system_instruction


def test_declarations_present_with_control_off():
    cfg = _bridge(editor=FakeEditor(), control=False)._live_config(START)
    assert _fd_names(cfg) == ["hangar_fit", "hangar_add_ship", "hangar_reset"]
    assert cfg.system_instruction == ("PERSONA\n\n" + SC_MECHANICS_VOICE_NOTE + "\n\n"
                                      + HANGAR_EDIT_NOTE)


def test_note_appears_exactly_once_in_every_combination():
    for sc in (None, FakeExecutor(), FakeExecutor(declarations=[])):
        for control in (True, False):
            cfg = _bridge(editor=FakeEditor(), sc=sc, control=control)._live_config(START)
            assert cfg.system_instruction.count(HANGAR_EDIT_NOTE) == 1
            assert cfg.system_instruction.count(SC_DISPUTE_TAIL) == 1


def test_note_states_the_rules():
    n = HANGAR_EDIT_NOTE
    for tool in ("hangar_fit", "hangar_add_ship", "hangar_reset"):
        assert tool in n
    assert "should I" in n
    assert "choose_slot" in n and "ambiguous" in n
    assert "own" in n
    assert "changed" in n


# ---- binding: who is the acting member -------------------------------------

async def test_tool_call_uses_the_current_set_speaker_id():
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit",
                                             {"ship": "Connie", "item": "Hemera"}))])
    ed = FakeEditor()
    stats = await _run_pump(_bridge(session, editor=ed), session,
                            _ref(session, opener="111", speaker="222"))
    assert ed.calls == [("hangar_fit", "222", {"ship": "Connie", "item": "Hemera"})]
    rs = session.responses()
    assert len(rs) == 1 and rs[0].id == "h1" and rs[0].name == "hangar_fit"
    assert rs[0].response == ed.result
    assert stats.hangar_edits == 1


async def test_opener_is_the_fallback_before_any_set_speaker():
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_add_ship", {"vehicle": "Cutlass Black"}))])
    ed = FakeEditor(result={"added": True, "ship": {"shipId": "s9"}})
    await _run_pump(_bridge(session, editor=ed), session, _ref(session, opener="111"))
    assert ed.calls == [("hangar_add_ship", "111", {"vehicle": "Cutlass Black"})]


async def test_cleared_speaker_is_refused_without_calling_the_service():
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"}))])
    ed = FakeEditor()
    stats = await _run_pump(_bridge(session, editor=ed), session,
                            _ref(session, opener="111", speaker="222", cleared=True))
    assert ed.calls == []
    r = session.responses()[0].response
    assert r == {"error": "unknown_speaker",
                 "message": "I can't tell whose hangar to edit — try again after speaking"}
    assert stats.hangar_edits == 0


async def test_non_numeric_speaker_is_refused():
    for opener in ("", "voice-user", None):
        session = ToolSession([_tool_call_msg(FC("h1", "hangar_reset",
                                                 {"ship": "a", "slot": "all"}))])
        ed = FakeEditor()
        await _run_pump(_bridge(session, editor=ed), session, _ref(session, opener=opener))
        assert ed.calls == []
        assert session.responses()[0].response["error"] == "unknown_speaker"


async def test_model_supplied_member_args_cannot_redirect_the_edit():
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit",
                                             {"ship": "Titan", "item": "Hemera",
                                              "member_id": "999"}))])
    ed = FakeEditor()
    await _run_pump(_bridge(session, editor=ed), session, _ref(session, opener="111"))
    assert ed.calls[0][1] == "111"


async def test_speaker_is_read_when_the_call_arrives_not_when_it_finishes():
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"}))])
    ed = FakeEditor(delay=0.05)
    ref = _ref(session, opener="111", speaker="222")
    bridge = _bridge(session, editor=ed)

    async def emit(ev): pass
    task = asyncio.create_task(bridge._pump_server(session, emit, _SessionStats(),
                                                   _ResumeState(), ref))
    await asyncio.sleep(0.02)
    ref.speaker.set("333")
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert ed.calls[0][1] == "222"


async def test_set_speaker_id_is_tracked_through_converse():
    """End to end: SessionStart opener 111, then SetSpeaker 222 -> a later
    tool call edits 222; after an empty SetSpeaker it is refused."""
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"})),
                           _tool_call_msg(FC("h2", "hangar_fit", {"ship": "a", "item": "b"}))],
                          gaps={0: 0.05, 1: 0.05})
    ed = FakeEditor()
    bridge = _bridge(session, editor=ed)

    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=START)
        await asyncio.sleep(0.01)
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(
            user_id="222", display_name="Mike"))
        await asyncio.sleep(0.07)
        yield voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(
            user_id="", display_name=""))
        await asyncio.Event().wait()

    async def emit(ev): pass
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.25)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert [c[1] for c in ed.calls] == ["222"]
    rs = {r.id: r.response for r in session.responses()}
    assert rs["h2"]["error"] == "unknown_speaker"


async def test_opener_used_through_converse_when_no_set_speaker():
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"}))],
                          gaps={0: 0.03})
    ed = FakeEditor()
    bridge = _bridge(session, editor=ed)

    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=START)
        await asyncio.Event().wait()

    async def emit(ev): pass
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.15)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert [c[1] for c in ed.calls] == ["111"]


# ---- routing ---------------------------------------------------------------

async def test_hangar_calls_never_reach_the_mcp_executor():
    session = ToolSession([_tool_call_msg(FC("a", "sc_find_item", {"name": "x"}),
                                          FC("b", "hangar_fit", {"ship": "s", "item": "i"}))])
    ex = FakeExecutor()
    ed = FakeEditor()
    await _run_pump(_bridge(session, editor=ed, sc=ex), session, _ref(session, opener="111"))
    assert ex.calls == [("sc_find_item", {"name": "x"})]
    assert [c[0] for c in ed.calls] == ["hangar_fit"]
    assert sorted(r.id for r in session.responses()) == ["a", "b"]


async def test_hangar_names_without_editor_are_unknown_and_not_mcp():
    session = ToolSession([_tool_call_msg(FC("b", "hangar_fit", {"ship": "s", "item": "i"}))])
    ex = FakeExecutor()
    await _run_pump(_bridge(session, sc=ex), session, _ref(session, opener="111"))
    assert ex.calls == []
    assert session.responses()[0].response["error"] == "unknown_tool"


async def test_response_dropped_if_the_session_was_replaced(caplog):
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "s", "item": "i"}))])
    ed = FakeEditor()
    ref = _ref(session, opener="111")
    ref.session = object()   # a reconnect swapped in a new session
    with caplog.at_level(logging.INFO):
        stats = await _run_pump(_bridge(session, editor=ed), session, ref)
    assert session.responses() == []
    assert len(ed.calls) == 1           # the write itself happened
    assert stats.hangar_edits == 1
    assert "Live session is gone" in caplog.text


async def test_editor_exception_becomes_an_error_response():
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "s", "item": "i"}))])
    ed = FakeEditor(exc=RuntimeError("boom"))
    stats = await _run_pump(_bridge(session, editor=ed), session, _ref(session, opener="111"))
    r = session.responses()[0].response
    assert r["error"] == "unavailable"
    assert stats.hangar_edits == 0


async def test_call_is_bounded(monkeypatch):
    import src.live_bridge as lb
    monkeypatch.setattr(lb, "HANGAR_CALL_TIMEOUT_S", 0.05)
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "s", "item": "i"}))])
    ed = FakeEditor(delay=1.0)
    await _run_pump(_bridge(session, editor=ed), session, _ref(session, opener="111"), wait=0.2)
    r = session.responses()[0].response
    assert r["error"] == "unavailable"


async def test_error_result_passes_through_and_is_not_counted():
    env = {"error": "choose_slot", "message": "which?", "slots": [{"slot": "a"}, {"slot": "b"}]}
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "s", "item": "i"}))])
    stats = await _run_pump(_bridge(session, editor=FakeEditor(result=env)), session,
                            _ref(session, opener="111"))
    assert session.responses()[0].response == env
    assert stats.hangar_edits == 0


async def test_unchanged_noop_is_not_counted():
    noop = {"ship": {"shipId": "s1"}, "changes": [], "unchanged": True}
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "s", "item": "i"}))])
    stats = await _run_pump(_bridge(session, editor=FakeEditor(result=noop)), session,
                            _ref(session, opener="111"))
    assert session.responses()[0].response == noop
    assert stats.hangar_edits == 0


def test_note_covers_other_members_request():
    assert "someone else's" in HANGAR_EDIT_NOTE and "own hangar" in HANGAR_EDIT_NOTE


async def test_info_log_per_edit_call(caplog):
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit",
                                             {"ship": "my Connie", "item": "Hemera",
                                              "slot": "qd"}))])
    with caplog.at_level(logging.INFO):
        await _run_pump(_bridge(session, editor=FakeEditor()), session,
                        _ref(session, opener="111", speaker="222"))
    lines = [r.getMessage() for r in caplog.records if "voice: hangar edit" in r.getMessage()]
    assert len(lines) == 1
    line = lines[0]
    for part in ("hangar_fit", "member=222", "my Connie", "Hemera", "qd", "-> ok",
                 "hardpoint_quantum_drive: Bolon -> Hemera"):
        assert part in line, (part, line)


async def test_session_end_line_counts_hangar_edits_last(caplog):
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "s", "item": "i"}))],
                          gaps={0: 0.02})
    bridge = _bridge(session, editor=FakeEditor())

    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=START)
        await asyncio.Event().wait()

    async def emit(ev): pass
    with caplog.at_level(logging.INFO):
        task = asyncio.create_task(bridge.converse(req_iter(), emit))
        await asyncio.sleep(0.12)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    end = [r.getMessage() for r in caplog.records if "session END" in r.getMessage()]
    assert len(end) == 1 and end[0].endswith("hangar_edits=1")


# ---- connect fallback keeps them like control tools -------------------------

async def test_sc_fallback_keeps_hangar_declarations():
    session = ToolSession([])
    opens = []

    @contextlib.asynccontextmanager
    async def make(model, config):
        opens.append(config)
        if "sc_find_item" in _fd_names(config):
            raise RuntimeError("400 INVALID_ARGUMENT: bad sc schema")
        yield session

    bridge = _bridge(editor=FakeEditor(), sc=FakeExecutor(), factory=make, max_reconnects=0)
    from tests.test_live_bridge_tools import _converse_briefly
    out = await _converse_briefly(bridge)
    assert len(opens) == 2
    assert _fd_names(opens[1]) == ["end_conversation", "go_quiet",
                                   "hangar_fit", "hangar_add_ship", "hangar_reset"]
    assert opens[1].system_instruction.count(HANGAR_EDIT_NOTE) == 1
    assert not any(e.WhichOneof("event") == "error" for e in out)


async def test_local_fallback_drops_hangar_with_control_even_when_control_is_off(caplog):
    session = ToolSession([])
    opens = []
    bridge = _bridge(editor=FakeEditor(), control=False,
                     factory=_rejecting_factory(session, opens), max_reconnects=0)
    from tests.test_live_bridge_tools import _converse_briefly
    with caplog.at_level(logging.INFO):
        out = await _converse_briefly(bridge)
    assert len(opens) == 2
    assert _fd_names(opens[0]) == ["hangar_fit", "hangar_add_ship", "hangar_reset"]
    assert opens[1].tools == SEARCH_ONLY
    assert HANGAR_EDIT_NOTE not in opens[1].system_instruction
    assert not any(e.WhichOneof("event") == "error" for e in out)
