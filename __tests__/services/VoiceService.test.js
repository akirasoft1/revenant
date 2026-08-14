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

function makeService(deps, configOverrides = {}, contextBuilder, speakerNames) {
  const voiceClient = {
    converse: jest.fn(() => {
      const s = new EventEmitter();
      s.sendStart = jest.fn(); s.sendAudio = jest.fn(); s.sendAudioStreamEnd = jest.fn(); s.end = jest.fn();
      s.sendSpeaker = jest.fn();
      return s;
    }),
    isHealthy: jest.fn(() => true),
  };
  const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue({}) };
  const config = { voice: { enabled: true, wakeWord: 'hey jarvis', liveVoice: 'Puck',
    followupWindowMs: 1000, idleTimeoutMs: 60000, maxSessions: 2, maxSessionSeconds: 600,
    ...configOverrides } };
  const builder = contextBuilder || jest.fn().mockResolvedValue({ systemPrompt: '', memoryBlock: '', historyTurns: [] });
  return { svc: new VoiceService({ voiceClient, mongoService, config, deps, contextBuilder: builder, speakerNames }),
           voiceClient, mongoService, contextBuilder: builder };
}

// --- VAD-driven active-branch test harness (Task 5/6) ---

// Fake VAD gate whose push() returns pre-scripted transition objects in order
// (the last entry repeats once the sequence is exhausted).
function fakeVadGate(sequence) {
  let i = 0;
  return { push: jest.fn(() => sequence[Math.min(i++, sequence.length - 1)]), reset: jest.fn(() => { i = 0; }) };
}

// Fake wake-word gate. `mode`:
//  - true/false: push() always/never wakes.
//  - a number N: push() wakes on the Nth call (1-indexed), false before/after.
//  - 'nextPushWakes': wakes on the very next push (same as N=1).
function fakeWakeGate(mode) {
  let n = 0;
  const wakeAt = mode === 'nextPushWakes' ? 1 : (typeof mode === 'number' ? mode : null);
  return {
    push: jest.fn(() => {
      n += 1;
      if (wakeAt !== null) return n === wakeAt;
      return !!mode;
    }),
    reset: jest.fn(() => { n = 0; }),
  };
}

// 16-bit mono PCM frames for feeding the (content-agnostic) fake gates above --
// silence() is all-zero, speech() is a nonzero tone, purely for readability at
// call sites (the fakes ignore the actual sample content).
function silence(nSamples = 320) { return Buffer.alloc(nSamples * 2); }
function speech(nSamples = 320) {
  const buf = Buffer.alloc(nSamples * 2);
  for (let i = 0; i < nSamples; i++) buf.writeInt16LE(3000, i * 2);
  return buf;
}

// 16 kHz mono s16le -> 48 kHz stereo s16le. _handleUserPcm always downsamples
// its input back to 16k mono before anything (wake gate / VAD gate) sees it,
// and the fake gates above ignore their input entirely -- this just needs to
// produce a plausibly-shaped 48k-stereo buffer for the call signature.
function to48kStereo(buf16Mono) {
  const nSamples = Math.floor(buf16Mono.length / 2);
  const out = Buffer.alloc(nSamples * 3 * 4);
  let w = 0;
  for (let i = 0; i < nSamples; i++) {
    const s = buf16Mono.readInt16LE(i * 2);
    for (let k = 0; k < 3; k++) { out.writeInt16LE(s, w); out.writeInt16LE(s, w + 2); w += 4; }
  }
  return out;
}

// Build a joined-but-idle VoiceService -- a live voice connection exists but
// no one has woken the room yet. Returns a spy on `_startSession` so tests can
// assert a session did/didn't open without depending on gRPC internals.
async function buildJoinedVoiceService(deps, configOverrides = {}, contextBuilder, speakerNames) {
  const { svc, voiceClient, mongoService } = makeService(deps, configOverrides, contextBuilder, speakerNames);
  const guildId = 'g1';
  await svc.join({ channel: { id: 'c1', guild: { id: guildId, voiceAdapterCreator: {} } }, guildId });
  const startSession = jest.spyOn(svc, '_startSession');
  return { svc, guildId, voiceClient, mongoService, startSession };
}

