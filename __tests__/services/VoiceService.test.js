jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { EventEmitter } = require('events');
const logger = require('../../logger');
const VoiceService = require('../../services/VoiceService');

// Mirrors ACK_RETRY_BASE_MS in services/VoiceService.js: the delay before the
// FIRST retry of a failed deferral acknowledgment.
const ACK_BACKOFF_FIRST_MS = 1000;

function makeDeps(overrides = {}) {
  const player = new EventEmitter(); player.play = jest.fn(); player.stop = jest.fn();
  // A real @discordjs/voice AudioPlayer ALWAYS carries a state (it starts Idle);
  // the fake used to have none, which is the one shape where the half-duplex gate
  // and the drain check used to disagree. Default it faithfully so "no state at
  // all" is an explicit, deliberate setup in the one test that wants it.
  player.state = { status: 'idle' };
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
      // Mirrors the real VoiceClient contract: sendAcknowledgeWaiting reports its
      // outcome as a boolean (false = the write provably did not go out). A fake
      // that returned undefined is what let the "only release if the ack actually
      // went out" guarantee pass its tests while being false in production -- the
      // failure tests below drive `false`, the signal the real client emits, not a
      // synchronous throw the real client never produces.
      s.sendAcknowledgeWaiting = jest.fn(() => true);
      return s;
    }),
    isHealthy: jest.fn(() => true),
  };
  const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue({}) };
  const config = { voice: { enabled: true, wakeWord: 'hey jarvis', liveVoice: 'Puck',
    followupWindowMs: 1000, idleTimeoutMs: 60000, maxSessions: 2, maxSessionSeconds: 600,
    deferralEnabled: false, deferralMinSpeechMs: 700,
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
  if (overrides.deferralEnabled !== undefined) configOverrides.deferralEnabled = overrides.deferralEnabled;
  if (overrides.deferralMinSpeechMs !== undefined) configOverrides.deferralMinSpeechMs = overrides.deferralMinSpeechMs;
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

// --- join-latency fix: guild state must be recorded before ANY later setup ---
//
// Root cause of a ~90s window where `/voice leave` was a no-op (9fd8039): the
// wake-word gate factory triggered a cold ONNX model load
// (services/voice/wakeword.js) that saturated the bot's 0.5-CPU limit, and it
// ran BEFORE `_guilds.set()` -- so for the whole load there was no entry for
// the guild and `/voice leave` silently no-opped while the bot sat in the VC.
//
// The fix is an ORDERING guarantee: `_guilds.set()` runs the moment a live
// connection exists, and everything else `join()` does happens after it.
//
// This test used to assert `sawStateWhenGateFactoryRan === true` after driving
// one frame through `_handleUserPcm`. That could not fail: the factory is now
// lazy (`_perUser`), its only call site is reached from `_handleUserPcm` after
// `_guilds.get(guildId)` has ALREADY returned a guild, and the variable was
// overwritten by every call -- so `true` was the only value it could ever
// hold, regression present or not. The rewrite below instead probes each seam
// `join()` touches and requires that every one of them already saw the state,
// which is exactly the invariant and is false the moment `_guilds.set()` moves
// later or eager work is put in front of it.
//
// What breaks it (verified by mutation):
//   * moving `this._guilds.set(guildId, state)` below the receiver wiring
//     -> receiverWiring probe records false;
//   * moving it below `d.setInterval(...)` (the pre-9fd8039 shape, at the end
//     of join) -> both the receiverWiring and timerSetup probes record false;
//   * reintroducing an eager `d.makeWakeGate()` before the set (the literal
//     regression) -> the gate-factory probe records false.
test('join records _guilds state (with the live connection) before every later step of join()', async () => {
  let svc = null;
  const probe = () => {
    const g = svc && svc._guilds.get('g1');
    return !!(g && g.connection);
  };
  // Every observation is kept, not just the last one, so a single early call
  // that misses the state cannot be masked by a later call that sees it.
  const seen = { gateFactory: [], receiverWiring: [], timerSetup: [] };

  const base = makeDeps();
  const deps = {
    ...base,
    joinVoiceChannel: jest.fn((...args) => {
      const connection = base.joinVoiceChannel(...args);
      // Instrument the first seam join() uses AFTER the guarantee point.
      const speaking = connection.receiver.speaking;
      const origOn = speaking.on.bind(speaking);
      speaking.on = (...onArgs) => { seen.receiverWiring.push(probe()); return origOn(...onArgs); };
      return connection;
    }),
    makeWakeGate: jest.fn(() => {
      seen.gateFactory.push(probe());
      return { push: jest.fn(() => false), reset: jest.fn() };
    }),
    setInterval: jest.fn(() => { seen.timerSetup.push(probe()); return 1; }),
  };
  ({ svc } = makeService(deps));
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

  // The receiver wiring and the tick timer are set up after `_guilds.set()`.
  // Both must have found the state, with the live connection, already there.
  expect(seen.receiverWiring).toEqual([true]);
  expect(seen.timerSetup).toEqual([true]);
  // Conditional half of the invariant: join() is free NOT to build gates (they
  // are lazy today), but if it ever builds one it must do so after the set.
  expect(seen.gateFactory).not.toContain(false);

  // And the lazy path keeps the guarantee: first contact from a speaker builds
  // the per-speaker gate, and it too sees the recorded state.
  await svc._handleUserPcm('g1', 'user1', Buffer.alloc(48 * 4));
  expect(seen.gateFactory.length).toBeGreaterThan(0);
  expect(seen.gateFactory).not.toContain(false);
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
    // The gate itself throws on push. _startSession's own failures are now
    // caught and recovered from inside the service (see the session-open
    // recovery tests below), so a gate throw -- which happens in
    // _handleUserPcm's own body, before any of that -- is what still exercises
    // the floating-promise guard at the 'data' call site.
    const gate = { push: jest.fn(() => { throw new Error('gate push boom'); }), reset: jest.fn() };
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
    const { svc } = makeService(deps);
    // The wake path throws synchronously inside _handleUserPcm, whose *caller*
    // -- the receive stream's 'data' listener wired in join() -- does not await
    // or catch.

    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

    // Wire up exactly as production join() does: a user starts speaking.
    connection.receiver.speaking.emit('start', 'user1');

    // This is the exact call site under test: stream 'data' -> decode -> this._handleUserPcm(...).
    // It must not throw synchronously and must not produce an unhandled rejection.
    expect(() => rxStream.emit('data', Buffer.alloc(1024))).not.toThrow();

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('voice: pcm handling failed'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gate push boom'));
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
  expect(engaged).toEqual({ listening: true, channelId: 'c1' });
  expect(voiceClient.converse).toHaveBeenCalled();        // session opened without any gate/wake
  const session = voiceClient.converse.mock.results[0].value;
  expect(session.sendStart).toHaveBeenCalled();
});

test('listen() when already active is a no-op (reports the refusal)', async () => {
  const gate = { push: jest.fn(() => true), reset: jest.fn() };
  const deps = makeDeps({ makeWakeGate: () => gate });
  const { svc } = makeService(deps);
  await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
  await svc._handleUserPcm('g1', 'u1', Buffer.alloc(1024)); // wake -> active
  const engaged = await svc.listen({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1', userId: 'u1' });
  expect(engaged).toEqual({ listening: false, reason: 'already-active' });
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
  expect(engaged).toEqual({ listening: true, channelId: 'c1' });

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

// FIX F: the half-duplex gate and the drain check must share ONE definition of
// "the bot is producing audio". They used to disagree on a player with no
// `.state`: the inlined gate read it as silent (mic flows, echo loop possible)
// while _botIsSpeaking read it as speaking. Unreachable with a real AudioPlayer,
// but the two fail-safes must at least point the same way.
test('half-duplex: a player reporting no state at all reads as STILL SPEAKING (fail-safe)', async () => {
  const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
  const { svc, guildId, session, player } = await buildActiveVoiceService({ makeVadGate: () => gate });
  delete player.state;
  await svc._handleUserPcm(guildId, 'u1', to48kStereo(speech()));
  expect(session.sendAudio).not.toHaveBeenCalled();
  expect(gate.push).not.toHaveBeenCalled();   // the early-return happens before the VAD gate
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
    // waitingMs only accrues while the bot is actually producing audio, so the
    // bot has to be talking (and barge-in on, or the half-duplex gate returns
    // before the non-holder branch is ever reached).
    const { svc, guildId, player } = await buildActiveVoiceService({
      holder: 'alice', allowBargeIn: true,
      makeVadGate: () => gates.__next || holderGate,
    });
    const g = svc._guilds.get(guildId);
    player.state = { status: 'playing' };
    // seed bob's context with his own gate so the non-holder branch uses it
    svc._perUser(g, 'bob').vadGate = otherGate;

    // 20ms frame @16k mono = 320 samples = 640 bytes
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));

    expect(g.floor.waiting()).toContain('bob');
    expect(svc._perUser(g, 'bob').waitingMs).toBeGreaterThan(0);
  });

  // FIX 2: nothing in the suite previously drove a justEnded transition for a
  // NON-holder, so the log line that is this task's actual deliverable never
  // ran in CI. Drive bob through speech-start then speech-end and assert the
  // log carries all three diagnostic fields the threshold decision needs.
  test('logs duration, playback state, and resolved name when a withheld speaker stops talking', async () => {
    const otherGate = fakeVadGate([
      { speaking: true, justStarted: true, justEnded: false },
      { speaking: false, justStarted: false, justEnded: true },
    ]);
    const { svc, guildId } = await buildActiveVoiceService({
      holder: 'alice',
      // allowBargeIn keeps the mic flowing while the bot plays, so `playing`
      // reaches the non-holder branch instead of being swallowed by the
      // earlier half-duplex early-return -- this is the exact echo scenario
      // (bot's own voice re-entering a mic) the measurement exists to catch.
      allowBargeIn: true,
      playing: true,
      speakerNames: { resolve: () => 'Bob', sanitize: (s) => s },
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = otherGate;

    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2))); // speech starts, waitingMs accrues
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2))); // speech ends -> justEnded -> log

    const call = logger.debug.mock.calls.find((c) => /withheld speech from Bob/.test(c[0]));
    expect(call).toBeDefined();
    expect(call[0]).toMatch(/withheld speech from Bob in guild g1: \d+ms/); // resolved name + duration
    expect(call[0]).toContain('alice holds the floor'); // who has the floor
    expect(call[0]).toContain('bot playback=playing'); // playback state
  });

  // FIX 3: qualification time and measurement time are now different numbers.
  // `waitingMs` (what qualifies a waiter for an acknowledgment) accrues ONLY
  // while the bot is actually producing audio, because the nudge asserts
  // "tried to speak while you were replying"; `withheldMs` accrues regardless
  // so the measurement log still sees non-overlapping interjections.
  test('waitingMs accrues only while the bot is playing; withheldMs accrues regardless', async () => {
    const otherGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, player } = await buildActiveVoiceService({
      holder: 'alice', allowBargeIn: true,
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = otherGate;

    // Bot is silent: this is two people talking to each other, not an interjection.
    player.state = { status: 'idle' };
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));
    expect(svc._perUser(g, 'bob').withheldMs).toBeGreaterThan(0);
    expect(svc._perUser(g, 'bob').waitingMs || 0).toBe(0);

    // Bot is talking: now the same speech is a genuine talk-over.
    player.state = { status: 'playing' };
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));
    expect(svc._perUser(g, 'bob').waitingMs).toBeGreaterThan(0);
  });

  // FIX 3 consequence: a waiter whose speech never overlapped the bot's reply
  // must NOT earn an acknowledgment, or the bot apologises for talking over a
  // reply that was not happening -- the common path in production, where
  // VOICE_ALLOW_BARGE_IN=true and `hot` lasts the whole 60s follow-up window.
  test('speech that never overlapped playback does not qualify for an acknowledgment', async () => {
    const otherGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', allowBargeIn: true, deferralEnabled: true, deferralMinSpeechMs: 20,
      speakerNames: { resolve: () => 'Bob' },
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = otherGate;
    player.state = { status: 'idle' }; // bot silent throughout

    for (let i = 0; i < 20; i++) await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));
    expect(svc._perUser(g, 'bob').withheldMs).toBeGreaterThan(100); // plenty of speech...

    g.machine._state = 'hot';
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled(); // ...none of it over the bot
  });

  // FIX 1: waitingMs must be scoped to a session, not to the whole join --
  // g.perUser persists across many wake/talk/idle cycles (idle auto-leave
  // doesn't exist yet), and the only other reset lives behind the
  // (flag-gated, currently-off) Phase 4 announcement path. Without a
  // flag-independent reset here, the numbers this measurement exists to
  // gather would be cumulative-since-join instead of per-episode.
  test('_endSession resets waitingMs so the measurement is scoped per session', async () => {
    const otherGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, player } = await buildActiveVoiceService({ holder: 'alice', allowBargeIn: true });
    const g = svc._guilds.get(guildId);
    player.state = { status: 'playing' };   // so the overlap counter actually accrues
    svc._perUser(g, 'bob').vadGate = otherGate;

    await svc._handleUserPcm(guildId, 'bob', to48kStereo(Buffer.alloc(320 * 2)));
    expect(svc._perUser(g, 'bob').waitingMs).toBeGreaterThan(0);

    svc._endSession(g);

    expect(svc._perUser(g, 'bob').waitingMs).toBe(0);
    expect(svc._perUser(g, 'bob').waitingPeakMs).toBe(0);   // FIX C: the peak is session-scoped too
    expect(svc._perUser(g, 'bob').withheldMs).toBe(0);
  });
});

