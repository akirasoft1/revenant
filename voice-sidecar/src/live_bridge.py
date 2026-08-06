"""Bridge between the Node bot's Converse gRPC stream and a Gemini Live session."""
import asyncio
import logging

from google.genai import types

from . import voice_pb2

logger = logging.getLogger(__name__)


class LiveBridge:
    def __init__(self, session_factory, *, model, default_voice):
        self._session_factory = session_factory
        self._model = model
        self._default_voice = default_voice

    def _live_config(self, start) -> types.LiveConnectConfig:
        voice = start.voice_name or self._default_voice
        return types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=start.system_prompt or None,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
                )
            ),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(
                activity_handling=types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
            ),
        )

    async def converse(self, request_iter, emit) -> None:
        # 1. First event MUST be session_start.
        first = None
        async for ev in request_iter:
            first = ev
            break
        if first is None or first.WhichOneof("event") != "session_start":
            await emit(voice_pb2.VoiceServerEvent(
                error=voice_pb2.ErrorEvent(message="first event must be session_start")))
            return
        start = first.session_start

        try:
            async with self._session_factory(self._model, self._live_config(start)) as session:
                # 2. Seed recall + system context as prior (non-final) turn.
                if start.recall_context:
                    await session.send_client_content(
                        turns=types.Content(role="user",
                                            parts=[types.Part(text=start.recall_context)]),
                        turn_complete=False,
                    )
                pump_in = asyncio.create_task(self._pump_client(request_iter, session))
                pump_out = asyncio.create_task(self._pump_server(session, emit))
                try:
                    done, pending = await asyncio.wait(
                        {pump_in, pump_out}, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    # Cancelling `converse` itself (e.g. gRPC context cancellation) throws
                    # CancelledError into the `await asyncio.wait(...)` above without
                    # touching pump_in/pump_out — they'd otherwise leak as orphaned tasks
                    # blocked forever on send/receive. Always reap both, on every exit path.
                    for t in (pump_in, pump_out):
                        if not t.done():
                            t.cancel()
                    await asyncio.gather(pump_in, pump_out, return_exceptions=True)
                for t in done:
                    exc = t.exception()
                    if exc:
                        raise exc
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("live bridge error")
            await emit(voice_pb2.VoiceServerEvent(
                error=voice_pb2.ErrorEvent(message=str(e))))

    async def _pump_client(self, request_iter, session) -> None:
        async for ev in request_iter:
            kind = ev.WhichOneof("event")
            if kind == "audio":
                await session.send_realtime_input(audio=ev.audio.pcm)
            elif kind == "session_end":
                return

    async def _pump_server(self, session, emit) -> None:
        # receive() ends per-turn on turn_complete; loop to span the whole session.
        while True:
            async for msg in session.receive():
                if msg.data:
                    await emit(voice_pb2.VoiceServerEvent(
                        audio=voice_pb2.AudioChunk(pcm=msg.data)))
                sc = getattr(msg, "server_content", None)
                if sc is None:
                    continue
                if getattr(sc, "input_transcription", None) and sc.input_transcription.text:
                    await emit(voice_pb2.VoiceServerEvent(
                        input_transcript=voice_pb2.Transcript(text=sc.input_transcription.text)))
                if getattr(sc, "output_transcription", None) and sc.output_transcription.text:
                    await emit(voice_pb2.VoiceServerEvent(
                        output_transcript=voice_pb2.Transcript(text=sc.output_transcription.text)))
                if getattr(sc, "interrupted", False):
                    await emit(voice_pb2.VoiceServerEvent(interrupted=voice_pb2.Interrupted()))
                if getattr(sc, "turn_complete", False):
                    await emit(voice_pb2.VoiceServerEvent(turn_complete=voice_pb2.TurnComplete()))
