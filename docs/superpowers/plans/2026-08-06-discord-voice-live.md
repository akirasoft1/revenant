# Discord Voice via Gemini Live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users talk to the bot in a Discord voice channel and hear it reply in real time — wake-word gated, driven by the Gemini Live API in a new dedicated sidecar, sharing one memory with text chat.

**Architecture:** A new stateless Python sidecar (`discord-article-bot-voice`) holds the Gemini Live WebSocket on the existing GEAP/Vertex auth and bridges audio + transcripts over a new bidirectional-streaming gRPC. The Node bot owns all Discord + audio work (join/leave, per-user Opus receive, wake-word gate via Porcupine, resampling, playback, a pure turn state machine) and all memory I/O (reads `RecallService` to seed the session, writes transcripts back to the Mongo message store).

**Tech Stack:** Node/discord.js 14 + `@discordjs/voice` + `prism-media` + `@picovoice/porcupine-node`; Python `google-genai` Live API + `grpc.aio`; gRPC (`@grpc/grpc-js` / `grpcio`); Jest + pytest.

## Global Constraints

- **Namespace `discord-article-bot`**; the bot container is named `bot`. Sidecar Deployment name: `discord-article-bot-voice`.
- **All images pinned to git short-SHA** — never `:latest`. Voice sidecar image: `mvilliger/discord-article-bot-voice:<sha>`.
- **Gemini runs only on GEAP/Vertex:** `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2`, `GOOGLE_CLOUD_LOCATION=global`, ADC via `GOOGLE_APPLICATION_CREDENTIALS=/var/secrets/genai/key.json` (reuse the `agent-genai-sa` Secret), `GEMINI_API_KEY=""` blanked. No consumer API.
- **Never echo secrets** to stdout/logs. **Never truncate log messages.**
- **`google-genai` pinned** (`>=1.33.0`); this sidecar does NOT use `google-adk` (no tools in v1).
- New slash commands must be added to `commands/slash/index.js` AND `scripts/registerCommands.js`, then registered by running that script.
- TDD throughout: failing test → minimal impl → green → commit. Sidecar pytest uses `asyncio_mode = "auto"` (no `@pytest.mark.asyncio` needed); import as `from src import ...`.
- Both proto copies stay in sync: `voice-sidecar/proto/voice.proto` (Python codegen source) and repo-root `proto/voice.proto` (Node loads this).

---

## File Structure

**New — voice sidecar (`voice-sidecar/`):**
- `proto/voice.proto` — the `discordbot.voice` contract (Converse + Health).
- `src/config.py` — frozen `Config` dataclass + `load()`.
- `src/tracing.py` — OTLP exporter setup (`service.name = discord-article-bot-voice`).
- `src/live_bridge.py` — `LiveBridge`: opens a Live session (injected factory) and bridges proto events ⇄ Live. The testable core.
- `src/server.py` — `VoiceServicer` (`Converse`, `Health`) + `serve()`.
- `src/voice_pb2.py`, `src/voice_pb2_grpc.py` — generated.
- `scripts/probe_live_model.py` — one-off reachability probe.
- `tests/` — `test_config.py`, `test_live_bridge.py`, `test_server.py`.
- `requirements.txt`, `pyproject.toml`, `Makefile`, `Dockerfile`.

**New — Node:**
- `proto/voice.proto` — repo-root copy for `@grpc/proto-loader`.
- `services/voice/audio.js` — pure PCM resamplers.
- `services/voice/wakeword.js` — Porcupine wrapper behind an injectable interface.
- `services/voice/VoiceSessionMachine.js` — pure turn state machine (idle/active/hot).
- `services/VoiceClient.js` — gRPC client (health poll + `converse()` stream).
- `services/VoiceService.js` — wiring adapter: Discord connection ↔ machine ↔ client ↔ memory.
- `commands/slash/voice.js` — `/voice join|leave`.

**Modified — Node:**
- `bot.js` — add `GatewayIntentBits.GuildVoiceStates`; instantiate `VoiceClient`/`VoiceService`; register the command.
- `config/config.js` — `voice:` block.
- `commands/slash/index.js`, `scripts/registerCommands.js` — export/register the command.
- `package.json` — voice deps.

**New — deploy (`k8s/voice/`, tracked, mirrors `k8s/sandbox/`):**
- `voice-deployment.yaml`, `voice-service.yaml`, `voice-networkpolicy.yaml`, `README.md`.

**Modified — docs:** `features.md`, `README.md`, `CLAUDE.md`.

---

## Task 1: Live-model reachability probe (de-risk gate)

Validate a Gemini Live audio model actually serves on GEAP `global` **before** building anything on top of it (the flash-model-404-at-`us-central1` lesson applies to Live too). This is a manual gate, not a unit test.

**Files:**
- Create: `voice-sidecar/scripts/probe_live_model.py`
- Create: `voice-sidecar/requirements-probe.txt` (just `google-genai>=1.33.0`)

- [ ] **Step 1: Write the probe script**

```python
# voice-sidecar/scripts/probe_live_model.py
"""Connect to a Gemini Live model on GEAP/Vertex and confirm it answers.
Run manually with the agent-genai SA creds; record the first model id that works.
Usage: GOOGLE_APPLICATION_CREDENTIALS=... GOOGLE_GENAI_USE_VERTEXAI=true \
       GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 GOOGLE_CLOUD_LOCATION=global \
       python scripts/probe_live_model.py [model_id]
"""
import asyncio
import os
import sys

from google import genai
from google.genai import types

CANDIDATES = [
    "gemini-live-2.5-flash",
    "gemini-2.0-flash-live-preview-04-09",
    "gemini-2.0-flash-live-001",
]


async def probe(model: str) -> bool:
    client = genai.Client()  # picks up GOOGLE_GENAI_USE_VERTEXAI + ADC from env
    config = types.LiveConnectConfig(response_modalities=["TEXT"])
    try:
        async with client.aio.live.connect(model=model, config=config) as session:
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text="say hi")]),
                turn_complete=True,
            )
            async for msg in session.receive():
                if msg.text:
                    print(f"OK  {model}: {msg.text!r}")
                    return True
        print(f"OK  {model}: connected, no text")
        return True
    except Exception as e:  # noqa: BLE001
        print(f"FAIL {model}: {type(e).__name__}: {e}")
        return False


async def main() -> None:
    models = [sys.argv[1]] if len(sys.argv) > 1 else CANDIDATES
    for m in models:
        if await probe(m):
            print(f"\nUSE THIS MODEL: {m}")
            return
    print("\nNo candidate model reachable on this project/location.")
    sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Run the probe manually**

```bash
cd voice-sidecar
python -m venv .venv && .venv/bin/pip install -r requirements-probe.txt
GOOGLE_APPLICATION_CREDENTIALS=$PWD/genai-sa-key.json \
GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_PROJECT=revenant-discord-bot-2 \
GOOGLE_CLOUD_LOCATION=global .venv/bin/python scripts/probe_live_model.py
```
Expected: one candidate prints `USE THIS MODEL: <id>`. **Record that id** — it becomes the `VOICE_LIVE_MODEL` default in Task 3. If all fail, STOP and revisit region/model availability before continuing.

- [ ] **Step 3: Commit**

```bash
git add voice-sidecar/scripts/probe_live_model.py voice-sidecar/requirements-probe.txt
git commit -m "feat(voice): Live-model reachability probe for GEAP"
```

---

## Task 2: voice.proto contract + codegen

**Files:**
- Create: `voice-sidecar/proto/voice.proto`
- Create: `proto/voice.proto` (repo-root copy, byte-identical)
- Create: `voice-sidecar/Makefile`
- Create: `voice-sidecar/requirements.txt` (minimal for codegen now; expanded in Task 3)
- Test: `voice-sidecar/tests/test_proto_import.py`, `__tests__/proto/voiceProto.test.js`

**Interfaces:**
- Produces: gRPC package `discordbot.voice`, service `Voice { Converse(stream VoiceClientEvent) returns (stream VoiceServerEvent); Health(HealthRequest) returns (HealthResponse); }`. Message field names (snake_case, `keepCase:true` on Node): `SessionStart{user_id, user_tag, channel_id, guild_id, system_prompt, recall_context, voice_name}`, `AudioChunk{pcm}`, `SessionEnd{}`, `Transcript{text}`, `TurnComplete{}`, `Interrupted{}`, `ErrorEvent{message}`, `HealthResponse{healthy}`. Oneofs: `VoiceClientEvent.event ∈ {session_start, audio, session_end}`, `VoiceServerEvent.event ∈ {audio, input_transcript, output_transcript, turn_complete, interrupted, error}`.

- [ ] **Step 1: Write the proto**

```proto
// voice-sidecar/proto/voice.proto  (also copy verbatim to repo-root proto/voice.proto)
syntax = "proto3";
package discordbot.voice;

service Voice {
  rpc Converse (stream VoiceClientEvent) returns (stream VoiceServerEvent);
  rpc Health (HealthRequest) returns (HealthResponse);
}

message HealthRequest {}
message HealthResponse { bool healthy = 1; }

message SessionStart {
  string user_id = 1;
  string user_tag = 2;
  string channel_id = 3;
  string guild_id = 4;
  string system_prompt = 5;
  string recall_context = 6;
  string voice_name = 7;
}
message AudioChunk { bytes pcm = 1; }
message SessionEnd {}
message Transcript { string text = 1; }
message TurnComplete {}
message Interrupted {}
message ErrorEvent { string message = 1; }