describe('deferral: announce and release', () => {
  function qualifiedWaiter(svc, guildId, userId, name = 'Sarah') {
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, userId);
    u.name = name;
    u.waitingMs = 5000;              // comfortably over the threshold
    g.floor.noteWaiting(userId);
    return g;
  }

  test('does NOT announce while the bot is still playing (drain, not turnComplete)', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'playing' };   // model finished generating; audio still draining
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
  });

  test('announces once the playback has drained, then releases the floor and clears the speaker', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Sarah' });
    expect(g.floor.holder()).toBeNull();                       // released, not handed over
    expect(session.sendSpeaker).toHaveBeenCalledWith(          // identity cleared
      expect.objectContaining({ displayName: '' }));
  });

  test('does not announce an unqualified (too-short) waiter', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, 'bob'); u.name = 'Sarah'; u.waitingMs = 100;  // below 700ms
    g.floor.noteWaiting('bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
  });

  test('does not announce a waiter with no resolvable name', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, 'bob'); u.name = null; u.waitingMs = 5000;
    g.floor.noteWaiting('bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
  });

  test('announces at most once per turn', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledTimes(1);
  });

  test('with the flag OFF, behaviour is unchanged', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({});  // default: disabled
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
    expect(g.floor.holder()).not.toBeNull();
  });

  // FIX 7: 'buffering' is the OTHER not-drained status. An implementation that
  // only checked `!== 'playing'` passed every one of the original six tests.
  test('does NOT announce while the player is buffering', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'buffering' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
  });

  // FIX 6: a player with no `.state` must read as NOT drained. The safe default
  // for "has the bot stopped talking?" is "assume it has not."
  test('does NOT announce when the player reports no state at all', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    delete player.state;                   // a real AudioPlayer always has one; this is the fail-safe shape
    expect(player.state).toBeUndefined();
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
    expect(g.floor.holder()).not.toBeNull();
  });

  // FIX 7: every original test poked `machine._state = 'hot'` directly, so the
  // real transition into 'hot' was never exercised alongside the trigger.
  test('announces after a REAL turnComplete transition into hot (no _state poking)', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({ deferralEnabled: true });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    expect(g.machine.state).toBe('active');
    session.emit('turnComplete');          // the real active -> hot transition
    await new Promise((r) => setImmediate(r));
    expect(g.machine.state).toBe('hot');
    player.state = { status: 'idle' };     // ...and the audio has since drained
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Sarah' });
  });

  // FIX 2: a failed send must change nothing. Releasing the floor after the
  // model never got the nudge deafens the session for an invitation that was
  // never issued.
  //
  // FINAL WAVE / FIX 1: the failure signal is the CLIENT'S RETURN VALUE, not an
  // exception. VoiceClient.sendAcknowledgeWaiting catches its own write error and
  // reports `false`; it never rethrows, so the original version of this test
  // (which installed a synchronous throw) exercised a signal the real client
  // cannot produce, and `sent` was unconditionally true in production.
  test('does not latch or release the floor when the acknowledgment reports it did not send', async () => {
    let t = 0;
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      deferralEnabled: true, now: () => t,
    });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    session.sendAcknowledgeWaiting.mockReturnValueOnce(false);

    svc._tick(guildId);
    expect(g.floor.holder()).toBe('u1');          // floor untouched
    expect(g.ackedThisTurn).toBe(false);          // not latched
    expect(session.sendSpeaker).not.toHaveBeenCalledWith(expect.objectContaining({ displayName: '' }));

    // ...and a later tick retries, because nothing was latched. (FIX D: "later"
    // is now once the backoff has elapsed, not on the very next 250ms tick.)
    t += ACK_BACKOFF_FIRST_MS;
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledTimes(2);
    expect(g.floor.holder()).toBeNull();
  });

  // Belt-and-braces half of the same fix: the real client cannot throw, but some
  // other session implementation might, and an escaped exception must still count
  // as "did not send" rather than propagating out of the 250ms tick.
  test('a thrown acknowledgment is also treated as a failure, with the full message logged', async () => {
    let t = 0;
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      deferralEnabled: true, now: () => t,
    });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    session.sendAcknowledgeWaiting.mockImplementationOnce(() => { throw new Error('stream closed'); });
    logger.warn.mockClear();

    expect(() => svc._tick(guildId)).not.toThrow();
    expect(g.floor.holder()).toBe('u1');
    expect(g.ackedThisTurn).toBe(false);
    const warn = logger.warn.mock.calls.find((c) => /sendAcknowledgeWaiting failed/.test(c[0]));
    expect(warn[0]).toContain('stream closed');   // the thrown message, untruncated
  });

  // FIX 5: the acknowledgment is a fresh bot turn, so it must re-arm the
  // follow-up window. Without this the deadline stays where the ORIGINAL turn
  // left it and _endSession can cut the acknowledgment off mid-word.
  test('re-arms the follow-up window so the invited speaker gets a full one', async () => {
    let t = 0;
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      deferralEnabled: true, now: () => t,
    });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    // Real turnComplete at t=0 arms the window (followupWindowMs = 1000 in the harness).
    session.emit('turnComplete');
    await new Promise((r) => setImmediate(r));
    expect(g.machine._followupAt).toBe(1000);

    t = 900;                               // interjection lands late in the window
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalled();
    expect(g.machine._followupAt).toBe(1900);   // a FULL window from the ack

    t = 1500;                              // past the ORIGINAL deadline
    svc._tick(guildId);
    expect(g.session).not.toBeNull();      // session survived; ack was not cut off
  });

  // FIX 1 (Critical) — the mirror of the review's repro. The whole feature is a
  // lie without this: `release()` sets _holder = null, isHolder() is then false
  // for EVERYONE, and the only other grant() sites are unreachable outside the
  // idle/wake path. Before this fix the forwarded-frame count below was 0.
  test('after the acknowledgment releases the floor, the invited speaker is HEARD', async () => {
    const bobGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', deferralEnabled: true, allowBargeIn: true,
    });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    svc._perUser(g, 'bob').vadGate = bobGate;
    g.machine._state = 'hot';
    player.state = { status: 'idle' };

    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Sarah' });
    expect(g.floor.holder()).toBeNull();   // released, held by nobody

    session.sendAudio.mockClear();
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));

    expect(g.floor.holder()).toBe('bob');            // he took the open floor
    expect(g.turnActive).toBe(true);                 // ...his turn opened
    expect(session.sendAudio).toHaveBeenCalledTimes(1);   // ...and the model heard him
    expect(session.sendSpeaker).toHaveBeenCalledWith({ userId: 'bob', displayName: 'Sarah' });
  });

  test('an open floor is claimed on VAD-reported SPEECH, not on mere packet delivery', async () => {
    // The gate reports ongoing sub-threshold room noise: never speech, never an edge.
    const noiseGate = fakeVadGate([{ speaking: false, justStarted: false, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', deferralEnabled: true, allowBargeIn: true,
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'carol').vadGate = noiseGate;
    g.floor.release();                     // post-acknowledgment: floor held by nobody
    g.machine._state = 'hot';
    player.state = { status: 'idle' };      // the bot is silent, so ONLY the VAD can block this

    session.sendAudio.mockClear();
    await svc._handleUserPcm(guildId, 'carol', to48kStereo(silence()));

    expect(g.floor.holder()).toBeNull();
    expect(session.sendAudio).not.toHaveBeenCalled();
  });

  // FIX G: this test used to stay green with the `holder() === null` clause
  // deleted, because FloorControl.grant() already returns false when someone
  // else holds. Every OTHER re-take condition is satisfied here (flag on, bot
  // silent, VAD reporting speech), so spying on grant is what actually proves
  // the service never even asks.
  test('while someone still holds the floor, a second speaker cannot take it', async () => {
    const bobGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', deferralEnabled: true, allowBargeIn: true,
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = bobGate;
    player.state = { status: 'idle' };
    const grant = jest.spyOn(g.floor, 'grant');

    session.sendAudio.mockClear();
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));

    expect(grant).not.toHaveBeenCalled();   // the held floor is never even offered
    expect(g.floor.holder()).toBe('alice');
    expect(g.floor.waiting()).toContain('bob');
    expect(session.sendAudio).not.toHaveBeenCalled();
  });

  // FIX A: while the bot speaks its OWN acknowledgment the floor is held by
  // NOBODY, and production runs VOICE_ALLOW_BARGE_IN=true so the half-duplex
  // early-return never fires. That audio re-entering a laptop-speaker mic is one
  // ~32ms rising edge away from seizing the floor -- which both feeds the bot's
  // own voice back to the model as user input and locks out the person it just
  // invited, who needs 700ms of real speech to qualify as a waiter again.
  test('echo during the acknowledgment playback does NOT seize the unheld floor', async () => {
    const echoGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', deferralEnabled: true, allowBargeIn: true,
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'carol').vadGate = echoGate;
    g.floor.release();                        // post-acknowledgment: nobody holds it
    g.machine._state = 'hot';
    player.state = { status: 'playing' };     // ...and the acknowledgment is still being spoken

    session.sendAudio.mockClear();
    await svc._handleUserPcm(guildId, 'carol', to48kStereo(speech()));

    expect(g.floor.holder()).toBeNull();
    expect(session.sendAudio).not.toHaveBeenCalled();

    // Once the acknowledgment has drained, the same speaker takes the floor.
    player.state = { status: 'idle' };
    await svc._handleUserPcm(guildId, 'carol', to48kStereo(speech()));
    expect(g.floor.holder()).toBe('carol');
  });

  // FIX B: the re-take must be LEVEL-triggered. VOICE_VAD_MIN_SILENCE_FRAMES is
  // ~768ms, so a speaker who is already mid-utterance emits no new rising edge
  // until they pause -- an edge-only re-take strands exactly the person the bot
  // just invited to talk.
  test('a speaker already mid-utterance (no rising edge) still takes the open floor', async () => {
    const midUtterance = fakeVadGate([{ speaking: true, justStarted: false, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', deferralEnabled: true, allowBargeIn: true,
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = midUtterance;
    svc._perUser(g, 'bob').name = 'Sarah';
    g.floor.release();
    g.machine._state = 'hot';
    player.state = { status: 'idle' };

    session.sendAudio.mockClear();
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));

    expect(g.floor.holder()).toBe('bob');
    expect(g.turnActive).toBe(true);
    expect(session.sendAudio).toHaveBeenCalledTimes(1);
  });

  // FIX B(b): the worst shape of the same defect. Gemini's server VAD endpoints
  // alice's turn early, the reply drains while she is STILL talking, and the
  // acknowledgment releases the floor out from under her. Her very next frame is
  // `speaking:true, justStarted:false` -- edge-only, she is cut off mid-word with
  // no way back until she stops talking.
  test('a holder whose floor was released mid-utterance recovers on the next frame', async () => {
    const aliceGate = fakeVadGate([{ speaking: true, justStarted: false, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', deferralEnabled: true, allowBargeIn: true,
    });
    const g = qualifiedWaiter(svc, guildId, 'bob');
    svc._perUser(g, 'alice').vadGate = aliceGate;
    g.machine._state = 'hot';
    player.state = { status: 'idle' };

    svc._tick(guildId);                                // ack fires, floor released
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalled();
    expect(g.floor.holder()).toBeNull();

    session.sendAudio.mockClear();
    await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));   // she never stopped talking

    expect(g.floor.holder()).toBe('alice');
    expect(session.sendAudio).toHaveBeenCalledTimes(1);
  });

  // FIX E: with the flag off the re-take must be structurally dead, not merely
  // unreachable-by-invariant. A future fifth release() site would otherwise turn
  // "machine non-idle => floor held" into a live code path under a flag that
  // promises today's exact behaviour.
  test('with the flag OFF, an unheld floor is never re-taken', async () => {
    const bobGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', deferralEnabled: false, allowBargeIn: true,
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = bobGate;
    g.floor.release();                     // the shape a fifth release() site would create
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    const grant = jest.spyOn(g.floor, 'grant');

    session.sendAudio.mockClear();
    await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));

    expect(grant).not.toHaveBeenCalled();
    expect(g.floor.holder()).toBeNull();
    expect(session.sendAudio).not.toHaveBeenCalled();
  });
});

