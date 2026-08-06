jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { EventEmitter } = require('events');
const logger = require('../../logger');
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

function makeService(deps, configOverrides = {}) {
  const voiceClient = {
    converse: jest.fn(() => {
      const s = new EventEmitter();
      s.sendStart = jest.fn(); s.sendAudio = jest.fn(); s.end = jest.fn();
      return s;
    }),
    isHealthy: jest.fn(() => true),
  };
  const recallService = { recall: jest.fn().mockResolvedValue({ block: 'past context' }) };
  const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue({}) };
  const config = { voice: { enabled: true, wakeWord: 'computer', liveVoice: 'Puck',
    followupWindowMs: 1000, idleTimeoutMs: 60000, maxSessions: 2, maxSessionSeconds: 600,
    ...configOverrides } };
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

test('leave destroys the connection and cleans up the tick timer', async () => {
  const deps = makeDeps();
  const { svc } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc.leave('g1');
  // connection.destroy is called via the stored connection
  expect(deps.joinVoiceChannel.mock.results[0].value.destroy).toHaveBeenCalled();
  // deps.setInterval() returns 1 in the fake; the tick timer must be cleared.
  expect(deps.clearInterval).toHaveBeenCalledWith(1);
});

test('on wake, fetches recall and opens a converse session with seeded context', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() }; // fire immediately
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc, voiceClient, recallService } = makeService(deps);
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

  expect(mongoService.recordChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: 'what is a hornet', authorId: 'voice-user', isBot: false, channelId: 'c1', guildId: 'g1',
  }));
  expect(mongoService.recordChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: 'a light fighter', authorId: 'bot', isBot: true, channelId: 'c1', guildId: 'g1',
  }));
  expect(mongoService.recordChannelMessage).toHaveBeenCalledTimes(2);

  // A second turn must not re-persist the first turn's text — buffers reset
  // after each _persistTurn.
  mongoService.recordChannelMessage.mockClear();
  session.emit('inputTranscript', 'and the raptor');
  session.emit('outputTranscript', 'a heavier one');
  session.emit('turnComplete');
  await new Promise((r) => setImmediate(r));

  expect(mongoService.recordChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: 'and the raptor', authorId: 'voice-user', isBot: false,
  }));
  expect(mongoService.recordChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
    content: 'a heavier one', authorId: 'bot', isBot: true,
  }));
  expect(mongoService.recordChannelMessage).toHaveBeenCalledTimes(2);
});

// --- Required refinement 1: maxSessionSeconds hard cap ---
test('_tick force-ends a session that has exceeded maxSessionSeconds', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() };
  let currentTime = 0;
  const deps = makeDeps({ makeWakeGate: () => gate, now: () => currentTime });
  const { svc, voiceClient } = makeService(deps, { maxSessionSeconds: 5 }); // 5s cap
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

  // Wake at t=0 -> opens a session.
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  const session = voiceClient.converse.mock.results[0].value;
  expect(session.end).not.toHaveBeenCalled();

  // Advance the injected clock past the 5s cap and drive the tick loop directly.
  currentTime = 6000;
  svc._tick('g1');
  await new Promise((r) => setImmediate(r));

  expect(session.end).toHaveBeenCalled();
  const g = svc._guilds.get('g1');
  expect(g.session).toBeNull();
  expect(g.machine.state).toBe('idle');
});

// --- Required refinement 2: health-gate actually gates ---
test('wake while sidecar is unhealthy does not open a converse session', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() };
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc, voiceClient } = makeService(deps);
  voiceClient.isHealthy.mockReturnValue(false);

  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));

  expect(voiceClient.converse).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unhealthy'));

  // Machine must not be stuck in 'active' with no session — a later wake must work
  // once the sidecar recovers.
  const g = svc._guilds.get('g1');
  expect(g.machine.state).toBe('idle');
  expect(g.session).toBeNull();

  voiceClient.isHealthy.mockReturnValue(true);
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  expect(voiceClient.converse).toHaveBeenCalled();
});

// --- Fix round 1: stale session listeners must not mutate live guild state ---
test('late events from a superseded/ended session are ignored (no stale playback or persistence)', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() };
  let currentTime = 0;
  const deps = makeDeps({ makeWakeGate: () => gate, now: () => currentTime });
  const { svc, voiceClient, mongoService } = makeService(deps, { maxSessionSeconds: 5 });
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  const staleSession = voiceClient.converse.mock.results[0].value;

  // Force-end the session via the maxSessionSeconds cap (belt-and-suspenders
  // path also exercised by _endSession on normal endSession/error actions).
  currentTime = 6000;
  svc._tick('g1');
  await new Promise((r) => setImmediate(r));

  const g = svc._guilds.get('g1');
  expect(g.session).toBeNull();

  const player = deps.createAudioPlayer.mock.results[0].value;
  mongoService.recordChannelMessage.mockClear();

  // Real gRPC duplex streams can deliver already-in-flight frames after
  // end(). These must not play stale audio or persist a stale transcript
  // against the now-superseded/idle guild state.
  staleSession.emit('audio', Buffer.alloc(10));
  staleSession.emit('outputTranscript', 'late stale transcript');
  staleSession.emit('turnComplete');
  await new Promise((r) => setImmediate(r));

  expect(player.play).not.toHaveBeenCalled();
  expect(mongoService.recordChannelMessage).not.toHaveBeenCalled();
  expect(g.machine.state).toBe('idle');

  // The wake gate is reset on session end so leftover buffered PCM doesn't
  // skew the next wake-word detection window.
  expect(gate.reset).toHaveBeenCalled();
});
