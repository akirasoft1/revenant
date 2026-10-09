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
from src.live_bridge import (CONTROL_NOTE, HANGAR_EDIT_NOTE, HANGAR_MAYBE_APPLIED_NOTE,
                             HANGAR_TOOL_DECLARATIONS,
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
                                      + CONTROL_NOTE + "\n\n" + HANGAR_EDIT_NOTE + " "
                                      + HANGAR_MAYBE_APPLIED_NOTE)


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
                                      + HANGAR_EDIT_NOTE + " " + HANGAR_MAYBE_APPLIED_NOTE)


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
    assert r["error"] == "unknown_speaker" and "web editor" in r["message"]
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


# ---- fix round 1: id-only SetSpeaker, reconnects, maybe_applied -----------

from types import SimpleNamespace  # noqa: E402

from google.genai import errors as genai_errors  # noqa: E402


async def _converse_with(bridge, events, wait):
    """Drive converse with a scripted client stream: `events` is a list of
    (delay_before, VoiceClientEvent)."""
    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=START)
        for delay, ev in events:
            await asyncio.sleep(delay)
            yield ev
        await asyncio.Event().wait()

    async def emit(ev): pass
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(wait)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def _speaker(uid, name):
    return voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id=uid,
                                                                      display_name=name))


def _audio():
    return voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\x01"))


async def test_named_then_lost_clear_then_nameless_id_only_speaker_uses_the_new_id():
    """B (named) holds the floor; the bot's empty SetSpeaker (release) is
    lost; C, whose name never resolved, takes the floor and the bot sends an
    id-only SetSpeaker. The edit must bind to C, not B -- and C gets
    the neutral marker, never B's name."""
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"}))],
                          gaps={0: 0.08})
    ed = FakeEditor()
    await _converse_with(_bridge(session, editor=ed), [
        (0.01, _speaker("222", "Bea")), (0, _audio()),
        (0.02, _speaker("333", "")), (0, _audio()),
    ], wait=0.2)
    assert [c[1] for c in ed.calls] == ["333"]
    markers = [str(t) for (t, _c) in session.seeded if "[SPEAKER:" in str(t)]
    # Bea's name, then the neutral marker for C -- never Bea's name for C
    assert len(markers) == 2 and "Bea" in markers[0] and "someone else" in markers[1]


async def test_id_only_then_named_same_speaker_announces_the_name():
    session = ToolSession([])
    await _converse_with(_bridge(session, editor=FakeEditor()), [
        (0.01, _speaker("333", "")), (0, _audio()),
        (0.01, _speaker("333", "Cal")), (0, _audio()),
    ], wait=0.1)
    markers = [str(t) for (t, _c) in session.seeded if "[SPEAKER:" in str(t)]
    assert len(markers) == 1 and "Cal" in markers[0]


async def test_previous_named_speaker_is_reannounced_after_an_id_only_one():
    session = ToolSession([])
    await _converse_with(_bridge(session, editor=FakeEditor()), [
        (0.01, _speaker("222", "Bea")), (0, _audio()),
        (0.01, _speaker("333", "")), (0, _audio()),
        (0.01, _speaker("222", "Bea")), (0, _audio()),
    ], wait=0.12)
    markers = [str(t) for (t, _c) in session.seeded if "[SPEAKER:" in str(t)]
    assert len(markers) == 3 and "Bea" in markers[0] and "Bea" in markers[2]


async def test_named_speaker_with_empty_id_clears_identity_but_keeps_the_marker():
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"}))],
                          gaps={0: 0.06})
    ed = FakeEditor()
    await _converse_with(_bridge(session, editor=ed), [
        (0.01, _speaker("", "Dee")), (0, _audio()),
    ], wait=0.15)
    assert ed.calls == []
    assert session.responses()[0].response["error"] == "unknown_speaker"
    assert any("Dee" in str(t) for (t, _c) in session.seeded)


