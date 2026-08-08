from src import agent_pb2


def test_chatrequest_has_context_fields():
    r = agent_pb2.ChatRequest(
        system_prompt="sp",
        memory_context="mem",
        history=[agent_pb2.Turn(role="user", content="hi")],
    )
    assert r.system_prompt == "sp" and r.memory_context == "mem"
    assert r.history[0].role == "user" and r.history[0].content == "hi"
