# Voice Phase 2b: Session Longevity (context compression + session resumption) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a shared voice room stay open indefinitely instead of dying at Gemini Live's ~15-minute audio-token cap, and survive a server-initiated disconnect transparently — without the humans in the channel noticing.

**Architecture:** Two independent Gemini Live features, both configured in the Python voice sidecar's `LiveConnectConfig`. (1) **Context-window compression** (sliding window) keeps the context from overflowing as audio tokens accumulate (~25 tok/s), which is what caps audio-only sessions at ~15 min today. (2) **Session resumption** makes the server hand us a resumption *handle*; when the connection drops (or the server sends `GoAway` before terminating it), the sidecar reconnects with that handle and the conversation continues with its context intact. The reconnect is internal to `LiveBridge.converse()`: the bot's gRPC `request_iter`/`emit` stream and the `_pump_client` task survive across reconnects (a session *reference* is swapped underneath them), so the bot never sees a session end and no proto/bot-side change is needed.

**Tech Stack:** Python 3, `google-genai` SDK (`types.LiveConnectConfig`), `grpc.aio`, pytest + pytest-asyncio. **Sidecar-only** — no Node/bot changes, no proto changes.

**Spec:** `docs/superpowers/specs/2026-08-13-multi-user-voice-vad-rework-design.md` §5.6 (session length) and its §9 plumbing reference. This plan implements **only** §5.6; Phase 2a (multi-user, bot-side) and Phase 3 (model identity-awareness) are separate.

## Global Constraints

