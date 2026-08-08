import asyncio
import contextlib
from types import SimpleNamespace

from src import voice_pb2
from src.live_bridge import LiveBridge


class FakeSession:
    def __init__(self, script):
        self._script = script            # list of server msgs to yield on first receive()
        self.sent_audio = []
        self.seeded = []

    async def send_client_content(self, *, turns, turn_complete):
        self.seeded.append((turns, turn_complete))

    async def send_realtime_input(self, *, audio):
        self.sent_audio.append(audio)

    async def receive(self):
        for m in self._script:
            yield m
        # after the scripted turn, block so the bridge exits via session_end instead
        await asyncio.Event().wait()


def _msg(*, data=None, in_tx=None, out_tx=None, turn_complete=False, interrupted=False):
    sc = SimpleNamespace(
        input_transcription=SimpleNamespace(text=in_tx) if in_tx else None,
        output_transcription=SimpleNamespace(text=out_tx) if out_tx else None,
        turn_complete=turn_complete, interrupted=interrupted,
    )
    return SimpleNamespace(data=data, server_content=sc)


def _factory(session):
    @contextlib.asynccontextmanager
    async def make(model, config):
        yield session
    return make


async def _drive(bridge, client_events, session):
    out = []
    async def emit(ev): out.append(ev)
    async def req_iter():
        for e in client_events:
            yield e
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.05)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    return out


async def test_seeds_recall_and_forwards_audio_and_transcripts():
    session = FakeSession([
        _msg(in_tx="hello there"),
        _msg(data=b"\x01\x02", out_tx="hi back"),
        _msg(turn_complete=True),
    ])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(
        user_id="u", system_prompt="be nice", recall_context="past chat", voice_name="Kore"))
    audio = voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\xaa\xbb"))
    out = await _drive(bridge, [start, audio], session)

    assert session.seeded, "recall/system prompt must be seeded via send_client_content"
    assert len(session.sent_audio) == 1
    assert session.sent_audio[0].data == b"\xaa\xbb"
    assert session.sent_audio[0].mime_type == "audio/pcm;rate=16000"
    kinds = [e.WhichOneof("event") for e in out]
    assert "input_transcript" in kinds and "output_transcript" in kinds
    assert "audio" in kinds and "turn_complete" in kinds
    audio_out = next(e for e in out if e.WhichOneof("event") == "audio")
    assert audio_out.audio.pcm == b"\x01\x02"


async def test_seeds_history_turns_then_recall():
    session = FakeSession([_msg(turn_complete=True)])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(
        user_id="u", system_prompt="SP", recall_context="MEM",
        history=[voice_pb2.Turn(role="user", content="hey"), voice_pb2.Turn(role="assistant", content="hi")]))
    await _drive(bridge, [start], session)
    seeded_texts = [t.parts[0].text for (t, _tc) in session.seeded]
    assert "hey" in seeded_texts and "hi" in seeded_texts and "MEM" in seeded_texts


async def test_maps_interrupted():
    session = FakeSession([_msg(interrupted=True)])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
    out = await _drive(bridge, [start], session)
    assert any(e.WhichOneof("event") == "interrupted" for e in out)


async def test_missing_session_start_emits_error():
    session = FakeSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    audio = voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"x"))
    out = await _drive(bridge, [audio], session)
    assert any(e.WhichOneof("event") == "error" for e in out)


class HangingSession:
    """A session whose receive() never produces anything and blocks forever,
    so it can only be terminated by cancellation. Records whether it was
    properly finalized (its `finally` ran) on cancellation."""

    def __init__(self):
        self.receive_finalized = False

    async def send_client_content(self, *, turns, turn_complete):
        pass

    async def send_realtime_input(self, *, audio):
        pass

    async def receive(self):
        try:
            await asyncio.Event().wait()
            yield  # pragma: no cover - unreachable
        finally:
            self.receive_finalized = True


async def test_cancel_reaps_both_pumps_when_both_pending():
    """Finding 2: cancelling converse() while BOTH pump_in and pump_out are
    genuinely pending (session still open, client stream still open) must
    reap both tasks -- not leak them. Deterministic via finally-set flags
    rather than inspecting asyncio.all_tasks()."""
    session = HangingSession()
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
    state = SimpleNamespace(req_finalized=False)

    async def req_iter():
        yield start
        try:
            await asyncio.Event().wait()
            yield  # pragma: no cover - unreachable
        finally:
            state.req_finalized = True

    async def emit(ev):
        pass

    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.05)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task

    assert session.receive_finalized is True, "server pump (session.receive) must be reaped"
    assert state.req_finalized is True, "client pump (request_iter) must be reaped"


class RaisingSession(FakeSession):
    """A session whose receive() raises immediately instead of yielding."""

    async def receive(self):
        raise RuntimeError("boom")
        yield  # pragma: no cover - unreachable, keeps this an async generator


async def test_pump_exception_emits_error_event():
    """Finding 3: an exception inside a pump (e.g. the server-receive pump)
    must surface as an ErrorEvent via emit, not crash silently."""
    session = RaisingSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
    out = await _drive(bridge, [start], session)
    errors = [e for e in out if e.WhichOneof("event") == "error"]
    assert errors, "expected an ErrorEvent when a pump raises"
    assert "boom" in errors[0].error.message


class MultiTurnClosingSession:
    """A session whose receive() spans multiple calls: yields one turn's
    messages, then on the next call yields nothing at all (immediate
    StopAsyncIteration) -- simulating a cleanly-closed session."""

    def __init__(self, turns):
        self._turns = turns
        self._call_count = 0

    async def send_client_content(self, *, turns, turn_complete):
        pass

    async def send_realtime_input(self, *, audio):
        pass

    async def receive(self):
        turn = self._turns[self._call_count] if self._call_count < len(self._turns) else []
        self._call_count += 1
        for m in turn:
            yield m


async def test_pump_server_stops_promptly_when_session_closes_cleanly():
    """Finding 1: when receive() yields nothing on a call (session closed),
    _pump_server must break out of its outer while-loop instead of
    busy-spinning. Wrapped in wait_for to prove converse() returns promptly
    rather than hanging/spinning."""
    session = MultiTurnClosingSession([
        [_msg(turn_complete=True)],  # one turn of messages
        [],                          # then: session closed, nothing more
    ])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
    out = []

    async def emit(ev):
        out.append(ev)

    async def req_iter():
        yield start
        await asyncio.Event().wait()  # client stream stays open; only the session closes
        yield  # pragma: no cover - unreachable

    await asyncio.wait_for(bridge.converse(req_iter(), emit), timeout=1)

    assert any(e.WhichOneof("event") == "turn_complete" for e in out)
