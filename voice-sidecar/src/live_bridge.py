"""Bridge between the Node bot's Converse gRPC stream and a Gemini Live session."""
import asyncio
import logging
import random
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
    from websockets.exceptions import ConnectionClosed, ConnectionClosedOK
    _WS_NORMAL_CLOSE = (ConnectionClosedOK,)
    _WS_ANY_CLOSE = (ConnectionClosed,)
except Exception:  # pragma: no cover
    _WS_NORMAL_CLOSE = ()
    _WS_ANY_CLOSE = ()
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


def _is_session_drop(exc) -> bool:
    """True if `exc` is the Live session's connection ending -- clean OR
    abnormal -- rather than a genuine bug in the bridge.

    Against the real google-genai SDK, `AsyncSession.receive()` NEVER returns
    normally on a closed connection: `_receive()` converts EVERY
    `ConnectionClosed` (clean 1000/1001 *and* abnormal 1006/1011 alike) into
    `errors.APIError.raise_error(...)`. So `_is_normal_close` alone (which
    only matches the clean-close subset) is not enough to reach the
    reconnect decision -- an abnormal drop would still look like "a real
    bug" and escape as a fatal error. This is the broader check that makes
    the reconnect path reachable for BOTH cases; callers still use
    `_is_normal_close` afterwards to classify the final outcome as
    "closed" vs "error" when a drop is NOT ultimately retried.
    """
    if _is_normal_close(exc):
        return True
    if _API_ERROR and isinstance(exc, _API_ERROR):
        return True
    if _WS_ANY_CLOSE and isinstance(exc, _WS_ANY_CLOSE):
        return True
    return False


def _reconnect_backoff_delay(attempt: int) -> float:
    """Exponential backoff with jitter for retrying a FAILED (re)open of the
    Live session (expired/consumed resumption handle, a transient GEAP 503
    spike -- see CLAUDE.md's agent-sidecar `_gemini_retry_options` note on
    this same error class). Shape: 0.5s, 1s, 2s, capped at 4s, +/-30% jitter.
    `attempt` is 0-based (0 -> ~0.5s, 1 -> ~1s, 2 -> ~2s, 3+ -> ~4s).
    """
    base = min(0.5 * (2 ** attempt), 4.0)
    jittered = base + base * random.uniform(-0.3, 0.3)
    return max(0.05, jittered)


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


class _ResumeState:
    """Session-resumption bookkeeping shared across reconnects: the newest
    handle the server gave us, whether it warned of an imminent disconnect
    (GoAway), and how many times we've reconnected."""
    __slots__ = ("handle", "going_away", "reconnects")

    def __init__(self):
        self.handle = None
        self.going_away = False
        self.reconnects = 0


class _SessionRef:
    """Mutable holder for the CURRENT Live session. `_pump_client` lives for the
    whole gRPC call and reads this each event, so a reconnect can swap the
    session underneath it without dropping the bot's stream."""
    __slots__ = ("session",)

    def __init__(self):
        self.session = None


