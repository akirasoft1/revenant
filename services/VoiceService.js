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
  constructor({ voiceClient, recallService, mongoService, config, deps }) {
    this._client = voiceClient;
    this._recall = recallService;
    this._mongo = mongoService;
    this._config = config;
    this._deps = deps;
    // guildId -> { connection, player, gate, machine, session, channelId,
    //              buffers, tickTimer, sessionOpenedAtMs }
    this._guilds = new Map();
  }

  isEnabled() { return !!(this._config.voice && this._config.voice.enabled); }

  wakeWord() { return (this._config.voice && this._config.voice.wakeWord) || 'hey jarvis'; }

  async join({ channel, guildId }) {
    if (this._guilds.size >= this._config.voice.maxSessions && !this._guilds.has(guildId)) {
      throw new Error('voice session limit reached');
    }
    const d = this._deps;
    const connection = d.joinVoiceChannel({
      channelId: channel.id, guildId, adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: false });
    const player = d.createAudioPlayer();
    connection.subscribe(player);
    const gate = d.makeWakeGate();
    const machine = new VoiceSessionMachine({
      followupWindowMs: this._config.voice.followupWindowMs, now: d.now });
    const state = { connection, player, gate, machine, session: null,
      channelId: channel.id, buffers: { in: [], out: [] }, tickTimer: null,
      sessionOpenedAtMs: null };
    this._guilds.set(guildId, state);

    connection.receiver.speaking.on('start', (userId) => {
      const stream = connection.receiver.subscribe(userId, { end: { behavior: d.EndBehaviorType.AfterSilence, duration: 800 } });
      const decoder = d.opusDecoderFactory();
      stream.pipe(decoder);
      decoder.on('data', (pcm48) => {
        this._handleUserPcm(guildId, userId, pcm48).catch((e) => logger.warn(`voice: pcm handling failed: ${e.message}`));
      });
    });

    state.tickTimer = d.setInterval(() => this._tick(guildId), 250);
    logger.info(`voice: joined channel ${channel.id} in guild ${guildId}`);
  }

  async _handleUserPcm(guildId, userId, pcm48Stereo) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const pcm16 = downsampleTo16kMono(pcm48Stereo);

    if (g.machine.state === 'idle') {
      if (g.gate.push(pcm16)) await this._apply(guildId, g.machine.onWake(), { userId });
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
      return;
    }

    let recallContext = '';
    try {
      const r = await this._recall.recall({ recentMessages: [], scope: { userId, channelId: g.channelId, personalityId: 'channel-voice' } });
      recallContext = (r && r.block) || '';
    } catch (e) { logger.warn(`voice: recall failed: ${e.message}`); }

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
      systemPrompt: this._config.voice.systemPrompt || '',
      recallContext, voiceName: this._config.voice.liveVoice });
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
    if (!g) return;
    if (g.tickTimer) this._deps.clearInterval(g.tickTimer);
    this._endSession(g);
    if (g.connection && g.connection.destroy) g.connection.destroy();
    this._guilds.delete(guildId);
    logger.info(`voice: left guild ${guildId}`);
  }
}

module.exports = VoiceService;