// Build a VoiceService already past the wake word -- a live gRPC session is
// open and the machine is 'active' -- ready to exercise the VAD-driven active
// branch of _handleUserPcm directly. `overrides.holder` (default 'u1') is the
// userId that holds the floor; setup grants the floor and drives the machine's
// real onWake()/_startSession() path directly (bypassing the wake gate) so a
// caller-supplied wake-gate/VAD-gate sequence is untouched by priming.
async function buildActiveVoiceService(overrides = {}) {
  const holderId = overrides.holder || 'u1';
  const deps = makeDeps({
    makeWakeGate: overrides.makeWakeGate || (() => ({ push: jest.fn(() => false), reset: jest.fn() })),
    ...(overrides.makeVadGate ? { makeVadGate: overrides.makeVadGate } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const configOverrides = {};
  if (overrides.allowBargeIn !== undefined) configOverrides.allowBargeIn = overrides.allowBargeIn;
  if (overrides.speechEndSilenceMs !== undefined) configOverrides.speechEndSilenceMs = overrides.speechEndSilenceMs;
  if (overrides.clientEndpointing !== undefined) configOverrides.clientEndpointing = overrides.clientEndpointing;
  const { svc, voiceClient, mongoService } = makeService(deps, configOverrides, overrides.contextBuilder, overrides.speakerNames);
  const guildId = 'g1';
  await svc.join({ channel: { id: 'c1', guild: { id: guildId, voiceAdapterCreator: {} } }, guildId });
  const g = svc._guilds.get(guildId);
  g.floor.grant(holderId);      // seed the floor directly -- no wake-gate push needed
  svc._perUser(g, holderId);    // materialize the holder's gate context up front
  await svc._apply(guildId, g.machine.onWake(), { userId: holderId }); // real startSession path
  const session = voiceClient.converse.mock.results[0].value;
  const player = deps.createAudioPlayer.mock.results[0].value;
  if (overrides.playing) player.state = { status: 'playing' };
  return { svc, guildId, session, player, playerStop: player.stop, deps, voiceClient, mongoService, holderId };
}

// Factory helper: returns the next fake gate from a fixed list, by call order
// (call N gets items[N-1], clamped to the last item once exhausted).
function queuedFactory(items) {
  let i = 0;
  return () => items[Math.min(i++, items.length - 1)];
}

test('active turn streams ALL frames continuously once speech starts (incl. trailing silence)', async () => {
  // gate: frame1 opens the turn, frames 2-3 are silence but still forwarded
  const gate = fakeVadGate([
    { speaking: true, justStarted: true, justEnded: false },
    { speaking: false, justStarted: false, justEnded: false },
    { speaking: false, justStarted: false, justEnded: false },
  ]);
  const { svc, guildId, session } = await buildActiveVoiceService({ makeVadGate: () => gate });
  const frame = Buffer.alloc(320 * 2); // ~20ms @16k
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(frame));
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(frame));
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(frame));
  expect(session.sendAudio).toHaveBeenCalledTimes(3); // NO frame dropped, incl. the 2 silent ones
});

test('no frames are forwarded before speech starts (no ambient streaming between turns)', async () => {
  const gate = fakeVadGate([{ speaking: false, justStarted: false, justEnded: false }]);
  const { svc, guildId, session } = await buildActiveVoiceService({ makeVadGate: () => gate });
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudio).not.toHaveBeenCalled();
});

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
test('join records _guilds state (with connection) before the (lazy, per-speaker) wake-gate factory ever runs', async () => {
  const deps = makeDeps();
  let sawStateWhenGateFactoryRan = null;
  deps.makeWakeGate = jest.fn(() => {
    const g = svc._guilds.get('g1');
    sawStateWhenGateFactoryRan = !!(g && g.connection);
    return { push: jest.fn(() => false), reset: jest.fn() };
  });
  const { svc } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  // The wake-gate factory is now lazy (per-speaker, via `_perUser`) -- it only
  // runs once someone actually speaks, not eagerly during join(). Drive that
  // first contact and confirm the same guarantee still holds: `_guilds` state
  // (with the live connection) was already in place before the factory ran.
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(48 * 4));
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
  const sent = session.sendStart.mock.calls[0][0];
  expect(sent.systemPrompt).toEqual(expect.stringContaining('DYN'));       // dynamic persona preserved
  expect(sent.systemPrompt).toEqual(expect.stringContaining('Jarvis'));    // voice-persona note appended (wake "hey jarvis")
  expect(sent.systemPrompt).toEqual(expect.stringContaining('web search')); // proactive-search directive appended
  expect(sent).toEqual(expect.objectContaining({ recallContext: 'MEM', history: [{ role: 'user', content: 'a' }] }));
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
    content: 'what is a hornet', authorId: 'user1', isBot: false, channelId: 'c1', guildId: 'g1',
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
    content: 'and the raptor', authorId: 'user1', isBot: false,
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

test('audio chunks within a turn play as ONE continuous resource, not one per chunk', async () => {
  // Regression for garbled playback: Gemini Live streams many small PCM chunks
  // per turn. Creating a new AudioResource + player.play() per chunk made each
  // chunk interrupt the previous one (only slivers heard -> garbled noise).
  const gate = { push: jest.fn(() => true), reset: jest.fn() };
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc, voiceClient } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024)); // wake -> open session
  const session = voiceClient.converse.mock.results[0].value;
  const player = deps.createAudioPlayer.mock.results[0].value;

  // Three audio chunks in one turn -> exactly ONE resource and ONE play().
  session.emit('audio', Buffer.alloc(480));
  session.emit('audio', Buffer.alloc(480));
  session.emit('audio', Buffer.alloc(480));
  await new Promise((r) => setImmediate(r));
  expect(deps.createAudioResource).toHaveBeenCalledTimes(1);
  expect(player.play).toHaveBeenCalledTimes(1);

  // Turn ends -> stream closed; the next turn's first chunk opens a fresh one.
  session.emit('turnComplete');
  await new Promise((r) => setImmediate(r));
  session.emit('audio', Buffer.alloc(480));
  await new Promise((r) => setImmediate(r));
  expect(deps.createAudioResource).toHaveBeenCalledTimes(2);
  expect(player.play).toHaveBeenCalledTimes(2);
});

