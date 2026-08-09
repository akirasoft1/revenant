"""Bridge between the Node bot's Converse gRPC stream and a Gemini Live session."""
import asyncio
import logging
import time

from google.genai import types
from opentelemetry import trace

from . import voice_pb2

logger = logging.getLogger(__name__)
tracer = trace.get_tracer(__name__)

# A clean websocket close (code 1000/1001) is how a Gemini Live session normally
# ends when we cancel it -- it is NOT an error. The google-genai SDK may surface
# it EITHER as a raw websockets ConnectionClosedOK OR wrapped in its own APIError
# carrying the ws close code, depending on which layer raised it. Detect both so
# a normal end never logs an error or emits a spurious ErrorEvent to the bot.
# Import defensively: both are transitive deps of google-genai, but keep the
# bridge importable without them.
try:  # pragma: no cover - import shape depends on the installed websockets
    from websockets.exceptions import ConnectionClosedOK
    _WS_NORMAL_CLOSE = (ConnectionClosedOK,)
except Exception:  # pragma: no cover
    _WS_NORMAL_CLOSE = ()
try:  # pragma: no cover
    from google.genai import errors as _genai_errors
    _API_ERROR = (_genai_errors.APIError,)
except Exception:  # pragma: no cover
    _API_ERROR = ()


def _is_normal_close(exc) -> bool:
    """True if `exc` is a clean session close (ws code 1000/1001), whether raw
    from websockets or wrapped by the genai SDK, so we don't treat it as an error."""
    if _WS_NORMAL_CLOSE and isinstance(exc, _WS_NORMAL_CLOSE):
        return True
    if _API_ERROR and isinstance(exc, _API_ERROR):
        code = getattr(exc, "code", None)
        if code in (1000, 1001):
            return True
        msg = str(exc)
        if "1000" in msg or "1001" in msg:
            return True
    return False