class _DropAfter(ToolSession):
    """Gives a resumption handle after `after` seconds, then drops (1011)."""

    def __init__(self, after):
        super().__init__([])
        self.after = after

    async def receive(self):
        await asyncio.sleep(self.after)
        yield SimpleNamespace(data=None, server_content=None, go_away=None, tool_call=None,
                              tool_call_cancellation=None,
                              session_resumption_update=SimpleNamespace(new_handle="h1",
                                                                        resumable=True))
        raise genai_errors.APIError(1011, {"message": "internal"})


def _two_sessions(s1, s2, second_open_delay=0.0):
    opened = []

    @contextlib.asynccontextmanager
    async def make(model, config):
        opened.append(config)
        if len(opened) == 1:
            yield s1
        else:
            await asyncio.sleep(second_open_delay)
            yield s2
    return make


async def test_speaker_id_survives_a_live_reconnect():
    s1 = _DropAfter(0.05)
    s2 = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"}))],
                     gaps={0: 0.03})
    ed = FakeEditor()
    bridge = _bridge(editor=ed, factory=_two_sessions(s1, s2), max_reconnects=2)
    await _converse_with(bridge, [(0.01, _speaker("222", "Bea")), (0, _audio())], wait=0.2)
    assert [c[1] for c in ed.calls] == ["222"]
    assert [r.id for r in s2.responses()] == ["h1"]


async def test_set_speaker_during_the_reconnect_gap_is_kept():
    s1 = _DropAfter(0.05)
    s2 = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"}))],
                     gaps={0: 0.03})
    ed = FakeEditor()
    bridge = _bridge(editor=ed, factory=_two_sessions(s1, s2, second_open_delay=0.1),
                     max_reconnects=2)
    # 222 before the drop (t~0.01); 333 lands at t~0.1, inside the 0.05-0.15 gap.
    await _converse_with(bridge, [(0.01, _speaker("222", "Bea")),
                                  (0.09, _speaker("333", "Cal"))], wait=0.3)
    assert [c[1] for c in ed.calls] == ["333"]


MAYBE = {"error": "unavailable", "maybe_applied": True,
         "message": "The hangar service didn't answer in time — the change may have been "
                    "saved; check before retrying"}


async def test_timeout_of_a_write_reports_maybe_applied(monkeypatch):
    import src.live_bridge as lb
    monkeypatch.setattr(lb, "HANGAR_CALL_TIMEOUT_S", 0.05)
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_add_ship", {"vehicle": "Cutlass"}))])
    await _run_pump(_bridge(session, editor=FakeEditor(delay=1.0)), session,
                    _ref(session, opener="111"), wait=0.2)
    assert session.responses()[0].response == MAYBE


async def test_cancelled_write_is_logged_as_maybe_applied(caplog):
    from tests.test_live_bridge_tools import _cancel_msg
    session = ToolSession([_tool_call_msg(FC("h1", "hangar_fit", {"ship": "a", "item": "b"})),
                           _cancel_msg("h1")], gaps={1: 0.03})
    with caplog.at_level(logging.INFO):
        await _run_pump(_bridge(session, editor=FakeEditor(delay=1.0)), session,
                        _ref(session, opener="111"), wait=0.1)
    assert session.responses() == []     # the model cancelled the call id
    assert "maybe_applied" in caplog.text


def test_note_maybe_applied_and_own_hangar_requests():
    with_sc = _bridge(editor=FakeEditor(), sc=FakeExecutor())._live_config(START).system_instruction
    no_sc = _bridge(editor=FakeEditor())._live_config(START).system_instruction
    assert "maybe_applied" in with_sc and "sc_member_hangar" in with_sc
    assert "maybe_applied" in no_sc and "sc_member_hangar" not in no_sc
    assert "asks you to update their own hangar" in HANGAR_EDIT_NOTE