class LiveBridge:
    def __init__(self, session_factory, *, model, default_voice,
                 compression_trigger_tokens=25000, resumption_enabled=True,
                 max_reconnects=5):
        self._session_factory = session_factory
        self._model = model
        self._default_voice = default_voice
        self._compression_trigger_tokens = compression_trigger_tokens
        self._resumption_enabled = resumption_enabled
        self._max_reconnects = max_reconnects

    def _live_config(self, start, resumption_handle=None) -> types.LiveConnectConfig:
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
            # Sliding-window compression -> session is no longer capped at ~15 min.
            context_window_compression=types.ContextWindowCompressionConfig(
                sliding_window=types.SlidingWindow(),
                trigger_tokens=self._compression_trigger_tokens,
            ),
            # None on first connect; the stored handle on a resume.
            session_resumption=(
                types.SessionResumptionConfig(handle=resumption_handle)
                if self._resumption_enabled else None
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
        # Hoisted above the try so the `finally` below can always read the
        # final reconnect count, even if we never got past the first connect.
        resume = _ResumeState()
        try:
            session_ref = _SessionRef()
            # Created ONCE -- it owns the bot's gRPC request stream and must
            # survive every reconnect below (only the server-side pump is
            # per-session) -- but NOT until the first session is actually open
            # (see where it is started, after seeding).
            #
            # It must not start earlier: `_pump_client` drops any frame that
            # arrives while `session_ref.session` is None, and the bot flushes
            # its whole pre-roll (the wake phrase AND the question spoken with
            # it) immediately after session_start. Draining the stream during
            # the ~1-3s open+seed would silently throw that question away and
            # leave the model with nothing to answer -- a real outage
            # (2026-08-14). Until we start reading, gRPC flow control buffers
            # those frames for us, which is exactly what we want on the FIRST
            # open. Dropping stays correct for a RECONNECT gap, where stale
            # audio replayed after a resume would read as current speech.
            pump_in = None
            client_done = False
            # Tracks whether we've ACTUALLY seeded history/recall_context into
            # a session yet -- deliberately separate from resume.reconnects,
            # which is the shared reconnect/retry BUDGET counter and also
            # increments on a failed session OPEN (FIX I2). If seeding were
            # gated on resume.reconnects == 0, a failed first open would bump
            # the counter before any context was ever sent, so the successful
            # retry would wrongly take the "resumed, context carried by
            # handle" branch and seed nothing -- even though resume.handle is
            # None. Only set True once context has actually been sent.
            seeded_context = False
            try:
                while True:
                    # --- (Re)open the Live session for this iteration.
                    #
                    # This is wrapped so a FAILED open/reopen (expired/consumed
                    # resumption handle, a transient GEAP 503 spike) is retried
                    # against the same reconnect budget below instead of
                    # escaping as a fatal ErrorEvent (FIX I2) -- `entered`
                    # distinguishes "the open itself failed" (retry) from "the
                    # session opened fine but the body raised" (propagate,
                    # unchanged from before).
                    entered = False
                    client_exc = None
                    server_exc = None
                    try:
                        async with self._session_factory(
                                self._model, self._live_config(start, resume.handle)) as session:
                            entered = True
                            session_ref.session = session
                            if not seeded_context:
                                # 2. Seed conversation history, then recall + system
                                # context, as prior (non-final) turns -- ONLY the
                                # first time context is actually seeded. A resumed
                                # session already carries this context via the
                                # resumption handle; re-seeding would duplicate the
                                # conversation. Gated on seeded_context (not
                                # resume.reconnects, which also counts failed
                                # opens) so a failed-then-retried first open still
                                # seeds on the successful attempt.
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
                                seeded_context = True
                            else:
                                logger.info(
                                    "voice: resumed Live session (reconnect #%d); context carried by handle",
                                    resume.reconnects)

                            # Start consuming the bot's stream only now that a
                            # session exists to receive it (first iteration
                            # only; it then survives reconnects). Before this
                            # point gRPC buffers the pre-roll for us.
                            if pump_in is None:
                                pump_in = asyncio.create_task(
                                    self._pump_client(request_iter, session_ref, stats))
                            pump_out = asyncio.create_task(self._pump_server(session, emit, stats, resume))
                            try:
                                done, _pending = await asyncio.wait(
                                    {pump_in, pump_out}, return_when=asyncio.FIRST_COMPLETED)
                            finally:
                                # Only the SERVER pump is per-session -- cancel and
                                # reap it on every iteration exit. pump_in must
                                # survive the reconnect; it is reaped in the outer
                                # finally below instead.
                                if not pump_out.done():
                                    pump_out.cancel()
                                await asyncio.gather(pump_out, return_exceptions=True)
                            session_ref.session = None
                            if pump_in in done:
                                # The client asked to end (or its stream broke) --
                                # that always means "exit", never "reconnect".
                                client_done = True
                            client_exc = pump_in.exception() if pump_in in done else None
                            server_exc = pump_out.exception() if pump_out in done else None
                            if client_exc:
                                raise client_exc  # the client stream broke: always fatal
                            if server_exc is not None and not _is_session_drop(server_exc):
                                raise server_exc  # a genuine bug: don't paper over it
                            # else: the server pump ended because the Live
                            # session's connection closed -- clean OR abnormal.
                            # Against the real SDK this is how EVERY close
                            # surfaces (receive() raises rather than returning),
                            # so this is what makes the reconnect decision below
                            # reachable at all. Fall through to it.
                    except Exception as open_or_body_exc:  # noqa: BLE001
                        if entered:
                            # A genuine exception from inside the session body
                            # (client_exc, or a non-drop server_exc) -- already
                            # logged/classified by the raises above; propagate
                            # unchanged to the outer handler.
                            raise
                        # The (re)open itself failed. Retry it against the same
                        # reconnect budget with exponential backoff + jitter
                        # (mirrors agent-sidecar's _gemini_retry_options shape
                        # for the same GEAP-transient-error class). Once the
                        # budget is exhausted, give up exactly as before.
                        if resume.reconnects >= self._max_reconnects:
                            logger.warning(
                                "voice: failed to (re)open Live session and reconnect budget "
                                "(%d) exhausted: %s", self._max_reconnects, open_or_body_exc)
                            raise
                        delay = _reconnect_backoff_delay(resume.reconnects)
                        resume.reconnects += 1
                        logger.warning(
                            "voice: failed to (re)open Live session (attempt %d/%d): %s; "
                            "retrying in %.2fs",
                            resume.reconnects, self._max_reconnects, open_or_body_exc, delay)
                        await asyncio.sleep(delay)
                        continue

                    if client_done:
                        return
                    if not (self._resumption_enabled and resume.handle):
                        logger.info(
                            "voice: session ended with no resumption handle (going_away=%s); "
                            "not reconnecting", resume.going_away)
                        if server_exc is not None:
                            # Not reconnecting -- don't silently swallow the drop;
                            # let the outer handler classify it (closed vs error).
                            raise server_exc
                        return
                    if resume.reconnects >= self._max_reconnects:
                        logger.warning("voice: reached max reconnects (%d); ending session",
                                       self._max_reconnects)
                        if server_exc is not None:
                            raise server_exc
                        return
                    resume.reconnects += 1
                    was_going_away = resume.going_away
                    resume.going_away = False
                    logger.info(
                        "voice: reconnecting Live session with resumption handle (#%d/%d) "
                        "after a %s drop",
                        resume.reconnects, self._max_reconnects,
                        "GoAway-flagged" if was_going_away else "unexplained")
            finally:
                # Cancelling `converse` itself (e.g. gRPC context cancellation) throws
                # CancelledError into the loop above without touching pump_in --
                # it would otherwise leak as an orphaned task blocked forever on
                # the bot's request stream. Always reap it, on every exit path.
                # pump_in is None if we never got a session open at all (every
                # attempt failed), in which case there is nothing to reap.
                if pump_in is not None:
                    if not pump_in.done():
                        pump_in.cancel()
                    await asyncio.gather(pump_in, return_exceptions=True)
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
            span.set_attribute("voice.reconnects", resume.reconnects)
            span.end()
            logger.info(
                "voice: session END user=%s outcome=%s dur=%.1fs "
                "audio_in=%d chunks/%dB audio_out=%d chunks/%dB "
                "turns=%d interruptions=%d in_tx_chars=%d out_tx_chars=%d reconnects=%d",
                start.user_id or "?", outcome, dur,
                stats.audio_in_chunks, stats.audio_in_bytes,
                stats.audio_out_chunks, stats.audio_out_bytes,
                stats.turns, stats.interruptions, stats.in_tx_chars, stats.out_tx_chars,
                resume.reconnects,
            )

    async def _pump_client(self, request_iter, session_ref, stats) -> None:
        # Per-session latches (reset whenever session_ref.session changes
        # identity -- i.e. on every reconnect swap):
        #   _last_session: tracks that identity so we can detect the swap.
        #   _warned_send_failure: the FIRST send failure in a session logs at
        #     WARNING (real signal); subsequent ones -- expected at ~20ms/frame
        #     once a session is dying -- stay at DEBUG so they don't churn the
        #     log at a silent-but-high rate (FIX M7).
        #   _pending_stream_end: latched when an audio_stream_end is dropped
        #     during a reconnect gap, so it can be replayed once the new
        #     session lands -- otherwise that turn's finalize signal is lost,
        #     and the bot (which already set its own audioEndSent=true) will
        #     NOT resend it, costing a whole turn (FIX m1).
        _last_session = None
        _warned_send_failure = False
        _pending_stream_end = False
        async for ev in request_iter:
            kind = ev.WhichOneof("event")
            if kind == "session_end":
                logger.info("voice: client requested session_end after %d audio chunk(s)",
                            stats.audio_in_chunks)
                return
            session = session_ref.session
            if session is not _last_session:
                _last_session = session
                _warned_send_failure = False
                if session is not None and _pending_stream_end:
                    try:
                        await session.send_realtime_input(audio_stream_end=True)
                        logger.info(
                            "voice: replayed audio_stream_end dropped during the reconnect gap")
                    except Exception:  # noqa: BLE001
                        logger.warning(
                            "voice: failed to replay audio_stream_end after reconnect", exc_info=True)
                    finally:
                        _pending_stream_end = False
            if session is None:
                # Mid-reconnect gap (~1-3s -- a full Live-session open): drop
                # rather than buffer -- stale audio would arrive after the
                # resume as if it were current speech. audio_stream_end is the
                # one exception: latch it for replay above once we reconnect.
                if kind == "audio_stream_end":
                    _pending_stream_end = True
                logger.debug("voice: dropping %s during session reconnect", kind)
                continue
            try:
                if kind == "audio":
                    stats.audio_in_chunks += 1
                    stats.audio_in_bytes += len(ev.audio.pcm)
                    await session.send_realtime_input(
                        audio=types.Blob(data=ev.audio.pcm, mime_type="audio/pcm;rate=16000"))
                elif kind == "audio_stream_end":
                    # Debounced end-of-speech from the bot: tell the Live model
                    # the user paused so it finalizes the turn now, instead of
                    # ambient audio holding it open. Automatic VAD still applies.
                    await session.send_realtime_input(audio_stream_end=True)
                    logger.debug("voice: signaled audio_stream_end")
            except Exception as e:  # noqa: BLE001
                # The session died under us; the reconnect loop will replace it.
                if not _warned_send_failure:
                    _warned_send_failure = True
                    logger.warning(
                        "voice: send failed on a closing session (%s); dropping frame "
                        "(further failures this session logged at DEBUG)", type(e).__name__)
                else:
                    logger.debug("voice: send failed on a closing session (%s); dropping frame",
                                 type(e).__name__)

    async def _pump_server(self, session, emit, stats, resume) -> None:
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
                sru = getattr(msg, "session_resumption_update", None)
                if sru is not None and getattr(sru, "resumable", False) and getattr(sru, "new_handle", None):
                    resume.handle = sru.new_handle
                    logger.debug("voice: session resumption handle updated")
                ga = getattr(msg, "go_away", None)
                if ga is not None:
                    resume.going_away = True
                    logger.info("voice: server sent GoAway (time_left=%s); will resume with handle=%s",
                                getattr(ga, "time_left", "?"), bool(resume.handle))
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