- **DO NOT DEPLOY.** The user has explicitly deferred deployment until they manually integration-test Phase 2a. This plan is code + tests only: no `docker build`, no `docker push`, no `kubectl`. Do not modify `k8s/overlays/deployed/` (gitignored, live config).
- **Branch:** `feat/voice-phase2b-session-longevity`, cut from `main` (never from a `fix/*` branch).
- **Sidecar-only:** touch `voice-sidecar/**` (+ tracked `k8s/voice/voice-deployment.yaml` env and root docs). Do NOT touch `services/`, `bot.js`, `proto/`, or `voice-sidecar/proto/` — resumption is transparent to the bot.
- **Model is `gemini-live-2.5-flash`** (`VOICE_LIVE_MODEL`), on the GEAP/Vertex backend.
- **Never truncate log messages.**
- **Tests must not make network calls** — always inject a fake session factory (the existing `tests/test_live_bridge.py` pattern).
- Run the sidecar suite from `voice-sidecar/`: `python3 -m pytest -v` (or `make test`). It must be fully green before each commit.
- Exact SDK field names (from the spec's §9 grounded reference — use verbatim):
  - `types.ContextWindowCompressionConfig(sliding_window=types.SlidingWindow(), trigger_tokens=<int>)`
  - `types.SessionResumptionConfig(handle=<str|None>)`
  - Server message fields: `msg.session_resumption_update` → `.new_handle`, `.resumable`; `msg.go_away` → `.time_left`.

---

## File Structure

- **Modify** `voice-sidecar/src/config.py` — three env-driven settings (compression trigger tokens, resumption toggle, max reconnects).
- **Modify** `voice-sidecar/src/live_bridge.py` — the whole change:
  - `_live_config(start, resumption_handle=None)` gains the compression + resumption blocks.
  - New `_ResumeState` (holds the latest handle + a `going_away` flag) and `_SessionRef` (mutable current-session holder).
  - `_pump_server` captures `session_resumption_update` / `go_away`.
  - `_pump_client` sends through `_SessionRef` and tolerates the brief reconnect gap.
  - `converse()` gains the reconnect loop (seed history only on the FIRST connect).
- **Modify** `voice-sidecar/tests/test_live_bridge.py` — config assertions, resumption/GoAway capture, and reconnect-loop tests (multi-session fake factory).
- **Modify** `k8s/voice/voice-deployment.yaml` (tracked manifest) — document the new env vars.
- **Modify** `CLAUDE.md` + `features.md` — document session longevity.

---

### Task 1: Config plumbing — env settings + `LiveConnectConfig` blocks

**Files:**
- Modify: `voice-sidecar/src/config.py`
- Modify: `voice-sidecar/src/live_bridge.py` (`LiveBridge.__init__`, `_live_config`)
- Test: `voice-sidecar/tests/test_live_bridge.py`, `voice-sidecar/tests/test_config.py`

**Interfaces:**
- Produces:
  - `Config` gains `context_compression_trigger_tokens: int` (env `VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS`, default `25000`), `session_resumption_enabled: bool` (env `VOICE_SESSION_RESUMPTION_ENABLED`, default `True`), `max_session_reconnects: int` (env `VOICE_MAX_SESSION_RECONNECTS`, default `5`).
  - `LiveBridge(session_factory, *, model, default_voice, compression_trigger_tokens=25000, resumption_enabled=True, max_reconnects=5)` — new keyword-only args with defaults so existing constructions still work.
  - `LiveBridge._live_config(start, resumption_handle=None) -> types.LiveConnectConfig` — same as today plus `context_window_compression` and (when enabled) `session_resumption`.

- [ ] **Step 1: Write the failing tests**

```python
# voice-sidecar/tests/test_live_bridge.py  (add)
from google.genai import types


def test_live_config_enables_compression_and_resumption():
    bridge = LiveBridge(_factory(FakeSession([])), model="m", default_voice="Puck")
    start = SimpleNamespace(voice_name="", system_prompt="", history=[], recall_context="")
    cfg = bridge._live_config(start)
    # sliding-window compression keeps audio-only sessions past the ~15 min cap
    assert cfg.context_window_compression is not None
    assert cfg.context_window_compression.sliding_window is not None
    assert cfg.context_window_compression.trigger_tokens == 25000
    # resumption requested with no handle on a first connect
    assert cfg.session_resumption is not None
    assert cfg.session_resumption.handle is None


def test_live_config_passes_resumption_handle_on_reconnect():
    bridge = LiveBridge(_factory(FakeSession([])), model="m", default_voice="Puck")
    start = SimpleNamespace(voice_name="", system_prompt="", history=[], recall_context="")
    cfg = bridge._live_config(start, resumption_handle="abc123")
    assert cfg.session_resumption.handle == "abc123"


def test_live_config_omits_resumption_when_disabled():
    bridge = LiveBridge(_factory(FakeSession([])), model="m", default_voice="Puck",
                        resumption_enabled=False)
    start = SimpleNamespace(voice_name="", system_prompt="", history=[], recall_context="")
    assert bridge._live_config(start).session_resumption is None
```

```python
# voice-sidecar/tests/test_config.py  (add)
def test_session_longevity_defaults(monkeypatch):
    for k in ("VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS", "VOICE_SESSION_RESUMPTION_ENABLED",
              "VOICE_MAX_SESSION_RECONNECTS"):
        monkeypatch.delenv(k, raising=False)
    c = load()
    assert c.context_compression_trigger_tokens == 25000
    assert c.session_resumption_enabled is True
    assert c.max_session_reconnects == 5


def test_session_resumption_can_be_disabled(monkeypatch):
    monkeypatch.setenv("VOICE_SESSION_RESUMPTION_ENABLED", "false")
    assert load().session_resumption_enabled is False
```

> Match `test_config.py`'s existing import style for `load`.

- [ ] **Step 2: Run to verify they fail**

Run (from `voice-sidecar/`): `python3 -m pytest tests/test_live_bridge.py tests/test_config.py -v`
Expected: FAIL — `TypeError` on the new kwarg / `AttributeError: context_window_compression is None` / missing Config fields.

- [ ] **Step 3: Add the Config fields**

In `voice-sidecar/src/config.py`, add to the dataclass and `load()`:

```python
    context_compression_trigger_tokens: int
    session_resumption_enabled: bool
    max_session_reconnects: int
```

```python
        # Sliding-window context compression: without it, audio-only Live
        # sessions die at ~15 min (audio accrues ~25 tokens/s). With it the
        # session is unbounded; the window trims oldest context past the trigger.
        context_compression_trigger_tokens=int(
            os.environ.get("VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS", "25000")),
        # Session resumption: the server hands us a handle; on a dropped/GoAway
        # connection we reconnect with it and keep the conversation's context.
        session_resumption_enabled=os.environ.get(
            "VOICE_SESSION_RESUMPTION_ENABLED", "true").lower() != "false",
        max_session_reconnects=int(os.environ.get("VOICE_MAX_SESSION_RECONNECTS", "5")),
```

- [ ] **Step 4: Extend `LiveBridge.__init__` and `_live_config`**

```python
    def __init__(self, session_factory, *, model, default_voice,
                 compression_trigger_tokens=25000, resumption_enabled=True,
                 max_reconnects=5):
        self._session_factory = session_factory
        self._model = model
        self._default_voice = default_voice
        self._compression_trigger_tokens = compression_trigger_tokens
        self._resumption_enabled = resumption_enabled
        self._max_reconnects = max_reconnects
```

In `_live_config`, change the signature to `def _live_config(self, start, resumption_handle=None) -> types.LiveConnectConfig:` and add these two fields to the returned `LiveConnectConfig(...)` (keep every existing field unchanged):

```python
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
```

- [ ] **Step 5: Wire the config through at the construction site**

Find where `LiveBridge(...)` is constructed (`voice-sidecar/src/server.py`) and pass the new settings from `Config`:

```python
        compression_trigger_tokens=cfg.context_compression_trigger_tokens,
        resumption_enabled=cfg.session_resumption_enabled,
        max_reconnects=cfg.max_session_reconnects,
```

Match the existing construction's style/variable names. If `test_server.py` constructs a `Config`, update that fixture with the three new fields.

- [ ] **Step 6: Run tests to green**

Run: `python3 -m pytest -v`
Expected: PASS (all sidecar tests, including the new ones).

- [ ] **Step 7: Commit**

```bash
git add voice-sidecar/src/config.py voice-sidecar/src/live_bridge.py voice-sidecar/src/server.py voice-sidecar/tests/
git commit -m "feat(voice): sidecar config for context compression + session resumption"
```

---

### Task 2: Capture the resumption handle and `GoAway` in `_pump_server`

**Files:**
- Modify: `voice-sidecar/src/live_bridge.py` (new `_ResumeState`; `_pump_server` signature + body)
- Test: `voice-sidecar/tests/test_live_bridge.py`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `class _ResumeState` with `__slots__ = ("handle", "going_away", "reconnects")`, initialized `handle=None, going_away=False, reconnects=0`.
  - `_pump_server(session, emit, stats, resume)` — same behavior as today, plus: a message carrying `session_resumption_update` with `resumable` truthy and a non-empty `new_handle` stores it on `resume.handle`; a message carrying `go_away` sets `resume.going_away = True` and logs `time_left`. Neither is forwarded to the bot (transparent).

- [ ] **Step 1: Write the failing tests**

```python
# voice-sidecar/tests/test_live_bridge.py (add)
from src.live_bridge import _ResumeState


def _resume_msg(handle, resumable=True):
    return SimpleNamespace(data=None, server_content=None,
                           session_resumption_update=SimpleNamespace(
                               new_handle=handle, resumable=resumable),
                           go_away=None)


def _go_away_msg(time_left="10s"):
    return SimpleNamespace(data=None, server_content=None,
                           session_resumption_update=None,
                           go_away=SimpleNamespace(time_left=time_left))


async def test_pump_server_captures_resumption_handle_and_go_away():
    session = FakeSession([_resume_msg("h-1"), _go_away_msg("5s")])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    resume = _ResumeState()
    out = []
    async def emit(ev): out.append(ev)
    task = asyncio.create_task(bridge._pump_server(session, emit, _SessionStatsForTest(), resume))
    await asyncio.sleep(0.05)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert resume.handle == "h-1"
    assert resume.going_away is True
    # neither is surfaced to the bot
    assert out == []


async def test_pump_server_ignores_non_resumable_update():
    session = FakeSession([_resume_msg("h-x", resumable=False)])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    resume = _ResumeState()
    async def emit(ev): pass
    task = asyncio.create_task(bridge._pump_server(session, emit, _SessionStatsForTest(), resume))
    await asyncio.sleep(0.05)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    assert resume.handle is None
```

> `_SessionStatsForTest()` = import and use the module's real `_SessionStats` (it's a plain counter object). Also update the existing `_msg()` helper so every fake message carries `session_resumption_update=None, go_away=None` (otherwise `getattr` on a `SimpleNamespace` without the attribute raises) — or rely on `getattr(msg, ..., None)` in the implementation, which is the existing defensive style. Prefer the `getattr(..., None)` implementation so old fakes keep working.

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest tests/test_live_bridge.py -v`
Expected: FAIL — `_ResumeState` does not exist / `_pump_server` takes 3 positional args.

- [ ] **Step 3: Add `_ResumeState`**

Next to `_SessionStats` in `live_bridge.py`:

```python
class _ResumeState:
    """Session-resumption bookkeeping shared across reconnects: the newest
    handle the server gave us, whether it warned of an imminent disconnect
    (GoAway), and how many times we've reconnected."""
    __slots__ = ("handle", "going_away", "reconnects")

    def __init__(self):
        self.handle = None
        self.going_away = False
        self.reconnects = 0
