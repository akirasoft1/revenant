"""Pins the google-genai Live API surface the bridge depends on.

`live_bridge._pump_server` reads server messages through `getattr(..., None)`
so a renamed field (e.g. `session_resumption_update.new_handle`) would NOT
raise -- resumption, GoAway handling or transcripts would just silently stop.
The FakeSession-based bridge tests can't see that, because the fakes are
shaped from our own assumptions. These tests check the REAL installed SDK, so a
`google-genai>=` floor bump that moves any of it fails here instead of in prod.
Re-verified on google-genai 2.25.0 (2026-09-26).
"""
import asyncio
import inspect

import pytest
import websockets
from websockets.frames import Close
from google.genai import errors, live, types


def test_server_message_fields_the_bridge_reads():
    assert {"session_resumption_update", "go_away", "server_content"} <= set(
        types.LiveServerMessage.model_fields)
    assert {"new_handle", "resumable"} <= set(
        types.LiveServerSessionResumptionUpdate.model_fields)
    assert "time_left" in types.LiveServerGoAway.model_fields
    assert {"input_transcription", "output_transcription", "interrupted",
            "turn_complete"} <= set(types.LiveServerContent.model_fields)
    assert "text" in types.Transcription.model_fields
    # `msg.data` is the SDK's inline-audio convenience property.
    assert hasattr(types.LiveServerMessage, "data")


def test_connect_config_fields_the_bridge_sets():
    assert {"context_window_compression", "session_resumption",
            "realtime_input_config", "input_audio_transcription",
            "output_audio_transcription", "speech_config", "tools",
            "system_instruction", "response_modalities"} <= set(
        types.LiveConnectConfig.model_fields)
    assert {"trigger_tokens", "sliding_window"} <= set(
        types.ContextWindowCompressionConfig.model_fields)
    assert "handle" in types.SessionResumptionConfig.model_fields
    assert types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS


def test_session_send_signatures():
    cc = inspect.signature(live.AsyncSession.send_client_content).parameters
    assert {"turns", "turn_complete"} <= set(cc)
    ri = inspect.signature(live.AsyncSession.send_realtime_input).parameters
    assert {"audio", "audio_stream_end"} <= set(ri)


class _ClosingWs:
    def __init__(self, code):
        self._code = code

    async def recv(self, decode=None):
        rcvd = Close(self._code, "bye") if self._code else None
        raise websockets.ConnectionClosed(rcvd, None)


class _Client:
    vertexai = True


@pytest.mark.parametrize("code,expected", [(1000, 1000), (1001, 1001),
                                           (1011, 1011), (None, 1006)])
def test_receive_raises_on_every_close_with_code_preserved(code, expected):
    """The close contract `_pump_server` and `_is_normal_close` are built on:
    every websocket close surfaces from `receive()` as a RAISED APIError
    carrying the close code -- never a silent return."""
    session = live.AsyncSession(api_client=_Client(), websocket=_ClosingWs(code))

    async def drain():
        async for _ in session.receive():
            pass

    with pytest.raises(errors.APIError) as ei:
        asyncio.run(drain())
    assert ei.value.code == expected


def test_function_calling_surface_the_bridge_uses():
    # sc-knowledge function calling (spec §7): _pump_server reads these via
    # getattr, so a rename would silently stop tool calls being answered.
    assert {"tool_call", "tool_call_cancellation"} <= set(types.LiveServerMessage.model_fields)
    assert "function_calls" in types.LiveServerToolCall.model_fields
    assert "ids" in types.LiveServerToolCallCancellation.model_fields
    assert {"id", "name", "args"} <= set(types.FunctionCall.model_fields)
    assert {"id", "name", "response"} <= set(types.FunctionResponse.model_fields)
    assert {"name", "description", "parameters_json_schema"} <= set(
        types.FunctionDeclaration.model_fields)
    assert "function_declarations" in types.Tool.model_fields
    tr = inspect.signature(live.AsyncSession.send_tool_response).parameters
    assert "function_responses" in tr