message VoiceClientEvent {
  oneof event {
    SessionStart session_start = 1;
    AudioChunk   audio         = 2;
    SessionEnd   session_end   = 3;
  }
}
message VoiceServerEvent {
  oneof event {
    AudioChunk   audio             = 1;
    Transcript   input_transcript  = 2;
    Transcript   output_transcript = 3;
    TurnComplete turn_complete      = 4;
    Interrupted  interrupted        = 5;
    ErrorEvent   error              = 6;
  }
}
```

- [ ] **Step 2: Write the Makefile (mirrors agent-sidecar)**

```makefile
# voice-sidecar/Makefile
.PHONY: protoc test
protoc:
	python3 -m grpc_tools.protoc -I proto \
	  --python_out=src --grpc_python_out=src proto/voice.proto
test:
	pytest -v
```

Create `voice-sidecar/requirements.txt` (minimal now — expanded in Task 3):
```
grpcio>=1.66.2
grpcio-tools>=1.66.2
protobuf>=5.27.2
pytest>=8.3.0
pytest-asyncio>=0.24.0
```

- [ ] **Step 3: Write the failing Python import test**

```python
# voice-sidecar/tests/test_proto_import.py
def test_voice_stubs_import_and_have_service():
    from src import voice_pb2, voice_pb2_grpc
    ev = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
    assert ev.session_start.user_id == "u"
    assert hasattr(voice_pb2_grpc, "VoiceServicer")
    assert hasattr(voice_pb2_grpc, "add_VoiceServicer_to_server")
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd voice-sidecar && python -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m pytest tests/test_proto_import.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.voice_pb2'` (stubs not generated yet). Note: also create `voice-sidecar/pyproject.toml` minimally now so pytest finds `src` — see Task 3 Step 1; if running before Task 3, add `[tool.pytest.ini_options]\npythonpath=["src"]\nasyncio_mode="auto"\ntestpaths=["tests"]`.

- [ ] **Step 5: Generate the stubs**

Run: `cd voice-sidecar && .venv/bin/python -m grpc_tools.protoc -I proto --python_out=src --grpc_python_out=src proto/voice.proto`

- [ ] **Step 6: Copy the proto to the repo root for Node**

```bash
cp voice-sidecar/proto/voice.proto proto/voice.proto
```

- [ ] **Step 7: Write the Node proto-load test**

```js
// __tests__/proto/voiceProto.test.js
const path = require('path');
const protoLoader = require('@grpc/proto-loader');
const grpc = require('@grpc/grpc-js');

test('voice.proto loads and exposes the Voice service', () => {
  const def = protoLoader.loadSync(path.join(__dirname, '..', '..', 'proto', 'voice.proto'), {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def).discordbot.voice;
  expect(typeof proto.Voice).toBe('function');
  expect(proto.Voice.service.Converse).toBeDefined();
  expect(proto.Voice.service.Converse.requestStream).toBe(true);
  expect(proto.Voice.service.Converse.responseStream).toBe(true);
});
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `cd voice-sidecar && .venv/bin/python -m pytest tests/test_proto_import.py -v` → PASS
Run (repo root): `npm test -- --testPathPatterns="voiceProto"` → PASS

- [ ] **Step 9: Commit**

```bash
git add voice-sidecar/proto/voice.proto proto/voice.proto voice-sidecar/Makefile \
  voice-sidecar/requirements.txt voice-sidecar/src/voice_pb2.py voice-sidecar/src/voice_pb2_grpc.py \
  voice-sidecar/tests/test_proto_import.py __tests__/proto/voiceProto.test.js
git commit -m "feat(voice): voice.proto contract + generated stubs (Python + Node)"
```

---

## Task 3: Voice sidecar scaffolding (config + tracing + packaging)

**Files:**
- Create: `voice-sidecar/src/config.py`, `voice-sidecar/src/tracing.py`
- Create/Modify: `voice-sidecar/pyproject.toml`, `voice-sidecar/requirements.txt`, `voice-sidecar/Dockerfile`
- Test: `voice-sidecar/tests/test_config.py`

**Interfaces:**
- Produces: `Config` (frozen dataclass) fields `grpc_listen_addr: str`, `voice_live_model: str`, `default_voice_name: str`, `otlp_endpoint: str | None`, `google_cloud_project: str | None`, `google_cloud_location: str | None`; `load() -> Config`; `tracing.setup(config: Config) -> None`.

- [ ] **Step 1: Write pyproject.toml and expand requirements.txt**

```toml
# voice-sidecar/pyproject.toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
pythonpath = ["src"]
```
Append to `voice-sidecar/requirements.txt`:
```
google-genai>=1.33.0
opentelemetry-api>=1.27.0
opentelemetry-sdk>=1.27.0
opentelemetry-exporter-otlp>=1.27.0
```

- [ ] **Step 2: Write the failing config test**

```python
# voice-sidecar/tests/test_config.py
import os
from src import config as cfg

def test_load_defaults(monkeypatch):
    for k in ["GRPC_LISTEN_ADDR", "VOICE_LIVE_MODEL", "VOICE_DEFAULT_VOICE",
              "OTEL_EXPORTER_OTLP_ENDPOINT", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]:
        monkeypatch.delenv(k, raising=False)
    c = cfg.load()
    assert c.grpc_listen_addr == "0.0.0.0:50051"
    assert c.voice_live_model  # non-empty default
    assert c.default_voice_name  # non-empty default
    assert c.otlp_endpoint is None

def test_load_reads_env(monkeypatch):
    monkeypatch.setenv("VOICE_LIVE_MODEL", "gemini-live-x")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    c = cfg.load()
    assert c.voice_live_model == "gemini-live-x"
    assert c.otlp_endpoint == "http://collector:4318"
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd voice-sidecar && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.config'`.

- [ ] **Step 4: Write config.py** (use the model id recorded in Task 1 as the default; the placeholder below is `gemini-live-2.5-flash` — replace with the validated id)

```python
# voice-sidecar/src/config.py
import os
from dataclasses import dataclass

@dataclass(frozen=True)
class Config:
    grpc_listen_addr: str
    voice_live_model: str
    default_voice_name: str
    otlp_endpoint: str | None
    google_cloud_project: str | None
    google_cloud_location: str | None

def load() -> Config:
    return Config(
        grpc_listen_addr=os.environ.get("GRPC_LISTEN_ADDR", "0.0.0.0:50051"),
        voice_live_model=os.environ.get("VOICE_LIVE_MODEL", "gemini-live-2.5-flash"),
        default_voice_name=os.environ.get("VOICE_DEFAULT_VOICE", "Puck"),
        otlp_endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
        google_cloud_project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
        google_cloud_location=os.environ.get("GOOGLE_CLOUD_LOCATION"),
    )
```

- [ ] **Step 5: Write tracing.py**

```python
# voice-sidecar/src/tracing.py
"""OpenTelemetry exporter setup; no-op when no OTLP endpoint configured."""
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .config import Config

def setup(config: Config) -> None:
    resource = Resource.create({"service.name": "discord-article-bot-voice"})
    provider = TracerProvider(resource=resource)
    if config.otlp_endpoint:
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=config.otlp_endpoint))
        )
    trace.set_tracer_provider(provider)
```

- [ ] **Step 6: Write the Dockerfile** (mirrors agent-sidecar)

```dockerfile
# voice-sidecar/Dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ src/
COPY proto/ proto/
ENV PYTHONPATH=/app:/app/src
USER 1000
EXPOSE 50051
CMD ["python", "-m", "src.server"]
```

- [ ] **Step 7: Run the config test to verify it passes**

Run: `cd voice-sidecar && .venv/bin/python -m pytest tests/test_config.py -v` → PASS

- [ ] **Step 8: Commit**

```bash
git add voice-sidecar/src/config.py voice-sidecar/src/tracing.py voice-sidecar/pyproject.toml \
  voice-sidecar/requirements.txt voice-sidecar/Dockerfile voice-sidecar/tests/test_config.py
git commit -m "feat(voice): sidecar config, tracing, packaging"
```

---

## Task 4: LiveBridge (the sidecar core)

Bridges proto events ⇄ a Gemini Live session. The session is injected as a factory so tests use a fake — no network, no creds.

**Files:**
- Create: `voice-sidecar/src/live_bridge.py`
- Test: `voice-sidecar/tests/test_live_bridge.py`

**Interfaces:**
- Consumes: `voice_pb2` messages.
- Produces:
  - `class LiveBridge` with `__init__(self, session_factory, *, model, default_voice)` where `session_factory(model, config) -> async context manager` yielding an object with async `send_client_content(*, turns, turn_complete)`, async `send_realtime_input(*, audio)`, and `receive() -> async iterator` of objects exposing `.data: bytes | None` and `.server_content` (with `.input_transcription.text`, `.output_transcription.text`, `.turn_complete: bool`, `.interrupted: bool`, each possibly None).
  - `async def converse(self, request_iter, emit) -> None` — `request_iter` is an async iterator of `VoiceClientEvent`; `emit` is `async (VoiceServerEvent) -> None`. Reads the leading `session_start`, opens the session (seeding `recall_context` + `system_prompt`), then concurrently pumps client audio in and server messages out until `session_end` or `request_iter` ends.

- [ ] **Step 1: Write failing tests**

