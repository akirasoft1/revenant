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
  test('collapses stereo to mono then 3-tap low-pass averages before decimating', () => {
    // 6 stereo frames (L,R) -> mono avg -> [150,0,0,500,0,0] -> 2 output samples,
    // each the mean of its group of 3 mono samples (the anti-alias low-pass).
    const stereo = pcm([100, 200, 0, 0, 0, 0, 400, 600, 0, 0, 0, 0]);
    const out = samples(downsampleTo16kMono(stereo));
    expect(out.length).toBe(2);
    expect(out[0]).toBe(50);              // round(mean(150,0,0))
    expect(out[1]).toBe(167);             // round(mean(500,0,0))
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
    // 2 mono -> 4 mono (2x linear interp) -> 8 values (stereo L==R).
    // Sample 0 (1000) -> 1000, mid(1000,2000)=1500
    // Sample 1 (2000, last) -> 2000, mid(2000,2000)=2000
    // Each duplicated to stereo: [1000,1000, 1500,1500, 2000,2000, 2000,2000]
    expect(out).toEqual([1000, 1000, 1500, 1500, 2000, 2000, 2000, 2000]);
  });
});

test('FRAME_SAMPLES_16K is 512', () => {
  expect(FRAME_SAMPLES_16K).toBe(512);
});
