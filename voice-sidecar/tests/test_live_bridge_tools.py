"""Gemini Live function calling backed by sc-knowledge (spec §7).

`_pump_server` is driven directly with scripted `receive()` messages, the same
way tests/test_live_bridge.py does; `send_tool_response` calls are recorded."""
import asyncio
import contextlib
import logging
import time
from types import SimpleNamespace

from google.genai import types

from src import voice_pb2
from src.live_bridge import SC_VOICE_NOTE, LiveBridge, _ResumeState, _SessionRef, _SessionStats


class ToolSession:
    def __init__(self, script, gaps=None):
        self._script = script
        self._gaps = gaps or {}          # index -> seconds to wait BEFORE yielding it
        self.tool_responses = []         # (monotonic time, [FunctionResponse])
        self.seeded = []

    async def send_client_content(self, *, turns, turn_complete):
        self.seeded.append((turns, turn_complete))

    async def send_realtime_input(self, **kw):
        pass

    async def send_tool_response(self, *, function_responses):
        self.tool_responses.append((time.monotonic(), list(function_responses)))

    async def receive(self):
        for i, m in enumerate(self._script):
            if i in self._gaps:
                await asyncio.sleep(self._gaps[i])
            yield m
        await asyncio.Event().wait()

    def responses(self):
        return [fr for (_t, frs) in self.tool_responses for fr in frs]


def FC(id, name, args=None):
    return SimpleNamespace(id=id, name=name, args=args)


def _tool_call_msg(*calls):
    return SimpleNamespace(data=None, server_content=None, session_resumption_update=None,
                           go_away=None, tool_call=SimpleNamespace(function_calls=list(calls)),
                           tool_call_cancellation=None)


def _cancel_msg(*ids):
    return SimpleNamespace(data=None, server_content=None, session_resumption_update=None,
                           go_away=None, tool_call=None,
                           tool_call_cancellation=SimpleNamespace(ids=list(ids)))


class FakeExecutor:
    def __init__(self, delay=0.0, declarations=None):
        self.delay = delay
        self.calls = []
        self.declarations = declarations if declarations is not None else [
            types.FunctionDeclaration(name="sc_find_item", description="d",
                                      parameters_json_schema={"type": "object"})]

    async def call(self, name, args):
        self.calls.append((name, args))
        await asyncio.sleep(self.delay)
        return {"echo": name, "args": args}


def _factory(session):
    @contextlib.asynccontextmanager
    async def make(model, config):
        yield session
    return make


async def _run_pump(bridge, session, wait=0.1, session_ref=None, stats=None):
    if session_ref is None:
        session_ref = _SessionRef()
        session_ref.session = session
    stats = stats or _SessionStats()
    async def emit(ev): pass
    task = asyncio.create_task(bridge._pump_server(session, emit, stats, _ResumeState(), session_ref))
    await asyncio.sleep(wait)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    return stats


async def test_tool_call_gets_exactly_one_matching_response():
    session = ToolSession([_tool_call_msg(FC("c1", "sc_find_item", {"name": "V801-12"}))])
    ex = FakeExecutor()
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck", sc_executor=ex)
    stats = await _run_pump(bridge, session)
    rs = session.responses()
    assert len(rs) == 1
    assert rs[0].id == "c1" and rs[0].name == "sc_find_item"
    assert rs[0].response == {"echo": "sc_find_item", "args": {"name": "V801-12"}}
    assert ex.calls == [("sc_find_item", {"name": "V801-12"})]
    assert stats.tool_calls == 1


async def test_two_calls_in_one_message_run_concurrently():
    session = ToolSession([_tool_call_msg(FC("a", "sc_find_item", {"name": "x"}),
                                          FC("b", "sc_trade_routes", {}))])
    ex = FakeExecutor(delay=0.2)
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck", sc_executor=ex)
    t0 = time.monotonic()
    await _run_pump(bridge, session, wait=0.35)
    rs = session.responses()
    assert sorted(r.id for r in rs) == ["a", "b"]
    assert {r.id: r.name for r in rs} == {"a": "sc_find_item", "b": "sc_trade_routes"}
    # Overlap, not a tight wall-clock bound: serial execution would need
    # >= 0.4s; allow scheduler jitter above the ideal 0.2s.
    assert max(t for (t, _) in session.tool_responses) - t0 <= 0.35


async def test_tool_calls_do_not_block_the_pump():
    # A slow tool call must not stop _pump_server from reading (and emitting)
    # later messages -- audio/transcripts keep flowing while the lookup runs.
    later = SimpleNamespace(data=b"\x01", server_content=None)
    session = ToolSession([_tool_call_msg(FC("c1", "sc_find_item", {})), later])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck",
                        sc_executor=FakeExecutor(delay=1.0))
    stats = await _run_pump(bridge, session, wait=0.1)
    assert stats.audio_out_chunks == 1
    assert session.responses() == []