test('barge-in (interrupted) stops playback and drops the buffered stream', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() };
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc, voiceClient } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));
  const session = voiceClient.converse.mock.results[0].value;
  const player = deps.createAudioPlayer.mock.results[0].value;

  session.emit('audio', Buffer.alloc(480));
  await new Promise((r) => setImmediate(r));
  session.emit('interrupted');
  await new Promise((r) => setImmediate(r));
  expect(player.stop).toHaveBeenCalled();

  // After a barge-in, the next chunk opens a brand-new resource.
  session.emit('audio', Buffer.alloc(480));
  await new Promise((r) => setImmediate(r));
  expect(deps.createAudioResource).toHaveBeenCalledTimes(2);
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

test('pre-roll: audio buffered before the wake is flushed into the session on open', async () => {
  // fire the wake on the 3rd pushed frame
  let n = 0;
  const gate = { push: jest.fn(() => (++n === 3)), reset: jest.fn() };
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc, voiceClient } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'u1', Buffer.alloc(48 * 4)); // pre-roll frame 1
  await svc._handleUserPcm('g1', 'u1', Buffer.alloc(48 * 4)); // pre-roll frame 2
  await svc._handleUserPcm('g1', 'u1', Buffer.alloc(48 * 4)); // frame 3 -> wake -> open + flush
  await new Promise((r) => setImmediate(r));
  const session = voiceClient.converse.mock.results[0].value;
  // all three pre-roll frames (including the wake frame) are flushed to the session
  expect(session.sendAudio).toHaveBeenCalledTimes(3);
});

test('listen() opens a session immediately with no wake word', async () => {
  const deps = makeDeps();
  const { svc, voiceClient } = makeService(deps);
  const engaged = await svc.listen({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1', userId: 'u1' });
  expect(engaged).toBe(true);
  expect(voiceClient.converse).toHaveBeenCalled();        // session opened without any gate/wake
  const session = voiceClient.converse.mock.results[0].value;
  expect(session.sendStart).toHaveBeenCalled();
});

test('listen() when already active is a no-op (returns false)', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() };
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'u1', Buffer.alloc(1024)); // wake -> active
  const engaged = await svc.listen({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1', userId: 'u1' });
  expect(engaged).toBe(false);
});

// --- Bug fix: listen() must grant the floor, or the active-branch's floor
// check withholds EVERY speaker's audio (including the invoking admin's),
// leaving the session open but silently forwarding nothing. ---

test('listen() grants the floor to the invoking user so their audio is actually forwarded', async () => {
  const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const deps = makeDeps({ makeVadGate: () => gate });
  const { svc, voiceClient } = makeService(deps);
  const guildId = 'g1';
  const engaged = await svc.listen({ channel: { id: 'c1', guild: { id: guildId, voiceAdapterCreator: {} } }, guildId, userId: 'admin1' });
  expect(engaged).toBe(true);

  const g = svc._guilds.get(guildId);
  expect(g.floor.holder()).toBe('admin1'); // listen() must make the invoker the floor holder

  const session = voiceClient.converse.mock.results[0].value;
  await svc._handleUserPcm(guildId, 'admin1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudio).toHaveBeenCalled(); // the whole point of listen mode: audio must reach the model
});

test('half-duplex: no user audio is streamed while the bot is playing its reply (VAD gate not even consulted)', async () => {
  const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const { svc, guildId, session, player } = await buildActiveVoiceService({ makeVadGate: () => gate });

  // Bot is speaking -> a would-be-speech frame is NOT forwarded (no echo/loop,
  // no barge-in without opt-in), and the half-duplex early-return happens
  // BEFORE the VAD gate is even consulted.
  player.state = { status: 'playing' };
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudio).not.toHaveBeenCalled();
  expect(gate.push).not.toHaveBeenCalled();

  // Bot finishes -> input flows again.
  player.state = { status: 'idle' };
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudio).toHaveBeenCalledTimes(1);
  expect(gate.push).toHaveBeenCalledTimes(1);
});

