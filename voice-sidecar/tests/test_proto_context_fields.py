from src import voice_pb2


def test_sessionstart_has_history():
    s = voice_pb2.SessionStart(
        system_prompt="sp",
        recall_context="r",
        history=[voice_pb2.Turn(role="assistant", content="yo")],
    )
    assert s.history[0].content == "yo"


def test_voiceclientevent_carries_set_speaker():
    e = voice_pb2.VoiceClientEvent(
        set_speaker=voice_pb2.SetSpeaker(user_id="u1", display_name="Mike")
    )
    assert e.WhichOneof("event") == "set_speaker"
    assert e.set_speaker.user_id == "u1"
    assert e.set_speaker.display_name == "Mike"