async def test_cancellation_drops_the_in_flight_call(caplog):
    session = ToolSession([_tool_call_msg(FC("c1", "sc_find_item", {}), FC("c2", "sc_find_item", {})),
                           _cancel_msg("c1")], gaps={1: 0.05})
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck",
                        sc_executor=FakeExecutor(delay=0.2))
    with caplog.at_level(logging.INFO):
        await _run_pump(bridge, session, wait=0.4)
    assert [r.id for r in session.responses()] == ["c2"]
    assert "c1" in caplog.text and "cancel" in caplog.text


async def test_no_executor_answers_tools_unavailable():
    session = ToolSession([_tool_call_msg(FC("c1", "sc_find_item", {"name": "x"}))])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    await _run_pump(bridge, session)
    rs = session.responses()
    assert len(rs) == 1 and rs[0].id == "c1"
    assert rs[0].response["error"] == "tools_unavailable"


async def test_unknown_tool_name_is_refused_without_calling_executor():
    session = ToolSession([_tool_call_msg(FC("c1", "rm_rf", {}))])
    ex = FakeExecutor()
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck", sc_executor=ex)
    await _run_pump(bridge, session)
    rs = session.responses()
    assert len(rs) == 1 and rs[0].id == "c1" and rs[0].response["error"] == "unknown_tool"
    assert ex.calls == []


async def test_pump_exit_cancels_outstanding_tool_calls():
    session = ToolSession([_tool_call_msg(FC("c1", "sc_find_item", {}))])
    ex = FakeExecutor(delay=0.3)
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck", sc_executor=ex)
    before = set(asyncio.all_tasks())
    await _run_pump(bridge, session, wait=0.05)       # pump cancelled mid-call
    await asyncio.sleep(0)
    leftover = [t for t in asyncio.all_tasks() - before if not t.done()]
    assert leftover == [], "in-flight tool tasks must be cancelled when the pump exits"
    await asyncio.sleep(0.4)
    assert session.responses() == [], "a dropped call must never answer late"


async def test_response_is_dropped_if_the_session_was_replaced(caplog):
    session = ToolSession([_tool_call_msg(FC("c1", "sc_find_item", {}))])
    ref = _SessionRef()
    ref.session = session
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck",
                        sc_executor=FakeExecutor(delay=0.05))

    async def emit(ev): pass
    task = asyncio.create_task(bridge._pump_server(session, emit, _SessionStats(), _ResumeState(), ref))
    await asyncio.sleep(0.01)
    ref.session = object()      # a reconnect swapped the live session under the call
    with caplog.at_level(logging.INFO):
        await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert session.responses() == []
    assert any(r.levelno == logging.INFO and "c1" in r.getMessage() for r in caplog.records)


async def test_tool_call_logged_with_name_outcome_duration(caplog):
    session = ToolSession([_tool_call_msg(FC("c1", "sc_find_item", {}))])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck",
                        sc_executor=FakeExecutor())
    with caplog.at_level(logging.INFO):
        await _run_pump(bridge, session)
    assert any("tool_call sc_find_item -> ok (" in r.getMessage() for r in caplog.records)


async def test_session_end_log_counts_tool_calls(caplog):
    session = ToolSession([_tool_call_msg(FC("c1", "sc_find_item", {}))])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck",
                        sc_executor=FakeExecutor())
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))

    async def req_iter():
        yield start
        await asyncio.Event().wait()

    async def emit(ev): pass
    with caplog.at_level(logging.INFO):
        task = asyncio.create_task(bridge.converse(req_iter(), emit))
        await asyncio.sleep(0.1)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    assert "tool_calls=1" in caplog.text
    assert len(session.responses()) == 1


# ---- _live_config ---------------------------------------------------------

def test_live_config_attaches_sc_tools_and_voice_note():
    ex = FakeExecutor()
    bridge = LiveBridge(_factory(None), model="m", default_voice="Puck", sc_executor=ex)
    cfg = bridge._live_config(voice_pb2.SessionStart(user_id="u", system_prompt="PERSONA"))
    assert any(t.google_search is not None for t in cfg.tools)
    fd_tools = [t for t in cfg.tools if t.function_declarations]
    assert len(fd_tools) == 1
    assert [d.name for d in fd_tools[0].function_declarations] == ["sc_find_item"]
    assert cfg.system_instruction == "PERSONA\n\n" + SC_VOICE_NOTE


def test_live_config_voice_note_without_system_prompt():
    bridge = LiveBridge(_factory(None), model="m", default_voice="Puck", sc_executor=FakeExecutor())
    cfg = bridge._live_config(voice_pb2.SessionStart(user_id="u"))
    assert cfg.system_instruction == "\n\n" + SC_VOICE_NOTE


