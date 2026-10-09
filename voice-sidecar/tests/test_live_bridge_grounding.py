"""Google Search grounding observability (2026-09-29 incident).

The Live model can ground a turn with Google Search server-side; the search
queries ride on `server_content.grounding_metadata.web_search_queries`. Before
this, the sidecar logged nothing about it, so whether the model searched was
only inferable from citation markers in the output transcript. Each turn now
logs `search_queries=N` on the turn-complete line (plus the full queries when
N>0), and the session END line / span carry `search_turns` + `search_queries`.
"""
import logging
from types import SimpleNamespace

from google.genai import types

from src import live_bridge, voice_pb2
from src.live_bridge import LiveBridge

from .test_live_bridge import FakeSession, _drive, _factory


def _gmsg(queries=None, *, metadata="auto", turn_complete=False, out_tx=None):
    """A server_content message carrying grounding metadata. `metadata=None`
    models a message with no grounding at all; a non-"auto" value is used
    verbatim (for malformed shapes)."""
    if metadata == "auto":
        metadata = SimpleNamespace(web_search_queries=queries)
    sc = SimpleNamespace(
        input_transcription=None,
        output_transcription=SimpleNamespace(text=out_tx) if out_tx else None,
        turn_complete=turn_complete, interrupted=False,
        grounding_metadata=metadata,
    )
    return SimpleNamespace(data=None, server_content=sc)


def _start():
    return voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u1"))


async def _run(script, caplog):
    session = FakeSession(script)
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    with caplog.at_level(logging.INFO):
        await _drive(bridge, [_start()], session)
    return [r.getMessage() for r in caplog.records]


def _line(lines, needle):
    matches = [ln for ln in lines if needle in ln]
    assert matches, f"no log line containing {needle!r} in {lines!r}"
    return matches


async def test_distinct_queries_across_messages_counted_once_per_turn(caplog):
    long_q = "star citizen quantum drive nav mode master modes speed " * 6  # >300 chars
    lines = await _run([
        _gmsg(["star citizen nav mode speed", long_q]),
        _gmsg(["star citizen nav mode speed"]),          # duplicate: counted once
        _gmsg(["quantum spool 1000 m/s"], turn_complete=True),
    ], caplog)
    tc = _line(lines, "turn complete (#1")
    assert "search_queries=3" in tc[0]
    ws = _line(lines, "web search (turn #1)")
    assert len(ws) == 1
    assert ws[0].endswith(
        "star citizen nav mode speed | " + long_q + " | quantum spool 1000 m/s"), (
        "queries must be logged in full, in first-seen order, joined by ' | '")


async def test_counters_reset_per_turn_and_end_totals(caplog):
    lines = await _run([
        _gmsg(["a", "b"]),
        _gmsg(None, metadata=None, turn_complete=True),          # turn 1: 2 queries
        _gmsg(None, metadata=None, turn_complete=True),          # turn 2: none
        _gmsg(["a"], turn_complete=True),                        # turn 3: "a" again counts
    ], caplog)
    assert "search_queries=2" in _line(lines, "turn complete (#1")[0]
    assert "search_queries=0" in _line(lines, "turn complete (#2")[0]
    assert "search_queries=1" in _line(lines, "turn complete (#3")[0]
    assert not [ln for ln in lines if "web search (turn #2)" in ln]
    assert _line(lines, "web search (turn #3)")[0].endswith(": a")
    end = _line(lines, "session END")[0]
    assert end.endswith("search_turns=2 search_queries=3 hangar_edits=0"), end
    # existing fields are kept, in order, before the new ones
    assert "tool_calls=0 sc_fallbacks=0 search_turns=2" in end


async def test_no_grounding_logs_zero_and_no_search_line(caplog):
    lines = await _run([_gmsg(None, metadata=None, turn_complete=True)], caplog)
    assert "search_queries=0" in _line(lines, "turn complete (#1")[0]
    assert not [ln for ln in lines if "web search (turn" in ln]
    assert _line(lines, "session END")[0].endswith("search_turns=0 search_queries=0 hangar_edits=0")


async def test_messages_without_grounding_attribute_are_tolerated(caplog):
    # The plain transcript/turn-complete message shape used everywhere else
    # has no grounding_metadata attribute at all.
    from .test_live_bridge import _msg
    lines = await _run([_msg(out_tx="hi"), _msg(turn_complete=True)], caplog)
    assert "search_queries=0" in _line(lines, "turn complete (#1")[0]


async def test_malformed_metadata_is_tolerated(caplog):
    lines = await _run([
        _gmsg(None),                                            # web_search_queries=None
        _gmsg(metadata=SimpleNamespace()),                      # attribute missing
        _gmsg(metadata="not-an-object"),                        # wrong type entirely
        _gmsg(metadata=SimpleNamespace(web_search_queries="a string, not a list")),
        _gmsg(["", None, 42, "  ", "real query"], turn_complete=True),
    ], caplog)
    assert "search_queries=1" in _line(lines, "turn complete (#1")[0]
    assert _line(lines, "web search (turn #1)")[0].endswith(": real query")
    assert "session END" in "\n".join(lines)