```

- [ ] **Step 4: Capture both messages in `_pump_server`**

Change the signature to `async def _pump_server(self, session, emit, stats, resume) -> None:` and, inside the `async for msg in session.receive():` loop, BEFORE the `sc = getattr(msg, "server_content", None)` block:

```python
                sru = getattr(msg, "session_resumption_update", None)
                if sru is not None and getattr(sru, "resumable", False) and getattr(sru, "new_handle", None):
                    resume.handle = sru.new_handle
                    logger.debug("voice: session resumption handle updated")
                ga = getattr(msg, "go_away", None)
                if ga is not None:
                    resume.going_away = True
                    logger.info("voice: server sent GoAway (time_left=%s); will resume with handle=%s",
                                getattr(ga, "time_left", "?"), bool(resume.handle))
```

- [ ] **Step 5: Update the existing `converse()` call site so the suite still runs**

`converse()` currently calls `self._pump_server(session, emit, stats)`. Add a `_ResumeState()` local in `converse()` and pass it: `self._pump_server(session, emit, stats, resume)`. (Task 3 replaces this with the full loop; this step only keeps the suite green.)

- [ ] **Step 6: Run tests to green**

Run: `python3 -m pytest -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add voice-sidecar/src/live_bridge.py voice-sidecar/tests/test_live_bridge.py
git commit -m "feat(voice): capture session-resumption handle + GoAway in the server pump"
```

---

### Task 3: Transparent reconnect loop in `converse()`

**Files:**
- Modify: `voice-sidecar/src/live_bridge.py` (`_SessionRef`, `_pump_client`, `converse`)
- Test: `voice-sidecar/tests/test_live_bridge.py`

**Interfaces:**
- Consumes: `_ResumeState` (Task 2), `_live_config(start, resumption_handle)` (Task 1).
- Produces:
  - `class _SessionRef` — `__slots__ = ("session",)`, `session=None` initially. A mutable holder so the long-lived `_pump_client` can keep sending through whatever session is current.
  - `_pump_client(request_iter, session_ref, stats)` — reads `session_ref.session` per event; if it is `None` (mid-reconnect) the audio chunk is dropped with a debug log; a send that raises during the reconnect window is logged and dropped, not raised.
  - `converse()` — opens sessions in a loop. History/recall is seeded **only on the first connect**. `_pump_client` is created ONCE, outside the loop, and is never cancelled between reconnects; `_pump_server` is per-session. The loop reconnects when the session ended without the client asking to stop, a resumption handle exists, and `resume.reconnects < self._max_reconnects`.

**This is the risky task.** The invariants that matter: (a) the bot's gRPC stream and `_pump_client` survive reconnects; (b) history is NEVER re-seeded on a resume (the resumed session already has the context — re-seeding would duplicate it); (c) a transparent reconnect emits NO `ErrorEvent` to the bot; (d) `pump_in` completing means the client asked to end → exit the loop.

- [ ] **Step 1: Write the failing reconnect tests**

```python
# voice-sidecar/tests/test_live_bridge.py (add)