```python
# voice-sidecar/tests/test_live_bridge.py
import asyncio
import contextlib
from types import SimpleNamespace

from src import voice_pb2
from src.live_bridge import LiveBridge


class FakeSession:
    def __init__(self, script):
        self._script = script            # list of server msgs to yield on first receive()
        self.sent_audio = []
        self.seeded = []

    async def send_client_content(self, *, turns, turn_complete):
        self.seeded.append((turns, turn_complete))

    async def send_realtime_input(self, *, audio):
        self.sent_audio.append(audio)

    async def receive(self):
        for m in self._script:
            yield m
        # after the scripted turn, block so the bridge exits via session_end instead
        await asyncio.Event().wait()


def _msg(*, data=None, in_tx=None, out_tx=None, turn_complete=False, interrupted=False):
    sc = SimpleNamespace(
        input_transcription=SimpleNamespace(text=in_tx) if in_tx else None,
        output_transcription=SimpleNamespace(text=out_tx) if out_tx else None,
        turn_complete=turn_complete, interrupted=interrupted,
    )
    return SimpleNamespace(data=data, server_content=sc)


def _factory(session):
    @contextlib.asynccontextmanager
    async def make(model, config):
        yield session
    return make


async def _drive(bridge, client_events, session):
    out = []
    async def emit(ev): out.append(ev)
    async def req_iter():
        for e in client_events:
            yield e
    task = asyncio.create_task(bridge.converse(req_iter(), emit))
    await asyncio.sleep(0.05)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    return out


async def test_seeds_recall_and_forwards_audio_and_transcripts():
    session = FakeSession([
        _msg(in_tx="hello there"),
        _msg(data=b"\x01\x02", out_tx="hi back"),
        _msg(turn_complete=True),
    ])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(
        user_id="u", system_prompt="be nice", recall_context="past chat", voice_name="Kore"))
    audio = voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"\xaa\xbb"))
    out = await _drive(bridge, [start, audio], session)

    assert session.seeded, "recall/system prompt must be seeded via send_client_content"
    assert session.sent_audio == [b"\xaa\xbb"]
    kinds = [e.WhichOneof("event") for e in out]
    assert "input_transcript" in kinds and "output_transcript" in kinds
    assert "audio" in kinds and "turn_complete" in kinds
    audio_out = next(e for e in out if e.WhichOneof("event") == "audio")
    assert audio_out.audio.pcm == b"\x01\x02"


async def test_maps_interrupted():
    session = FakeSession([_msg(interrupted=True)])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    start = voice_pb2.VoiceClientEvent(session_start=voice_pb2.SessionStart(user_id="u"))
    out = await _drive(bridge, [start], session)
    assert any(e.WhichOneof("event") == "interrupted" for e in out)


async def test_missing_session_start_emits_error():
    session = FakeSession([])
    bridge = LiveBridge(_factory(session), model="m", default_voice="Puck")
    audio = voice_pb2.VoiceClientEvent(audio=voice_pb2.AudioChunk(pcm=b"x"))
    out = await _drive(bridge, [audio], session)
    assert any(e.WhichOneof("event") == "error" for e in out)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd voice-sidecar && .venv/bin/python -m pytest tests/test_live_bridge.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.live_bridge'`.

- [ ] **Step 3: Implement live_bridge.py**

```python
# voice-sidecar/src/live_bridge.py
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
                done, pending = await asyncio.wait(
                    {pump_in, pump_out}, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
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
                await session.send_realtime_input(
                    audio=types.Blob(data=ev.audio.pcm, mime_type="audio/pcm;rate=16000"))
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd voice-sidecar && .venv/bin/python -m pytest tests/test_live_bridge.py -v` → PASS

- [ ] **Step 5: Commit**

```bash
git add voice-sidecar/src/live_bridge.py voice-sidecar/tests/test_live_bridge.py
git commit -m "feat(voice): LiveBridge — proto <-> Gemini Live session bridge"
```

---

## Task 5: VoiceServicer + serve()

**Files:**
- Create: `voice-sidecar/src/server.py`
- Test: `voice-sidecar/tests/test_server.py`

**Interfaces:**
- Consumes: `LiveBridge.converse`, `voice_pb2_grpc`.
- Produces: `class VoiceServicer(voice_pb2_grpc.VoiceServicer)` with `__init__(self, bridge=None)`, async `Health(request, context)`, async `Converse(request_iter, context)` (async generator yielding `VoiceServerEvent`). `serve()` builds config, tracing, a real `LiveBridge` (session_factory = `genai.Client().aio.live.connect`), starts a `grpc.aio` server with signal-based graceful shutdown.

- [ ] **Step 1: Write failing tests**

```python
# voice-sidecar/tests/test_server.py
import asyncio
import grpc
import pytest

from src import voice_pb2, voice_pb2_grpc
from src.server import VoiceServicer


async def _start(servicer):
    server = grpc.aio.server()
    voice_pb2_grpc.add_VoiceServicer_to_server(servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    return server, port


async def test_health_ok():
    server, port = await _start(VoiceServicer())
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as ch:
            stub = voice_pb2_grpc.VoiceStub(ch)
            resp = await stub.Health(voice_pb2.HealthRequest())
            assert resp.healthy is True
    finally:
        await server.stop(grace=0)


class _EchoBridge:
    async def converse(self, request_iter, emit):
        async for ev in request_iter:
            if ev.WhichOneof("event") == "session_start":
                await emit(voice_pb2.VoiceServerEvent(
                    output_transcript=voice_pb2.Transcript(text="started")))
                return


async def test_converse_streams_from_bridge():
    server, port = await _start(VoiceServicer(bridge=_EchoBridge()))
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as ch:
            stub = voice_pb2_grpc.VoiceStub(ch)
            call = stub.Converse(iter([voice_pb2.VoiceClientEvent(
                session_start=voice_pb2.SessionStart(user_id="u"))]))
            got = [ev async for ev in call]
            assert any(e.WhichOneof("event") == "output_transcript" for e in got)
    finally:
        await server.stop(grace=0)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd voice-sidecar && .venv/bin/python -m pytest tests/test_server.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.server'`.

- [ ] **Step 3: Implement server.py**

```python
# voice-sidecar/src/server.py
import asyncio
import logging
import signal

import grpc

from . import voice_pb2, voice_pb2_grpc
from .config import load as load_config
from .tracing import setup as setup_tracing

logger = logging.getLogger(__name__)


class VoiceServicer(voice_pb2_grpc.VoiceServicer):
    def __init__(self, bridge=None) -> None:
        self._bridge = bridge

    async def Health(self, request, context):  # noqa: N802
        return voice_pb2.HealthResponse(healthy=True)

    async def Converse(self, request_iter, context):  # noqa: N802
        if self._bridge is None:
            await context.abort(grpc.StatusCode.UNIMPLEMENTED, "Voice bridge not configured")
            return
        queue: asyncio.Queue = asyncio.Queue()
        _DONE = object()

        async def emit(server_event) -> None:
            await queue.put(server_event)

        async def run() -> None:
            try:
                await self._bridge.converse(request_iter, emit)
            finally:
                await queue.put(_DONE)

        task = asyncio.create_task(run())
        try:
            while True:
                item = await queue.get()
                if item is _DONE:
                    break
                yield item
        finally:
            task.cancel()


def _build_bridge(config):
    from google import genai  # lazy: keep google-genai out of unit-test imports
    from .live_bridge import LiveBridge

    client = genai.Client()  # GOOGLE_GENAI_USE_VERTEXAI + ADC from env

    def session_factory(model, live_config):
        return client.aio.live.connect(model=model, config=live_config)

    return LiveBridge(session_factory, model=config.voice_live_model,
                      default_voice=config.default_voice_name)


def serve() -> None:
    logging.basicConfig(level=logging.INFO)
    config = load_config()
    setup_tracing(config)
    bridge = _build_bridge(config)

    async def _run() -> None:
        server = grpc.aio.server()
        voice_pb2_grpc.add_VoiceServicer_to_server(VoiceServicer(bridge=bridge), server)
        server.add_insecure_port(config.grpc_listen_addr)
        await server.start()
        logger.info("voice sidecar listening on %s", config.grpc_listen_addr)

        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop_event.set)
        try:
            await stop_event.wait()
        finally:
            await server.stop(grace=10)

    asyncio.run(_run())


if __name__ == "__main__":
    serve()
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd voice-sidecar && .venv/bin/python -m pytest -v` → all PASS

- [ ] **Step 5: Commit**

```bash
git add voice-sidecar/src/server.py voice-sidecar/tests/test_server.py
git commit -m "feat(voice): VoiceServicer + grpc.aio serve()"
```

---

## Task 6: Node audio transforms (pure)

Discord decodes to 48 kHz stereo s16le PCM; Live wants 16 kHz mono in and returns 24 kHz mono; Discord playback (`StreamType.Raw`) wants 48 kHz stereo. Two pure functions, fully unit-testable.

**Files:**
- Create: `services/voice/audio.js`
- Test: `__tests__/services/voice/audio.test.js`

**Interfaces:**
- Produces:
  - `downsampleTo16kMono(buf48kStereo: Buffer) -> Buffer` — stereo→mono average, then 3:1 decimation (48000/16000). Input length must be a multiple of 4 bytes (2 ch × 2 bytes); output is 16-bit mono LE.
  - `upsample24kMonoTo48kStereo(buf24kMono: Buffer) -> Buffer` — 2× linear upsample, then mono→stereo duplicate. Output is 16-bit stereo LE.
  - `FRAME_SAMPLES_16K = 512` (Porcupine frame length constant, re-exported for the wake-word framing).

- [ ] **Step 1: Write failing tests**

