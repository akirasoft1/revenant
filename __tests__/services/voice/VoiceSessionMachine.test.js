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
