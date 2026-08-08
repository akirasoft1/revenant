// VoiceService: wiring adapter that ties the Node voice pipeline together.
//
// Owns the Discord voice connection per guild, feeds decoded/resampled PCM to
// the wake-word gate while idle, drives VoiceSessionMachine, and translates
// its action objects into real side effects (open the gRPC converse session,
// stream audio, play audio back, persist transcripts). All heavy
// collaborators (discord.js voice primitives, wake-word engine, clock,
// timers) are injected via `deps` so this is unit-testable without
// Discord/openWakeWord/gRPC.

'use strict';
const logger = require('../logger');
const VoiceSessionMachine = require('./voice/VoiceSessionMachine');
const { downsampleTo16kMono, upsample24kMonoTo48kStereo } = require('./voice/audio');
const { Readable } = require('stream');

class VoiceService {
  constructor({ voiceClient, mongoService, config, deps, contextBuilder }) {
    this._client = voiceClient;
    this._mongo = mongoService;
    this._config = config;
    this._deps = deps;
    this._contextBuilder = contextBuilder;
    // guildId -> { connection, player, gate, machine, session, channelId,
    //              buffers, tickTimer, sessionOpenedAtMs }
    this._guilds = new Map();
  }

  isEnabled() { return !!(this._config.voice && this._config.voice.enabled); }

  wakeWord() { return (this._config.voice && this._config.voice.wakeWord) || 'hey jarvis'; }

  async join({ channel, guildId }) {
    // Idempotent join: if we're already connected in this guild, do NOT create a
    // second connection or re-wire the receiver. discord.js reuses the existing
    // voice connection for a repeat join, so re-running the wiring stacked a new
    // `speaking.on('start')` handler (and, via re-subscribe, duplicate
    // data/end/error listeners) on the SAME AudioReceiveStream every time --
    // observed live as "11 data listeners added to [AudioReceiveStream]". That
    // made `_handleUserPcm` fire up to 11x per audio frame, feeding the
    // wake-word gate's continuous mel window duplicated audio and destroying the
    // temporal structure of the wake phrase so it could never be detected.
    if (this._guilds.has(guildId)) {
      logger.info(`voice: already connected in guild ${guildId} (channel ${this._guilds.get(guildId).channelId}); ignoring duplicate /voice join`);
      return;
    }
    if (this._guilds.size >= this._config.voice.maxSessions) {
      throw new Error('voice session limit reached');
    }
    const d = this._deps;
    const connection = d.joinVoiceChannel({
      channelId: channel.id, guildId, adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: false });
    const player = d.createAudioPlayer();
    connection.subscribe(player);
    const machine = new VoiceSessionMachine({
      followupWindowMs: this._config.voice.followupWindowMs, now: d.now });

    // Record state as soon as we have a live connection -- BEFORE the
    // (potentially slow) wake-gate factory runs. `makeWakeGate()` can trigger
    // an ONNX model load (services/voice/wakeword.js) that, on a cold cache,
    // saturates the bot's CPU limit for tens of seconds. If `_guilds.set()`
    // happened after that call, a `/voice leave` racing the slow setup would
    // find no entry and silently no-op while the bot stayed connected to the
    // VC. `gate` is filled in moments later, synchronously, once created;
    // `leave()`/`_endSession()` already guard for a still-null gate.
    const state = { connection, player, gate: null, machine, session: null,
      channelId: channel.id, buffers: { in: [], out: [] }, tickTimer: null,
      sessionOpenedAtMs: null, receiving: new Set() };
    this._guilds.set(guildId, state);

    state.gate = d.makeWakeGate();

    connection.receiver.speaking.on('start', (userId) => {
      // De-dupe per user: `speaking start` can fire repeatedly for a user whose
      // subscription is still open, and `receiver.subscribe` returns the SAME
      // AudioReceiveStream in that case -- re-wiring would stack duplicate
      // listeners and feed each audio frame to the wake gate multiple times.
      // Skip until the current subscription for this user ends.
      if (state.receiving.has(userId)) return;
      state.receiving.add(userId);
      const stream = connection.receiver.subscribe(userId, { end: { behavior: d.EndBehaviorType.AfterSilence, duration: 800 } });
      const decoder = d.opusDecoderFactory();
      // Decode each received Opus packet individually in a try/catch rather
      // than piping the receive stream through a decoder Transform. Discord's
      // first frame(s) after a "speaking" start can carry an RTP header
      // extension / silence marker that isn't valid Opus, and the decoder
      // throws "The compressed data passed is corrupted". Piped, that throw
      // surfaces as an UNHANDLED stream 'error' that crashes the entire bot
      // process (the pod restarts and the bot drops out of the voice channel).
      // Per-packet decode lets us drop the bad frame and keep decoding the
      // good ones so wake-word detection still runs.
      let decoded = 0;
      let dropped = 0;
      logger.debug(`voice: speaking start from user ${userId} in guild ${guildId}`);
      stream.on('data', (opusPacket) => {
        let pcm48;
        try {
          pcm48 = decoder.decode(opusPacket);
        } catch (e) {
          dropped += 1;
          return;
        }
        decoded += 1;
        this._handleUserPcm(guildId, userId, pcm48).catch((e) => logger.warn(`voice: pcm handling failed: ${e.message}`));
      });
      let ended = false;
      const onEnd = (reason) => {
        if (ended) return;
        ended = true;
        state.receiving.delete(userId);
        // Boundary instrumentation: how much audio decoded vs. was dropped, the
        // best wake score the engine reached, and any ONNX-chain error. This
        // distinguishes "no audio", "audio all-corrupt (DAVE/encryption)",
        // "wake engine erroring", and "audio fine but below threshold".
        const wakeErr = state.gate && typeof state.gate.lastError === 'function' ? state.gate.lastError() : null;
        const wakeScore = state.gate && typeof state.gate.lastScore === 'function' ? state.gate.lastScore() : null;
        logger.debug(`voice: utterance end (${reason}) user ${userId} guild ${guildId}: decoded ${decoded} frame(s), dropped ${dropped}, wake maxScore ${wakeScore}${wakeErr ? `, wake-engine error: ${wakeErr.message}` : ''}`);
      };
      stream.once('end', () => onEnd('end'));
      stream.once('error', (e) => { logger.warn(`voice: receive stream error from user ${userId} in guild ${guildId}: ${e.message}`); onEnd('error'); });
    });

    state.tickTimer = d.setInterval(() => this._tick(guildId), 250);
    logger.info(`voice: joined channel ${channel.id} in guild ${guildId}`);
  }