```js
// __tests__/services/voice/audio.test.js
const { downsampleTo16kMono, upsample24kMonoTo48kStereo, FRAME_SAMPLES_16K } =
  require('../../../services/voice/audio');

function pcm(samples) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}
function samples(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

describe('downsampleTo16kMono', () => {
  test('collapses stereo to mono and decimates 3:1', () => {
    // 6 stereo frames (L,R) -> mono avg -> 2 output samples (6/3)
    const stereo = pcm([100, 200, 0, 0, 0, 0, 400, 600, 0, 0, 0, 0]);
    const out = samples(downsampleTo16kMono(stereo));
    expect(out.length).toBe(2);           // 6 mono samples decimated by 3
    expect(out[0]).toBe(150);             // avg(100,200) from first frame
    expect(out[1]).toBe(500);             // avg(400,600) from fourth frame
  });

  test('output byte length is input/6', () => {
    const stereo = Buffer.alloc(48 * 4);  // 48 stereo frames
    expect(downsampleTo16kMono(stereo).length).toBe((48 / 3) * 2);
  });
});

describe('upsample24kMonoTo48kStereo', () => {
  test('doubles sample count and duplicates to stereo', () => {
    const mono = pcm([1000, 2000]);
    const out = samples(upsample24kMonoTo48kStereo(mono));
    // 2 mono -> 4 mono (2x) -> 8 values (stereo). L==R for each.
    expect(out.length).toBe(8);
    expect(out[0]).toBe(out[1]);          // first output frame L==R
  });
});

test('FRAME_SAMPLES_16K is 512', () => {
  expect(FRAME_SAMPLES_16K).toBe(512);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns="voice/audio"`
Expected: FAIL — cannot find module `services/voice/audio`.

- [ ] **Step 3: Implement audio.js**

```js
// services/voice/audio.js
'use strict';

const FRAME_SAMPLES_16K = 512; // Porcupine frame length @ 16 kHz

/** 48 kHz stereo s16le -> 16 kHz mono s16le (stereo avg, then 3:1 decimation). */
function downsampleTo16kMono(buf) {
  const stereoFrames = Math.floor(buf.length / 4); // 2 ch * 2 bytes
  const mono = new Int16Array(stereoFrames);
  for (let i = 0; i < stereoFrames; i++) {
    const l = buf.readInt16LE(i * 4);
    const r = buf.readInt16LE(i * 4 + 2);
    mono[i] = (l + r) >> 1;
  }
  const outLen = Math.floor(stereoFrames / 3);
  const out = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) out.writeInt16LE(mono[i * 3], i * 2);
  return out;
}

/** 24 kHz mono s16le -> 48 kHz stereo s16le (2x linear upsample, duplicate to stereo). */
function upsample24kMonoTo48kStereo(buf) {
  const inSamples = Math.floor(buf.length / 2);
  const out = Buffer.alloc(inSamples * 2 * 2 * 2); // 2x samples, 2 channels, 2 bytes
  let w = 0;
  for (let i = 0; i < inSamples; i++) {
    const cur = buf.readInt16LE(i * 2);
    const next = i + 1 < inSamples ? buf.readInt16LE((i + 1) * 2) : cur;
    const mid = (cur + next) >> 1;
    for (const s of [cur, mid]) {
      out.writeInt16LE(s, w); out.writeInt16LE(s, w + 2); w += 4; // L,R
    }
  }
  return out;
}

module.exports = { downsampleTo16kMono, upsample24kMonoTo48kStereo, FRAME_SAMPLES_16K };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --testPathPatterns="voice/audio"` → PASS

- [ ] **Step 5: Commit**

```bash
git add services/voice/audio.js __tests__/services/voice/audio.test.js
git commit -m "feat(voice): PCM resamplers (48k stereo <-> 16k/24k mono)"
```

---

## Task 7: Node VoiceClient (gRPC)

Mirrors `services/AgentClient.js`: proto load, health poll + `isHealthy()`, and a `converse()` that opens the bidi stream and surfaces server events as named EventEmitter events.

**Files:**
- Create: `services/VoiceClient.js`
- Test: `__tests__/services/VoiceClient.test.js`

**Interfaces:**
- Consumes: `proto/voice.proto`.
- Produces: `class VoiceClient` — `constructor({ address, protoPath, healthIntervalMs=5000, unhealthyThresholdMs=30000, healthDeadlineMs=2000 })`; `isHealthy(): boolean`; `converse(): VoiceSession` where `VoiceSession` is an `EventEmitter` with `sendStart({userId,userTag,channelId,guildId,systemPrompt,recallContext,voiceName})`, `sendAudio(buf: Buffer)`, `end()`, and emits `'audio'(Buffer)`, `'inputTranscript'(string)`, `'outputTranscript'(string)`, `'turnComplete'`, `'interrupted'`, `'error'(Error)`, `'end'`; `close()`.

- [ ] **Step 1: Write failing tests** (model on `__tests__/services/AgentClient.test.js`)

```js
// __tests__/services/VoiceClient.test.js
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const path = require('path');
const VoiceClient = require('../../services/VoiceClient');

const PROTO = path.join(__dirname, '..', '..', 'proto', 'voice.proto');

function makeClient() {
  return new VoiceClient({ address: '127.0.0.1:0', protoPath: PROTO });
}

describe('VoiceClient', () => {
  test('isHealthy false before any successful health check', () => {
    const c = makeClient();
    c._lastHealthyAt = 0;
    expect(c.isHealthy()).toBe(false);
    c.close();
  });

  test('converse maps server events to emitter events', (done) => {
    const c = makeClient();
    // Fake the underlying bidi call.
    const { EventEmitter } = require('events');
    const fakeCall = new EventEmitter();
    fakeCall.write = jest.fn();
    fakeCall.end = jest.fn();
    c._stub = { Converse: () => fakeCall, Health: (r, o, cb) => cb(null, { healthy: true }) };

    const session = c.converse();
    const seen = {};
    session.on('outputTranscript', (t) => { seen.out = t; });
    session.on('audio', (b) => { seen.audio = b; });
    session.on('turnComplete', () => {
      expect(seen.out).toBe('hi');
      expect(Buffer.isBuffer(seen.audio)).toBe(true);
      c.close(); done();
    });

    session.sendStart({ userId: 'u' });
    expect(fakeCall.write).toHaveBeenCalled();
    fakeCall.emit('data', { output_transcript: { text: 'hi' }, event: 'output_transcript' });
    fakeCall.emit('data', { audio: { pcm: Buffer.from([1, 2]) }, event: 'audio' });
    fakeCall.emit('data', { turn_complete: {}, event: 'turn_complete' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns="VoiceClient"`
Expected: FAIL — cannot find module `services/VoiceClient`.

- [ ] **Step 3: Implement VoiceClient.js**

```js
// services/VoiceClient.js
'use strict';
const { EventEmitter } = require('events');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const logger = require('../logger');

class VoiceClient {
  constructor({ address, protoPath, healthIntervalMs = 5000, unhealthyThresholdMs = 30000,
                healthDeadlineMs = 2000 }) {
    this.unhealthyThresholdMs = unhealthyThresholdMs;
    this.healthDeadlineMs = healthDeadlineMs;
    this._lastHealthyAt = 0;
    this._wasHealthy = null;
    const def = protoLoader.loadSync(protoPath, {
      keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
    const proto = grpc.loadPackageDefinition(def).discordbot.voice;
    this._stub = new proto.Voice(address, grpc.credentials.createInsecure());
    this._healthTimer = setInterval(() => this._healthCheck(), healthIntervalMs);
    if (this._healthTimer.unref) this._healthTimer.unref();
    this._healthCheck();
  }

  _healthCheck() {
    const deadline = new Date(Date.now() + this.healthDeadlineMs);
    this._stub.Health({}, { deadline }, (err) => {
      if (!err) {
        this._lastHealthyAt = Date.now();
        if (this._wasHealthy === false) logger.info('voice sidecar healthy');
        this._wasHealthy = true;
      } else {
        if (this._wasHealthy === true) logger.warn(`voice sidecar unhealthy: ${err.message}`);
        this._wasHealthy = false;
      }
    });
  }

  isHealthy() {
    return Date.now() - this._lastHealthyAt < this.unhealthyThresholdMs;
  }

  converse() {
    const call = this._stub.Converse();
    const session = new EventEmitter();
    call.on('data', (ev) => {
      switch (ev.event) {
        case 'audio': session.emit('audio', Buffer.from(ev.audio.pcm)); break;
        case 'input_transcript': session.emit('inputTranscript', ev.input_transcript.text); break;
        case 'output_transcript': session.emit('outputTranscript', ev.output_transcript.text); break;
        case 'turn_complete': session.emit('turnComplete'); break;
        case 'interrupted': session.emit('interrupted'); break;
        case 'error': session.emit('error', new Error(ev.error.message)); break;
        default: break;
      }
    });
    call.on('error', (err) => session.emit('error', err));
    call.on('end', () => session.emit('end'));

    session.sendStart = (s) => call.write({ session_start: {
      user_id: s.userId || '', user_tag: s.userTag || '', channel_id: s.channelId || '',
      guild_id: s.guildId || '', system_prompt: s.systemPrompt || '',
      recall_context: s.recallContext || '', voice_name: s.voiceName || '' } });
    session.sendAudio = (buf) => call.write({ audio: { pcm: buf } });
    session.end = () => { try { call.write({ session_end: {} }); } catch (_) { /* closed */ } call.end(); };
    return session;
  }

  close() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    if (this._stub && this._stub.close) this._stub.close();
  }
}

module.exports = VoiceClient;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --testPathPatterns="VoiceClient"` → PASS

