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
    opusDecoderFactory: () => ({ decode: jest.fn((buf) => buf) }),
    makeWakeGate: () => ({ push: jest.fn(() => false), reset: jest.fn() }),
    now: () => 0,
    setInterval: jest.fn(() => 1),
    clearInterval: jest.fn(),
    getVoiceConnection: jest.fn(() => null),
    ...overrides,
  };
}

function makeService(deps, configOverrides = {}, contextBuilder) {
  const voiceClient = {
    converse: jest.fn(() => {
      const s = new EventEmitter();
      s.sendStart = jest.fn(); s.sendAudio = jest.fn(); s.end = jest.fn();
      return s;
    }),
    isHealthy: jest.fn(() => true),
  };
  const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue({}) };
  const config = { voice: { enabled: true, wakeWord: 'hey jarvis', liveVoice: 'Puck',
    followupWindowMs: 1000, idleTimeoutMs: 60000, maxSessions: 2, maxSessionSeconds: 600,
    ...configOverrides } };
  const builder = contextBuilder || jest.fn().mockResolvedValue({ systemPrompt: '', memoryBlock: '', historyTurns: [] });
  return { svc: new VoiceService({ voiceClient, mongoService, config, deps, contextBuilder: builder }),
           voiceClient, mongoService, contextBuilder: builder };
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

// --- join-latency fix: guild state must be recorded before slow gate setup ---
//
// Root cause of a ~90s window where `/voice leave` was a no-op: the wake-word
// gate factory can trigger a long ONNX model load (see services/voice/wakeword.js)
// that saturates the CPU limit. `_guilds.set()` must happen as soon as the
// connection exists, BEFORE `deps.makeWakeGate()` runs, so a `/voice leave`
// racing that slow setup still finds the connection.
test('join records _guilds state (with connection) before invoking the wake-gate factory', async () => {
  const deps = makeDeps();
  let sawStateWhenGateFactoryRan = null;
  deps.makeWakeGate = jest.fn(() => {
    const g = svc._guilds.get('g1');
    sawStateWhenGateFactoryRan = !!(g && g.connection);
    return { push: jest.fn(() => false), reset: jest.fn() };
  });
  const { svc } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  expect(sawStateWhenGateFactoryRan).toBe(true);
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

test('on wake, builds context via the shared builder and opens a converse session with seeded context', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() }; // fire immediately
  const deps = makeDeps({ makeWakeGate: () => gate });
  const contextBuilder = jest.fn().mockResolvedValue({ systemPrompt: 'STATIC', memoryBlock: 'past context', historyTurns: [] });
  const { svc, voiceClient } = makeService(deps, {}, contextBuilder);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  // Simulate a user speaking: the receiver subscribe stream emits decoded PCM via the decoder.
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  expect(contextBuilder).toHaveBeenCalled();
  expect(voiceClient.converse).toHaveBeenCalled();
  const session = voiceClient.converse.mock.results[0].value;
  expect(session.sendStart).toHaveBeenCalledWith(expect.objectContaining({ recallContext: 'past context' }));
});