test('barge-in enabled (allowBargeIn): speech IS streamed while the bot is playing', async () => {
  const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const { svc, guildId, session } = await buildActiveVoiceService({ makeVadGate: () => gate, allowBargeIn: true, playing: true });
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudio).toHaveBeenCalledTimes(1); // real speech interrupts
});

test('audio_stream_end fires speechEndSilenceMs after the last speaking frame and clears turnActive', async () => {
  let t = 1000;
  const now = () => t;
  const gate = fakeVadGate([
    { speaking: true, justStarted: true, justEnded: false },
    { speaking: true, justStarted: true, justEnded: false }, // re-arm for the 2nd turn below
  ]);
  const { svc, guildId, session } = await buildActiveVoiceService({
      // client endpointing is OFF by default now (server VAD owns it);
      // this test is specifically about OUR endpointer, so opt in.
      clientEndpointing: true, makeVadGate: () => gate, now, speechEndSilenceMs: 800 });

  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2))); // opens the turn, lastSpeechAt = 1000
  expect(session.sendAudio).toHaveBeenCalledTimes(1);

  // Before the window elapses, no end signal.
  t = 1700; svc._tick(guildId);
  expect(session.sendAudioStreamEnd).not.toHaveBeenCalled();

  // After the window, exactly one end signal (idempotent until new speech), and
  // the turn stops forwarding (turnActive clears) until the next onset.
  t = 1900; svc._tick(guildId);
  t = 2300; svc._tick(guildId);
  expect(session.sendAudioStreamEnd).toHaveBeenCalledTimes(1);
  expect(svc._guilds.get(guildId).turnActive).toBe(false);

  // New speech re-arms it; another silence window sends a second signal.
  t = 2400; await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  t = 3300; svc._tick(guildId);
  expect(session.sendAudioStreamEnd).toHaveBeenCalledTimes(2);
});

test('Silero justEnded fires audio_stream_end immediately as the early endpointer, without the _tick timer elapsing', async () => {
  const gate = fakeVadGate([
    { speaking: true, justStarted: true, justEnded: false },
    { speaking: false, justStarted: false, justEnded: true },
  ]);
  const { svc, guildId, session } = await buildActiveVoiceService({
      // client endpointing is OFF by default now (server VAD owns it);
      // this test is specifically about OUR endpointer, so opt in.
      clientEndpointing: true, makeVadGate: () => gate });

  // Frame 1: speech onset opens the turn; no end signal yet.
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudioStreamEnd).not.toHaveBeenCalled();

  // Frame 2: Silero declares end-of-speech (justEnded) -- audio_stream_end
  // fires right here, with NO _tick() call in between (i.e. not via the
  // silence-timer backstop).
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
  expect(session.sendAudioStreamEnd).toHaveBeenCalledTimes(1);
  expect(svc._guilds.get(guildId).turnActive).toBe(false);
});

test('interrupted server event flushes playback (stopPlayback)', async () => {
  const { svc, guildId, session, playerStop } = await buildActiveVoiceService({});
  session.emit('interrupted');
  await new Promise((r) => setImmediate(r));
  expect(playerStop).toHaveBeenCalled(); // _stopPlayback -> player.stop()
});

// --- Task 2: per-speaker gate context ---

