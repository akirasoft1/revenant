"""The [SPEAKER: name] marker is re-announced at the start of every user turn,
not only on a speaker change.

2026-10-10, gemini-3.8-live: with the marker sent only on a speaker change,
"what's my name?" asked one exchange AFTER Sarah's marker was answered
"your name hasn't been mentioned to me yet" in 1-2 of 6 real-model smoke runs
-- the model loses a marker that is a turn old. Re-sending the current
speaker's marker before the first audio after each turn_complete keeps the
identity next to the speech it describes. It is a few tokens per turn and
still turn_complete=False context only."""
import asyncio
import contextlib

from src import voice_pb2
from src.live_bridge import LiveBridge
from tests.test_live_bridge import FakeSession, _factory, _msg


class GatedSession(FakeSession):
    """Yields one turn_complete only when `release` is set, so the test
    controls where the turn boundary falls between client audio chunks."""

    def __init__(self):
        super().__init__([])
        self.release = asyncio.Event()

    async def receive(self):
        await self.release.wait()
        yield _msg(turn_complete=True)
        await asyncio.Event().wait()


def _markers(session):
    return [(i, str(t)) for i, (t, _c) in enumerate(session.seeded) if "[SPEAKER:" in str(t)]


async def _run(session, events_before, events_after):
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")

    async def emit(ev):
        pass

    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
        for e in events_before:
            yield e
        await asyncio.sleep(0.05)
        session.release.set()
        await asyncio.sleep(0.05)   # let the server pump record the turn boundary
        for e in events_after:
            yield e
        await asyncio.Event().wait()

    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.3)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def _speaker(uid, name):
    return voice_pb2.VoiceClientEvent(set_speaker=voice_pb2.SetSpeaker(user_id=uid, display_name=name))


def _audio(b):
    return voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b))


async def test_same_speaker_marker_is_reannounced_after_a_turn_complete():
    session = GatedSession()
    await _run(session, [_speaker("u2", "Sarah"), _audio(b"\x01")], [_audio(b"\x02"), _audio(b"\x03")])
    markers = _markers(session)
    assert [m for _i, m in markers] == [str(session.seeded[markers[0][0]][0])] * 2
    assert all("Sarah" in m for _i, m in markers)
    assert all(c is False for (_t, c) in session.seeded)
    # exactly one re-announce for the new turn, not one per chunk
    assert len(markers) == 2
    assert len(session.sent_audio) == 3


async def test_no_reannounce_without_a_named_current_speaker():
    session = GatedSession()
    await _run(session, [_audio(b"\x01")], [_audio(b"\x02")])
    assert _markers(session) == []


async def test_cleared_speaker_is_not_reannounced_after_a_turn():
    session = GatedSession()
    await _run(session,
               [_speaker("u2", "Sarah"), _audio(b"\x01"), _speaker("", "")],
               [_audio(b"\x02")])
    assert len(_markers(session)) == 1   # only the original Sarah marker


async def test_unnamed_speaker_after_turn_does_not_reannounce_previous_name():
    session = GatedSession()
    await _run(session,
               [_speaker("u2", "Sarah"), _audio(b"\x01"), _speaker("u3", ""), _audio(b"\x02")],
               [_audio(b"\x03")])
    texts = [m for _i, m in _markers(session)]
    assert sum("Sarah" in t for t in texts) == 1
    assert sum("someone else" in t for t in texts) == 1