async def test_real_genai_types_carry_the_queries(caplog):
    # Pins the attribute names against the installed google-genai: a real
    # LiveServerContent/GroundingMetadata, not a SimpleNamespace stand-in.
    sc = types.LiveServerContent(
        turn_complete=True,
        grounding_metadata=types.GroundingMetadata(web_search_queries=["real sdk query"]))
    msg = SimpleNamespace(data=None, server_content=sc)
    lines = await _run([msg], caplog)
    assert "search_queries=1" in _line(lines, "turn complete (#1")[0]
    assert _line(lines, "web search (turn #1)")[0].endswith(": real sdk query")


class _RecordingSpan:
    def __init__(self):
        self.attrs = {}

    def set_attribute(self, k, v):
        self.attrs[k] = v

    def record_exception(self, e):
        pass

    def end(self):
        pass


async def test_session_span_carries_search_totals(caplog, monkeypatch):
    span = _RecordingSpan()
    monkeypatch.setattr(live_bridge, "tracer",
                        SimpleNamespace(start_span=lambda name: span))
    await _run([_gmsg(["x", "y"], turn_complete=True),
                _gmsg(None, metadata=None, turn_complete=True)], caplog)
    assert span.attrs["voice.search_turns"] == 1
    assert span.attrs["voice.search_queries"] == 2


# --- turns that never reach turn_complete (review fix round) ----------------

def _interrupted_msg():
    sc = SimpleNamespace(input_transcription=None, output_transcription=None,
                         turn_complete=False, interrupted=True, grounding_metadata=None)
    return SimpleNamespace(data=None, server_content=sc)


async def test_interrupted_turn_without_turn_complete_is_flushed(caplog):
    lines = await _run([_gmsg(["q interrupted"]), _interrupted_msg()], caplog)
    assert _line(lines, "web search (interrupted turn)")[0].endswith(": q interrupted")
    assert _line(lines, "session END")[0].endswith("search_turns=1 search_queries=1 hangar_edits=0")


async def test_pending_queries_flushed_at_session_end(caplog):
    # /voice leave, the session cap, or a control teardown mid-reply: the turn
    # never completes, but its searches still happened and must be counted.
    lines = await _run([_gmsg(["q1", "q2"])], caplog)
    assert [ln for ln in lines if "web search (" in ln and ln.endswith(": q1 | q2")]
    end = _line(lines, "session END")[0]
    assert end.endswith("search_turns=1 search_queries=2 hangar_edits=0"), end
    # flushed exactly once, even though both the per-session and END paths run
    assert len([ln for ln in lines if "web search (" in ln]) == 1


async def test_drop_mid_turn_then_resume_does_not_bleed_into_next_turn(caplog):
    from .test_live_bridge import ApiCloseSession, _drive_open_ended, _multi_factory, _resume_msg
    s1 = ApiCloseSession([_resume_msg("h-1"), _gmsg(["before drop"])])  # drops mid-turn
    s2 = FakeSession([_gmsg(["after resume"], turn_complete=True)])
    bridge = LiveBridge(_multi_factory([s1, s2]), model="m", default_voice="Puck")
    with caplog.at_level(logging.INFO):
        await _drive_open_ended(bridge, voice_pb2.SessionStart(user_id="u1"))
    lines = [r.getMessage() for r in caplog.records]
    assert [ln for ln in lines if "web search (" in ln and ln.endswith(": before drop")]
    assert "search_queries=1" in _line(lines, "turn complete (#1")[0]
    assert _line(lines, "web search (turn #1)")[0].endswith(": after resume")
    assert _line(lines, "session END")[0].endswith("search_turns=2 search_queries=2 hangar_edits=0")


async def test_resume_does_not_dedupe_against_the_dropped_turn(caplog):
    from .test_live_bridge import ApiCloseSession, _drive_open_ended, _multi_factory, _resume_msg
    s1 = ApiCloseSession([_resume_msg("h-1"), _gmsg(["same q"])])
    s2 = FakeSession([_gmsg(["same q"], turn_complete=True)])
    bridge = LiveBridge(_multi_factory([s1, s2]), model="m", default_voice="Puck")
    with caplog.at_level(logging.INFO):
        await _drive_open_ended(bridge, voice_pb2.SessionStart(user_id="u1"))
    lines = [r.getMessage() for r in caplog.records]
    assert "search_queries=1" in _line(lines, "turn complete (#1")[0]
    assert _line(lines, "session END")[0].endswith("search_turns=2 search_queries=2 hangar_edits=0")
