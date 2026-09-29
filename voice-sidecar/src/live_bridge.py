"""Bridge between the Node bot's Converse gRPC stream and a Gemini Live session."""
import asyncio
import logging
import math
import random
import re
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


# Anchored close-code match for the message FALLBACK below. `APIError.__str__`
# is `f"{self.code} {self.status}. {self.details}"`, so a wrapped close code is
# always the FIRST token of the message. The `\b` matters as much as the `^`:
# without it "10000 ..." matches the "1000" prefix.
_CLOSE_CODE_AT_START = re.compile(r"^\s*(?:1000|1001)\b")

# Appended to the system instruction ONLY when sc-knowledge function
# declarations are attached (spec §7 persona note). Voice-only: tables and
# long number lists are unlistenable, and a silent lookup reads as a hang.
SC_VOICE_NOTE = (
    "You can look up live Star Citizen data with the sc_* tools (item stats and where to buy, "
    "what a place's shops sell and what's unique to it, component rankings, faction missions by "
    "reputation per minute, trade routes, commodity prices, and our org's curated guides on "
    "mining, salvage and trading). Use them for any Star Citizen item, price, mission, "
    "reputation, trade or location question instead of memory; never assert from memory that "
    "something is vaulted, removed, not in the game, or located somewhere -- tool and search "
    "results beat memory. Before a lookup, say a very short natural filler like \"let me check\". "
    "When answering, speak only the top two or three results in plain sentences and offer the "
    "rest; never read tables or long number lists aloud."
)

# Local voice control tools (spec 2026-09-27-voice-control-commands). Declared
# to the Live model independently of sc-knowledge (present even when SC is
# off/unavailable) and answered IN THE SIDECAR -- never sent to the MCP
# executor. The call itself is the detection; enforcement (teardown after
# playback drains, the quiet deadline, clamping) is bot-side, driven by the
# `Control` event `_answer_control_call` emits.
END_CONVERSATION_TOOL = "end_conversation"
GO_QUIET_TOOL = "go_quiet"
CONTROL_TOOL_NAMES = frozenset({END_CONVERSATION_TOOL, GO_QUIET_TOOL})
CONTROL_TOOL_DECLARATIONS = (
    types.FunctionDeclaration(
        name=END_CONVERSATION_TOOL,
        description=(
            "End the current voice conversation now. Call this when the user says they are done "
            "or dismisses you, e.g. \"that's all\", \"thanks, that's it\", \"we're done\", "
            "\"end conversation\", \"bye\". Takes no arguments."),
    ),
    types.FunctionDeclaration(
        name=GO_QUIET_TOOL,
        description=(
            "Stop listening for a while: ends the conversation and ignores the wake word from "
            "everyone until the time is up. Call this when asked to go quiet, be quiet, mute, "
            "stop listening or leave people alone for some time. Pass `minutes` when the user "
            "gives a duration (convert hours to minutes); omit it if they don't."),
        parameters_json_schema={"type": "object", "properties": {"minutes": {"type": "number"}}},
    ),
)
# Appended to the system instruction ONLY when the control tools are declared.
CONTROL_NOTE = (
    "Call end_conversation when the user is done with you or dismisses you, and call go_quiet "
    "(with minutes, if they say how long) when asked to stop listening or be quiet for a while. "
    "When you call either, say only a very short confirmation."
)
# Control.seconds is an int32 on the wire.
_INT32_MAX = 2**31 - 1


def _quiet_seconds(minutes) -> int:
    """go_quiet `minutes` -> whole seconds for `Control.seconds`. Anything
    missing/unusable (None, non-numeric, bool, NaN/inf, negative) is 0, which
    the bot reads as "not given" and replaces with its default; clamping to
    the allowed range is bot-side too. Only the int32 wire limit is enforced
    here, because protobuf raises on an out-of-range value."""
    if minutes is None or isinstance(minutes, bool):
        return 0
    try:
        value = float(minutes)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(value) or value < 0:
        return 0
    return min(round(value * 60), _INT32_MAX)