// FIX C: qualification describes ONE utterance. A session-cumulative counter let
// three separate sub-threshold bursts add up to clear a bar none of them reached,
// which is precisely what spec §5's threshold exists to reject ("coughs, one-word
// backchannels, and echo bursts do not earn an announcement").
describe('deferral: qualification is per-utterance, not cumulative', () => {
  // Drive `frames` speech frames then a justEnded, repeated `bursts` times.
  function burstGate(bursts, framesPerBurst) {
    const seq = [];
    for (let b = 0; b < bursts; b++) {
      for (let f = 0; f < framesPerBurst; f++) seq.push({ speaking: true, justStarted: f === 0, justEnded: false });
      seq.push({ speaking: false, justStarted: false, justEnded: true });
    }
    seq.push({ speaking: false, justStarted: false, justEnded: false });
    return fakeVadGate(seq);
  }

  async function runBursts({ bursts, framesPerBurst }) {
    const gate = burstGate(bursts, framesPerBurst);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', allowBargeIn: true, deferralEnabled: true, deferralMinSpeechMs: 700,
      speakerNames: { resolve: () => 'Bob' },
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = gate;
    player.state = { status: 'playing' };   // the bot is talking throughout, so every frame is overlap
    // (frames + the closing justEnded frame) per burst; 20ms of speech each.
    for (let i = 0; i < bursts * (framesPerBurst + 1); i++) {
      await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));
    }
    g.machine._state = 'hot';
    player.state = { status: 'idle' };      // drained -> the acknowledgment is evaluated now
    svc._tick(guildId);
    return { svc, g, session, guildId };
  }

  test('three sub-threshold bursts (300ms each, 900ms total) do NOT qualify', async () => {
    const { g, session } = await runBursts({ bursts: 3, framesPerBurst: 15 }); // 15 * 20ms = 300ms
    expect(svcWithheld(g)).toBeGreaterThanOrEqual(900);   // the cumulative sum WOULD have cleared 700
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
    expect(g.floor.holder()).toBe('alice');              // ...and nothing was released
  });

  test('one continuous over-threshold utterance DOES qualify', async () => {
    const { session } = await runBursts({ bursts: 1, framesPerBurst: 40 }); // 40 * 20ms = 800ms
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Bob' });
  });

  // The naive per-utterance RESET (zero on justEnded, no peak) makes the feature
  // never fire at all: _tick evaluates AFTER the utterance ended, so the value is
  // always 0 by then. The test above is what catches that -- this one pins the
  // in-progress half, so a "peak only, drop the accumulator" variant is caught too.
  test('an over-threshold utterance still IN PROGRESS qualifies', async () => {
    const gate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', allowBargeIn: true, deferralEnabled: true, deferralMinSpeechMs: 700,
      speakerNames: { resolve: () => 'Bob' },
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = gate;
    player.state = { status: 'playing' };
    for (let i = 0; i < 40; i++) await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech())); // 800ms, no justEnded

    expect(svc._perUser(g, 'bob').waitingPeakMs || 0).toBe(0);   // nothing folded yet
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Bob' });
  });

  function svcWithheld(g) {
    const u = g.perUser.get('bob');
    return u.withheldMs || 0;
  }
});