class ClosingFakeSession(FakeSession):
    """A session whose receive() ENDS (rather than blocking), so the bridge
    observes a server-side session end and can decide to resume."""
    async def receive(self):
        for m in self._script:
            yield m
        return


def _multi_factory(sessions):
    """Yields a different session per `async with` — records the configs used."""
    seen = []
    it = iter(sessions)
    @contextlib.asynccontextmanager
    async def make(model, config):
        seen.append(config)
        yield next(it)
    make.configs = seen
    return make


async def test_reconnects_with_handle_and_does_not_reseed_history():
    s1 = ClosingFakeSession([_resume_msg("h-1")])   # gives a handle, then ends
    s2 = FakeSession([])                             # resumed session: blocks (stays open)
    factory = _multi_factory([s1, s2])
    bridge = LiveBridge(factory, model="m", default_voice="Puck")
    start = voice_pb2.SessionStart(user_id="u1", history=[
        voice_pb2.HistoryTurn(role="user", content="earlier question")])
    out = []
    async def emit(ev): out.append(ev)
    async def req_iter():
        yield voice_pb2.VoiceClientEvent(session_start=start)
        await asyncio.Event().wait()   # keep the client stream open across the reconnect
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.1)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    # reconnected: two sessions opened, second carried the handle
    assert len(factory.configs) == 2
    assert factory.configs[0].session_resumption.handle is None
    assert factory.configs[1].session_resumption.handle == "h-1"
    # history seeded ONLY on the first connect
    assert len(s1.seeded) == 1
    assert s2.seeded == []
    # transparent: no error surfaced to the bot
    assert not any(ev.WhichOneof("event") == "error" for ev in out)