def _is_normal_close(exc) -> bool:
    """True if `exc` is a clean session close (ws code 1000/1001), whether raw
    from websockets or wrapped by the genai SDK, so we don't treat it as an error.

    Misclassifying here fails in the WORST direction: `converse` would set
    `outcome = "closed"`, emit no ErrorEvent, and the bot would never learn its
    session died -- no teardown, no notifyError, no reconnect. So the checks are
    ordered strongest-first and the loosest one is anchored.

    The structured `code` check is the real one, and against the installed
    google-genai (2.17.0, re-verified on 2.25.0 -- by executing it, not by reading it) it is
    sufficient on its own: every path that turns a websocket close into an
    exception -- `AsyncSession._receive` and the one-shot connect in `live.py` --
    calls `errors.APIError.raise_error(code, reason, None)` with the ws close
    code (1006 when the peer sent no close frame), and `APIError.__init__`
    assigns `self.code = code if code else self._get_code(...)`, so a truthy
    close code is always preserved on the instance.

    The message fallback is kept only for an SDK/wrapper shape that formats the
    code into the text without carrying it on the instance, and it is anchored
    to the position `APIError` actually formats it at. It used to be
    `"1000" in str(exc)`, which matched incidental digits ANYWHERE: a timeout
    reported as "10000ms", a quota message containing "100000", or a request id
    that happened to contain "1000" all classified a genuine failure as a clean
    close.
    """
    if _WS_NORMAL_CLOSE and isinstance(exc, _WS_NORMAL_CLOSE):
        return True
    if _API_ERROR and isinstance(exc, _API_ERROR):
        code = getattr(exc, "code", None)
        if code in (1000, 1001):
            return True
        # A code that IS populated and is not 1000/1001 is a decided answer --
        # don't let the text fallback second-guess it (a 1011 whose reason text
        # quotes "1000" is not a clean close).
        if isinstance(code, int):
            return False
        if _CLOSE_CODE_AT_START.match(str(exc)):
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


def _note_grounding(sc, stats) -> None:
    """Record the Google Search queries a server_content message grounded on.

    `LiveServerContent.grounding_metadata` (GroundingMetadata | None) ->
    `.web_search_queries` (list[str] | None), verified against google-genai
    2.25.0. Grounding can be spread across several server_content messages of
    one turn and repeat the same query, so queries are de-duplicated per turn.
    Anything malformed is ignored: this is observability only and must never
    break the audio pump."""
    gm = getattr(sc, "grounding_metadata", None)
    if gm is None:
        return
    queries = getattr(gm, "web_search_queries", None)
    if not isinstance(queries, (list, tuple)):
        return
    for q in queries:
        if isinstance(q, str) and q.strip():
            stats.turn_search_queries.setdefault(q, None)