// FINAL WAVE / FIX 2: qualification belongs to the turn it was earned against.
// Nothing used to clear it at a turn boundary -- only a successful ack or
// _endSession -- so a waiter who qualified against turn N and then went silent
// could be named at the drain of turn N+1, minutes later.
describe('deferral: qualification does not survive a turn boundary', () => {
  // 40 frames of speech (20ms each = 800ms, over the 700ms bar) then an end.
  function longUtteranceGate() {
    const seq = [];
    for (let f = 0; f < 40; f++) seq.push({ speaking: true, justStarted: f === 0, justEnded: false });
    seq.push({ speaking: false, justStarted: false, justEnded: true });
    seq.push({ speaking: false, justStarted: false, justEnded: false });
    return fakeVadGate(seq);
  }

  test('a waiter who qualified against the PREVIOUS turn is not announced after the next one drains', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', allowBargeIn: true, deferralEnabled: true, deferralMinSpeechMs: 700,
      speakerNames: { resolve: () => 'Bob' },
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = longUtteranceGate();
    svc._perUser(g, 'alice').vadGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);

    // Turn N: the bot is replying and Bob talks over it for 800ms -- he qualifies.
    player.state = { status: 'playing' };
    for (let i = 0; i < 41; i++) await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));
    expect(svc._perUser(g, 'bob').waitingPeakMs).toBeGreaterThanOrEqual(700);

    // The model finishes generating, but the audio has NOT drained yet...
    g.machine._state = 'hot';
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();   // still playing

    // ...and before it drains, Alice (the holder) says something: turn N+1 opens,
    // the machine goes hot -> active, and turn N's drain-time ack never fires.
    await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));
    expect(g.machine.state).toBe('active');
    expect(svc._perUser(g, 'bob').waitingPeakMs).toBe(0); // Bob's claim died with turn N
    expect(svc._perUser(g, 'bob').waitingMs).toBe(0);

    // Turn N+1 completes and drains. Bob has been silent throughout it.
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);

    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
    expect(g.floor.holder()).toBe('alice');                 // nothing released
    // Proof this is the counter and not some other missing precondition: he is
    // still a known, named waiter -- he simply has no qualifying speech any more.
    expect(g.floor.waiting()).toContain('bob');
    expect(svc._perUser(g, 'bob').name).toBe('Bob');
  });

  test('the same waiter IS announced when they re-qualify against the new turn', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', allowBargeIn: true, deferralEnabled: true, deferralMinSpeechMs: 700,
      speakerNames: { resolve: () => 'Bob' },
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = longUtteranceGate();
    svc._perUser(g, 'alice').vadGate = fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]);

    player.state = { status: 'playing' };
    for (let i = 0; i < 41; i++) await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));
    await svc._handleUserPcm(guildId, 'alice', to48kStereo(speech()));   // turn N+1 opens, Bob is cleared
    expect(svc._perUser(g, 'bob').waitingPeakMs).toBe(0);

    // Bob talks over turn N+1's reply too -- a fresh 800ms utterance.
    svc._perUser(g, 'bob').vadGate = longUtteranceGate();
    for (let i = 0; i < 41; i++) await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));

    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Bob' });
  });
});