async def test_no_reconnect_without_a_handle():
    s1 = ClosingFakeSession([])       # ends with no resumption handle
    s2 = FakeSession([])
    factory = _multi_factory([s1, s2])
    bridge = LiveBridge(factory, model="m", default_voice="Puck")
    ...  # drive as above
    assert len(factory.configs) == 1  # gave up rather than blind-reconnecting


async def test_reconnects_are_capped():
    # every session ends immediately but hands back a handle
    sessions = [ClosingFakeSession([_resume_msg(f"h-{i}")]) for i in range(10)]
    factory = _multi_factory(sessions)
    bridge = LiveBridge(factory, model="m", default_voice="Puck", max_reconnects=2)
    ...  # drive as above
    assert len(factory.configs) == 3   # initial + 2 reconnects, then stop
```

> Fill the `...` bodies with the same drive pattern as the first test. Keep the existing `_drive` helper for the older tests.

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m pytest tests/test_live_bridge.py -v`
Expected: FAIL — only one session is ever opened (no reconnect loop).

- [ ] **Step 3: Add `_SessionRef` and make `_pump_client` use it**

```python
class _SessionRef:
    """Mutable holder for the CURRENT Live session. `_pump_client` lives for the
    whole gRPC call and reads this each event, so a reconnect can swap the
    session underneath it without dropping the bot's stream."""
    __slots__ = ("session",)

    def __init__(self):
        self.session = None
```

Rewrite `_pump_client` to take `session_ref`:

```python
    async def _pump_client(self, request_iter, session_ref, stats) -> None:
        async for ev in request_iter:
            kind = ev.WhichOneof("event")
            if kind == "session_end":
                logger.info("voice: client requested session_end after %d audio chunk(s)",
                            stats.audio_in_chunks)
                return
            session = session_ref.session
            if session is None:
                # Mid-reconnect gap (typically well under a second): drop rather
                # than buffer -- stale audio would arrive after the resume as if
                # it were current speech.
                logger.debug("voice: dropping %s during session reconnect", kind)
                continue
            try:
                if kind == "audio":
                    stats.audio_in_chunks += 1
                    stats.audio_in_bytes += len(ev.audio.pcm)
                    await session.send_realtime_input(
                        audio=types.Blob(data=ev.audio.pcm, mime_type="audio/pcm;rate=16000"))
                elif kind == "audio_stream_end":
                    await session.send_realtime_input(audio_stream_end=True)
                    logger.debug("voice: signaled audio_stream_end")
            except Exception as e:  # noqa: BLE001
                # The session died under us; the reconnect loop will replace it.
                logger.debug("voice: send failed on a closing session (%s); dropping frame",
                             type(e).__name__)
```

