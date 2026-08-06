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