// FINAL WAVE / FIX 5: the ack clears QUALIFICATION state. `withheldMs` is the
// session-scoped measurement counter (_endSession owns it) and is the source of
// the "Nms withheld in total" figure -- zeroing it on every ack silently reset
// the measurement mid-session, corrupting the data it exists to gather.
describe('deferral: the acknowledgment preserves the session measurement counter', () => {
  test('clears waitingMs/waitingPeakMs but leaves withheldMs accumulating', async () => {
    const seq = [];
    for (let f = 0; f < 40; f++) seq.push({ speaking: true, justStarted: f === 0, justEnded: false });
    seq.push({ speaking: false, justStarted: false, justEnded: true });
    seq.push({ speaking: false, justStarted: false, justEnded: false });
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      holder: 'alice', allowBargeIn: true, deferralEnabled: true, deferralMinSpeechMs: 700,
      speakerNames: { resolve: () => 'Bob' },
    });
    const g = svc._guilds.get(guildId);
    svc._perUser(g, 'bob').vadGate = fakeVadGate(seq);
    player.state = { status: 'playing' };
    for (let i = 0; i < 41; i++) await svc._handleUserPcm(guildId, 'bob', to48kStereo(speech()));
    const withheldBefore = svc._perUser(g, 'bob').withheldMs;
    expect(withheldBefore).toBeGreaterThanOrEqual(700);

    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Bob' });

    expect(svc._perUser(g, 'bob').withheldMs).toBe(withheldBefore);   // measurement survives
    expect(svc._perUser(g, 'bob').waitingMs).toBe(0);                 // qualification does not
    expect(svc._perUser(g, 'bob').waitingPeakMs).toBe(0);
  });
});