- [ ] **Step 5: Commit**

```bash
git add services/VoiceClient.js __tests__/services/VoiceClient.test.js
git commit -m "feat(voice): VoiceClient gRPC stream wrapper"
```

---

## Task 8: Wake-word detector wrapper

Wrap Porcupine behind a tiny injectable interface so `VoiceService` depends on the interface, not the native lib. Frame-buffers 16 kHz PCM into 512-sample frames.

**Files:**
- Create: `services/voice/wakeword.js`
- Test: `__tests__/services/voice/wakeword.test.js`

**Interfaces:**
- Produces:
  - `class WakeWordGate` — `constructor(engine)` where `engine` has `frameLength: number` and `process(Int16Array) -> number` (index ≥ 0 on detection, −1 otherwise). Method `push(pcmBuf: Buffer) -> boolean` — buffers bytes, processes each full frame, returns `true` if any frame detected the keyword. `reset()` clears the buffer.
  - `createPorcupineEngine({ accessKey, keyword, sensitivity }) -> engine` — real engine (constructs `Porcupine`); imported lazily so tests don't need the native module.

- [ ] **Step 1: Write failing tests**

```js
// __tests__/services/voice/wakeword.test.js
const { WakeWordGate } = require('../../../services/voice/wakeword');

class FakeEngine {
  constructor(detectAtCall) { this.frameLength = 4; this._n = 0; this._at = detectAtCall; }
  process() { this._n += 1; return this._n === this._at ? 0 : -1; }
}
function pcm(n) { return Buffer.alloc(n * 2); } // n samples of silence

test('detects on the frame where engine fires', () => {
  const gate = new WakeWordGate(new FakeEngine(2)); // fires on 2nd frame
  expect(gate.push(pcm(4))).toBe(false);            // frame 1
  expect(gate.push(pcm(4))).toBe(true);             // frame 2 -> detect
});

test('buffers partial frames across pushes', () => {
  const gate = new WakeWordGate(new FakeEngine(1));
  expect(gate.push(pcm(2))).toBe(false);            // half a frame, no process yet
  expect(gate.push(pcm(2))).toBe(true);             // completes frame 1 -> detect
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns="voice/wakeword"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement wakeword.js**

```js
// services/voice/wakeword.js
'use strict';

class WakeWordGate {
  constructor(engine) {
    this._engine = engine;
    this._frame = engine.frameLength;
    this._buf = new Int16Array(0);
  }

  push(pcmBuf) {
    const incoming = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.length / 2));
    const merged = new Int16Array(this._buf.length + incoming.length);
    merged.set(this._buf); merged.set(incoming, this._buf.length);

    let offset = 0;
    let detected = false;
    while (merged.length - offset >= this._frame) {
      const frame = merged.subarray(offset, offset + this._frame);
      if (this._engine.process(frame) >= 0) detected = true;
      offset += this._frame;
    }
    this._buf = merged.subarray(offset).slice(); // keep remainder
    return detected;
  }

  reset() { this._buf = new Int16Array(0); }
}

function createPorcupineEngine({ accessKey, keyword, sensitivity = 0.5 }) {
  // Lazy require so unit tests never load the native binding.
  const { Porcupine, BuiltinKeyword } = require('@picovoice/porcupine-node');
  const kw = BuiltinKeyword[keyword] !== undefined ? BuiltinKeyword[keyword] : keyword;
  return new Porcupine(accessKey, [kw], [sensitivity]);
}

module.exports = { WakeWordGate, createPorcupineEngine };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --testPathPatterns="voice/wakeword"` → PASS

- [ ] **Step 5: Commit**

```bash
git add services/voice/wakeword.js __tests__/services/voice/wakeword.test.js
git commit -m "feat(voice): wake-word gate with injectable engine"
```

---

## Task 9: VoiceSessionMachine (pure turn state machine)

The crown-jewel testable unit: all the tricky timing (follow-up window, barge-in, idle) with an injected clock and zero I/O.

**Files:**
- Create: `services/voice/VoiceSessionMachine.js`
- Test: `__tests__/services/voice/VoiceSessionMachine.test.js`

**Interfaces:**
- Produces: `class VoiceSessionMachine` — `constructor({ followupWindowMs = 15000, now = () => Date.now() })`; getter `state` ∈ `'idle' | 'active' | 'hot'`. Methods return an **array of action objects**:
  - `onWake()` → from `idle`: `[{ type: 'startSession' }]`, state→`active`. From `active`/`hot`: `[]`.
  - `onServerEvent({ type, pcm })` where `type` ∈ `audio|inputTranscript|outputTranscript|turnComplete|interrupted|error`:
    - `audio` → `[{ type: 'play', pcm }]`
    - `interrupted` → `[{ type: 'stopPlayback' }]`
    - `turnComplete` → from `active`: state→`hot`, `[{ type: 'armFollowup', atMs }]` where `atMs = now() + followupWindowMs`
    - `error` → state→`idle`, `[{ type: 'endSession' }, { type: 'notifyError' }]`
    - `inputTranscript`/`outputTranscript` → `[]` (service buffers text; machine only tracks control/timing)
  - `onUserSpeechStart()` → from `hot`: state→`active`, `[{ type: 'cancelFollowup' }]`. Else `[]`.
  - `onTick(nowMs)` → from `hot` when `nowMs >= atMs`: state→`idle`, `[{ type: 'endSession' }]`. Else `[]`.

- [ ] **Step 1: Write failing tests**

```js
// __tests__/services/voice/VoiceSessionMachine.test.js
const VoiceSessionMachine = require('../../../services/voice/VoiceSessionMachine');

function mk(nowRef) {
  return new VoiceSessionMachine({ followupWindowMs: 1000, now: () => nowRef.t });
}

test('wake from idle starts a session', () => {
  const now = { t: 0 };
  const m = mk(now);
  expect(m.state).toBe('idle');
  expect(m.onWake()).toEqual([{ type: 'startSession' }]);
  expect(m.state).toBe('active');
});

test('wake while active is a no-op', () => {
  const now = { t: 0 };
  const m = mk(now); m.onWake();
  expect(m.onWake()).toEqual([]);
  expect(m.state).toBe('active');
});

test('audio server event yields play', () => {
  const now = { t: 0 };
  const m = mk(now); m.onWake();
  expect(m.onServerEvent({ type: 'audio', pcm: Buffer.from([1]) }))
    .toEqual([{ type: 'play', pcm: Buffer.from([1]) }]);
});

test('interrupted stops playback', () => {
  const now = { t: 0 };
  const m = mk(now); m.onWake();
  expect(m.onServerEvent({ type: 'interrupted' })).toEqual([{ type: 'stopPlayback' }]);
});

test('turnComplete enters hot and arms the follow-up timer', () => {
  const now = { t: 500 };
  const m = mk(now); m.onWake();
  expect(m.onServerEvent({ type: 'turnComplete' })).toEqual([{ type: 'armFollowup', atMs: 1500 }]);
  expect(m.state).toBe('hot');
});

test('speaking during hot returns to active and cancels the timer', () => {
  const now = { t: 0 };
  const m = mk(now); m.onWake(); m.onServerEvent({ type: 'turnComplete' });
  expect(m.onUserSpeechStart()).toEqual([{ type: 'cancelFollowup' }]);
  expect(m.state).toBe('active');
});

test('tick after the window ends the session', () => {
  const now = { t: 0 };
  const m = mk(now); m.onWake(); m.onServerEvent({ type: 'turnComplete' }); // atMs=1000
  expect(m.onTick(999)).toEqual([]);
  expect(m.onTick(1000)).toEqual([{ type: 'endSession' }]);
  expect(m.state).toBe('idle');
});