class _SessionStats:
    """Per-session counters, shared by the client/server pumps and logged +
    attached to the session span when the session ends."""
    __slots__ = ("audio_in_chunks", "audio_in_bytes", "audio_out_chunks",
                 "audio_out_bytes", "turns", "interruptions",
                 "in_tx_chars", "out_tx_chars", "speaker_markers",
                 "deferral_acks", "tool_calls", "sc_fallbacks",
                 "search_turns", "search_queries", "turn_search_queries")

    def __init__(self):
        self.audio_in_chunks = 0
        self.audio_in_bytes = 0
        self.audio_out_chunks = 0
        self.audio_out_bytes = 0
        self.turns = 0
        self.interruptions = 0
        self.in_tx_chars = 0
        self.out_tx_chars = 0
        self.speaker_markers = 0
        self.deferral_acks = 0
        self.tool_calls = 0
        self.sc_fallbacks = 0
        # Google Search grounding: session totals, plus the distinct queries
        # seen in the CURRENT turn (insertion-ordered dict used as an ordered
        # set; cleared at each turn_complete).
        self.search_turns = 0
        self.search_queries = 0
        self.turn_search_queries = {}


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
                 max_reconnects=5, sc_executor=None, control_tools_enabled=False):
        self._session_factory = session_factory
        # Local end_conversation/go_quiet tools. The constructor default is
        # OFF so a bare LiveBridge keeps the pre-control config; server.py
        # passes config.control_tools_enabled (VOICE_CONTROL_TOOLS_ENABLED,
        # default true).
        self._control_enabled = bool(control_tools_enabled)
        # sc_tools.ScToolExecutor, or None when SC_KNOWLEDGE_ENABLED is off.
        self._sc = sc_executor
        self._model = model
        self._default_voice = default_voice
        self._compression_trigger_tokens = compression_trigger_tokens
        self._resumption_enabled = resumption_enabled
        self._max_reconnects = max_reconnects

    def _sc_tools_attachable(self) -> bool:
        return self._sc is not None and bool(self._sc.declarations)

    def _live_config(self, start, resumption_handle=None, with_sc=True,
                     with_control=True) -> types.LiveConnectConfig:
        voice = start.voice_name or self._default_voice
        # Google Search grounding: lets the model answer with current, real
        # web knowledge (e.g. game specifics) instead of only its training
        # data. Grounding is handled SERVER-SIDE for the built-in search tool
        # -- no client-side tool-response plumbing needed (that caveat is only
        # for function_declarations). gemini-live-2.5-flash supports Search.
        tools = [types.Tool(google_search=types.GoogleSearch())]
        system_instruction = start.system_prompt or None
        # sc-knowledge function calling (spec §7): attached only when the
        # executor exists AND has loaded declarations -- otherwise this config
        # is identical to the search-only one (pinned by
        # tests/test_live_bridge_tools.py). Evaluated per (re)connect, so a
        # background refresh that succeeds later reaches the next session.
        # These calls are answered by `_pump_server` via send_tool_response.
        # with_sc=False is `converse`'s search-only connect fallback.
        #
        # Control tools (end_conversation/go_quiet) are independent of SC:
        # prepended to the SAME function-declarations Tool when SC is
        # attached, or in their own Tool when it isn't. with_control=False is
        # the second (control-only) step of the connect fallback. With the
        # flag off this whole block is skipped -> today's config exactly.
        declarations = []
        notes = []
        if with_control and self._control_enabled:
            declarations.extend(CONTROL_TOOL_DECLARATIONS)
        if with_sc and self._sc_tools_attachable():
            declarations.extend(self._sc.declarations)
            notes.append(SC_VOICE_NOTE)
        if with_control and self._control_enabled:
            notes.append(CONTROL_NOTE)
        if declarations:
            tools.append(types.Tool(function_declarations=declarations))
            system_instruction = "\n\n".join([start.system_prompt or ""] + notes)
        return types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=system_instruction,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
                )
            ),
            tools=tools,
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
            # SC connect fallback: flips False (for the rest of this Converse
            # call, reconnects included) the first time an open fails while
            # sc-knowledge function declarations were attached. See the
            # open-failure handler below.
            use_sc = True
            # Control-tool connect fallback: the same single-shot rule, one
            # layer further down. Flips False (sticky for this Converse) the
            # first time an open fails with the control declarations attached
            # and NO sc_* declarations (SC is always dropped first), so a
            # rejected control schema degrades to today's search-only config
            # instead of failing every connect.
            use_control = True
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
                    sc_attached = use_sc and self._sc_tools_attachable()
                    control_attached = use_control and self._control_enabled
                    try:
                        async with self._session_factory(
                                self._model,
                                self._live_config(start, resume.handle, with_sc=use_sc,
                                                  with_control=use_control)) as session:
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
                            pump_out = asyncio.create_task(
                                self._pump_server(session, emit, stats, resume, session_ref))
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
                        if sc_attached:
                            # The open failed WITH sc-knowledge function
                            # declarations attached. Their JSON schemas (sanitised
                            # by sc_tools._sanitize_schema, but still) are
                            # the one part of this config not proven on GEAP
                            # Live, and a rejection would fail EVERY connect
                            # while SC_KNOWLEDGE_ENABLED is on -- so retry this
                            # open ONCE, immediately and outside the reconnect
                            # budget, search-only (no declarations, no
                            # SC_VOICE_NOTE), and keep this call search-only.
                            # If the failure was unrelated (e.g. a transient
                            # 503) the search-only open fails too and falls
                            # into the normal budgeted retry below.
                            #
                            # Control tools, when declared, are KEPT on this
                            # retry: only the SC layer is dropped here. If the
                            # control declarations are the problem, the next
                            # open fails too and the branch below drops them.
                            use_sc = False
                            stats.sc_fallbacks += 1
                            if control_attached:
                                logger.warning(
                                    "voice: Live session open failed with sc_* function declarations "
                                    "attached (%s: %s); retrying once without sc_* tools (control "
                                    "tools kept) -- this Converse stays without sc_* tools "
                                    "(sc_fallbacks=%d)",
                                    type(open_or_body_exc).__name__, open_or_body_exc,
                                    stats.sc_fallbacks, exc_info=True)
                            else:
                                logger.warning(
                                    "voice: Live session open failed with sc_* function declarations "
                                    "attached (%s: %s); retrying once search-only -- this Converse "
                                    "stays search-only (sc_fallbacks=%d)",
                                    type(open_or_body_exc).__name__, open_or_body_exc,
                                    stats.sc_fallbacks, exc_info=True)
                            continue
                        if control_attached:
                            # Same single-shot, out-of-budget retry for the
                            # control declarations (end_conversation/go_quiet)
                            # once SC is no longer attached: retry with NO
                            # function declarations and no CONTROL_NOTE, and
                            # keep this Converse that way. The bot's transcript
                            # phrase backstop still catches the commands.
                            use_control = False
                            logger.warning(
                                "voice: Live session open failed with the control tool declarations "
                                "(end_conversation/go_quiet) attached (%s: %s); retrying once "
                                "without them -- this Converse stays search-only; spoken control "
                                "commands fall back to the bot's phrase matcher",
                                type(open_or_body_exc).__name__, open_or_body_exc, exc_info=True)
                            continue
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
            span.set_attribute("voice.tool_calls", stats.tool_calls)
            span.set_attribute("voice.sc_fallbacks", stats.sc_fallbacks)
            span.set_attribute("voice.search_turns", stats.search_turns)
            span.set_attribute("voice.search_queries", stats.search_queries)
            span.end()
            logger.info(
                "voice: session END user=%s outcome=%s dur=%.1fs "
                "audio_in=%d chunks/%dB audio_out=%d chunks/%dB "
                "turns=%d interruptions=%d in_tx_chars=%d out_tx_chars=%d reconnects=%d "
                "speaker_markers=%d deferral_acks=%d tool_calls=%d sc_fallbacks=%d "
                "search_turns=%d search_queries=%d",
                start.user_id or "?", outcome, dur,
                stats.audio_in_chunks, stats.audio_in_bytes,
                stats.audio_out_chunks, stats.audio_out_bytes,
                stats.turns, stats.interruptions, stats.in_tx_chars, stats.out_tx_chars,
                resume.reconnects, stats.speaker_markers, stats.deferral_acks,
                stats.tool_calls, stats.sc_fallbacks,
                stats.search_turns, stats.search_queries,
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
        #   current_speaker/pending_speaker: the currently-known speaker name
        #     and whether a marker for it is still owed. On a session swap,
        #     pending_speaker is RE-ARMED to current_speaker (current_speaker
        #     itself is left untouched) so the marker is re-sent into the new
        #     session -- it has no memory of the [SPEAKER: ...] context turn
        #     from before the swap, and the floor holder cannot change
        #     mid-session, so nothing else would ever prompt another marker.
        #     This also preserves a set_speaker that arrives DURING the
        #     reconnect gap (session is briefly None mid-swap): that already
        #     updates current_speaker/pending_speaker directly regardless of
        #     session state, and re-arming (instead of clearing) here means
        #     the later None -> new-session transition doesn't discard it.
        #   pending_ack: a deferral acknowledgment (Phase 4) owed to whoever
        #     tried to speak while the bot was replying. Unlike
        #     pending_speaker, this is NOT re-armed across a reconnect --
        #     it's a one-shot nudge tied to a specific moment, not durable
        #     conversational context, so it is simply dropped on a session
        #     swap rather than replayed into a session it was never meant for.
        _last_session = None
        _warned_send_failure = False
        _pending_stream_end = False
        current_speaker = None
        pending_speaker = None
        pending_ack = None
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
                pending_speaker = current_speaker   # re-arm: re-announce into the new session
                pending_ack = None                  # one-shot: do not replay into a new session
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
            if kind == "acknowledge_waiting":
                name = (ev.acknowledge_waiting.display_name or "").strip()
                if name:
                    pending_ack = name.replace("[", "").replace("]", "")
            elif kind == "set_speaker":
                name = (ev.set_speaker.display_name or "").strip()
                if not name:
                    # Explicit clear (Phase 4 floor release): without this the
                    # next speaker would inherit the previous speaker's
                    # identity instead of being re-announced.
                    current_speaker = None
                    pending_speaker = None
                elif name != current_speaker:
                    current_speaker = name
                    pending_speaker = name
            if pending_ack and session is not None:
                # Flushed in the SAME iteration it was latched -- unlike the
                # speaker marker, this does not wait for the next audio chunk.
                # It is never flushed in a LATER iteration: an ack latched
                # while session was None (mid-reconnect) is cleared by the
                # swap block above before this check is reached on the next
                # event. That drop is deliberate (see pending_ack in the
                # block comment); this note exists so nobody reads "as soon
                # as a session exists" as a promise the gap case is covered.
                try:
                    await session.send_client_content(
                        turns=types.Content(role="user", parts=[types.Part(
                            text=f"[SYSTEM: {pending_ack} tried to speak while you were replying. "
                                 f"Briefly let them know you noticed, in your own voice. "
                                 f"Do not answer anything else yet.]")]),
                        # turn_complete=True (NOT False like the speaker marker):
                        # we WANT a generated reply here -- this IS the
                        # acknowledgment.
                        turn_complete=True,
                    )
                    stats.deferral_acks += 1
                    logger.info("voice: acknowledged waiting speaker %s", pending_ack)
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "voice: failed to send deferral acknowledgment", exc_info=True)
                finally:
                    pending_ack = None
            if kind in ("acknowledge_waiting", "set_speaker"):
                continue
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
                    if pending_speaker:
                        # Out-of-band identity for the audio that follows.
                        # turn_complete=False -> conversational CONTEXT only: the
                        # model is not prompted to reply and does not read it
                        # aloud. Sent as late as possible (right before this
                        # speaker's first chunk) because send_realtime_input does
                        # not guarantee ordering against send_client_content.
                        # Defence in depth: the bot-side sanitizer
                        # (services/SpeakerNames.js) already strips bracket
                        # characters, but a user-controlled name is scrubbed
                        # again here so a `]` in the name can never escape the
                        # marker brackets even if that sanitizer is bypassed.
                        safe_speaker = pending_speaker.replace("[", "").replace("]", "")
                        await session.send_client_content(
                            turns=types.Content(role="user",
                                                parts=[types.Part(text=f"[SPEAKER: {safe_speaker}]")]),
                            turn_complete=False,
                        )
                        stats.speaker_markers += 1
                        logger.info("voice: speaker is now %s", pending_speaker)
                        pending_speaker = None
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

    async def _pump_server(self, session, emit, stats, resume, session_ref=None) -> None:
        # receive() ends per-turn on turn_complete; `_pump_server_loop` loops to
        # span the whole session (split out only so the tool-task cleanup below
        # wraps it; every exception still propagates through unchanged).
        #
        # How that loop REALLY terminates, verified against the installed
        # google-genai 2.17.0, re-verified by execution on 2.25.0 (2026-09-26;
        # requirements.txt pins >=; re-check on a bump):
        # `AsyncSession.receive()` (2.25.0 live.py:471-475) is
        # `while result := await self._receive():` over a `LiveServerMessage`.
        # That is a pydantic model with no `__bool__` and no `__len__`, so it
        # is ALWAYS truthy and the walrus condition can never end the loop.
        # `receive()` therefore has exactly two exits: the explicit `break`
        # after an "interaction complete" message (2.25: `interaction_status
        # == IDLE` when the server sets it, else `server_content.turn_complete`
        # -- this loop re-enters `receive()` either way), or an exception. And
        # EVERY connection close arrives as an exception -- clean 1000/1001 and
        # abnormal 1006/1011 alike -- because `_receive()` (2.25.0
        # live.py:555-562) funnels every `ConnectionClosed` into
        # `errors.APIError.raise_error(...)`.
        #
        # So against the SDK this generator NEVER completes without producing
        # at least one message: a closed session raises out of the `async for`
        # below, `converse` catches it, `_is_session_drop` classifies it, and
        # that is what makes the reconnect decision reachable at all.
        #
        # Which makes the `if not produced: break` guard at the bottom
        # UNREACHABLE in production. It is kept deliberately, and only as a
        # hot-spin fuse: this `while True` contains no await outside the
        # `async for`, so a `receive()` that returns without yielding would
        # spin with no suspension point and peg the event loop -- taking down
        # every session in the sidecar, not just this one. That is a much
        # worse failure than an early exit, and the guard costs one branch.
        #
        # What would make it reachable: google-genai changing `receive()` to
        # swallow `ConnectionClosed` and return (its own `_receive_loop` at
        # 2.25.0 live.py:520-540 already does exactly that for its internal loop), or
        # `LiveServerMessage` gaining a falsy `__bool__`/`__len__`. Either is
        # a silent behaviour change, which is why the branch logs at WARNING.
        #
        # Tool calls (sc-knowledge, spec §7): each function call is answered by
        # its OWN task so a lookup (up to the executor's 6s bound) never stops
        # this loop from reading audio/transcripts/GoAway/further tool calls.
        # The tasks are per-session: the `finally` below cancels every one
        # still in flight when this pump exits (session drop, reconnect, end)
        # -- in-flight calls are DROPPED, not replayed into a resumed session
        # (the new session never saw that call id). `session_ref` lets a task
        # confirm, at send time, that its session is still the live one.
        tool_tasks: dict = {}
        try:
            await self._pump_server_loop(session, emit, stats, resume, session_ref, tool_tasks)
        finally:
            # Cancel, don't await: reaping could wait on an MCP transport's
            # teardown and delay the reconnect this exit usually precedes.
            # Each task logs its own cancellation and re-raises it.
            outstanding = sorted(str(k) for k, t in tool_tasks.items() if not t.done())
            for t in list(tool_tasks.values()):
                t.cancel()
            tool_tasks.clear()
            if outstanding:
                logger.info(
                    "voice: Live session pump ended; dropped %d in-flight tool call(s) "
                    "(not replayed): %s", len(outstanding), ", ".join(outstanding))

    async def _pump_server_loop(self, session, emit, stats, resume, session_ref, tool_tasks) -> None:
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
                tc = getattr(msg, "tool_call", None)
                if tc is not None:
                    for fc in (getattr(tc, "function_calls", None) or []):
                        self._spawn_tool_call(session, session_ref, fc, stats, tool_tasks, emit)
                tcc = getattr(msg, "tool_call_cancellation", None)
                if tcc is not None:
                    for call_id in (getattr(tcc, "ids", None) or []):
                        task = tool_tasks.pop(call_id, None)
                        if task is not None and not task.done():
                            task.cancel()
                            logger.info("voice: tool_call id=%s cancelled by the model", call_id)
                        else:
                            logger.info("voice: tool_call id=%s cancellation for a call not in flight",
                                        call_id)
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
                _note_grounding(sc, stats)
                if getattr(sc, "turn_complete", False):
                    stats.turns += 1
                    queries = list(stats.turn_search_queries)
                    stats.turn_search_queries = {}
                    if queries:
                        stats.search_turns += 1
                        stats.search_queries += len(queries)
                    logger.info("voice: turn complete (#%d, audio_out=%d chunks/%dB so far, "
                                "search_queries=%d)",
                                stats.turns, stats.audio_out_chunks, stats.audio_out_bytes,
                                len(queries))
                    if queries:
                        # Full queries, never truncated (house rule).
                        logger.info("voice: web search (turn #%d): %s",
                                    stats.turns, " | ".join(queries))
                    await emit(voice_pb2.VoiceServerEvent(turn_complete=voice_pb2.TurnComplete()))
            if not produced:
                # Unreachable against google-genai's AsyncSession (see the long
                # note at the top of this method). WARNING, not DEBUG: if this
                # ever fires, the SDK close contract this whole bridge is built
                # on has changed, and the reconnect path -- which only runs off
                # a RAISED close -- has stopped being reachable.
                logger.warning(
                    "voice: session receive() returned without producing a message; the "
                    "google-genai close contract has changed (a close must always raise, "
                    "never return) -- ending the server pump instead of spinning. "
                    "Session resumption/reconnect is driven by the raised close and is "
                    "NOT reachable on this path.")
                break

    def _spawn_tool_call(self, session, session_ref, fc, stats, tool_tasks, emit=None) -> None:
        stats.tool_calls += 1
        key = getattr(fc, "id", None) or f"anon-{stats.tool_calls}"
        previous = tool_tasks.get(key)
        if previous is not None and not previous.done():
            previous.cancel()   # a re-issued id supersedes the earlier call
        name = getattr(fc, "name", None) or ""
        if self._control_enabled and name in CONTROL_TOOL_NAMES:
            # Local control tool: same per-call task machinery (cancellation,
            # CURRENT-session targeting, cleanup on pump exit), but answered
            # in-sidecar -- never the MCP executor, never unknown_tool.
            coro = self._answer_control_call(session, session_ref, fc, emit)
        else:
            coro = self._answer_tool_call(session, session_ref, fc)
        task = asyncio.create_task(coro)
        tool_tasks[key] = task

        def _forget(t, k=key):
            if tool_tasks.get(k) is t:
                del tool_tasks[k]
        task.add_done_callback(_forget)

    async def _answer_control_call(self, session, session_ref, fc, emit) -> None:
        """Answer an end_conversation/go_quiet call locally and tell the bot.

        The FunctionResponse (`{"ok": true, ...}`) lets the model speak its
        short confirmation; it goes only to the CURRENT session, exactly like
        an sc_* answer. The `Control` event is emitted FIRST and regardless of
        whether that response can be delivered: the user's request is real
        either way, the bot's handler is idempotent, and awaiting the send
        first let a hung send_tool_response delay (or, on pump teardown, lose)
        the command. The bot does not act on it until the model's reply turn
        has produced output and completed, so emitting early cannot cut the
        confirmation short."""
        name = getattr(fc, "name", None) or ""
        call_id = getattr(fc, "id", None)
        args = dict(getattr(fc, "args", None) or {})
        if name == END_CONVERSATION_TOOL:
            action, seconds = "end", 0
            result = {"ok": True, "action": "end"}
        else:
            action = "quiet"
            seconds = _quiet_seconds(args.get("minutes"))
            result = {"ok": True, "action": "quiet",
                      "minutes": (seconds / 60) if seconds else None}
        if emit is not None:
            await emit(voice_pb2.VoiceServerEvent(
                control=voice_pb2.Control(action=action, seconds=seconds)))
        logger.info("voice: control %s (%ds) via tool id=%s", action, seconds, call_id)
        if session_ref is not None and session_ref.session is not session:
            logger.info(
                "voice: control tool_call %s id=%s answered but its Live session is gone; "
                "dropping the response (control event already sent)", name, call_id)
        else:
            try:
                await session.send_tool_response(function_responses=[
                    types.FunctionResponse(id=call_id, name=name, response=result)])
            except Exception as e:  # noqa: BLE001 - the session is dying; the reconnect path owns that
                logger.warning(
                    "voice: control tool_call %s id=%s send_tool_response failed (%s: %s); "
                    "control event already sent", name, call_id, type(e).__name__, e)

    async def _answer_tool_call(self, session, session_ref, fc) -> None:
        name = getattr(fc, "name", None) or ""
        call_id = getattr(fc, "id", None)
        started = time.monotonic()
        try:
            if self._sc is None:
                # A tool call with no executor should be impossible (no
                # declarations are sent), but never leave the model hanging.
                result = {"error": "tools_unavailable",
                          "detail": "Star Citizen data tools are not available right now"}
            elif not name.startswith("sc_"):
                result = {"error": "unknown_tool", "detail": f"no such tool: {name}"}
            else:
                result = await self._sc.call(name, dict(getattr(fc, "args", None) or {}))
        except asyncio.CancelledError:
            logger.info("voice: tool_call %s id=%s -> cancelled (%dms)", name, call_id,
                        int((time.monotonic() - started) * 1000))
            raise
        except Exception as e:  # noqa: BLE001 - the executor never raises; belt and braces
            result = {"error": "tool_failed", "detail": f"{type(e).__name__}: {e}"}
        code = result.get("error") if isinstance(result, dict) else None
        outcome = code or "ok"
        ms = int((time.monotonic() - started) * 1000)
        # Target the CURRENT live session: after a reconnect the session this
        # call was issued on is dead, and the new one never saw this call id.
        if session_ref is not None and session_ref.session is not session:
            logger.info(
                "voice: tool_call %s id=%s -> %s (%dms) but its Live session is gone; "
                "dropping the response", name, call_id, outcome, ms)
            return
        try:
            await session.send_tool_response(function_responses=[
                types.FunctionResponse(id=call_id, name=name, response=result)])
        except Exception as e:  # noqa: BLE001 - the session is dying; the reconnect path owns that
            logger.warning("voice: tool_call %s id=%s -> %s (%dms) but send_tool_response failed (%s: %s)",
                           name, call_id, outcome, ms, type(e).__name__, e)
            return
        logger.info("voice: tool_call %s -> %s (%dms)", name, outcome, ms)