// FINAL WAVE / FIX 4: a config object with no usable threshold must fall back to
// the documented 700ms default, never to 0 -- `>= 0` is true for every named
// waiter on their very first speech frame.
describe('deferral: an unusable configured threshold falls back, not to zero', () => {
  test('a NaN threshold does not announce a 100ms waiter', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      deferralEnabled: true, deferralMinSpeechMs: NaN,
    });
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, 'bob'); u.name = 'Sarah'; u.waitingMs = 100;   // far below 700
    g.floor.noteWaiting('bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };

    svc._tick(guildId);

    expect(session.sendAcknowledgeWaiting).not.toHaveBeenCalled();
    expect(g.floor.holder()).toBe('u1');
  });

  test('...but still announces a waiter who clears the fallback default', async () => {
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      deferralEnabled: true, deferralMinSpeechMs: NaN,
    });
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, 'bob'); u.name = 'Sarah'; u.waitingMs = 900;   // over 700
    g.floor.noteWaiting('bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };

    svc._tick(guildId);

    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledWith({ displayName: 'Sarah' });
  });
});

// FIX D: retrying a failed acknowledgment is correct; retrying it on every 250ms
// tick forever is not (~240 attempts and 240 warn lines per 60s follow-up window,
// unbounded in /voice listen).
describe('deferral: failed-acknowledgment backoff', () => {
  test('backs off exponentially instead of retrying every 250ms tick', async () => {
    let t = 0;
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      deferralEnabled: true, now: () => t,
    });
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, 'bob'); u.name = 'Sarah'; u.waitingMs = 5000;
    g.floor.noteWaiting('bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    session.sendAcknowledgeWaiting.mockReturnValue(false);   // the real client's failure signal
    logger.warn.mockClear();

    // 40 ticks at the real 250ms cadence = 10s of wall clock.
    for (let i = 0; i < 40; i++) { svc._tick(guildId); t += 250; }

    // Without backoff this is 40. With 1s/2s/4s/8s/16s backoff it is ~5.
    expect(session.sendAcknowledgeWaiting.mock.calls.length).toBeLessThanOrEqual(6);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalled();          // it does still retry
    const warns = logger.warn.mock.calls.filter((c) => /sendAcknowledgeWaiting failed/.test(c[0]));
    expect(warns.length).toBe(session.sendAcknowledgeWaiting.mock.calls.length);
    // Full message, never truncated -- what changed is frequency, plus per-attempt
    // detail so no two lines are verbatim identical.
    expect(warns[0][0]).toContain('the write did not go out');
    expect(warns[0][0]).toMatch(/attempt 1, retrying in \d+ms/);
    expect(warns[1][0]).toMatch(/attempt 2, retrying in \d+ms/);
    expect(warns[0][0]).not.toBe(warns[1][0]);
  });

  test('a successful acknowledgment clears the backoff state', async () => {
    let t = 0;
    const { svc, guildId, session, player } = await buildActiveVoiceService({
      deferralEnabled: true, now: () => t,
    });
    const g = svc._guilds.get(guildId);
    const u = svc._perUser(g, 'bob'); u.name = 'Sarah'; u.waitingMs = 5000;
    g.floor.noteWaiting('bob');
    g.machine._state = 'hot';
    player.state = { status: 'idle' };
    session.sendAcknowledgeWaiting.mockReturnValueOnce(false);

    svc._tick(guildId);
    expect(g.ackNextAttemptAt).toBeGreaterThan(0);
    t += ACK_BACKOFF_FIRST_MS;             // wait out the first backoff
    svc._tick(guildId);
    expect(session.sendAcknowledgeWaiting).toHaveBeenCalledTimes(2);
    expect(g.ackFailures).toBe(0);
    expect(g.ackNextAttemptAt).toBe(0);
  });
});

describe('deferral: persona clause kill switch', () => {
  // FIX 4: with the flag off, the system prompt must be byte-identical to
  // today's -- a clause describing a mechanism that can never fire is still a
  // prompt change, and the flag promises "today's exact behaviour".
  test('omits the [SYSTEM: ...] clause when deferral is disabled', async () => {
    const { svc } = makeService(makeDeps(), { deferralEnabled: false });
    const text = svc._appendVoicePersona('BASE');
    expect(text).not.toContain('[SYSTEM:');
    expect(text).toContain('[SPEAKER:');   // the Phase 3 clause is unconditional
  });

  test('includes the [SYSTEM: ...] clause when deferral is enabled', async () => {
    const { svc } = makeService(makeDeps(), { deferralEnabled: true });
    const text = svc._appendVoicePersona('BASE');
    expect(text).toContain('[SYSTEM:');
  });
});

// ===========================================================================
// Audit group 2a — session lifecycle, false success, and the paths no test
// reached. Every test below covers code that the audit proved was untested:
// deleting VoiceService's session-error handler outright left the whole suite
// green.
// ===========================================================================

// A 48k-stereo frame whose every sample is `v`, so it survives
// downsampleTo16kMono (stereo average + 3-tap mean of equal values) with its
// identity intact and can be recognised again on the far side of a buffer.
function taggedFrame(v, nSamples = 320) {
  const mono = Buffer.alloc(nSamples * 2);
  for (let i = 0; i < nSamples; i++) mono.writeInt16LE(v, i * 2);
  return to48kStereo(mono);
}