- [ ] **Step 4: Restructure `converse()` into the reconnect loop**

Replace the body from `async with self._session_factory(...)` through the `for t in done:` re-raise with the loop below. Keep everything else (the session_start validation, the `_SessionStats`, the span, the `except`/`finally` blocks) unchanged.

```python
            resume = _ResumeState()
            session_ref = _SessionRef()
            pump_in = asyncio.create_task(self._pump_client(request_iter, session_ref, stats))
            client_done = False
            try:
                while True:
                    async with self._session_factory(
                            self._model, self._live_config(start, resume.handle)) as session:
                        session_ref.session = session
                        if resume.reconnects == 0:
                            # Seed history/recall ONLY on the first connect -- a
                            # resumed session already carries this context, so
                            # re-seeding would duplicate the conversation.
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
                        else:
                            logger.info("voice: resumed Live session (reconnect #%d); context carried by handle",
                                        resume.reconnects)

                        pump_out = asyncio.create_task(self._pump_server(session, emit, stats, resume))
                        try:
                            done, _pending = await asyncio.wait(
                                {pump_in, pump_out}, return_when=asyncio.FIRST_COMPLETED)
                        finally:
                            # Only the SERVER pump is per-session. pump_in must
                            # survive the reconnect (it owns the bot's stream);
                            # it is reaped in the outer finally.
                            if not pump_out.done():
                                pump_out.cancel()
                            await asyncio.gather(pump_out, return_exceptions=True)
                        session_ref.session = None
                        if pump_in in done:
                            client_done = True
                        for t in done:
                            exc = t.exception()
                            if exc:
                                raise exc
                    if client_done:
                        return
                    if not (self._resumption_enabled and resume.handle):
                        logger.info("voice: session ended with no resumption handle; not reconnecting")
                        return
                    if resume.reconnects >= self._max_reconnects:
                        logger.warning("voice: reached max reconnects (%d); ending session",
                                       self._max_reconnects)
                        return
                    resume.reconnects += 1
                    resume.going_away = False
                    logger.info("voice: reconnecting Live session with resumption handle (#%d)",
                                resume.reconnects)
            finally:
                if not pump_in.done():
                    pump_in.cancel()
                await asyncio.gather(pump_in, return_exceptions=True)
```

Also add the reconnect count to the span/end log in the existing `finally` block:

```python
            span.set_attribute("voice.reconnects", resume.reconnects)
```

and append `reconnects=%d` + `resume.reconnects` to the session END log line. (`resume` is defined inside `try`; hoist `resume = _ResumeState()` ABOVE the `try:` so the `finally` can always read it.)

- [ ] **Step 5: Run the reconnect tests**

Run: `python3 -m pytest tests/test_live_bridge.py -v`
Expected: PASS — reconnect with handle, no re-seed, no error emitted, no-handle case does not reconnect, cap respected.

- [ ] **Step 6: Run the whole sidecar suite**

Run: `python3 -m pytest -v`
Expected: PASS (all). Pay attention to the pre-existing tests (normal-close, audio_stream_end, seeding) — they must still pass unchanged in intent; adapt only their construction if a signature moved.

- [ ] **Step 7: Commit**

```bash
git add voice-sidecar/src/live_bridge.py voice-sidecar/tests/test_live_bridge.py
git commit -m "feat(voice): transparent Live session reconnect via resumption handle"
```

---

### Task 4: Manifest env + documentation