test('error resets to idle and notifies', () => {
  const now = { t: 0 };
  const m = mk(now); m.onWake();
  expect(m.onServerEvent({ type: 'error' }))
    .toEqual([{ type: 'endSession' }, { type: 'notifyError' }]);
  expect(m.state).toBe('idle');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns="VoiceSessionMachine"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement VoiceSessionMachine.js**

```js
// services/voice/VoiceSessionMachine.js
'use strict';

class VoiceSessionMachine {
  constructor({ followupWindowMs = 15000, now = () => Date.now() } = {}) {
    this._followupWindowMs = followupWindowMs;
    this._now = now;
    this._state = 'idle';
    this._followupAt = null;
  }

  get state() { return this._state; }

  onWake() {
    if (this._state !== 'idle') return [];
    this._state = 'active';
    return [{ type: 'startSession' }];
  }

  onServerEvent(evt) {
    switch (evt.type) {
      case 'audio':
        return [{ type: 'play', pcm: evt.pcm }];
      case 'interrupted':
        return [{ type: 'stopPlayback' }];
      case 'turnComplete':
        if (this._state === 'active') {
          this._state = 'hot';
          this._followupAt = this._now() + this._followupWindowMs;
          return [{ type: 'armFollowup', atMs: this._followupAt }];
        }
        return [];
      case 'error':
        this._state = 'idle';
        this._followupAt = null;
        return [{ type: 'endSession' }, { type: 'notifyError' }];
      default:
        return []; // transcripts handled by the service
    }
  }

  onUserSpeechStart() {
    if (this._state === 'hot') {
      this._state = 'active';
      this._followupAt = null;
      return [{ type: 'cancelFollowup' }];
    }
    return [];
  }

  onTick(nowMs) {
    if (this._state === 'hot' && this._followupAt !== null && nowMs >= this._followupAt) {
      this._state = 'idle';
      this._followupAt = null;
      return [{ type: 'endSession' }];
    }
    return [];
  }
}

module.exports = VoiceSessionMachine;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --testPathPatterns="VoiceSessionMachine"` → PASS

- [ ] **Step 5: Commit**

```bash
git add services/voice/VoiceSessionMachine.js __tests__/services/voice/VoiceSessionMachine.test.js
git commit -m "feat(voice): pure turn state machine (idle/active/hot)"
```

---

## Task 10: VoiceService wiring adapter

Owns the Discord voice connection, drives the machine, and translates its actions into real side effects (stream audio, play, persist transcripts). All heavy collaborators are injected so it's unit-testable without Discord/Porcupine/gRPC.

**Files:**
- Create: `services/VoiceService.js`
- Test: `__tests__/services/VoiceService.test.js`

**Interfaces:**
- Consumes: `VoiceClient.converse()`, `VoiceSessionMachine`, `WakeWordGate`, `downsampleTo16kMono`, `RecallService.recall(...)`, `MongoService.recordChannelMessage(...)`, and discord voice primitives (injected via a `deps` object for testing).
- Produces: `class VoiceService` — `constructor({ voiceClient, recallService, mongoService, config, deps })`; `isEnabled(): boolean` (→ `config.voice.enabled`); `async join({ channel, guildId }): Promise<void>`; `async leave(guildId): Promise<void>`. `deps` supplies `{ joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, EndBehaviorType, opusDecoderFactory, makeWakeGate, now, setInterval, clearInterval }` so tests inject fakes.

- [ ] **Step 1: Write failing tests** (focus on the wiring contract, not Discord internals)

```js
// __tests__/services/VoiceService.test.js
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { EventEmitter } = require('events');
const VoiceService = require('../../services/VoiceService');

function makeDeps(overrides = {}) {
  const player = new EventEmitter(); player.play = jest.fn(); player.stop = jest.fn();
  const connection = new EventEmitter();
  connection.subscribe = jest.fn();
  connection.receiver = { subscribe: jest.fn(() => new EventEmitter()), speaking: new EventEmitter() };
  connection.destroy = jest.fn();
  return {
    joinVoiceChannel: jest.fn(() => connection),
    createAudioPlayer: jest.fn(() => player),
    createAudioResource: jest.fn((s) => ({ s })),
    StreamType: { Raw: 'raw' },
    EndBehaviorType: { AfterSilence: 1 },
    opusDecoderFactory: () => new EventEmitter(),
    makeWakeGate: () => ({ push: jest.fn(() => false), reset: jest.fn() }),
    now: () => 0,
    setInterval: jest.fn(() => 1),
    clearInterval: jest.fn(),
    ...overrides,
  };
}

function makeService(deps) {
  const voiceClient = { converse: jest.fn(() => {
    const s = new EventEmitter();
    s.sendStart = jest.fn(); s.sendAudio = jest.fn(); s.end = jest.fn();
    return s;
  }) };
  const recallService = { recall: jest.fn().mockResolvedValue({ block: 'past context' }) };
  const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue({}) };
  const config = { voice: { enabled: true, wakeWord: 'computer', liveVoice: 'Puck',
    followupWindowMs: 1000, idleTimeoutMs: 60000, maxSessions: 2 } };
  return { svc: new VoiceService({ voiceClient, recallService, mongoService, config, deps }),
           voiceClient, recallService, mongoService };
}

test('isEnabled reflects config', () => {
  const deps = makeDeps();
  const { svc } = makeService(deps);
  expect(svc.isEnabled()).toBe(true);
});

test('join creates a voice connection and a wake gate', async () => {
  const deps = makeDeps();
  const { svc } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  expect(deps.joinVoiceChannel).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'c1', guildId: 'g1' }));
});

test('leave destroys the connection', async () => {
  const deps = makeDeps();
  const { svc } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc.leave('g1');
  // connection.destroy is called via the stored connection
  expect(deps.joinVoiceChannel.mock.results[0].value.destroy).toHaveBeenCalled();
});

test('on wake, fetches recall and opens a converse session with seeded context', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() }; // fire immediately
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc, voiceClient, recallService } = makeService(deps);
  const conn = deps.joinVoiceChannel.mock.results;
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  // Simulate a user speaking: the receiver subscribe stream emits decoded PCM via the decoder.
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  expect(recallService.recall).toHaveBeenCalled();
  expect(voiceClient.converse).toHaveBeenCalled();
  const session = voiceClient.converse.mock.results[0].value;
  expect(session.sendStart).toHaveBeenCalledWith(expect.objectContaining({ recallContext: 'past context' }));
});

test('output transcript is persisted to the message store on turnComplete', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() };
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc, voiceClient, mongoService } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  const session = voiceClient.converse.mock.results[0].value;
  session.emit('inputTranscript', 'what is a hornet');
  session.emit('outputTranscript', 'a light fighter');
  session.emit('turnComplete');
  await new Promise((r) => setImmediate(r));
  expect(mongoService.recordChannelMessage).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns="VoiceService"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement VoiceService.js**

```js
// services/VoiceService.js
'use strict';
const logger = require('../logger');
const VoiceSessionMachine = require('./voice/VoiceSessionMachine');
const { downsampleTo16kMono } = require('./voice/audio');

class VoiceService {
  constructor({ voiceClient, recallService, mongoService, config, deps }) {
    this._client = voiceClient;
    this._recall = recallService;
    this._mongo = mongoService;
    this._config = config;
    this._deps = deps;
    this._guilds = new Map(); // guildId -> { connection, player, gate, machine, session, channelId, buffers, tickTimer, atMs }
  }

  isEnabled() { return !!(this._config.voice && this._config.voice.enabled); }

  async join({ channel, guildId }) {
    if (this._guilds.size >= this._config.voice.maxSessions && !this._guilds.has(guildId)) {
      throw new Error('voice session limit reached');
    }
    const d = this._deps;
    const connection = d.joinVoiceChannel({
      channelId: channel.id, guildId, adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: false });
    const player = d.createAudioPlayer();
    connection.subscribe(player);
    const gate = d.makeWakeGate();
    const machine = new VoiceSessionMachine({
      followupWindowMs: this._config.voice.followupWindowMs, now: d.now });
    const state = { connection, player, gate, machine, session: null,
      channelId: channel.id, buffers: { in: [], out: [] }, tickTimer: null };
    this._guilds.set(guildId, state);

    connection.receiver.speaking.on('start', (userId) => {
      const stream = connection.receiver.subscribe(userId, { end: { behavior: d.EndBehaviorType.AfterSilence, duration: 800 } });
      const decoder = d.opusDecoderFactory();
      stream.pipe(decoder);
      decoder.on('data', (pcm48) => this._handleUserPcm(guildId, userId, pcm48));
    });

    state.tickTimer = d.setInterval(() => this._tick(guildId), 250);
    logger.info(`voice: joined channel ${channel.id} in guild ${guildId}`);
  }

  async _handleUserPcm(guildId, userId, pcm48Stereo) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const pcm16 = downsampleTo16kMono(pcm48Stereo);

    if (g.machine.state === 'idle') {
      if (g.gate.push(pcm16)) await this._apply(guildId, g.machine.onWake(), { userId });
      return;
    }
    // active/hot: barge-in signal + stream audio to the live session.
    await this._apply(guildId, g.machine.onUserSpeechStart(), { userId });
    if (g.session) g.session.sendAudio(pcm16);
  }

  async _apply(guildId, actions, ctx = {}) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    for (const a of actions) {
      switch (a.type) {
        case 'startSession': await this._startSession(guildId, ctx.userId); break;
        case 'play': this._play(g, a.pcm); break;
        case 'stopPlayback': g.player.stop(); break;
        case 'armFollowup': g.atMs = a.atMs; break;
        case 'cancelFollowup': g.atMs = null; break;
        case 'endSession': this._endSession(g); break;
        case 'notifyError': logger.warn(`voice: live error in guild ${guildId}`); break;
        default: break;
      }
    }
  }

  async _startSession(guildId, userId) {
    const g = this._guilds.get(guildId);
    if (!g || !this._client.isHealthy || !this._client.isHealthy()) {
      if (this._client.isHealthy && !this._client.isHealthy()) logger.warn('voice: sidecar unhealthy, ignoring wake');
    }
    let recallContext = '';
    try {
      const r = await this._recall.recall({ recentMessages: [], scope: { userId, channelId: g.channelId, personalityId: 'channel-voice' } });
      recallContext = (r && r.block) || '';
    } catch (e) { logger.warn(`voice: recall failed: ${e.message}`); }

    const session = this._client.converse();
    g.session = session;
    g.buffers = { in: [], out: [] };
    session.on('audio', (buf) => this._apply(guildId, g.machine.onServerEvent({ type: 'audio', pcm: buf })));
    session.on('inputTranscript', (t) => g.buffers.in.push(t));
    session.on('outputTranscript', (t) => g.buffers.out.push(t));
    session.on('interrupted', () => this._apply(guildId, g.machine.onServerEvent({ type: 'interrupted' })));
    session.on('turnComplete', () => {
      this._persistTurn(guildId).catch((e) => logger.warn(`voice: persist failed: ${e.message}`));
      this._apply(guildId, g.machine.onServerEvent({ type: 'turnComplete' }));
    });
    session.on('error', (e) => { logger.warn(`voice: session error: ${e.message}`); this._apply(guildId, g.machine.onServerEvent({ type: 'error' })); });

    session.sendStart({ userId, channelId: g.channelId, guildId,
      systemPrompt: this._config.voice.systemPrompt || '',
      recallContext, voiceName: this._config.voice.liveVoice });
  }

  _play(g, pcm24Mono) {
    const d = this._deps;
    const { upsample24kMonoTo48kStereo } = require('./voice/audio');
    const { Readable } = require('stream');
    const pcm48 = upsample24kMonoTo48kStereo(pcm24Mono);
    const resource = d.createAudioResource(Readable.from(pcm48), { inputType: d.StreamType.Raw });
    g.player.play(resource);
  }

  async _persistTurn(guildId) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const userText = g.buffers.in.join(' ').trim();
    const botText = g.buffers.out.join(' ').trim();
    g.buffers = { in: [], out: [] };
    const base = { channelId: g.channelId, guildId, timestamp: new Date(), source: 'voice' };
    if (userText) await this._mongo.recordChannelMessage({ ...base, authorId: 'voice-user', content: userText, isBot: false });
    if (botText) await this._mongo.recordChannelMessage({ ...base, authorId: 'bot', content: botText, isBot: true });
  }

  _tick(guildId) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    this._apply(guildId, g.machine.onTick(this._deps.now()));
  }

  _endSession(g) {
    if (g.session) { try { g.session.end(); } catch (_) { /* closed */ } g.session = null; }
  }

  async leave(guildId) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    if (g.tickTimer) this._deps.clearInterval(g.tickTimer);
    this._endSession(g);
    if (g.connection && g.connection.destroy) g.connection.destroy();
    this._guilds.delete(guildId);
    logger.info(`voice: left guild ${guildId}`);
  }
}