test('voice start uses the shared context builder', async () => {
  const contextBuilder = jest.fn().mockResolvedValue({
    systemPrompt: 'DYN', memoryBlock: 'MEM', historyTurns: [{ role: 'user', content: 'a' }] });
  const gate = { push: jest.fn(() => true), reset: jest.fn() }; // fires wake immediately
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc, voiceClient } = makeService(deps, {}, contextBuilder);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  const session = voiceClient.converse.mock.results[0].value;
  expect(contextBuilder).toHaveBeenCalled();
  expect(session.sendStart).toHaveBeenCalledWith(expect.objectContaining({
    systemPrompt: 'DYN', recallContext: 'MEM', history: [{ role: 'user', content: 'a' }] }));
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

// --- join-latency fix: leave() must always disconnect, even with no _guilds entry ---
//
// Root cause: during the ~90s wake-gate-setup window above, `_guilds` had no
// entry yet, so `/voice leave` was a no-op even though the bot was connected.
// leave() must fall back to @discordjs/voice's own connection registry.
test('leave with no _guilds entry falls back to deps.getVoiceConnection to still disconnect', async () => {
  const fakeConnection = { destroy: jest.fn() };
  const deps = makeDeps({ getVoiceConnection: jest.fn(() => fakeConnection) });
  const { svc } = makeService(deps);
  await svc.leave('never-joined-guild');
  expect(deps.getVoiceConnection).toHaveBeenCalledWith('never-joined-guild');
  expect(fakeConnection.destroy).toHaveBeenCalled();
});

test('leave with no _guilds entry and no live connection does not throw', async () => {
  const deps = makeDeps({ getVoiceConnection: jest.fn(() => null) });
  const { svc } = makeService(deps);
  await expect(svc.leave('never-joined-guild')).resolves.toBeUndefined();
});

test('leave with no _guilds entry and deps.getVoiceConnection absent does not throw', async () => {
  const deps = makeDeps();
  delete deps.getVoiceConnection;
  const { svc } = makeService(deps);
  await expect(svc.leave('never-joined-guild')).resolves.toBeUndefined();
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

  // The wake-word gate/engine must be reset on the aborted-wake path too,
  // same as _endSession — otherwise stale detection state from the tail of
  // this utterance could immediately re-fire onWake.
  expect(gate.reset).toHaveBeenCalled();

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

// --- Fix round 2: floating async calls from sync callbacks must not crash the process ---
// VoiceService._apply/_handleUserPcm are async and can reject. They are invoked from
// synchronous timer/event callbacks (the tick interval, the opus decoder's 'data' event)
// with no await/try-catch at the call site. Without a `.catch()` guard, a rejection there
// becomes an unhandledRejection, and since this repo has no
// `process.on('unhandledRejection', ...)` handler, Node's default terminates the whole
// process -- not just voice. These tests prove the guards swallow+log instead.

test('a rejection in the tick path is caught and logged, not left as an unhandled rejection', async () => {
  const unhandledRejections = [];
  const onUnhandledRejection = (err) => unhandledRejections.push(err);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    // gate.reset throws -- this fires inside _endSession, invoked synchronously
    // from _apply's 'endSession' case, which _tick calls without an await.
    const gate = { push: jest.fn(() => true), reset: jest.fn(() => { throw new Error('gate reset boom'); }) };
    let currentTime = 0;
    const deps = makeDeps({ makeWakeGate: () => gate, now: () => currentTime });
    const { svc, voiceClient } = makeService(deps, { followupWindowMs: 1000 });
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

    // Wake -> active, opens a session.
    await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
    const session = voiceClient.converse.mock.results[0].value;

    // Drive the machine to 'hot' with a follow-up deadline in the past.
    session.emit('turnComplete');
    await new Promise((r) => setImmediate(r));
    const g = svc._guilds.get('g1');
    expect(g.machine.state).toBe('hot');

    currentTime = 10000; // past followupWindowMs

    // This is the exact call site under test: the tick timer's floating `_apply` call.
    // onTick() -> [endSession] -> _endSession() -> gate.reset() throws synchronously
    // inside the async _apply body, rejecting its returned promise.
    expect(() => svc._tick('g1')).not.toThrow();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('voice: tick apply failed'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gate reset boom'));
    expect(unhandledRejections).toHaveLength(0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('a rejection in the PCM decoder path is caught and logged, not left as an unhandled rejection', async () => {
  const unhandledRejections = [];
  const onUnhandledRejection = (err) => unhandledRejections.push(err);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const gate = { push: jest.fn(() => true), reset: jest.fn() }; // fire wake immediately
    const rxStream = new EventEmitter();
    const decoder = { decode: jest.fn((buf) => buf) };
    const connection = new EventEmitter();
    connection.subscribe = jest.fn();
    connection.receiver = { subscribe: jest.fn(() => rxStream), speaking: new EventEmitter() };
    connection.destroy = jest.fn();

    const deps = makeDeps({
      makeWakeGate: () => gate,
      joinVoiceChannel: jest.fn(() => connection),
      opusDecoderFactory: () => decoder,
    });
    const { svc, voiceClient } = makeService(deps);
    // Force the wake path to throw synchronously inside _startSession (invoked via
    // _apply, which _handleUserPcm awaits internally but whose *caller* -- the receive
    // stream's 'data' listener wired in join() -- does not await or catch).
    voiceClient.converse.mockImplementation(() => { throw new Error('converse boom'); });

    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

    // Wire up exactly as production join() does: a user starts speaking.
    connection.receiver.speaking.emit('start', 'user1');

    // This is the exact call site under test: stream 'data' -> decode -> this._handleUserPcm(...).
    // It must not throw synchronously and must not produce an unhandled rejection.
    expect(() => rxStream.emit('data', Buffer.alloc(1024))).not.toThrow();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('voice: pcm handling failed'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('converse boom'));
    expect(unhandledRejections).toHaveLength(0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('an undecodable opus frame is dropped without crashing, and later good frames still decode', async () => {
  // Regression for the live crash: Discord sends non-Opus frames (RTP header
  // extension / silence markers) that make the decoder throw "The compressed
  // data passed is corrupted". Previously piped through a Transform, that throw
  // was an unhandled stream error that crashed the whole bot process; per-packet
  // decode must drop the bad frame and keep decoding the good ones.
  const unhandledRejections = [];
  const onUnhandledRejection = (err) => unhandledRejections.push(err);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const gate = { push: jest.fn(() => false), reset: jest.fn() };
    const rxStream = new EventEmitter();
    const decode = jest.fn()
      .mockImplementationOnce(() => { throw new Error('The compressed data passed is corrupted'); })
      .mockImplementationOnce((buf) => buf);
    const decoder = { decode };
    const connection = new EventEmitter();
    connection.subscribe = jest.fn();
    connection.receiver = { subscribe: jest.fn(() => rxStream), speaking: new EventEmitter() };
    connection.destroy = jest.fn();

    const deps = makeDeps({
      makeWakeGate: () => gate,
      joinVoiceChannel: jest.fn(() => connection),
      opusDecoderFactory: () => decoder,
    });
    const { svc } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    connection.receiver.speaking.emit('start', 'user1');

    // Corrupt frame: must NOT throw and must NOT reach the wake gate.
    expect(() => rxStream.emit('data', Buffer.from([0xbe, 0xde, 0xff]))).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(gate.push).not.toHaveBeenCalled();

    // A good frame after the bad one still decodes and reaches the wake gate.
    rxStream.emit('data', Buffer.alloc(1024));
    await new Promise((r) => setImmediate(r));
    expect(gate.push).toHaveBeenCalledTimes(1);

    expect(unhandledRejections).toHaveLength(0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('repeated speaking-start for the same user does not re-subscribe until the subscription ends (no listener stacking)', async () => {
  const rxStream = new EventEmitter();
  const subscribe = jest.fn(() => rxStream);
  const connection = new EventEmitter();
  connection.subscribe = jest.fn();
  connection.receiver = { subscribe, speaking: new EventEmitter() };
  connection.destroy = jest.fn();

  const deps = makeDeps({ joinVoiceChannel: jest.fn(() => connection) });
  const { svc } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

  // Two starts for the same user while the subscription is still open: only the
  // first subscribes; the second is a no-op (prevents the AudioReceiveStream
  // listener leak observed live).
  connection.receiver.speaking.emit('start', 'user1');
  connection.receiver.speaking.emit('start', 'user1');
  expect(subscribe).toHaveBeenCalledTimes(1);

  // Once the subscription ends, a subsequent start re-subscribes.
  rxStream.emit('end');
  connection.receiver.speaking.emit('start', 'user1');
  expect(subscribe).toHaveBeenCalledTimes(2);
});

test('a second /voice join for the same guild is idempotent -- no second connection or re-wiring', async () => {
  const joinVoiceChannel = jest.fn(() => {
    const c = new EventEmitter();
    c.subscribe = jest.fn();
    c.receiver = { subscribe: jest.fn(() => new EventEmitter()), speaking: new EventEmitter() };
    c.destroy = jest.fn();
    return c;
  });
  const deps = makeDeps({ joinVoiceChannel });
  const { svc } = makeService(deps);
  const channel = { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } };

  await svc.join({ channel, guildId: 'g1' });
  await svc.join({ channel, guildId: 'g1' });

  expect(joinVoiceChannel).toHaveBeenCalledTimes(1);
});