**Files:**
- Modify: `k8s/voice/voice-deployment.yaml` (tracked manifest — env only, NOT the gitignored deployed overlay)
- Modify: `CLAUDE.md` (Voice section), `features.md`

**Interfaces:** none (config surface + docs).

- [ ] **Step 1: Add the env vars to the tracked manifest**

In `k8s/voice/voice-deployment.yaml`, alongside the existing `VOICE_LIVE_MODEL` / `VOICE_DEFAULT_VOICE` env entries, add (matching the file's `{ name: ..., value: ... }` style) with a short comment:

```yaml
            # Session longevity: sliding-window context compression (without it
            # audio-only sessions die at ~15 min) + session resumption so a
            # dropped/GoAway connection reconnects transparently with context.
            - { name: VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS, value: "25000" }
            - { name: VOICE_SESSION_RESUMPTION_ENABLED, value: "true" }
            - { name: VOICE_MAX_SESSION_RECONNECTS, value: "5" }
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the Voice section, document: sliding-window **context compression** removes the ~15-minute audio-only session cap (audio accrues ~25 tok/s; trigger `VOICE_CONTEXT_COMPRESSION_TRIGGER_TOKENS`, default 25000); **session resumption** stores the server's handle and transparently reconnects on a dropped connection or a `GoAway` warning, re-seeding **nothing** (the handle carries the context) and surfacing no error to the bot — capped by `VOICE_MAX_SESSION_RECONNECTS` (default 5), disable with `VOICE_SESSION_RESUMPTION_ENABLED=false`. Note the brief mid-reconnect audio gap (frames are dropped, not buffered). Move "Live session-resumption / context-window compression (sessions cap ~15 min)" OUT of the deferred-follow-ups list. Add the three env vars to the sidecar-env list.

- [ ] **Step 3: Update `features.md`**

Add a bullet: long-running voice sessions — sliding-window context compression + transparent session resumption.

- [ ] **Step 4: Confirm scope and commit**

Run: `git diff --stat` — expect ONLY `k8s/voice/voice-deployment.yaml`, `CLAUDE.md`, `features.md`. Confirm `k8s/overlays/deployed/` is untouched.

```bash
git add k8s/voice/voice-deployment.yaml CLAUDE.md features.md
git commit -m "docs(voice): document session longevity (compression + resumption) + manifest env"
```

---

## Self-Review

**Spec coverage (§5.6):** context-window compression → Task 1. Session resumption (store handle, reconnect with it, 2 h validity is server-side) → Tasks 2-3. `GoAway` pre-disconnect warning → Task 2. Exact field names from the spec's §9 reference used verbatim in Tasks 1-2. ✓
**Out of scope (correctly):** Phase 2a multi-user (separate branch/PR), Phase 3 identity-awareness, Phase 4 deferral. No proto/bot changes — resumption is transparent by design. ✓
**Deployment:** explicitly excluded per the user's instruction; no build/push/kubectl step anywhere in this plan. ✓

**Placeholder scan:** The `...` in Task 3's Step 1 is an explicit instruction to reuse the drive pattern shown immediately above it in the same step, not an unspecified requirement. Test helper `_SessionStatsForTest` is defined by reference to the module's real `_SessionStats`.

**Type consistency:** `_ResumeState` (`handle`/`going_away`/`reconnects`) defined Task 2, consumed Tasks 2-3. `_SessionRef` (`session`) defined Task 3, consumed by `_pump_client` + `converse` in the same task. `_live_config(start, resumption_handle=None)` defined Task 1, called with the handle in Task 3. `_pump_server(session, emit, stats, resume)` signature changed in Task 2 and its `converse()` call site updated in the same task (Step 5) so the suite never sits red across a task boundary. `LiveBridge.__init__` kwargs (`compression_trigger_tokens`/`resumption_enabled`/`max_reconnects`) defined Task 1, consumed in Tasks 1 and 3.

**Known risk (flagged):** Task 3 restructures async task lifetimes. The specific hazards — cancelling `pump_in` between reconnects (must NOT), re-seeding on resume (must NOT), and an un-reaped `pump_out` — are each called out inline with the code that prevents them, and each has a test.
