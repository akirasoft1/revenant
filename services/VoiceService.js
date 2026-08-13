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
const { Readable, PassThrough } = require('stream');

// Rolling pre-roll depth while idle: ~3s of ~20ms frames. Captures the wake
// phrase (and any words spoken with it) so they can be flushed into the session
// once it opens -- otherwise the first-turn question is lost in the wake->session
// startup gap.
const MAX_PREROLL_FRAMES = 150;

// A frame whose mean |sample| (int16 scale) is >= this counts as real speech
// (vs. ambient ~0-20). In the active/hot path (_handleUserPcm) sub-threshold
// frames ARE dropped — not streamed — to block false barge-ins and stop ambient
// from holding a turn open; the same signal also times the debounced
// audio_stream_end. NOTE: this fixed-threshold energy gate is a crude client-side
// VAD slated for rework — the SOTA path is to stop dropping frames and let
// Gemini's server VAD endpoint (or run Silero client-side). See the voice VAD
// brainstorm/spec before extending this constant.
const REAL_SPEECH_MEANABS = 50;

// Fallback: how long after the last real-speech frame to send audio_stream_end
// (finalize the turn) when config doesn't provide one.
const DEFAULT_SPEECH_END_SILENCE_MS = 800;

// Cheap strided mean-|sample| of an s16le PCM buffer.
function frameMeanAbs(buf) {
  let sum = 0;
  let n = 0;
  for (let off = 0; off + 1 < buf.length; off += 64) { sum += Math.abs(buf.readInt16LE(off)); n += 1; }
  return n ? sum / n : 0;
}

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

  // Voice-only note appended to the system prompt: (1) own the wake-phrase name
  // ("hey jarvis" -> "Jarvis") so it doesn't reply "I'm not Jarvis", and (2)
  // mandate PROACTIVE web-search use so it looks things up instead of deflecting
  // with "I don't know" / "I don't play that game" (the model has the
  // google_search tool but, left to the persona + seeded history, won't use it
  // unless explicitly told to -- observed live: it only searched when asked to).
  _appendVoicePersona(prompt) {
    const wake = this.wakeWord();
    const name = (wake || '').replace(/^\s*(hey|ok|okay|hi|yo|hello)\s+/i, '').trim() || wake;
    const nameCap = name ? name.charAt(0).toUpperCase() + name.slice(1) : 'the assistant';
    const note = [
      `You're in a live voice chat. People get your attention with the wake phrase "${wake}", so they call you "${nameCap}" — answer to that name and keep your usual voice and tone. Don't tell anyone you aren't ${nameCap}.`,
      `You have a live web search tool. Actually use it: when asked about facts, game mechanics, how-tos, lore, current events, or anything you're not sure of, search first and give the real answer in your own voice. Never brush someone off with "I don't know" or "I don't play that game" when it's something you could look up.`,
      `Your replies are spoken aloud by a text-to-speech voice, so never write out laughter or sound effects as text — no "hehe", "haha", "lol", "*laughs*", etc. They get read literally and sound robotic. Convey amusement through your wording and delivery instead. Keep replies conversational and reasonably brief.`,
    ].join('\n\n');
    return prompt ? `${prompt}\n\n${note}` : note;
  }

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
    // DAVE (Discord's MLS end-to-end voice encryption) defaults ON in
    // @discordjs/voice; set it explicitly so the choice is intentional. Decrypt
    // happens transparently before we see packets -- but if it ever fails,
    // packets are dropped UPSTREAM (silent gaps, not decode errors), which would
    // show up as a low "decoded N frames" count in the utterance diagnostics.
    const connection = d.joinVoiceChannel({
      channelId: channel.id, guildId, adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: false, daveEncryption: true });
    const player = d.createAudioPlayer();
    connection.subscribe(player);

    // Defense-in-depth: a voice connection/networking failure must never crash
    // the whole bot. Root cause of an observed crash was the voice-gateway WSS
    // connect failing (a non-443 endpoint blocked by NetworkPolicy) and the
    // socket error surfacing as an uncaught AggregateError. The NetworkPolicy is
    // the real fix; these handlers ensure any future connection/player error
    // degrades to a log instead of taking the process down.
    if (typeof connection.on === 'function') {
      connection.on('error', (e) => logger.warn(`voice: connection error in guild ${guildId}: ${e && e.message ? e.message : e}`));
    }
    if (typeof player.on === 'function') {
      player.on('error', (e) => logger.warn(`voice: player error in guild ${guildId}: ${e && e.message ? e.message : e}`));
    }
    // Observability for DAVE E2EE: log its state once the connection is Ready so
    // a silent-drop DAVE failure is diagnosable (see daveEncryption note above).
    if (d.VoiceConnectionStatus && typeof connection.on === 'function') {
      connection.on(d.VoiceConnectionStatus.Ready, () => {
        let privacy;
        try { privacy = connection.state && connection.state.networking && connection.state.networking.state
          && connection.state.networking.state.dave && connection.state.networking.state.dave.voicePrivacyCode; } catch (_) { /* internal */ }
        logger.info(`voice: connection ready in guild ${guildId}; DAVE E2EE on${privacy ? `, privacy code ${privacy}` : ''}`);
      });
    }
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
      sessionOpenedAtMs: null, receiving: new Set(), playback: null,
      preroll: [], pending: null, lastSpeechAt: null, audioEndSent: false };
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
      let peak = 0;       // max |sample| seen (int16 scale, 32767 = full) -- wake-debug
      let sumAbs = 0;     // running sum of |sample| over strided probe
      let probes = 0;
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
        // Cheap strided amplitude probe (every 32nd 16-bit sample): is the mic
        // audio actually loud speech, or near-silence? A flat-zero wake score on
        // decoded audio is usually too-quiet input (or Discord noise suppression).
        for (let off = 0; off + 1 < pcm48.length; off += 64) {
          const s = Math.abs(pcm48.readInt16LE(off));
          if (s > peak) peak = s;
          sumAbs += s; probes += 1;
        }
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
        const fs = state.gate && typeof state.gate.frameStats === 'function' ? state.gate.frameStats() : null;
        const meanAbs = probes ? Math.round(sumAbs / probes) : 0;
        logger.debug(`voice: utterance end (${reason}) user ${userId} guild ${guildId}: decoded ${decoded} frame(s), dropped ${dropped}, peak ${peak}/32767, meanAbs ${meanAbs}, wake maxScore ${wakeScore}${fs ? `, engine scheduled ${fs.scheduled}/droppedBusy ${fs.droppedBusy}` : ''}${wakeErr ? `, wake-engine error: ${wakeErr.message}` : ''}`);
      };
      stream.once('end', () => onEnd('end'));
      stream.once('error', (e) => { logger.warn(`voice: receive stream error from user ${userId} in guild ${guildId}: ${e.message}`); onEnd('error'); });
    });

    state.tickTimer = d.setInterval(() => this._tick(guildId), 250);
    logger.info(`voice: joined channel ${channel.id} in guild ${guildId}`);
  }

  // Admin override (/voice listen): join if needed, then open a session
  // immediately with NO wake word and keep it open (continuous listen) until
  // /voice leave or the max-session cap. Returns true if listen mode engaged.
  async listen({ channel, guildId, userId }) {
    if (!this._guilds.has(guildId)) {
      await this.join({ channel, guildId });
    }
    const g = this._guilds.get(guildId);
    if (!g) return false;
    const actions = g.machine.forceListen();
    if (!actions.length) {
      logger.info(`voice: listen requested but a session is already active in guild ${guildId}`);
      return false;
    }
    await this._apply(guildId, actions, { userId });
    logger.info(`voice: listen mode engaged in guild ${guildId} (user ${userId}) — no wake word required`);
    return true;
  }

  async _handleUserPcm(guildId, userId, pcm48Stereo) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const pcm16 = downsampleTo16kMono(pcm48Stereo);

    if (g.machine.state === 'idle') {
      // Keep a short rolling pre-roll so the words spoken WITH the wake phrase
      // aren't lost while the session opens.
      g.preroll.push(pcm16);
      if (g.preroll.length > MAX_PREROLL_FRAMES) g.preroll.shift();
      if (g.gate.push(pcm16)) {
        logger.info(`voice: wake word detected in guild ${guildId} (user ${userId})`);
        g.pending = g.preroll.slice(); // carry the wake-phrase audio into the session
        g.preroll = [];
        await this._apply(guildId, g.machine.onWake(), { userId });
      }
      return;
    }
    // Half-duplex (default): while the bot is playing its OWN reply, don't feed
    // the mic back to the model. Without echo cancellation, a speakers->mic loop
    // feeds the bot's voice back as "user input" and it answers itself on a loop.
    // Trade-off: no barge-in while it's speaking. Set VOICE_ALLOW_BARGE_IN=true
    // (headphones only) to permit barge-in -- real speech then interrupts the
    // reply; the energy gate below still blocks ambient from false-triggering it.
    // player.state.status stays 'playing'/'buffering' through the reply incl.
    // drain, so this covers the tail too.
    if (!(this._config.voice && this._config.voice.allowBargeIn)) {
      const playing = g.player && g.player.state && g.player.state.status;
      if (playing === 'playing' || playing === 'buffering') return;
    }

    // active/hot: only forward REAL speech to the Live model; drop ambient/
    // near-silence. This prevents (1) FALSE barge-ins -- with
    // START_OF_ACTIVITY_INTERRUPTS, Gemini would otherwise hear breathing/room
    // noise while the bot is talking and cut its own reply off ("Premature
    // close" on the playback stream) -- and (2) ambient holding a turn open.
    // Turn FINALIZATION no longer needs trailing silence: _tick sends an
    // explicit audio_stream_end after the user goes quiet (that was the missing
    // piece the first time we tried gating). Real speech is meanAbs ~200+;
    // ambient ~0-20.
    if (frameMeanAbs(pcm16) < REAL_SPEECH_MEANABS) return;
    g.lastSpeechAt = this._deps.now();
    g.audioEndSent = false;
    await this._apply(guildId, g.machine.onUserSpeechStart(), { userId });
    if (g.session) {
      g.session.sendAudio(pcm16);
    } else {
      // Session still opening (post-wake startup): buffer so nothing is lost;
      // _startSession flushes g.pending (pre-roll + these) once the session is up.
      (g.pending || (g.pending = [])).push(pcm16);
    }
  }

  async _apply(guildId, actions, ctx = {}) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    for (const a of actions) {
      switch (a.type) {
        case 'startSession': await this._startSession(guildId, ctx.userId); break;
        case 'play': this._play(g, a.pcm); break;
        case 'stopPlayback': this._stopPlayback(g); break;
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
      g.pending = null; // drop the captured pre-roll; no session to receive it
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

    // Voice-only persona note: people summon the bot by its wake phrase, so they
    // address it by that name. Without this the model replies "I'm not Jarvis".
    systemPrompt = this._appendVoicePersona(systemPrompt);

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
      // End (not destroy) the turn's playback stream so its buffered audio
      // drains and the resource completes naturally; the next turn opens a
      // fresh stream.
      this._endPlayback(g);
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

    // Flush the pre-roll (wake-phrase audio) plus anything buffered while the
    // session was opening, so a first-turn question spoken with the wake phrase
    // reaches the model. gRPC/the sidecar buffer these until the Live session is
    // ready, so ordering (pre-roll first, then live) is preserved.
    if (g.pending && g.pending.length) {
      for (const f of g.pending) session.sendAudio(f);
    }
    g.pending = null;
  }

  _play(g, pcm24Mono) {
    const d = this._deps;
    const pcm48 = upsample24kMonoTo48kStereo(pcm24Mono);
    // Gemini Live streams many small 24kHz-mono PCM chunks per turn, faster than
    // real-time. Playing each chunk as its own AudioResource made every chunk
    // interrupt the previous one (AudioPlayer.play replaces the current
    // resource), so only slivers were heard -> garbled noise. Instead, open ONE
    // continuous 48kHz-stereo raw stream per turn and write chunks into it, so
    // the whole reply plays as a single uninterrupted resource.
    if (!g.playback) {
      const stream = new PassThrough({ highWaterMark: 1 << 22 });
      // A raw-PCM stream that only ever ends between turns must not surface an
      // unhandled 'error' if the player tears it down mid-write.
      stream.on('error', (e) => {
        // ERR_STREAM_PREMATURE_CLOSE is expected when we intentionally destroy
        // the playback stream on a barge-in / session end — don't cry wolf.
        if (e && e.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        logger.warn(`voice: playback stream error: ${e.message}`);
      });
      const resource = d.createAudioResource(stream, { inputType: d.StreamType.Raw });
      g.playback = { stream };
      g.player.play(resource);
    }
    g.playback.stream.write(pcm48);
  }

  // Barge-in / hard stop: cut playback immediately and drop the buffered audio.
  _stopPlayback(g) {
    g.player.stop();
    if (g.playback) {
      try { g.playback.stream.destroy(); } catch (_) { /* already gone */ }
      g.playback = null;
    }
  }

  // End of a turn: close the stream so buffered audio drains and the resource
  // completes; the next turn's first chunk opens a fresh stream.
  _endPlayback(g) {
    if (g.playback) {
      try { g.playback.stream.end(); } catch (_) { /* already ended */ }
      g.playback = null;
    }
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

    // Debounced end-of-speech: once the user has been quiet for
    // speechEndSilenceMs after their last real-speech frame, tell the Live model
    // the turn is over so it finalizes promptly. This fixes turns that ambient
    // noise would otherwise hold open (streaming ambient can't stop it, but the
    // absence of REAL speech does). Sent at most once per speech->silence cycle.
    const silenceMs = (this._config.voice && this._config.voice.speechEndSilenceMs) || DEFAULT_SPEECH_END_SILENCE_MS;
    if (g.session && g.lastSpeechAt !== null && !g.audioEndSent && (now - g.lastSpeechAt) >= silenceMs) {
      try { g.session.sendAudioStreamEnd(); } catch (e) { logger.warn(`voice: audio_stream_end failed: ${e.message}`); }
      g.audioEndSent = true;
    }

    this._apply(guildId, g.machine.onTick(now)).catch((e) => logger.warn(`voice: tick apply failed: ${e.message}`));
  }

  _endSession(g) {
    // Tear down any in-progress playback so a half-streamed reply doesn't linger
    // into the next session.
    this._stopPlayback(g);
    // Reset audio buffers + speech-end tracking so the next idle/listen period
    // starts clean.
    g.pending = null;
    g.preroll = [];
    g.lastSpeechAt = null;
    g.audioEndSent = false;
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