test('per-user gates are created lazily, one set per distinct speaker', async () => {
  let wakeCalls = 0;
  const deps = makeDeps({
    makeWakeGate: () => { wakeCalls++; return fakeWakeGate(false); },
    makeVadGate: () => fakeVadGate([{ speaking: false, justStarted: false, justEnded: false }]),
  });
  const { svc, guildId } = await buildJoinedVoiceService(deps);
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(silence()));
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(silence()));
  await svc._handleUserPcm(guildId, 'bob', to48kStereo(silence()));
  expect(wakeCalls).toBe(2); // one for alice, one for bob (not per frame)
  const g = svc._guilds.get(guildId);
  expect(g.perUser.size).toBe(2);
});

// --- Task 3: idle-wake path -- per-user wake gate grants the floor ---

test('first speaker to wake takes the floor and opens the session', async () => {
  const deps = makeDeps({
    makeWakeGate: () => fakeWakeGate('nextPushWakes'),
    makeVadGate: () => fakeVadGate([{ speaking: false, justStarted: false, justEnded: false }]),
  });
  const { svc, guildId, startSession } = await buildJoinedVoiceService(deps);
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
  const g = svc._guilds.get(guildId);
  expect(g.floor.holder()).toBe('alice');
  expect(startSession).toHaveBeenCalledTimes(1);
});

// --- Task 4: active path -- floor arbitration ---

test('only the floor-holder audio is forwarded; a second speaker is withheld and noted waiting', async () => {
  const holderVad = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const otherVad = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const { svc, guildId, session } = await buildActiveVoiceService({
    holder: 'alice',
    makeVadGate: queuedFactory([holderVad, otherVad]), // 1st call (alice's setup) -> holderVad, 2nd (bob) -> otherVad
  });
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech())); // holder -> forwarded
  await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));   // non-holder -> withheld
  expect(session.sendAudio).toHaveBeenCalledTimes(1); // only alice
  const g = svc._guilds.get(guildId);
  expect(g.floor.waiting()).toContain('bob');
  expect(g.floor.holder()).toBe('alice');
});

// --- Task 5: transcript attribution to the floor-holder's userId ---

test('voice user transcript is authored with the floor-holder userId', async () => {
  const { svc, guildId, mongoService } = await buildActiveVoiceService({ holder: 'alice' });
  const g = svc._guilds.get(guildId);
  g.buffers.in = ['what is the weather'];
  g.buffers.out = ['sunny and warm'];
  await svc._persistTurn(guildId);
  const userDoc = mongoService.recordChannelMessage.mock.calls.map((c) => c[0]).find((m) => m.isBot === false);
  expect(userDoc.authorId).toBe('alice'); // not 'voice-user'
  expect(userDoc.source).toBe('voice');
});

// --- Task 6: multi-user regression coverage ---

test('single-speaker flow is unchanged (wake -> forward -> early end -> attribution)', async () => {
  const deps = makeDeps({
    makeWakeGate: () => fakeWakeGate('nextPushWakes'),
    makeVadGate: () => fakeVadGate([
      { speaking: true, justStarted: true, justEnded: false },
      { speaking: false, justStarted: false, justEnded: true },
    ]),
  });
  const { svc, guildId, voiceClient, mongoService } = await buildJoinedVoiceService(deps);

  // Wake -> alice takes the floor, session opens.
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
  const g = svc._guilds.get(guildId);
  expect(g.floor.holder()).toBe('alice');
  const session = voiceClient.converse.mock.results[0].value;

  // Speech onset -> forwarded.
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
  expect(session.sendAudio).toHaveBeenCalled();

  // Silero end-of-speech -> early audio_stream_end, turn closes.
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(silence()));
  // Endpointing is the server VAD's job by default now, so we no longer send
  // audio_stream_end -- the observable contract is that the turn closes.
  expect(session.sendAudioStreamEnd).not.toHaveBeenCalled();
  expect(g.turnActive).toBe(false);

  // Turn completes -> transcript persisted under alice's real userId.
  session.emit('inputTranscript', 'what time is it');
  session.emit('outputTranscript', 'three pm');
  session.emit('turnComplete');
  await new Promise((r) => setImmediate(r));
  const userDoc = mongoService.recordChannelMessage.mock.calls.map((c) => c[0]).find((m) => m.isBot === false);
  expect(userDoc.authorId).toBe('alice');
});