module.exports = VoiceService;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --testPathPatterns="VoiceService"` → PASS

- [ ] **Step 5: Commit**

```bash
git add services/VoiceService.js __tests__/services/VoiceService.test.js
git commit -m "feat(voice): VoiceService wiring adapter"
```

---

## Task 11: /voice slash command + config + deps + bot wiring

**Files:**
- Create: `commands/slash/voice.js`, `__tests__/commands/slash/voice.test.js`
- Modify: `commands/slash/index.js`, `scripts/registerCommands.js`, `config/config.js`, `bot.js`, `package.json`

**Interfaces:**
- Consumes: `VoiceService.isEnabled()`, `join()`, `leave()`.
- Produces: `VoiceSlashCommand` (subclass of `BaseSlashCommand`) — subcommands `join` / `leave`; resolves the caller's channel via `interaction.member.voice.channel`.

- [ ] **Step 1: Write the failing slash-command test**

```js
// __tests__/commands/slash/voice.test.js
const VoiceSlashCommand = require('../../../commands/slash/voice');

function fakeInteraction({ inChannel = true, sub = 'join' } = {}) {
  return {
    user: { id: 'u1', tag: 'u#1' },
    guildId: 'g1',
    member: { voice: { channel: inChannel ? { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } } : null } },
    options: { getSubcommand: () => sub },
    deferred: false, replied: false,
    reply: jest.fn().mockResolvedValue({}), editReply: jest.fn().mockResolvedValue({}),
    followUp: jest.fn().mockResolvedValue({}),
  };
}

