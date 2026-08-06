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