  async _handleUserPcm(guildId, userId, pcm48Stereo) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const pcm16 = downsampleTo16kMono(pcm48Stereo);

    if (g.machine.state === 'idle') {
      if (g.gate.push(pcm16)) {
        logger.info(`voice: wake word detected in guild ${guildId} (user ${userId})`);
        await this._apply(guildId, g.machine.onWake(), { userId });
      }
      return;
    }
    // active/hot: barge-in signal + stream audio to the live session.
    await this._apply(guildId, g.machine.onUserSpeechStart(), { userId });
    if (g.session) g.session.sendAudio(pcm16);
  }

  async _apply(guildId, actions, ctx = {}) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    for (const a of actions) {
      switch (a.type) {
        case 'startSession': await this._startSession(guildId, ctx.userId); break;
        case 'play': this._play(g, a.pcm); break;
        case 'stopPlayback': g.player.stop(); break;
        case 'armFollowup': break; // follow-up deadline lives inside the machine; nothing to wire here
        case 'cancelFollowup': break;
        case 'endSession': this._endSession(g); break;
        case 'notifyError': logger.warn(`voice: live error in guild ${guildId}`); break;
        default: break;
      }
    }
  }

  async _startSession(guildId, userId) {
    const g = this._guilds.get(guildId);
    if (!g) return;

    // Health-gate: do NOT open a converse session against an unhealthy
    // sidecar. Reset the machine back to idle so it isn't stuck in 'active'
    // with no session — a subsequent wake (once the sidecar recovers) must
    // still work.
    if (this._client.isHealthy && !this._client.isHealthy()) {
      logger.warn(`voice: sidecar unhealthy, ignoring wake in guild ${guildId}`);
      g.machine = new VoiceSessionMachine({
        followupWindowMs: this._config.voice.followupWindowMs, now: this._deps.now });
      g.session = null;
      g.sessionOpenedAtMs = null;
      // Discard any in-flight wake-word detection state from the tail of
      // this same utterance so it can't immediately re-fire onWake once the
      // sidecar recovers (mirrors the reset in _endSession).
      if (g.gate && typeof g.gate.reset === 'function') g.gate.reset();
      return;
    }

    let systemPrompt = this._config.voice.systemPrompt || '';
    let recallContext = '';
    let history = [];
    try {
      const ctx = await this._contextBuilder({
        userId, userTag: '', channelId: g.channelId, guildId,
        userMessage: '', personalityId: 'channel-voice',
      });
      systemPrompt = ctx.systemPrompt || systemPrompt;
      recallContext = ctx.memoryBlock || '';
      history = ctx.historyTurns || [];
    } catch (e) { logger.warn(`voice: context build failed: ${e.message}`); }

    const session = this._client.converse();
    g.session = session;
    g.sessionOpenedAtMs = this._deps.now();
    g.buffers = { in: [], out: [] };

    // Real gRPC duplex streams can deliver already-in-flight server frames
    // after the local end() call. Every handler below is guarded by session
    // identity (`g.session !== session` => stale/superseded, ignore) so a
    // late event from a session that has already been ended/replaced can't
    // mutate the *current* guild state (stale audio playback, transcript
    // cross-session bleed). This is belt-and-suspenders alongside
    // `_endSession`'s `removeAllListeners()`.
    const applyGuarded = (evt) => {
      if (g.session !== session) return;
      this._apply(guildId, g.machine.onServerEvent(evt)).catch((e) => logger.warn(`voice: apply failed: ${e.message}`));
    };
    session.on('audio', (buf) => applyGuarded({ type: 'audio', pcm: buf }));
    session.on('inputTranscript', (t) => { if (g.session !== session) return; g.buffers.in.push(t); });
    session.on('outputTranscript', (t) => { if (g.session !== session) return; g.buffers.out.push(t); });
    session.on('interrupted', () => applyGuarded({ type: 'interrupted' }));
    session.on('turnComplete', () => {
      if (g.session !== session) return;
      this._persistTurn(guildId).catch((e) => logger.warn(`voice: persist failed: ${e.message}`));
      applyGuarded({ type: 'turnComplete' });
    });
    session.on('error', (e) => {
      if (g.session !== session) return;
      logger.warn(`voice: session error: ${e.message}`);
      applyGuarded({ type: 'error' });
    });

    session.sendStart({ userId, channelId: g.channelId, guildId,
      systemPrompt, recallContext, history, voiceName: this._config.voice.liveVoice });
  }

  _play(g, pcm24Mono) {
    const d = this._deps;
    const pcm48 = upsample24kMonoTo48kStereo(pcm24Mono);
    const resource = d.createAudioResource(Readable.from(pcm48), { inputType: d.StreamType.Raw });
    g.player.play(resource);
  }

  async _persistTurn(guildId) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const userText = g.buffers.in.join(' ').trim();
    const botText = g.buffers.out.join(' ').trim();
    g.buffers = { in: [], out: [] };
    const base = { channelId: g.channelId, guildId, timestamp: new Date(), source: 'voice' };
    if (userText) await this._mongo.recordChannelMessage({ ...base, authorId: 'voice-user', content: userText, isBot: false });
    if (botText) await this._mongo.recordChannelMessage({ ...base, authorId: 'bot', content: botText, isBot: true });
  }

  _tick(guildId) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const now = this._deps.now();

    // Belt-and-suspenders cost guard: hard-cap a session's wall-clock
    // duration regardless of idle timeout / follow-up window state.
    const capMs = (this._config.voice.maxSessionSeconds || 0) * 1000;
    if (g.session && g.sessionOpenedAtMs !== null && capMs > 0 && (now - g.sessionOpenedAtMs) >= capMs) {
      logger.warn(`voice: maxSessionSeconds cap reached in guild ${guildId}, force-ending session`);
      this._endSession(g);
      g.machine = new VoiceSessionMachine({
        followupWindowMs: this._config.voice.followupWindowMs, now: this._deps.now });
      return;
    }

    this._apply(guildId, g.machine.onTick(now)).catch((e) => logger.warn(`voice: tick apply failed: ${e.message}`));
  }

  _endSession(g) {
    if (g.session) {
      const session = g.session;
      // Belt-and-suspenders with the identity guards in _startSession:
      // strip listeners so a real gRPC stream can't fire late in-flight
      // events into this guild's handlers at all.
      try { session.removeAllListeners(); } catch (_) { /* best-effort */ }
      try { session.end(); } catch (_) { /* closed */ }
      g.session = null;
    }
    g.sessionOpenedAtMs = null;
    // Discard any PCM buffered mid-utterance so the next wake-word window
    // isn't skewed by leftover audio from the just-ended session.
    if (g.gate && typeof g.gate.reset === 'function') g.gate.reset();
  }

  async leave(guildId) {
    const g = this._guilds.get(guildId);
    if (!g) {
      // No in-memory state -- most likely `/voice leave` raced a slow join()
      // (see join()'s early `_guilds.set` above), or the process restarted
      // mid-session. Fall back to @discordjs/voice's own connection registry
      // so the bot always disconnects instead of leaving a ghost connection.
      const getVoiceConnection = this._deps.getVoiceConnection;
      const existing = typeof getVoiceConnection === 'function' ? getVoiceConnection(guildId) : null;
      if (existing && typeof existing.destroy === 'function') {
        existing.destroy();
        logger.info(`voice: left guild ${guildId} (via fallback connection lookup, no _guilds entry)`);
      }
      return;
    }
    if (g.tickTimer) this._deps.clearInterval(g.tickTimer);
    this._endSession(g);
    if (g.connection && g.connection.destroy) g.connection.destroy();
    this._guilds.delete(guildId);
    logger.info(`voice: left guild ${guildId}`);
  }
}

module.exports = VoiceService;
