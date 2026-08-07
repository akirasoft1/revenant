# openWakeWord models (vendored)

Pretrained ONNX models for the bot's keyless, offline wake-word gate
(`services/voice/wakeword.js`, `createOpenWakeWordEngine`). Run in-process via
`onnxruntime-node`; no API key or network access needed.

## Source

[openWakeWord](https://github.com/dscripka/openWakeWord) by David Scripka,
release `v0.5.1`. Fetched from the GitHub release assets:

- `melspectrogram.onnx` — raw 16 kHz audio → mel features (shared frontend)
- `embedding_model.onnx` — mel features → 96-dim embeddings (shared frontend)
- `hey_jarvis_v0.1.onnx` — the wake-phrase classifier (embeddings → score)

Re-fetch:

```bash
BASE=https://github.com/dscripka/openWakeWord/releases/download/v0.5.1
curl -L -o melspectrogram.onnx   $BASE/melspectrogram.onnx
curl -L -o embedding_model.onnx  $BASE/embedding_model.onnx
curl -L -o hey_jarvis_v0.1.onnx  $BASE/hey_jarvis_v0.1.onnx
```

## License

openWakeWord and its pretrained models are licensed **Apache-2.0**. See the
upstream repository for the full license text and model-training details.

## Pretrained wake phrases

openWakeWord ships four pretrained wake-phrase models. Only `hey_jarvis` is
vendored here (the default); to switch phrases, drop the corresponding model in
and point `VOICE_WAKE_MODEL` at it (the mel + embedding frontend models are
shared across all phrases):

| Phrase | Model file |
|---|---|
| **hey jarvis** (default) | `hey_jarvis_v0.1.onnx` |
| alexa | `alexa_v0.1.onnx` |
| hey mycroft | `hey_mycroft_v0.1.onnx` |
| hey rhasspy | `hey_rhasspy_v0.1.onnx` |