test('two speakers: alice holds through her turn; bob only takes the floor after the room goes idle and he wakes', async () => {
  let t = 0;
  const now = () => t;
  const deps = makeDeps({
    now,
    makeWakeGate: () => fakeWakeGate('nextPushWakes'),
    makeVadGate: () => fakeVadGate([
      { speaking: true, justStarted: true, justEnded: false },
      { speaking: false, justStarted: false, justEnded: true },
    ]),
  });
  const { svc, guildId, voiceClient } = await buildJoinedVoiceService(deps);

  // Alice wakes -> holds the floor, session opens.
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
  const g = svc._guilds.get(guildId);
  expect(g.floor.holder()).toBe('alice');
  const session1 = voiceClient.converse.mock.results[0].value;
  session1.sendAudio.mockClear(); // drop the wake-phrase pre-roll flush from setup

  // Alice speaks -> forwarded (turn opens on onset).
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
  expect(session1.sendAudio).toHaveBeenCalledTimes(1);

  // Bob speaks while alice holds the floor -> withheld + noted waiting, never forwarded.
  await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));
  expect(session1.sendAudio).toHaveBeenCalledTimes(1); // still just alice's frame
  expect(g.floor.waiting()).toContain('bob');
  expect(g.floor.holder()).toBe('alice');

  // Alice's turn ends (Silero justEnded) -> audio_stream_end.
  await svc._handleUserPcm(guildId, 'alice', to48kStereo(silence()));
  // Endpointing belongs to the server VAD by default, so no client signal;
  // what matters for the floor hand-off is that alice's turn closed.
  expect(session1.sendAudioStreamEnd).not.toHaveBeenCalled();
  expect(g.turnActive).toBe(false);

  // Server finishes the turn -> machine goes 'hot' (follow-up window armed).
  session1.emit('turnComplete');
  await new Promise((r) => setImmediate(r));
  expect(g.machine.state).toBe('hot');

  // Follow-up window elapses -> session ends, room returns to idle, floor released.
  t = 5000;
  svc._tick(guildId);
  await new Promise((r) => setImmediate(r));
  expect(g.machine.state).toBe('idle');
  expect(g.floor.holder()).toBeNull();

  // Bob now wakes -> HE takes the floor; a fresh session opens for him (his
  // wake-phrase pre-roll frame flushes into it on open).
  await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));
  expect(g.floor.holder()).toBe('bob');
  expect(voiceClient.converse).toHaveBeenCalledTimes(2);
  const session2 = voiceClient.converse.mock.results[1].value;
  session2.sendAudio.mockClear();

  // Bob's audio now forwards since he holds the floor.
  await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));
  expect(session2.sendAudio).toHaveBeenCalledTimes(1);
});

// --- Regression: a missed end-of-speech edge must not wedge the session ------
//
// Production outage (2026-08-14, fixed on main and re-applied here after a
// silent merge resolution dropped it): audio stopped reaching the model after
// the FIRST turn. The sidecar received only the first utterance (audio_in=200
// chunks / 4.0s) while the user kept talking, and the session idled out exactly
// followupWindowMs after turnComplete -- proof onUserSpeechStart never fired
// again.
//
// Cause: opening a turn was purely EDGE-triggered on `justStarted`. Discord
// stops delivering packets once a speaker goes quiet, so the VAD gate can miss
// the sub-threshold frames it needs to close (minSilenceFrames = 768ms). If it
// never closes it never produces another rising edge -- while _tick's timer
// independently clears turnActive. The two drift apart and the turn can never
// reopen: every later frame hits `if (!g.turnActive) return`.
describe('turn re-arming after a missed end-of-speech edge', () => {
  test('holder speech still forwards when the gate reports speaking with no rising edge', async () => {
    // The gate believes it is still mid-utterance and emits no edges at all --
    // exactly the wedged state observed in production.
    const gate = fakeVadGate([{ speaking: true, justStarted: false, justEnded: false }]);
    const { svc, guildId, session, holderId } = await buildActiveVoiceService({
      // client endpointing is OFF by default now (server VAD owns it);
      // this test is specifically about OUR endpointer, so opt in.
      clientEndpointing: true,
      // client endpointing is OFF by default now (server VAD owns it);
      // this test is specifically about OUR endpointer, so opt in.
      clientEndpointing: true, makeVadGate: () => gate });
    const g = svc._guilds.get(guildId);
    g.turnActive = false; // _tick's backstop already closed the previous turn

    await svc._handleUserPcm(guildId, holderId, to48kStereo(Buffer.alloc(320 * 2)));

    expect(session.sendAudio).toHaveBeenCalledTimes(1);
    expect(g.turnActive).toBe(true);
  });

  test('_tick resets the FLOOR HOLDER\'s VAD gate when it finalizes a turn', async () => {
    let t = 1000;
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, holderId } = await buildActiveVoiceService({
      makeVadGate: () => gate, now: () => t, speechEndSilenceMs: 800,
    });
    await svc._handleUserPcm(guildId, holderId, to48kStereo(Buffer.alloc(320 * 2)));
    t = 1900;
    svc._tick(guildId);

    // With client endpointing OFF (the default) we do NOT signal Gemini -- but
    // the LOCAL turn bookkeeping must still run, which is the whole point here.
    expect(svc._guilds.get(guildId).turnActive).toBe(false);
    // The holder's gate state must be cleared in lockstep with turnActive,
    // otherwise it stays "speaking" forever and never re-arms.
    const holder = svc._guilds.get(guildId).perUser.get(holderId);
    expect(holder.vadGate.reset).toHaveBeenCalled();
  });
});

