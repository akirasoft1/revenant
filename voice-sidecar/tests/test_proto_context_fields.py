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


def test_voiceclientevent_carries_acknowledge_waiting():
    e = voice_pb2.VoiceClientEvent(
        acknowledge_waiting=voice_pb2.AcknowledgeWaiting(display_name="Sarah")
    )
    assert e.WhichOneof("event") == "acknowledge_waiting"
    assert e.acknowledge_waiting.display_name == "Sarah"


def test_voiceserverevent_carries_control():
    e = voice_pb2.VoiceServerEvent(control=voice_pb2.Control(action="quiet", seconds=600))
    assert e.WhichOneof("event") == "control"
    assert e.control.action == "quiet"
    assert e.control.seconds == 600


def test_control_is_field_7_and_existing_fields_keep_their_numbers():
    fields = voice_pb2.VoiceServerEvent.DESCRIPTOR.fields_by_name
    assert {n: fields[n].number for n in fields} == {
        "audio": 1, "input_transcript": 2, "output_transcript": 3,
        "turn_complete": 4, "interrupted": 5, "error": 6, "control": 7}
    c = voice_pb2.Control.DESCRIPTOR.fields_by_name
    assert c["action"].number == 1 and c["seconds"].number == 2


def test_sidecar_proto_copy_matches_repo_proto():
    import pathlib
    here = pathlib.Path(__file__).resolve().parent.parent
    assert (here / "proto" / "voice.proto").read_text() == \
        (here.parent / "proto" / "voice.proto").read_text()
