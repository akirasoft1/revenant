from src import voice_pb2


def test_sessionstart_has_history():
    s = voice_pb2.SessionStart(
        system_prompt="sp",
        recall_context="r",
        history=[voice_pb2.Turn(role="assistant", content="yo")],
    )
    assert s.history[0].content == "yo"