// --- Dual-endpointing toggle -------------------------------------------------
// Observed live: one utterance transcribed and answered 2-3x (31.9s of reply
// audio for a ~10s answer) while audio_in showed the audio was sent ONCE. Since
// Phase 1 streams trailing silence, Gemini's automatic VAD can finalize the
// turn by itself -- doing that AND sending our own audio_stream_end finalizes
// the same audio twice. VOICE_CLIENT_ENDPOINTING=false hands endpointing
// entirely to the server so only one finalization happens.
describe('client endpointing toggle', () => {
  test('does NOT send audio_stream_end when client endpointing is disabled', async () => {
    let t = 1000;
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: true }]);
    const { svc, guildId, session } = await buildActiveVoiceService({
      makeVadGate: () => gate, now: () => t, speechEndSilenceMs: 800, clientEndpointing: false,
    });
    await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
    t = 5000;
    svc._tick(guildId);
    expect(session.sendAudioStreamEnd).not.toHaveBeenCalled();
    expect(session.sendAudio).toHaveBeenCalled(); // audio still streams
  });

  test('does NOT send audio_stream_end by DEFAULT (server VAD owns endpointing)', async () => {
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: true }]);
    const { svc, guildId, session } = await buildActiveVoiceService({ makeVadGate: () => gate });
    await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
    expect(session.sendAudioStreamEnd).not.toHaveBeenCalled();
  });

  test('sends audio_stream_end when explicitly re-enabled', async () => {
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: true }]);
    const { svc, guildId, session } = await buildActiveVoiceService({ makeVadGate: () => gate, clientEndpointing: true });
    await svc._handleUserPcm(guildId, 'u1', to48kStereo(Buffer.alloc(320 * 2)));
    expect(session.sendAudioStreamEnd).toHaveBeenCalledTimes(1);
  });
});