class _SessionStats:
    """Per-session counters, shared by the client/server pumps and logged +
    attached to the session span when the session ends."""
    __slots__ = ("audio_in_chunks", "audio_in_bytes", "audio_out_chunks",
                 "audio_out_bytes", "turns", "interruptions",
                 "in_tx_chars", "out_tx_chars")

    def __init__(self):
        self.audio_in_chunks = 0
        self.audio_in_bytes = 0
        self.audio_out_chunks = 0
        self.audio_out_bytes = 0
        self.turns = 0
        self.interruptions = 0
        self.in_tx_chars = 0
        self.out_tx_chars = 0


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
            # Google Search grounding: lets the model answer with current, real
            # web knowledge (e.g. game specifics) instead of only its training
            # data. Grounding is handled SERVER-SIDE for the built-in search tool
            # -- no client-side tool-response plumbing needed (that caveat is only
            # for function_declarations). gemini-live-2.5-flash supports Search.
            tools=[types.Tool(google_search=types.GoogleSearch())],
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
            logger.warning("voice: first Converse event was not session_start; aborting")
            await emit(voice_pb2.VoiceServerEvent(
                error=voice_pb2.ErrorEvent(message="first event must be session_start")))
            return
        start = first.session_start

        stats = _SessionStats()
        started_at = time.monotonic()
        voice = start.voice_name or self._default_voice
        logger.info(
            "voice: session START user=%s model=%s voice=%s history_turns=%d recall=%s system_prompt=%s",
            start.user_id or "?", self._model, voice, len(start.history),
            bool(start.recall_context), bool(start.system_prompt),
        )
        span = tracer.start_span("voice.session")
        span.set_attribute("voice.user_id", start.user_id or "")
        span.set_attribute("voice.model", self._model)
        span.set_attribute("voice.voice_name", voice)
        span.set_attribute("voice.history_turns", len(start.history))
        span.set_attribute("voice.has_recall", bool(start.recall_context))

        outcome = "ok"
        try:
            async with self._session_factory(self._model, self._live_config(start)) as session:
                # 2. Seed conversation history, then recall + system context, as
                # prior (non-final) turns.
                seeded = 0
                for turn in start.history:
                    if turn.content:
                        await session.send_client_content(
                            turns=types.Content(
                                role=("model" if turn.role == "assistant" else "user"),
                                parts=[types.Part(text=turn.content)]),
                            turn_complete=False,
                        )
                        seeded += 1
                if start.recall_context:
                    await session.send_client_content(
                        turns=types.Content(role="user",
                                            parts=[types.Part(text=start.recall_context)]),
                        turn_complete=False,
                    )
                    seeded += 1
                logger.info("voice: seeded %d context turn(s); Live session open", seeded)
                pump_in = asyncio.create_task(self._pump_client(request_iter, session, stats))
                pump_out = asyncio.create_task(self._pump_server(session, emit, stats))
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
            outcome = "cancelled"
            raise
        except Exception as e:  # noqa: BLE001
            if _is_normal_close(e):
                outcome = "closed"
                logger.info("voice: session closed normally (%s)", type(e).__name__)
            else:
                outcome = "error"
                span.record_exception(e)
                logger.exception("voice: live bridge error")
                await emit(voice_pb2.VoiceServerEvent(
                    error=voice_pb2.ErrorEvent(message=str(e))))
        finally:
            dur = time.monotonic() - started_at
            span.set_attribute("voice.outcome", outcome)
            span.set_attribute("voice.duration_s", round(dur, 3))
            span.set_attribute("voice.audio_in_chunks", stats.audio_in_chunks)
            span.set_attribute("voice.audio_in_bytes", stats.audio_in_bytes)
            span.set_attribute("voice.audio_out_chunks", stats.audio_out_chunks)
            span.set_attribute("voice.audio_out_bytes", stats.audio_out_bytes)
            span.set_attribute("voice.turns", stats.turns)
            span.set_attribute("voice.interruptions", stats.interruptions)
            span.end()
            logger.info(
                "voice: session END user=%s outcome=%s dur=%.1fs "
                "audio_in=%d chunks/%dB audio_out=%d chunks/%dB "
                "turns=%d interruptions=%d in_tx_chars=%d out_tx_chars=%d",
                start.user_id or "?", outcome, dur,
                stats.audio_in_chunks, stats.audio_in_bytes,
                stats.audio_out_chunks, stats.audio_out_bytes,
                stats.turns, stats.interruptions, stats.in_tx_chars, stats.out_tx_chars,
            )

    async def _pump_client(self, request_iter, session, stats) -> None:
        async for ev in request_iter:
            kind = ev.WhichOneof("event")
            if kind == "audio":
                stats.audio_in_chunks += 1
                stats.audio_in_bytes += len(ev.audio.pcm)
                await session.send_realtime_input(
                    audio=types.Blob(data=ev.audio.pcm, mime_type="audio/pcm;rate=16000"))
            elif kind == "session_end":
                logger.info("voice: client requested session_end after %d audio chunk(s)",
                            stats.audio_in_chunks)
                return

    async def _pump_server(self, session, emit, stats) -> None:
        # receive() ends per-turn on turn_complete; loop to span the whole session.
        # When the session is closed, receive() yields nothing immediately —
        # that's the signal to stop, otherwise this would busy-spin forever.
        while True:
            produced = False
            async for msg in session.receive():
                produced = True
                if msg.data:
                    stats.audio_out_chunks += 1
                    stats.audio_out_bytes += len(msg.data)
                    await emit(voice_pb2.VoiceServerEvent(
                        audio=voice_pb2.AudioChunk(pcm=msg.data)))
                sc = getattr(msg, "server_content", None)
                if sc is None:
                    continue
                if getattr(sc, "input_transcription", None) and sc.input_transcription.text:
                    stats.in_tx_chars += len(sc.input_transcription.text)
                    logger.info("voice: user said: %s", sc.input_transcription.text)
                    await emit(voice_pb2.VoiceServerEvent(
                        input_transcript=voice_pb2.Transcript(text=sc.input_transcription.text)))
                if getattr(sc, "output_transcription", None) and sc.output_transcription.text:
                    stats.out_tx_chars += len(sc.output_transcription.text)
                    logger.info("voice: model said: %s", sc.output_transcription.text)
                    await emit(voice_pb2.VoiceServerEvent(
                        output_transcript=voice_pb2.Transcript(text=sc.output_transcription.text)))
                if getattr(sc, "interrupted", False):
                    stats.interruptions += 1
                    logger.info("voice: interrupted (barge-in)")
                    await emit(voice_pb2.VoiceServerEvent(interrupted=voice_pb2.Interrupted()))
                if getattr(sc, "turn_complete", False):
                    stats.turns += 1
                    logger.info("voice: turn complete (#%d, audio_out=%d chunks/%dB so far)",
                                stats.turns, stats.audio_out_chunks, stats.audio_out_bytes)
                    await emit(voice_pb2.VoiceServerEvent(turn_complete=voice_pb2.TurnComplete()))
            if not produced:
                logger.debug("voice: session receive() closed; ending server pump")
                break