describe('2.1 — a session open that fails must leave the guild recoverable', () => {
  // The reachable trigger (TRIAGE 2.1): sendStart on a duplex grpc-js has
  // already destroyed. Everything after the health gate used to be unguarded,
  // so the throw escaped _startSession with the machine left in 'active' —
  // and every route back to idle is predicated on a session existing.
  test('a throw after the health gate leaves the machine idle, not wedged in active', async () => {
    const gate = { push: jest.fn(() => true), reset: jest.fn() };
    const deps = makeDeps({ makeWakeGate: () => gate });
    const { svc, voiceClient } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    voiceClient.converse.mockImplementationOnce(() => {
      const s = new EventEmitter();
      s.sendStart = jest.fn(() => { throw new Error('write after end'); });
      s.sendAudio = jest.fn(); s.sendAudioStreamEnd = jest.fn(); s.sendSpeaker = jest.fn(); s.end = jest.fn();
      return s;
    });

    await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024));

    const g = svc._guilds.get('g1');
    expect(g.machine.state).toBe('idle');   // NOT 'active' with no session
    expect(g.session).toBeNull();
    expect(g.floor.holder()).toBeNull();    // no phantom holder left behind
    expect(g.pending).toBeNull();
    expect(g.sessionOpening).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('session open failed'));
  });

  test('and the very next wake opens a session normally (the guild is not deaf)', async () => {
    const gate = { push: jest.fn(() => true), reset: jest.fn() };
    const deps = makeDeps({ makeWakeGate: () => gate });
    const { svc, voiceClient } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    voiceClient.converse.mockImplementationOnce(() => { throw new Error('converse boom'); });

    await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024)); // fails
    await svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024)); // must still work

    expect(voiceClient.converse).toHaveBeenCalledTimes(2);
    const g = svc._guilds.get('g1');
    expect(g.session).not.toBeNull();
    expect(g.machine.state).toBe('active');
  });

  // The recovery must not be gated on `g.session` — that is the very thing a
  // failed open never sets. This drives the wedge state directly (machine
  // advanced with no session behind it) and asserts _tick, the only thing
  // still running for that guild, gets it back.
  test('_tick recovers a guild left non-idle with no session', async () => {
    const deps = makeDeps();
    const { svc } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    const g = svc._guilds.get('g1');
    g.machine.onWake();                 // machine -> 'active', no session opened
    expect(g.machine.state).toBe('active');
    expect(g.session).toBeNull();

    svc._tick('g1');

    expect(g.machine.state).toBe('idle');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('a session open must have failed'));
  });

  // ...and it must NOT mistake a slow open for a wedge. _contextBuilder is
  // awaited with no timeout and can take seconds; a recovery that could not
  // tell the two apart would tear down every session while it was opening.
  test('_tick leaves a session that is merely slow to open alone', async () => {
    let release;
    const contextBuilder = jest.fn(() => new Promise((r) => { release = r; }));
    const gate = { push: jest.fn(() => true), reset: jest.fn() };
    const deps = makeDeps({ makeWakeGate: () => gate });
    const { svc, voiceClient } = makeService(deps, {}, contextBuilder);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

    const opening = svc._handleUserPcm('g1', 'user1', Buffer.alloc(1024)); // suspends in _contextBuilder
    await new Promise((r) => setImmediate(r));
    const g = svc._guilds.get('g1');
    expect(g.sessionOpening).toBe(true);

    svc._tick('g1');
    svc._tick('g1');
    expect(g.machine.state).toBe('active'); // untouched while opening

    release({ systemPrompt: '', memoryBlock: '', historyTurns: [] });
    await opening;
    expect(voiceClient.converse).toHaveBeenCalledTimes(1);
    expect(g.session).not.toBeNull();
    expect(g.sessionOpening).toBe(false);
  });
});

describe('2.2 — the pre-roll/pending buffer is bounded', () => {
  test('a slow session open flushes only the newest ~5s, not every frame it buffered', async () => {
    let release;
    const contextBuilder = jest.fn(() => new Promise((r) => { release = r; }));
    const deps = makeDeps({
      makeWakeGate: () => fakeWakeGate('nextPushWakes'),
      makeVadGate: () => fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]),
    });
    const { svc, voiceClient } = makeService(deps, {}, contextBuilder);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

    // Frame 0 wakes; the open then blocks in _contextBuilder.
    const opening = svc._handleUserPcm('g1', 'u1', taggedFrame(0));
    await new Promise((r) => setImmediate(r));

    // The speaker keeps talking for 400 frames (~8s) while the open is stuck.
    for (let i = 1; i <= 400; i++) await svc._handleUserPcm('g1', 'u1', taggedFrame(i));
    const g = svc._guilds.get('g1');
    expect(g.pending.length).toBe(250); // MAX_PENDING_FRAMES, not 401

    release({ systemPrompt: '', memoryBlock: '', historyTurns: [] });
    await opening;

    const session = voiceClient.converse.mock.results[0].value;
    expect(session.sendAudio).toHaveBeenCalledTimes(250);
    // Drop-oldest: the surviving window is the NEWEST audio (151..400), because
    // replaying the stale head as current speech is the actual hazard.
    expect(session.sendAudio.mock.calls[0][0].readInt16LE(0)).toBe(151);
    expect(session.sendAudio.mock.calls[249][0].readInt16LE(0)).toBe(400);
  });
});

describe("2.3 — a clean 'end' from the sidecar is noticed", () => {
  test('a clean stream close tears the session down and the next wake opens a new one', async () => {
    const gate = { push: jest.fn(() => true), reset: jest.fn() };
    const deps = makeDeps({ makeWakeGate: () => gate });
    const { svc, voiceClient } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    await svc._handleUserPcm('g1', 'u1', Buffer.alloc(1024));
    const session = voiceClient.converse.mock.results[0].value;
    const g = svc._guilds.get('g1');
    expect(g.session).toBe(session);

    // The sidecar closes the Converse stream cleanly (no ErrorEvent — its
    // no-resumption-handle and outcome="closed" paths both exit silently).
    session.emit('end');

    expect(g.session).toBeNull();
    expect(g.machine.state).toBe('idle');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('closed the Converse stream'));

    await svc._handleUserPcm('g1', 'u1', Buffer.alloc(1024));
    expect(voiceClient.converse).toHaveBeenCalledTimes(2);
    expect(svc._guilds.get('g1').session).not.toBeNull();
  });

  test("a late 'end' from a superseded session does not touch the live one", async () => {
    const gate = { push: jest.fn(() => true), reset: jest.fn() };
    const deps = makeDeps({ makeWakeGate: () => gate });
    const { svc, voiceClient } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    await svc._handleUserPcm('g1', 'u1', Buffer.alloc(1024));
    const first = voiceClient.converse.mock.results[0].value;
    first.emit('end');                                   // session 1 gone
    await svc._handleUserPcm('g1', 'u1', Buffer.alloc(1024)); // session 2 opens
    const g = svc._guilds.get('g1');
    const live = g.session;
    expect(live).not.toBeNull();

    first.emit('end'); // in-flight duplicate from the dead stream

    expect(g.session).toBe(live);
    expect(g.machine.state).toBe('active');
  });
});