def test_live_config_unchanged_without_executor_or_declarations():
    start = voice_pb2.SessionStart(user_id="u", system_prompt="PERSONA")
    base = LiveBridge(_factory(None), model="m", default_voice="Puck")._live_config(start)
    empty = LiveBridge(_factory(None), model="m", default_voice="Puck",
                       sc_executor=FakeExecutor(declarations=[]))._live_config(start)
    for cfg in (base, empty):
        assert cfg.tools == [types.Tool(google_search=types.GoogleSearch())]
        assert cfg.system_instruction == "PERSONA"
    assert base == empty


def test_sc_voice_note_verbatim():
    assert SC_VOICE_NOTE == (
        "You can look up live Star Citizen data with the sc_* tools (item stats and where to buy, "
        "component rankings, faction missions by reputation per minute, trade routes, commodity "
        "prices, and our org's curated guides on mining, salvage and trading). Use them for any "
        "Star Citizen item, price, mission, reputation or trade question instead of memory. Before "
        "a lookup, say a very short natural filler like \"let me check\". When answering, speak "
        "only the top two or three results in plain sentences and offer the rest; never read "
        "tables or long number lists aloud.")


# ---- search-only connect fallback (fix round 1) ---------------------------

def _rejecting_factory(session, opens, reject_open_numbers=None):
    """Raises on open whenever function_declarations are attached (models GEAP
    rejecting the SC schemas), or on the listed 1-based open attempts."""
    @contextlib.asynccontextmanager
    async def make(model, config):
        opens.append(config)
        n = len(opens)
        has_fd = any(t.function_declarations for t in (config.tools or []))
        if has_fd or (reject_open_numbers and n in reject_open_numbers):
            raise RuntimeError(f"400 INVALID_ARGUMENT: bad function schema (open #{n})")
        yield session
    return make


async def _converse_briefly(bridge, wait=0.1, prompt="PERSONA"):
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(
        user_id="u", system_prompt=prompt))
    out = []

    async def req_iter():
        yield start
        await asyncio.Event().wait()

    async def emit(ev): out.append(ev)
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(wait)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    return out


async def test_open_rejected_with_sc_tools_retries_once_search_only(caplog):
    session = ToolSession([])
    opens = []
    bridge = LiveBridge(_rejecting_factory(session, opens), model="m", default_voice="Puck",
                        sc_executor=FakeExecutor(), max_reconnects=0)
    with caplog.at_level(logging.INFO):
        out = await _converse_briefly(bridge)
    assert len(opens) == 2
    assert any(t.function_declarations for t in opens[0].tools)
    assert opens[1].tools == [types.Tool(google_search=types.GoogleSearch())]
    assert opens[1].system_instruction == "PERSONA"
    # the fallback does not spend the reconnect budget (max_reconnects=0 here)
    assert not any(e.WhichOneof("event") == "error" for e in out)
    warn = [r for r in caplog.records if r.levelno == logging.WARNING and "search-only" in r.getMessage()]
    assert len(warn) == 1 and "400 INVALID_ARGUMENT: bad function schema (open #1)" in warn[0].getMessage()
    assert "sc_fallbacks=1" in caplog.text


async def test_fallback_is_sticky_across_reconnects():
    # After the fallback, a later reconnect must stay search-only too.
    from google.genai import errors as genai_errors
    drop = genai_errors.APIError(1011, {"message": "internal"})

    class DropOnce(ToolSession):
        def __init__(self):
            super().__init__([])
            self.n = 0

        async def receive(self):
            self.n += 1
            if self.n == 1:
                yield SimpleNamespace(data=None, server_content=None, go_away=None,
                                      session_resumption_update=SimpleNamespace(
                                          new_handle="h1", resumable=True))
                raise drop
            await asyncio.Event().wait()
            yield  # pragma: no cover

    session = DropOnce()
    opens = []
    bridge = LiveBridge(_rejecting_factory(session, opens), model="m", default_voice="Puck",
                        sc_executor=FakeExecutor(), max_reconnects=3)
    await _converse_briefly(bridge, wait=0.2)
    assert len(opens) == 3                       # sc (rejected), search-only, reconnect
    assert all(not any(t.function_declarations for t in o.tools) for o in opens[1:])


async def test_fallback_happens_only_once_then_normal_budget_applies():
    # Every open fails (not SC-related): one search-only retry, then the
    # ordinary budgeted retry path -- never a second fallback.
    session = ToolSession([])
    opens = []
    bridge = LiveBridge(_rejecting_factory(session, opens, reject_open_numbers={1, 2, 3, 4}),
                        model="m", default_voice="Puck", sc_executor=FakeExecutor(),
                        max_reconnects=0)
    out = await _converse_briefly(bridge)
    assert len(opens) == 2
    assert any(e.WhichOneof("event") == "error" for e in out)


async def test_no_fallback_attempt_without_sc_tools():
    session = ToolSession([])
    opens = []
    bridge = LiveBridge(_rejecting_factory(session, opens, reject_open_numbers={1}),
                        model="m", default_voice="Puck", max_reconnects=0)
    out = await _converse_briefly(bridge)
    assert len(opens) == 1
    assert any(e.WhichOneof("event") == "error" for e in out)