describe('speaker identity', () => {
  test('sends SetSpeaker once per speaker change, not per frame', async () => {
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, holderId } = await buildActiveVoiceService({
      makeVadGate: () => gate,
      speakerNames: { resolve: () => 'Mike', sanitize: (s) => s },
    });
    await svc._handleUserPcm(guildId, holderId, to48kStereo(Buffer.alloc(320 * 2)));
    await svc._handleUserPcm(guildId, holderId, to48kStereo(Buffer.alloc(320 * 2)));
    expect(session.sendSpeaker).toHaveBeenCalledTimes(1);
    expect(session.sendSpeaker).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Mike' }));
    expect(session.sendAudio).toHaveBeenCalledTimes(2);
  });

  test('sends no SetSpeaker when the name cannot be resolved', async () => {
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, holderId } = await buildActiveVoiceService({
      makeVadGate: () => gate,
      speakerNames: { resolve: () => null, sanitize: (s) => s },
    });
    await svc._handleUserPcm(guildId, holderId, to48kStereo(Buffer.alloc(320 * 2)));
    expect(session.sendSpeaker).not.toHaveBeenCalled();
    expect(session.sendAudio).toHaveBeenCalledTimes(1); // audio still flows
  });

  test('voice persona instructs the model never to read the marker aloud', () => {
    const { svc } = makeService(makeDeps({}), {}, undefined);
    const p = svc._appendVoicePersona('BASE');
    expect(p).toMatch(/\[SPEAKER:/);
    expect(p.toLowerCase()).toMatch(/never read|do not read|aloud/);
  });

  // Regression: the wake-triggering utterance (pre-roll + anything buffered
  // during the multi-second session-open window) flushes via a direct
  // session.sendAudio loop in _startSession, entirely outside
  // _handleUserPcm's sendSpeaker gate. Without labeling it there too, the
  // FIRST audio of every session -- the audio that most needs "who is
  // talking now" -- reached the model unmarked.
  test('pre-roll flush is labeled: SetSpeaker fires once, before sendAudio, for the wake-triggering speaker', async () => {
    const deps = makeDeps({
      makeWakeGate: () => fakeWakeGate('nextPushWakes'),
      makeVadGate: () => fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]),
    });
    const speakerNames = { resolve: () => 'Mike', sanitize: (s) => s };
    const { svc, guildId, voiceClient } = await buildJoinedVoiceService(deps, {}, undefined, speakerNames);

    // Wake -> alice takes the floor -> session opens -> her pre-roll (the
    // wake-phrase audio) flushes into the fresh session.
    await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
    const session = voiceClient.converse.mock.results[0].value;
    expect(session.sendSpeaker).toHaveBeenCalledTimes(1);
    expect(session.sendSpeaker).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice', displayName: 'Mike' }));
    expect(session.sendAudio).toHaveBeenCalled(); // the pre-roll frame(s) flushed

    // Ordering: the marker must precede the pre-roll audio it labels.
    const speakerOrder = session.sendSpeaker.mock.invocationCallOrder[0];
    const firstAudioOrder = session.sendAudio.mock.invocationCallOrder[0];
    expect(speakerOrder).toBeLessThan(firstAudioOrder);

    // A subsequent LIVE frame from the same (still-holding) speaker must not
    // re-send the marker -- _startSession already recorded lastSpeakerSent.
    await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
    expect(session.sendSpeaker).toHaveBeenCalledTimes(1);
  });

  test('speaker change across sessions: each wake-triggering speaker gets their own SetSpeaker call', async () => {
    let t = 0;
    const now = () => t;
    const deps = makeDeps({
      now,
      makeWakeGate: () => fakeWakeGate('nextPushWakes'),
      makeVadGate: () => fakeVadGate([
        { speaking: true, justStarted: true, justEnded: false },
        { speaking: false, justStarted: false, justEnded: true },
      ]),
    });
    const speakerNames = {
      resolve: (user) => {
        if (user && user.id === 'alice') return 'Alice';
        if (user && user.id === 'bob') return 'Bob';
        return null;
      },
      sanitize: (s) => s,
    };
    const { svc, guildId, voiceClient } = await buildJoinedVoiceService(deps, {}, undefined, speakerNames);

    // Alice wakes -> holds the floor, session 1 opens labeled Alice.
    await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
    const g = svc._guilds.get(guildId);
    expect(g.floor.holder()).toBe('alice');
    const session1 = voiceClient.converse.mock.results[0].value;
    expect(session1.sendSpeaker).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice', displayName: 'Alice' }));

    // Alice's turn ends and the room idles out, releasing the floor.
    await svc._handleUserPcm(guildId, 'alice', to48kStereo(silence()));
    session1.emit('turnComplete');
    await new Promise((r) => setImmediate(r));
    expect(g.machine.state).toBe('hot');
    t = 5000;
    svc._tick(guildId);
    await new Promise((r) => setImmediate(r));
    expect(g.machine.state).toBe('idle');
    expect(g.floor.holder()).toBeNull();

    // Bob now wakes -> HE takes the floor; a fresh session opens labeled Bob.
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));
    expect(g.floor.holder()).toBe('bob');
    expect(voiceClient.converse).toHaveBeenCalledTimes(2);
    const session2 = voiceClient.converse.mock.results[1].value;
    expect(session2).not.toBe(session1);
    expect(session2.sendSpeaker).toHaveBeenCalledWith(expect.objectContaining({ userId: 'bob', displayName: 'Bob' }));

    // Each session only ever heard its own speaker announced.
    expect(session1.sendSpeaker).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'bob' }));
    expect(session2.sendSpeaker).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice' }));
  });
});

describe('waiting-speaker measurement', () => {
  test('accrues withheld speech duration on the non-holder per-user context', async () => {
    const holderGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const otherGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const gates = { alice: holderGate, bob: otherGate };
    const { svc, guildId } = await buildActiveVoiceService({
      holder: 'alice',
      makeVadGate: () => gates.__next || holderGate,
    });
    const g = svc._guilds.get(guildId);
    // seed bob's context with his own gate so the non-holder branch uses it
    svc._perUser(g, 'bob').vadGate = otherGate;

    // 20ms frame @16k mono = 320 samples = 640 bytes
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));

    expect(g.floor.waiting()).toContain('bob');
    expect(svc._perUser(g, 'bob').waitingMs).toBeGreaterThan(0);
  });
});