def test_unknown_speaker_message():
    from src.hangar_edit import UNKNOWN_SPEAKER
    assert UNKNOWN_SPEAKER == {
        "error": "unknown_speaker",
        "message": "I can't tell who's speaking, so I can't edit a hangar right now — use "
                   "text chat or the web editor."}


# ---- final fix round: neutral speaker marker, tool descriptions -------------

def _markers(session):
    return [str(t) for (t, _c) in session.seeded if "[SPEAKER:" in str(t)]


async def test_id_only_after_an_emitted_named_marker_sends_a_neutral_marker():
    from src.live_bridge import NEUTRAL_SPEAKER_MARKER
    session = ToolSession([])
    await _converse_with(_bridge(session, editor=FakeEditor()), [
        (0.01, _speaker("222", "Bea")), (0, _audio()),
        (0.01, _speaker("333", "")), (0, _audio()),
    ], wait=0.1)
    m = _markers(session)
    assert len(m) == 2 and "Bea" in m[0] and NEUTRAL_SPEAKER_MARKER in m[1]
    assert "Bea" not in m[1]
    assert all(c is False for (t, c) in session.seeded if "[SPEAKER:" in str(t))


async def test_neutral_marker_is_lazy_sent_only_before_the_next_audio():
    session = ToolSession([])
    await _converse_with(_bridge(session, editor=FakeEditor()), [
        (0.01, _speaker("222", "Bea")), (0, _audio()),
        (0.01, _speaker("333", "")),
    ], wait=0.1)
    assert len(_markers(session)) == 1


async def test_no_neutral_marker_when_the_session_started_nameless():
    session = ToolSession([])
    await _converse_with(_bridge(session, editor=FakeEditor()), [
        (0.01, _speaker("333", "")), (0, _audio()),
        (0.01, _speaker("444", "")), (0, _audio()),
    ], wait=0.1)
    assert _markers(session) == []


async def test_no_neutral_marker_on_the_empty_id_clear():
    session = ToolSession([])
    await _converse_with(_bridge(session, editor=FakeEditor()), [
        (0.01, _speaker("222", "Bea")), (0, _audio()),
        (0.01, _speaker("", "")), (0, _audio()),
    ], wait=0.1)
    assert len(_markers(session)) == 1


async def test_named_marker_must_actually_have_been_emitted():
    # Bea is announced but never speaks (no audio -> no marker emitted); an
    # id-only speaker after her owes no neutral marker.
    session = ToolSession([])
    await _converse_with(_bridge(session, editor=FakeEditor()), [
        (0.01, _speaker("222", "Bea")),
        (0.01, _speaker("333", "")), (0, _audio()),
    ], wait=0.1)
    assert _markers(session) == []


async def test_neutral_marker_only_once_for_consecutive_nameless_speakers():
    session = ToolSession([])
    await _converse_with(_bridge(session, editor=FakeEditor()), [
        (0.01, _speaker("222", "Bea")), (0, _audio()),
        (0.01, _speaker("333", "")), (0, _audio()),
        (0.01, _speaker("444", "")), (0, _audio()),
    ], wait=0.12)
    assert len(_markers(session)) == 2


async def test_neutral_marker_counted_in_speaker_markers(caplog):
    session = ToolSession([])
    with caplog.at_level(logging.INFO):
        await _converse_with(_bridge(session, editor=FakeEditor()), [
            (0.01, _speaker("222", "Bea")), (0, _audio()),
            (0.01, _speaker("333", "")), (0, _audio()),
        ], wait=0.1)
    end = [r.getMessage() for r in caplog.records if "session END" in r.getMessage()]
    assert "speaker_markers=2" in end[0]


def test_tool_descriptions_cover_explicit_requests_and_advice():
    by_name = {d.name: d.description for d in HANGAR_TOOL_DECLARATIONS}
    for n in ("hangar_fit", "hangar_add_ship"):
        assert "or explicitly asks you to update their own hangar" in by_name[n]
    assert "never for advice" in by_name["hangar_reset"]
