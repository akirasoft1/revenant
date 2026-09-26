// __tests__/scripts/genTestVoices.test.js
// gemini-3.8-flash-tts returns a complete RIFF/WAV (audio/wav, 24kHz mono
// 16-bit) where gemini-2.5-flash-preview-tts returned raw audio/L16 PCM.
// The fixture writer must handle both without double-wrapping.

const { MODEL, audioToWav, pcmToWav } = require('../../scripts/gen-test-voices');

describe('gen-test-voices', () => {
  test('uses the current GA TTS model', () => {
    expect(MODEL).toBe('gemini-3.8-flash-tts');
  });

  test('wraps raw L16 PCM in a WAV header', () => {
    const pcm = Buffer.alloc(480, 1);
    const wav = audioToWav(pcm, 'audio/L16;codec=pcm;rate=24000');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.readUInt32LE(24)).toBe(24000);
  });

  test('passes an already-WAV response through unchanged (no double header)', () => {
    const wav = pcmToWav(Buffer.alloc(480, 2));
    const out = audioToWav(wav, 'audio/wav');
    expect(out.equals(wav)).toBe(true);
  });

  test('detects WAV by RIFF magic even if the mimeType is missing', () => {
    const wav = pcmToWav(Buffer.alloc(100, 3));
    expect(audioToWav(wav, undefined).equals(wav)).toBe(true);
  });

  test('rejects a WAV at a sample rate the voice fixtures do not expect', () => {
    const wav = pcmToWav(Buffer.alloc(100, 3), { sampleRate: 48000 });
    expect(() => audioToWav(wav, 'audio/wav')).toThrow(/24000/);
  });
});