describe('/voice', () => {
  let voiceService, command;
  beforeEach(() => {
    voiceService = { isEnabled: jest.fn(() => true), join: jest.fn().mockResolvedValue(), leave: jest.fn().mockResolvedValue() };
    command = new VoiceSlashCommand(voiceService);
  });

  test('disabled feature short-circuits', async () => {
    voiceService.isEnabled.mockReturnValue(false);
    const i = fakeInteraction();
    await command.execute(i, {});
    expect(voiceService.join).not.toHaveBeenCalled();
  });

  test('join with caller in a channel joins it', async () => {
    const i = fakeInteraction({ inChannel: true, sub: 'join' });
    await command.execute(i, {});
    expect(voiceService.join).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'g1' }));
  });

  test('join with caller not in a channel errors, does not join', async () => {
    const i = fakeInteraction({ inChannel: false, sub: 'join' });
    await command.execute(i, {});
    expect(voiceService.join).not.toHaveBeenCalled();
  });

  test('leave calls leave', async () => {
    const i = fakeInteraction({ sub: 'leave' });
    await command.execute(i, {});
    expect(voiceService.leave).toHaveBeenCalledWith('g1');
  });

  test('metadata', () => {
    expect(command.data.name).toBe('voice');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns="slash/voice"`
Expected: FAIL — cannot find module `commands/slash/voice`.

- [ ] **Step 3: Implement commands/slash/voice.js**

```js
// commands/slash/voice.js
'use strict';
const { SlashCommandBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');

class VoiceSlashCommand extends BaseSlashCommand {
  constructor(voiceService) {
    super({
      data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Talk to me in a voice channel')
        .addSubcommand((s) => s.setName('join').setDescription('Join your current voice channel'))
        .addSubcommand((s) => s.setName('leave').setDescription('Leave the voice channel')),
      cooldown: 5,
    });
    this.voiceService = voiceService;
  }

  async execute(interaction, context) {
    this.logExecution(interaction);
    if (!this.voiceService || !this.voiceService.isEnabled()) {
      await this.sendReply(interaction, { content: 'Voice is not enabled on this bot.', ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'join') {
      const channel = interaction.member?.voice?.channel;
      if (!channel) {
        await this.sendReply(interaction, { content: 'Join a voice channel first, then run `/voice join`.', ephemeral: true });
        return;
      }
      try {
        await this.voiceService.join({ channel, guildId: interaction.guildId });
        await this.sendReply(interaction, { content: `Joined <#${channel.id}>. Say "computer" to get my attention.`, ephemeral: true });
      } catch (e) {
        await this.sendError(interaction, `Couldn't join: ${e.message}`);
      }
      return;
    }
    // leave
    await this.voiceService.leave(interaction.guildId);
    await this.sendReply(interaction, { content: 'Left the voice channel.', ephemeral: true });
  }
}

module.exports = VoiceSlashCommand;
```

- [ ] **Step 4: Register the command in index.js and registerCommands.js**

In `commands/slash/index.js` add `VoiceSlashCommand: require('./voice'),` to the exports object.
In `scripts/registerCommands.js`: add `VoiceSlashCommand` to the destructured import from `../commands/slash`, then in the push block add (feature-gated like the others):
```js
if (config.voice?.enabled) commands.push(new VoiceSlashCommand(null));
```

- [ ] **Step 5: Add the config block, deps, and bot wiring**

`config/config.js` — add after the `agent:` block:
```js
voice: {
  enabled: process.env.VOICE_ENABLED === 'true',
  address: process.env.VOICE_GRPC_ADDR || 'discord-article-bot-voice.discord-article-bot.svc.cluster.local:50051',
  wakeWord: process.env.VOICE_WAKE_WORD || 'computer',
  liveVoice: process.env.VOICE_LIVE_VOICE || 'Puck',
  picovoiceAccessKey: process.env.PICOVOICE_ACCESS_KEY || '',
  followupWindowMs: parseInt(process.env.VOICE_FOLLOWUP_WINDOW_MS || '15000', 10),
  idleTimeoutMs: parseInt(process.env.VOICE_IDLE_TIMEOUT_MS || '120000', 10),
  maxSessions: parseInt(process.env.VOICE_MAX_SESSIONS || '2', 10),
  maxSessionSeconds: parseInt(process.env.VOICE_MAX_SESSION_SECONDS || '600', 10),
  systemPrompt: process.env.VOICE_SYSTEM_PROMPT || '',
},
```

`package.json` — add to `dependencies`:
```
"@discordjs/voice": "^0.19.0",
"@discordjs/opus": "^0.10.0",
"prism-media": "^1.3.5",
"sodium-native": "^4.3.1",
"@picovoice/porcupine-node": "^3.0.5"
```
Then `npm install`.

`bot.js`:
- Add `GatewayIntentBits.GuildVoiceStates` to the `intents` array (after `MessageContent`).
- Instantiate the client + service (near the AgentClient block, gated on `config.voice.enabled`):
```js
if (config.voice.enabled) {
  try {
    const VoiceClient = require('./services/VoiceClient');
    const VoiceService = require('./services/VoiceService');
    const dv = require('@discordjs/voice');
    const prism = require('prism-media');
    const { createPorcupineEngine, WakeWordGate } = require('./services/voice/wakeword');
    this.voiceClient = new VoiceClient({
      address: config.voice.address,
      protoPath: require('path').join(__dirname, 'proto', 'voice.proto'),
    });
    this.voiceService = new VoiceService({
      voiceClient: this.voiceClient,
      recallService: this.recallService,
      mongoService: this.mongoService,
      config,
      deps: {
        joinVoiceChannel: dv.joinVoiceChannel,
        createAudioPlayer: dv.createAudioPlayer,
        createAudioResource: dv.createAudioResource,
        StreamType: dv.StreamType,
        EndBehaviorType: dv.EndBehaviorType,
        opusDecoderFactory: () => new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }),
        makeWakeGate: () => new WakeWordGate(createPorcupineEngine({
          accessKey: config.voice.picovoiceAccessKey, keyword: config.voice.wakeWord })),
        now: () => Date.now(), setInterval, clearInterval,
      },
    });
  } catch (e) { logger.error(`voice init failed: ${e.message}`); this.voiceService = null; }
}
```
- Register the command inside the existing slash-registration block (near the other `if (config.xxx.enabled)` registrations):
```js
if (config.voice.enabled && this.voiceService) {
  const VoiceSlashCommand = require('./commands/slash/voice');
  this.slashCommandHandler.register(new VoiceSlashCommand(this.voiceService));
}
```

- [ ] **Step 6: Run the slash-command test + full Node suite**

Run: `npm test -- --testPathPatterns="slash/voice"` → PASS
Run: `npm test` → all PASS (fix any snapshot/registration test that enumerates commands).

- [ ] **Step 7: Commit**

```bash
git add commands/slash/voice.js __tests__/commands/slash/voice.test.js commands/slash/index.js \
  scripts/registerCommands.js config/config.js bot.js package.json package-lock.json
git commit -m "feat(voice): /voice slash command + config + bot wiring"
```

---

## Task 12: Deployment manifests + build + docs

Manual deploy + smoke test (no unit test). Manifests tracked under `k8s/voice/` mirroring `k8s/sandbox/`; real secrets live only in the gitignored `k8s/overlays/deployed/`.

**Files:**
- Create: `k8s/voice/voice-deployment.yaml`, `k8s/voice/voice-service.yaml`, `k8s/voice/voice-networkpolicy.yaml`, `k8s/voice/README.md`
- Modify: `features.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write voice-service.yaml**

```yaml
# k8s/voice/voice-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: discord-article-bot-voice
  namespace: discord-article-bot
spec:
  selector:
    app: discord-article-bot-voice
  ports:
    - name: grpc
      port: 50051
      targetPort: 50051
  type: ClusterIP
```

- [ ] **Step 2: Write voice-deployment.yaml** (RollingUpdate + scalable — the whole point; SHA-pinned image)

```yaml
# k8s/voice/voice-deployment.yaml
# Bump .image to the new git short-SHA on every release. RollingUpdate + scalable
# (unlike the agent sidecar): this holds long-lived voice WebSockets.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: discord-article-bot-voice
  namespace: discord-article-bot
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
  selector:
    matchLabels:
      app: discord-article-bot-voice
  template:
    metadata:
      labels:
        app: discord-article-bot-voice
      annotations:
        dynatrace.com/inject: "false"
    spec:
      serviceAccountName: agent-sa
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
        - name: voice
          image: mvilliger/discord-article-bot-voice:REPLACE_WITH_SHA
          ports:
            - name: grpc
              containerPort: 50051
          env:
            - { name: GRPC_LISTEN_ADDR, value: "0.0.0.0:50051" }
            - { name: OTEL_SERVICE_NAME, value: "discord-article-bot-voice" }
            - { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: "http://telemetry-ingest.dynatrace.svc.cluster.local:4318" }
            - { name: VOICE_LIVE_MODEL, value: "REPLACE_WITH_VALIDATED_MODEL" }
            - { name: VOICE_DEFAULT_VOICE, value: "Puck" }
            - { name: GOOGLE_GENAI_USE_VERTEXAI, value: "true" }
            - { name: GOOGLE_CLOUD_PROJECT, value: "revenant-discord-bot-2" }
            - { name: GOOGLE_CLOUD_LOCATION, value: "global" }
            - { name: GOOGLE_APPLICATION_CREDENTIALS, value: "/var/secrets/genai/key.json" }
            - { name: GEMINI_API_KEY, value: "" }
          resources:
            requests: { cpu: "200m", memory: "256Mi" }
            limits: { cpu: "1", memory: "512Mi" }
          readinessProbe:
            tcpSocket: { port: 50051 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket: { port: 50051 }
            initialDelaySeconds: 10
            periodSeconds: 20
          volumeMounts:
            - name: genai-sa
              mountPath: /var/secrets/genai
              readOnly: true
      volumes:
        - name: genai-sa
          secret:
            secretName: agent-genai-sa
```

- [ ] **Step 3: Write voice-networkpolicy.yaml** (egress to GEAP + Dynatrace + DNS; ingress from the bot)

```yaml
# k8s/voice/voice-networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: voice-egress
  namespace: discord-article-bot
spec:
  podSelector:
    matchLabels:
      app: discord-article-bot-voice
  policyTypes: ["Egress", "Ingress"]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: discord-article-bot
      ports:
        - { protocol: TCP, port: 50051 }
  egress:
    - to:                       # DNS
        - namespaceSelector: {}
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    - to:                       # GEAP / Vertex (aiplatform.googleapis.com) — public egress
        - ipBlock:
            cidr: 0.0.0.0/0
            except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
      ports:
        - { protocol: TCP, port: 443 }
    - to:                       # Dynatrace OTLP
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: dynatrace
      ports:
        - { protocol: TCP, port: 4317 }
        - { protocol: TCP, port: 4318 }
```

- [ ] **Step 4: Write k8s/voice/README.md**

Document: apply order (`kubectl apply -f k8s/voice/ -n discord-article-bot`); that the real image tag + `VOICE_LIVE_MODEL` are set in the gitignored deployed overlay; the two bot-side edits (add `VOICE_ENABLED=true`, `PICOVOICE_ACCESS_KEY`, `VOICE_GRPC_ADDR` to the bot's ConfigMap/Secret; the bot NetworkPolicy already allows egress to this service via in-cluster pod selector — add a rule if not); and that `agent-genai-sa` + `agent-sa` are reused from the agent sidecar (no new secrets).

- [ ] **Step 5: Build, push, deploy, smoke-test**

```bash
# from repo root
SHA=$(git rev-parse --short HEAD)
docker build -f voice-sidecar/Dockerfile -t mvilliger/discord-article-bot-voice:$SHA voice-sidecar/
docker push mvilliger/discord-article-bot-voice:$SHA
# set image + VOICE_LIVE_MODEL in k8s/overlays/deployed/ copies, then:
kubectl apply -f k8s/voice/ -n discord-article-bot
kubectl rollout status deployment/discord-article-bot-voice -n discord-article-bot --timeout=120s
kubectl logs deployment/discord-article-bot-voice -n discord-article-bot | tail -20  # expect "voice sidecar listening on 0.0.0.0:50051"
```
Then set `VOICE_ENABLED=true` + `PICOVOICE_ACCESS_KEY` on the bot, redeploy the bot, run `node scripts/registerCommands.js`, and in Discord: `/voice join` → say "computer, what's 2 + 2" → hear a reply → confirm a transcript appears via `/tldr`.

- [ ] **Step 6: Update docs**

- `features.md`: add a "Voice channel conversation" capability entry.
- `README.md`: document `/voice join|leave`, the wake word, and the new env vars.
- `CLAUDE.md`: add a "Voice (discord-article-bot-voice sidecar)" section — the new-sidecar rationale (RollingUpdate/scalable vs the agent sidecar's Recreate/do-not-scale), that it reuses `agent-genai-sa`, the `VOICE_*` tunables, the wake-word dependency (Picovoice key), and that voice transcripts flow into the Mongo message store (`/tldr` + recall).

- [ ] **Step 7: Commit**

```bash
git add k8s/voice/ features.md README.md CLAUDE.md
git commit -m "feat(voice): deployment manifests + docs"
```

---

## Self-Review

**Spec coverage:**
- Wake-word gate → Task 8. Gemini Live brain → Tasks 4–5. New dedicated sidecar → Tasks 3–5, 12. `/voice join|leave` + caller-inferred channel → Task 11. Turn rhythm (wake→reply→hot→idle) → Task 9. Reuse `channel-voice` prompt → passed via `SessionStart.system_prompt` (Task 11 config `systemPrompt` + VoiceService `_startSession`); **note:** the bot must populate `config.voice.systemPrompt` from the `channel-voice` personality — see gap below. Configurable Live voice + barge-in → Tasks 4, 7, 9. Memory (recall in, transcripts out) → Task 10. Error handling / health-gate / cost guards → Tasks 7, 9, 10 (`maxSessions`, idle tick; `maxSessionSeconds` is configured but see gap). Pre-flight model validation → Task 1. Deployment (RollingUpdate, agent-genai-sa, NetworkPolicy) → Task 12.

**Gaps found & resolved inline:**
1. **`channel-voice` prompt wiring:** `config.voice.systemPrompt` defaults to `''`. To honor "reuse the channel-voice personality," bot.js should set it from the loaded personality. Add to Task 11 Step 5: after building config, `config.voice.systemPrompt = require('./personalities/channel-voice').systemPrompt || config.voice.systemPrompt;` (or read via the PersonalityManager). Flagging here rather than expanding the task — the implementer wires the existing personality's `systemPrompt` into the voice config.
2. **`maxSessionSeconds` hard cap:** configured but not enforced in the VoiceService tick loop. The idle timeout + follow-up window bound normal cost; the absolute cap is a belt-and-suspenders guard. Implementer: in `_tick`, if a session has been open longer than `maxSessionSeconds`, call `_endSession`. Left as a small addition to Task 10's `_tick` (the test harness already injects `now`).

**Placeholder scan:** `REPLACE_WITH_SHA` / `REPLACE_WITH_VALIDATED_MODEL` in the deployment YAML are deliberate deploy-time substitutions (documented in Task 12 Step 5 / Task 1), not plan placeholders. No TODO/TBD in code steps.

**Type consistency:** `SessionStart` fields (snake_case in proto; camelCase in `VoiceClient.sendStart`) are consistent across Tasks 2, 4, 7, 10. Machine action shapes (`startSession`/`play`/`stopPlayback`/`armFollowup`/`cancelFollowup`/`endSession`/`notifyError`) match between Task 9 (producer) and Task 10 (`_apply` consumer). Server-event names (`audio`/`inputTranscript`/`outputTranscript`/`turnComplete`/`interrupted`/`error`) match between Task 7 (emitter) and Task 10 (handlers).