describe('2.4 / 2.5 — listen() reports what actually happened', () => {
  test('an unhealthy sidecar is reported as a failure, not as engaged listen mode', async () => {
    const deps = makeDeps();
    const { svc, voiceClient } = makeService(deps);
    voiceClient.isHealthy.mockReturnValue(false);

    const res = await svc.listen({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1', userId: 'admin1' });

    expect(res).toEqual({ listening: false, reason: 'session-failed' });
    expect(voiceClient.converse).not.toHaveBeenCalled();
    // ...and the guild is left idle, so a retry once the sidecar recovers works.
    const g = svc._guilds.get('g1');
    expect(g.machine.state).toBe('idle');
    voiceClient.isHealthy.mockReturnValue(true);
    const retry = await svc.listen({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1', userId: 'admin1' });
    expect(retry).toEqual({ listening: true, channelId: 'c1' });
  });

  test('a session open that throws is reported as a failure', async () => {
    const deps = makeDeps();
    const { svc, voiceClient } = makeService(deps);
    voiceClient.converse.mockImplementationOnce(() => { throw new Error('converse boom'); });

    const res = await svc.listen({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1', userId: 'admin1' });

    expect(res).toEqual({ listening: false, reason: 'session-failed' });
  });

  test('listening from a channel the bot is not in is refused, not silently redirected', async () => {
    const deps = makeDeps();
    const { svc, voiceClient } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });

    const res = await svc.listen({ channel: { id: 'c2', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1', userId: 'admin1' });

    expect(res).toEqual({ listening: false, reason: 'other-channel', channelId: 'c1' });
    expect(voiceClient.converse).not.toHaveBeenCalled();
  });

  // 2.5: the admin is told listen mode lasts "until /voice leave". The 600s cap
  // (not overridden in the deployed overlay) ends it ~10 minutes in. We do not
  // silently re-engage — the cap is a cost control — so the log must say so.
  test('the maxSessionSeconds cap logs that continuous listen mode has ended', async () => {
    let currentTime = 0;
    const deps = makeDeps({ now: () => currentTime });
    const { svc } = makeService(deps, { maxSessionSeconds: 600 });
    await svc.listen({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1', userId: 'admin1' });
    expect(svc._guilds.get('g1').continuousRequested).toBe(true);

    currentTime = 600001;
    svc._tick('g1');
    await new Promise((r) => setImmediate(r));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('continuous listen mode (/voice listen) ended'));
    expect(svc._guilds.get('g1').continuousRequested).toBe(false);
  });

  test('maxSessionSeconds() exposes the cap the reply quotes', () => {
    const { svc } = makeService(makeDeps(), { maxSessionSeconds: 600 });
    expect(svc.maxSessionSeconds()).toBe(600);
  });
});

describe('2.6 — join() reports what actually happened', () => {
  test('a first join reports the channel it joined', async () => {
    const { svc } = makeService(makeDeps());
    const res = await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    expect(res).toEqual({ joined: true, channelId: 'c1' });
  });

  test('a duplicate join reports the channel the bot is ACTUALLY in, not the one asked for', async () => {
    const { svc } = makeService(makeDeps());
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    const res = await svc.join({ channel: { id: 'c2', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    expect(res).toEqual({ joined: false, reason: 'already-connected', channelId: 'c1' });
  });
});

describe('2.7 — a speaker name that missed the cache is retried', () => {
  test('a name that resolved to null at first contact is re-resolved later in the same join', async () => {
    let cached = false;
    const speakerNames = { resolve: jest.fn(() => (cached ? 'Mike' : null)) };
    let currentTime = 0;
    const { svc, guildId, session } = await buildActiveVoiceService({
      now: () => currentTime,
      makeVadGate: () => fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]),
      speakerNames,
    });

    await svc._handleUserPcm(guildId, 'u1', to48kStereo(speech()));
    expect(session.sendSpeaker).not.toHaveBeenCalled();  // nothing to assert yet

    // Discord's user cache fills in (a member the bot had not seen before).
    cached = true;
    // Still inside the retry window: the hot path must not re-resolve.
    const callsBefore = speakerNames.resolve.mock.calls.length;
    await svc._handleUserPcm(guildId, 'u1', to48kStereo(speech()));
    expect(speakerNames.resolve).toHaveBeenCalledTimes(callsBefore);
    expect(session.sendSpeaker).not.toHaveBeenCalled();

    currentTime = 60001; // past SPEAKER_NAME_RETRY_MS
    await svc._handleUserPcm(guildId, 'u1', to48kStereo(speech()));

    expect(session.sendSpeaker).toHaveBeenCalledWith({ userId: 'u1', displayName: 'Mike' });
  });

  test('a name that resolved is never re-resolved (the hot path stays cheap)', async () => {
    const speakerNames = { resolve: jest.fn(() => 'Mike') };
    let currentTime = 0;
    const { svc, guildId } = await buildActiveVoiceService({
      now: () => currentTime,
      makeVadGate: () => fakeVadGate([{ speaking: true, justStarted: true, justEnded: false }]),
      speakerNames,
    });
    const callsAfterOpen = speakerNames.resolve.mock.calls.length;
    expect(callsAfterOpen).toBe(1);

    for (let i = 0; i < 5; i++) {
      currentTime += 60001;
      await svc._handleUserPcm(guildId, 'u1', to48kStereo(speech()));
    }

    expect(speakerNames.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('2.8 — leave() always releases the guild', () => {
  test('a throwing connection destroy still deletes the guild entry, so voice recovers', async () => {
    const deps = makeDeps();
    const { svc } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    const connection = deps.joinVoiceChannel.mock.results[0].value;
    connection.destroy.mockImplementation(() => { throw new Error('destroy boom'); });

    await expect(svc.leave('g1')).rejects.toThrow('destroy boom');

    expect(svc._guilds.has('g1')).toBe(false);
    // ...and a fresh join is possible again (before the fix, join() short-
    // circuited on the stale entry forever).
    connection.destroy.mockImplementation(() => {});
    const res = await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    expect(res).toEqual({ joined: true, channelId: 'c1' });
  });

  test('a throwing session teardown also releases the guild entry', async () => {
    const gate = { push: jest.fn(() => true), reset: jest.fn(() => { throw new Error('gate reset boom'); }) };
    const deps = makeDeps({ makeWakeGate: () => gate });
    const { svc } = makeService(deps);
    await svc.join({ channel: { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } }, guildId: 'g1' });
    await svc._handleUserPcm('g1', 'u1', Buffer.alloc(1024)); // materialise the gate

    await expect(svc.leave('g1')).rejects.toThrow('gate reset boom');

    expect(svc._guilds.has('g1')).toBe(false);
  });
});
