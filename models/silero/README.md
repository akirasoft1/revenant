# Silero VAD (vendored)

- Model: `silero_vad.onnx` — Silero VAD **v5.1**, source https://github.com/snakers4/silero-vad (tag `v5.1`)
- License: MIT (see upstream LICENSE)
- Input format: 16 kHz mono s16le, **512-sample (32 ms)** windows.
- Tensor IO (from `node scripts/_introspect-silero.js`, 2026-08-13):
  - input samples: `input` float32 `[?, ?]`
  - state (carried between calls): `state` float32 `[2, ?, 128]`, zero-initialized
  - sample rate: `sr` int64 scalar = 16000
  - output prob: `output` float32 `[?, 1]`
  - output next-state: `stateN` float32 `[?, ?, ?]`
