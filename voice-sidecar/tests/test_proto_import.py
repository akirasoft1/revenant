def test_voice_stubs_import_and_have_service():
    from src import voice_pb2, voice_pb2_grpc
    ev = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
    assert ev.session_start.user_id == "u"
    assert hasattr(voice_pb2_grpc, "VoiceServicer")
    assert hasattr(voice_pb2_grpc, "add_VoiceServicer_to_server")
