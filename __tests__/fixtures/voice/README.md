# Voice wake-word test fixtures

Raw 16 kHz mono signed-16-bit little-endian PCM (headerless) used by the
openWakeWord integration test (`__tests__/services/voice/wakeword.integration.test.js`).

- `hey_jarvis_16k_mono.pcm` — a real spoken "hey jarvis" utterance. Positive
  sample from the openWakeWord WASM reference project
  (https://github.com/dnavarrom/openwakeword_wasm, `hey_jarvis_11-2.wav`),
  resampled to 16 kHz mono. MUST fire the `hey_jarvis` wake model.
- `negative_16k_mono.pcm` — non-wake speech (first 3 s of openWakeWord's
  `notebooks/training_tutorial_data/negative/negative_reference.wav`,
  https://github.com/dscripka/openWakeWord). MUST NOT fire the wake model.

Regenerate with `ffmpeg -i <src>.wav -ar 16000 -ac 1 -f s16le <dst>.pcm`.
