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
const FloorControl = require('./voice/FloorControl');
const { downsampleTo16kMono, upsample24kMonoTo48kStereo } = require('./voice/audio');
const { Readable, PassThrough } = require('stream');

// Rolling pre-roll depth while idle: ~3s of ~20ms frames. Captures the wake
// phrase (and any words spoken with it) so they can be flushed into the session
// once it opens -- otherwise the first-turn question is lost in the wake->session
// startup gap.
const MAX_PREROLL_FRAMES = 150;

// Bound on `g.pending` -- the pre-roll captured at wake PLUS everything the
// floor holder says while the session is still opening. ~10s of ~20ms frames.
//
// It is bounded because an UNBOUNDED buffer holds minutes of backlog when the
// open is slow, and the flush replays all of it into the Live session as
// ordinary user audio -- i.e. as speech happening RIGHT NOW -- so the model
// answers a question the room moved on from. Ten seconds kills that hazard
// exactly as dead as five did.
//
// It is DROP-NEWEST (stop appending once full), which is the opposite of the
// pre-roll above, and the difference is the point. The pre-roll is a sliding
// window over ambient audio nobody has claimed yet: its oldest frame is the
// least interesting thing in it, so drop-oldest is right. `g.pending` is ONE
// utterance captured from its start -- its oldest frames are the wake phrase
// and the beginning of the question, i.e. precisely what the buffer exists to
// preserve. Drop-oldest here truncated the head: "hey jarvis, what's the
// population of Brazil compared to India?" arrived at the model as
// "...compared to India?" and it answered the wrong question.
//
// The two policies together mean the eviction branch is unreachable for any
// plausible first utterance (10s of continuous speech through a session open
// that normally costs ~3s), and when it IS reached the head survives and only
// the tail is lost -- and the tail keeps arriving live the moment the session
// opens, because `_handleUserPcm` streams straight to `g.session` from then on.
const MAX_PENDING_FRAMES = 500;

// How long to wait before re-attempting a speaker-name resolution that came
// back null. `lookupUser` is a CACHE-ONLY Discord lookup (bot.js), so a user
// the cache has not seen yet resolves to nothing on first contact -- and
// without a retry that miss is latched for the whole join: no [SPEAKER: ...]
// marker and no deferral acknowledgment for that person until /voice leave.
// A timestamp compare is all the hot path pays; the resolve itself runs at
// most once a minute per unresolved speaker.
const SPEAKER_NAME_RETRY_MS = 60000;

// Ceiling on the ONE await in the session-open path (`_contextBuilder`, which
// reaches Mongo/Qdrant/Mem0 through RecallService).
//
// `sessionOpening` is cleared only in _startSession's `finally`, and _tick's
// wedge recovery deliberately stands down while it is set. So a _contextBuilder
// promise that never SETTLES -- a hung driver socket, not a rejection -- leaves
// the guild `active` with no session and structurally prevents the very
// recovery that exists for this case: deaf until /voice leave. A rejection was
// always handled; "never answers" was not.
//
// On expiry the open CONTINUES with the fallback context (the configured system
// prompt, no recall, no history) rather than aborting: a voice session that
// answers without memory is far better than one that never opens, and the
// operator gets the warn line. Bounding the await rather than the whole open
// also avoids a torn-down-then-resumed race -- nothing else in _openSession
// awaits, so this single ceiling bounds the entire opening window.
//
// 15s is well past a cold recall build (the slow-open test path this repo
// already models in seconds) and well short of a Discord user concluding the
// bot is dead.
const CONTEXT_BUILD_TIMEOUT_MS = 15000;

// Fallback: how long after the last real-speech frame to send audio_stream_end
// (finalize the turn) when config doesn't provide one.
const DEFAULT_SPEECH_END_SILENCE_MS = 800;

// Backoff for a FAILED deferral acknowledgment. _tick runs at 250ms, so a bare
// retry-every-tick loop is ~240 attempts (and 240 warn lines) per 60s follow-up
// window, and unbounded in /voice listen. Retrying is still correct -- the send
// can fail transiently -- so back off exponentially instead of hammering.
const ACK_RETRY_BASE_MS = 1000;
const ACK_RETRY_MAX_MS = 30000;

// Qualification bar for announcing a waiting speaker, used when the injected
// config carries no usable value. Must match config/config.js's documented
// VOICE_DEFERRAL_MIN_SPEECH_MS default -- a 0 here announces everyone.
const DEFAULT_DEFERRAL_MIN_SPEECH_MS = 700;

class VoiceService {
  constructor({ voiceClient, mongoService, config, deps, contextBuilder, speakerNames }) {
    this._client = voiceClient;
    this._mongo = mongoService;
    this._config = config;
    this._deps = deps;
    this._contextBuilder = contextBuilder;
    // Optional (Phase 3 identity). When absent, _perUser resolves no names and
    // no [SPEAKER: ...] markers are ever sent -- behaves exactly as before.
    this._speakerNames = speakerNames || null;
    // guildId -> { connection, player, machine, session, channelId, buffers,
    //              tickTimer, sessionOpenedAtMs, perUser: Map<userId, {wakeGate,
    //              vadGate, preroll}>, floor: FloorControl }
    this._guilds = new Map();
  }

  isEnabled() { return !!(this._config.voice && this._config.voice.enabled); }

  // Whether WE finalize the turn (explicit audio_stream_end) or leave it to
  // Gemini's automatic server-side VAD. Doing both double-finalizes the same
  // utterance -- the model then transcribes and answers one question twice.
  // Since Phase 1 streams trailing silence continuously, the server VAD is
  // capable of endpointing on its own, so this is a real either/or.
  _clientEndpointing() {
    const v = this._config.voice;
    return !!(v && v.clientEndpointing === true);
  }


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
      `Write for the ear, not the page. Never wrap titles or names in quotation marks — a trailing straight quote gets voiced as the inches symbol, so "Toy Story 3" is read aloud as "Toy Story 3 inches". Just say the title plainly. Avoid other punctuation that gets spoken rather than heard, like parentheses, asterisks, slashes and emoji.`,
      `Say digit strings the way a person would read them out: zip codes, phone numbers, addresses, flight numbers, years and version numbers go digit by digit or in natural pairs — 60067 is "six oh oh six seven", not "sixty thousand sixty-seven". Use ordinary words for ordinary quantities ("72 degrees" is fine).`,
      `You are in a shared voice room. Before someone's turn you may receive a line like "[SPEAKER: Mike]". That is out-of-band metadata telling you who is talking now — NEVER read it aloud, never repeat the brackets or the word SPEAKER, and never mention that you receive it. Use it only to know who you are talking to, and address people by name when it is natural.`,
    ];
    // Kill-switch fidelity: the [SYSTEM: ...] nudge can only ever be injected by
    // the deferral path, so with VOICE_DEFERRAL_ENABLED off this clause would
    // describe a mechanism that can never fire -- a prompt change shipped under a
    // flag that promises "today's exact behaviour". Gate it with the feature.
    if (this._config.voice && this._config.voice.deferralEnabled) {
      note.push(`Lines beginning "[SYSTEM:" are out-of-band notes to you, exactly like the "[SPEAKER:" markers — NEVER read them aloud or mention them. If one tells you someone tried to speak while you were talking, just briefly let that person know you noticed, in your own voice, and then stop and wait for them — don't answer whatever you think they were going to ask.`);
    }
    const text = note.join('\n\n');
    return prompt ? `${prompt}\n\n${text}` : text;
  }

  // Is the bot itself producing audio right now? `player.state.status` stays
  // 'playing'/'buffering' for the whole reply INCLUDING the post-turnComplete
  // drain (Live streams faster than real-time, so the model finishes generating
  // seconds before the speaker stops moving).
  //
  // Fail-safe when there is no player/state/status: assume the bot MAY still be
  // talking. That is the safe default for "has it stopped?" (the deferral
  // announcement then never fires) and it is self-consistent for the waiting
  // accrual too -- a player that never reports a status can never drain, so
  // whatever accrues can never be spent. Unreachable with a real AudioPlayer.
  _botIsSpeaking(g) {
    const status = g && g.player && g.player.state ? g.player.state.status : undefined;
    if (status === undefined || status === null) return true;
    return status === 'playing' || status === 'buffering';
  }

  // Hard cap on a single session's wall clock (0 = uncapped). Exposed so
  // /voice listen can tell the admin the truth about how long "until
  // /voice leave" actually lasts -- see _noteContinuousEnded.
  maxSessionSeconds() {
    return (this._config.voice && this._config.voice.maxSessionSeconds) || 0;
  }

  // Returns what actually happened, because the caller reports it to a human:
  //   { joined: true,  channelId }                             -- connected now
  //   { joined: false, reason: 'already-connected', channelId } -- already in
  //                                                                channelId,
  //                                                                which may NOT
  //                                                                be the one
  //                                                                asked for
  // and still THROWS on the session-limit refusal (an exception the command
  // already renders). Before this, every one of those returned undefined and
  // the command said "Joined <#X>" for all three.
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
      const existingChannelId = this._guilds.get(guildId).channelId;
      logger.info(`voice: already connected in guild ${guildId} (channel ${existingChannelId}); ignoring duplicate /voice join`);
      return { joined: false, reason: 'already-connected', channelId: existingChannelId };
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
    // VC. Per-speaker gates are built lazily on first contact (`_perUser`),
    // well after this `_guilds.set()`; `leave()`/`_endSession()` already guard
    // for a still-empty `perUser` map.
    const state = { connection, player, machine, session: null,
      channelId: channel.id, buffers: { in: [], out: [] }, tickTimer: null,
      sessionOpenedAtMs: null, receiving: new Set(), playback: null,
      pending: null, pendingOverflowed: false,
      lastSpeechAt: null, audioEndSent: false, turnActive: false,
      perUser: new Map(), floor: new FloorControl(), lastSpeakerSent: null,
      ackedThisTurn: false, ackFailures: 0, ackNextAttemptAt: 0,
      // True only while _startSession is between its health gate and its
      // finally. _tick's wedge recovery keys off this so it can't tear down a
      // session that is merely slow to open (the _contextBuilder await).
      sessionOpening: false,
      // Set by a successful listen(); see _noteContinuousEnded.
      continuousRequested: false };
    this._guilds.set(guildId, state);

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
        const u = state.perUser.get(userId);
        const gate = u && u.wakeGate;
        const wakeErr = gate && typeof gate.lastError === 'function' ? gate.lastError() : null;
        const wakeScore = gate && typeof gate.lastScore === 'function' ? gate.lastScore() : null;
        const fs = gate && typeof gate.frameStats === 'function' ? gate.frameStats() : null;
        const meanAbs = probes ? Math.round(sumAbs / probes) : 0;
        logger.debug(`voice: utterance end (${reason}) user ${userId} guild ${guildId}: decoded ${decoded} frame(s), dropped ${dropped}, peak ${peak}/32767, meanAbs ${meanAbs}, wake maxScore ${wakeScore}${fs ? `, engine scheduled ${fs.scheduled}/droppedBusy ${fs.droppedBusy}` : ''}${wakeErr ? `, wake-engine error: ${wakeErr.message}` : ''}`);
      };
      stream.once('end', () => onEnd('end'));
      stream.once('error', (e) => { logger.warn(`voice: receive stream error from user ${userId} in guild ${guildId}: ${e.message}`); onEnd('error'); });
    });

    state.tickTimer = d.setInterval(() => this._tick(guildId), 250);
    logger.info(`voice: joined channel ${channel.id} in guild ${guildId}`);
    return { joined: true, channelId: channel.id };
  }

  // Admin override (/voice listen): join if needed, then open a session
  // immediately with NO wake word and keep it open (continuous listen) until
  // /voice leave or the max-session cap.
  //
  // Returns what actually happened, because the caller reports it to a human:
  //   { listening: true,  channelId }
  //   { listening: false, reason: 'already-active' }   -- a session is live
  //   { listening: false, reason: 'other-channel', channelId } -- we are sitting
  //                                                               in a DIFFERENT
  //                                                               channel; the
  //                                                               invoker's own
  //                                                               channel is not
  //                                                               the one we'd
  //                                                               be hearing
  //   { listening: false, reason: 'session-failed' }   -- the session never
  //                                                       opened (unhealthy
  //                                                       sidecar, or a throw
  //                                                       inside _startSession)
  // It used to return a bare `true` in every one of those cases.
  //
  // Every one of those also carries `joined`: true when THIS call put the bot
  // in the channel. On the failure paths that matters -- the bot is now sitting
  // in the voice channel (wake word live, session not) and a reply that reads
  // as total failure is the same false-reporting defect in the other direction.
  // We do not unwind the join: "connected, wake word required" is a perfectly
  // useful state, and silently disconnecting a channel the admin just pulled the
  // bot into is more surprising than saying so.
  async listen({ channel, guildId, userId }) {
    let joined = false;
    if (!this._guilds.has(guildId)) {
      await this.join({ channel, guildId });
      joined = this._guilds.has(guildId);
    }
    const g = this._guilds.get(guildId);
    if (!g) return { listening: false, reason: 'session-failed', joined };
    // Already connected somewhere else in this guild: forceListen() would open
    // a session that streams the OTHER channel's audio while the admin is told
    // we are listening in theirs.
    if (channel && channel.id && g.channelId !== channel.id) {
      logger.info(`voice: listen requested for channel ${channel.id} but guild ${guildId} is connected to channel ${g.channelId}`);
      return { listening: false, reason: 'other-channel', channelId: g.channelId, joined };
    }
    const actions = g.machine.forceListen();
    if (!actions.length) {
      logger.info(`voice: listen requested but a session is already active in guild ${guildId}`);
      return { listening: false, reason: 'already-active', joined };
    }
    // Grant the floor to the invoking admin, same as the wake path does for
    // whoever says the wake word. Without this, _handleUserPcm's active-branch
    // floor check (`isHolder`) is false for EVERY speaker -- including the
    // invoker -- since forceListen() never otherwise sets a holder, and the
    // session opens but silently forwards no audio at all.
    g.floor.grant(userId);
    await this._apply(guildId, actions, { userId });
    // _startSession leaves `g.session` null on EVERY refusal/failure (the
    // health gate and the catch-all both route through _resetToIdle), so this
    // is the one post-condition that covers all of them -- and it is checked
    // rather than assumed, which is the whole defect here.
    if (!g.session) {
      logger.warn(`voice: listen requested in guild ${guildId} (user ${userId}) but no session opened — listen mode is NOT engaged${joined ? '; the bot DID join the channel and the wake word still works' : ''}`);
      return { listening: false, reason: 'session-failed', joined };
    }
    g.continuousRequested = true;
    logger.info(`voice: listen mode engaged in guild ${guildId} (user ${userId}) — no wake word required`);
    return { listening: true, channelId: g.channelId, joined };
  }

  // Lazily build the per-speaker gate context. Each speaker runs their OWN
  // wake-word + VAD engine (the ONNX engines need contiguous single-speaker
  // frames; a shared gate would interleave two people's audio) and their own
  // pre-roll. Gate factories are the same DI as before, now per user.
  _perUser(g, userId) {
    let u = g.perUser.get(userId);
    if (!u) {
      u = {
        wakeGate: this._deps.makeWakeGate(),
        vadGate: this._deps.makeVadGate ? this._deps.makeVadGate() : null,
        preroll: [],
      };
      u.name = null;
      u.nameResolvedAt = null;
      g.perUser.set(userId, u);
    }
    // Resolve at most once per speaker while it SUCCEEDS -- the hot path must
    // never re-resolve a name we already have. A null, though, is not an
    // answer: `lookupUser` reads the cache only, so a user Discord has not
    // cached yet resolves to nothing on first contact and (before this) stayed
    // nameless for the entire join -- no [SPEAKER: ...] marker and no deferral
    // acknowledgment for that person until /voice leave. Retry on a timer so
    // the cache filling in later is picked up, and so this stays a number
    // compare on the per-frame path.
    if (u.name === null) {
      const now = this._deps.now();
      if (u.nameResolvedAt === null || (now - u.nameResolvedAt) >= SPEAKER_NAME_RETRY_MS) {
        u.nameResolvedAt = now;
        let name = null;
        try {
          name = this._speakerNames
            ? this._speakerNames.resolve(this._deps.lookupUser ? this._deps.lookupUser(userId) : { id: userId }, null)
            : null;
        } catch (e) { logger.warn(`voice: speaker-name resolution failed for ${userId}: ${e.message}`); }
        // Never assert a name we are not confident in (null -> no marker sent).
        u.name = name || null;
        if (u.name) logger.debug(`voice: resolved speaker name for ${userId}: ${u.name}`);
      }
    }
    return u;
  }

  async _handleUserPcm(guildId, userId, pcm48Stereo) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const pcm16 = downsampleTo16kMono(pcm48Stereo);

    if (g.machine.state === 'idle') {
      const u = this._perUser(g, userId);
      // Per-speaker pre-roll so the words spoken WITH the wake phrase aren't lost.
      u.preroll.push(pcm16);
      if (u.preroll.length > MAX_PREROLL_FRAMES) u.preroll.shift();
      if (u.wakeGate.push(pcm16)) {
        // First waker takes the floor; a near-simultaneous second wake loses the
        // race and will be handled by the active path (withheld + noted waiting).
        if (g.floor.grant(userId)) {
          logger.info(`voice: wake word detected in guild ${guildId} (user ${userId}) — floor granted`);
          g.pending = u.preroll.slice(); // carry THIS speaker's wake-phrase audio in
          g.pendingOverflowed = false;   // fresh utterance, fresh overflow latch
          u.preroll = [];
          await this._apply(guildId, g.machine.onWake(), { userId });
        }
      }
      return;
    }
    // Half-duplex (default): while the bot is playing its OWN reply, don't feed
    // the mic back to the model. Without echo cancellation, a speakers->mic loop
    // feeds the bot's voice back as "user input" and it answers itself on a loop.
    // Trade-off: no barge-in while it's speaking. Set VOICE_ALLOW_BARGE_IN=true
    // (headphones only) to permit barge-in -- real speech then interrupts the
    // reply; the VAD gate below still blocks ambient from false-triggering it.
    // player.state.status stays 'playing'/'buffering' through the reply incl.
    // drain, so this covers the tail too.
    //
    // Routed through _botIsSpeaking so there is exactly ONE definition of "the
    // bot is producing audio" in this file. This inlined copy used to treat a
    // player with no `.state` as NOT speaking while _botIsSpeaking treated it as
    // speaking -- unreachable with a real AudioPlayer (which always carries a
    // state), but two opposed fail-safes are a trap for the next reader.
    if (!(this._config.voice && this._config.voice.allowBargeIn)) {
      if (this._botIsSpeaking(g)) return;
    }

    const u = this._perUser(g, userId);

    // ONE VAD push per frame per speaker. The gate is stateful (Silero carries a
    // context tensor from chunk to chunk), so pushing the same frame twice --
    // once to decide whether an unheld floor can be claimed and once to drive the
    // turn -- would advance its internal state twice per 32ms window and skew
    // every speech/silence boundary it reports. Push here; reuse `vad` below.
    const vad = u.vadGate ? u.vadGate.push(pcm16) : null;

    let isHolder = g.floor.isHolder(userId);

    // Floor re-take on an UNHELD floor.
    //
    // The Phase 4 acknowledgment RELEASES the floor (spec §3: nobody gets it, the
    // next person to speak takes it) rather than handing it to someone we have not
    // heard. But the only other grant() sites are the wake branch above -- gated on
    // `machine.state === 'idle'`, which we are past -- and `listen()`. So without
    // this, "the next person simply takes the floor" is fiction: after an
    // acknowledgment the bot invites Bob and then withholds EVERY speaker's audio,
    // including Bob's, until the follow-up window expires (and in `/voice listen`,
    // where `_followupAt` is null, until the max-session cap). One 700ms
    // interjection would deafen the session.
    //
    // We are necessarily past the `state === 'idle'` early-return above, so this
    // only ever runs inside a live session, and only while the floor is genuinely
    // unheld -- while someone holds it, arbitration is exactly as before.
    //
    // Three conditions, and shipping any two of them without the third is unsafe:
    //
    //  1. `deferralEnabled`. The only code path that can leave a live session with
    //     an unheld floor is the Phase 4 acknowledgment, so with the flag off this
    //     branch is already dead -- but it is dead by an INVARIANT ("machine
    //     non-idle => floor held") that nothing pins, and a future fifth
    //     release() site would silently turn that into a live code path under a
    //     flag that promises today's exact behaviour. Gate it structurally.
    //
    //  2. The bot is not itself producing audio (`_botIsSpeaking` -- the same one
    //     definition the half-duplex gate and the drain check use). Production
    //     runs VOICE_ALLOW_BARGE_IN=true, so the half-duplex early-return above
    //     never fires, and the acknowledgment's own audio plays while the floor is
    //     held by NOBODY. Without this guard, that audio re-entering a laptop-
    //     speaker participant's mic is one ~32ms rising edge away from seizing the
    //     floor -- streaming the bot's own voice back to the model as user input
    //     (the self-answering loop the half-duplex comment above exists to
    //     prevent) and locking out the very person the bot just invited, who needs
    //     700ms of speech to qualify as a waiter again.
    //
    //  3. The VAD reports speech -- on LEVEL, not just the rising edge. This is
    //     the same edge-vs-level failure documented at the holder branch below as
    //     the 2026-08-14 outage: VOICE_VAD_MIN_SILENCE_FRAMES is ~768ms, so once
    //     a segment is open no new `justStarted` arrives until it closes. Edge-only
    //     stranded (a) the invited speaker who simply keeps talking through the
    //     acknowledgment, and (b) worse, a holder whose turn Gemini's server VAD
    //     endpointed early: the ack releases the floor out from under them mid-
    //     word and every subsequent frame is `speaking:true, justStarted:false`,
    //     so they are cut off with no way back until they stop talking.
    //     Condition 2 is what makes accepting a level safe.
    if (!isHolder
        && this._config.voice && this._config.voice.deferralEnabled
        && g.floor.holder() === null
        && !this._botIsSpeaking(g)
        && vad && vad.speaking) {
      if (g.floor.grant(userId)) {
        isHolder = true;
        logger.info(`voice: open floor claimed by ${u.name || userId} in guild ${guildId} on VAD speech (machine ${g.machine.state}, onset ${!!vad.justStarted})`);
      }
    }

    // Non-holder: detect that they spoke (for attribution/logging + the future
    // "someone else wants in" signal), but DO NOT forward their audio.
    if (!isHolder) {
      const nv = vad || { speaking: false, justStarted: false, justEnded: false };
      if (nv.speaking) {
        // 16 kHz mono s16le -> 2 bytes/sample. Accrue only REAL speech, so a
        // waiter is measured on how long they actually talked, not on how long
        // Discord happened to deliver packets.
        const ms = Math.round((pcm16.length / 2) / 16);
        // TOTAL withheld speech -- the measurement that sets the threshold. Accrues
        // unconditionally so the debug line below still reports interjections that
        // did NOT overlap the bot's reply; that contrast is the reason it exists.
        u.withheldMs = (u.withheldMs || 0) + ms;
        // QUALIFYING time is only speech that overlapped the bot's own audio. The
        // nudge the sidecar injects asserts "<Name> tried to speak while you were
        // replying" -- and `hot` lasts the whole follow-up window (60s in the
        // deployed configmap) with VOICE_ALLOW_BARGE_IN=true in production, so the
        // half-duplex early-return above never fires either. Without this
        // condition the COMMON qualifying path is someone talking into a silence,
        // and the bot apologises for talking over a reply that never happened.
        if (this._botIsSpeaking(g)) u.waitingMs = (u.waitingMs || 0) + ms;
      }
      if (nv.justStarted) {
        g.floor.noteWaiting(userId);
      }
      if (nv.justEnded) {
        // Qualification is a per-UTTERANCE question ("did this person talk over
        // the bot long enough to be a real interjection?"), so fold the finished
        // utterance into a PEAK and zero the accumulator. Summing across
        // utterances instead let three separate 300ms bursts -- coughs,
        // one-word backchannels, echo -- clear a 700ms bar no single one of them
        // ever reached, which is exactly what the threshold exists to reject.
        //
        // A peak rather than a plain per-utterance reset because the
        // acknowledgment is evaluated in _tick AFTER the utterance ended: a naive
        // reset leaves 0 at every evaluation and the feature never fires at all.
        const utteranceWaitingMs = u.waitingMs || 0;
        u.waitingPeakMs = Math.max(u.waitingPeakMs || 0, utteranceWaitingMs);
        u.waitingMs = 0;
        // Measurement (ships even with the feature off): is this a real
        // interjection, or the bot's own voice re-entering someone's mic? The
        // threshold VOICE_DEFERRAL_MIN_SPEECH_MS is meant to be set from this.
        const playing = g.player && g.player.state && g.player.state.status;
        logger.debug(`voice: withheld speech from ${u.name || userId} in guild ${guildId}: ${u.withheldMs || 0}ms (${utteranceWaitingMs}ms of this utterance overlapping bot playback, longest single utterance of this turn ${u.waitingPeakMs}ms) while ${g.floor.holder()} holds the floor, bot playback=${playing || 'idle'}`);
      }
      return;
    }

    // Floor-holder: Silero VAD drives the turn (same Phase-1 logic, now scoped
    // to this speaker's own gate). A turn opens on speech onset; once open we
    // stream EVERY frame continuously (including the user's pauses and trailing
    // silence) so Gemini's server VAD sees real end-of-speech as a fallback --
    // the fix for the old energy-gate starvation. The turn stops forwarding
    // when _tick fires audio_stream_end (which clears g.turnActive).
    const v = vad || { speaking: true, justStarted: !g.turnActive, justEnded: false };
    // Open the turn on LEVEL, not just the rising edge. `justStarted` alone is
    // edge-triggered, and a missed closing edge wedges the session forever:
    // Discord stops delivering packets the moment a speaker goes quiet, so the
    // gate can miss the ~768ms of sub-threshold frames it needs to close. It
    // then stays "speaking", never emits another rising edge, while _tick's
    // timer independently clears turnActive -- and every later frame falls out
    // at `if (!g.turnActive) return`. That is the 2026-08-14 outage: only the
    // first utterance of a session ever reached the model. Treating "the gate
    // says speech and no turn is open" as an onset makes that self-healing.
    if (v.justStarted || (v.speaking && !g.turnActive)) {
      g.turnActive = true;
      g.audioEndSent = false;
      g.ackedThisTurn = false; // a new turn opened -- allow a fresh deferral announcement
      // ...and the PREVIOUS turn's qualification counters die with it, so a
      // waiter must re-qualify against the reply they actually talked over.
      this._clearTurnQualification(g);
      await this._apply(guildId, g.machine.onUserSpeechStart(), { userId });
    }
    if (v.speaking) g.lastSpeechAt = this._deps.now();
    if (!g.turnActive) return; // between turns: forward nothing
    if (g.session) {
      // Identity travels on speaker CHANGE only -- decoupled from the audio
      // cadence. The sidecar turns this into an out-of-band [SPEAKER: name]
      // marker ahead of this speaker's next chunk.
      //
      // NOTE (Phase 4 dependency): there is currently NO way to CLEAR the
      // speaker once set -- `u.name` null just means "don't send a marker",
      // it never un-sends the last one that WAS sent. A speaker with no
      // resolvable name therefore silently inherits whatever identity the
      // previous speaker last announced. That's unreachable today because
      // there is exactly one floor holder per session (FloorControl), so
      // "the speaker" never legitimately changes to "unknown" mid-session.
      // Phase 4's deferral work and `/voice listen` (continuous listening,
      // no re-wake, no single floor holder) both break that invariant --
      // revisit this when either lands.
      if (u.name && g.lastSpeakerSent !== userId && typeof g.session.sendSpeaker === 'function') {
        g.session.sendSpeaker({ userId, displayName: u.name });
        g.lastSpeakerSent = userId;
      }
      g.session.sendAudio(pcm16);
    } else {
      // Session still opening (post-wake startup): buffer so the first turn
      // isn't lost; _startSession flushes g.pending (pre-roll + these) once the
      // session is up. Bounded, but DROP-NEWEST -- unlike the pre-roll, whose
      // oldest frame is disposable, this buffer's oldest frames are the wake
      // phrase and the start of the question. See MAX_PENDING_FRAMES.
      const pending = g.pending || (g.pending = []);
      if (pending.length < MAX_PENDING_FRAMES) {
        pending.push(pcm16);
      } else if (!g.pendingOverflowed) {
        // Once per open, not once per frame: at 50 frames/s an un-latched log
        // here is 50 warn lines a second for as long as the open is stuck.
        g.pendingOverflowed = true;
        logger.warn(`voice: the pre-session audio buffer filled (${MAX_PENDING_FRAMES} frames, ~${Math.round(MAX_PENDING_FRAMES / 50)}s) in guild ${guildId} while the session was still opening — keeping the start of the utterance and dropping the rest until the session is up`);
      }
    }

    // Early client endpoint (Gemini Hybrid VAD): when Silero declares end-of-speech,
    // finalize the turn NOW rather than waiting on the _tick silence timer. The timer
    // in _tick remains a backstop (fires only if this path didn't, e.g. no session yet).
    if (v.justEnded && g.session && !g.audioEndSent) {
      // Closing the turn LOCALLY and TELLING GEMINI are separate concerns. The
      // local bookkeeping must happen either way -- skipping it would leave
      // turnActive stuck true and (in _tick) the VAD gate un-reset, which is the
      // wedge this class of bug keeps producing. Only the network signal is
      // conditional: when the server VAD owns endpointing, sending our own
      // audio_stream_end finalizes the same audio a SECOND time.
      if (this._clientEndpointing()) {
        try { g.session.sendAudioStreamEnd(); } catch (e) { logger.warn(`voice: audio_stream_end (vad) failed: ${e.message}`); }
      }
      g.audioEndSent = true;
      g.turnActive = false; // stop forwarding until the next speech onset
    }
  }

  // Drop every speaker's per-TURN qualification counters.
  //
  // `waitingMs` / `waitingPeakMs` answer one question: "did this person talk over
  // THIS reply long enough to be a real interjection?" Nothing used to end that
  // question at a turn boundary -- only a successful acknowledgment or
  // _endSession cleared them. So (easy with VOICE_ALLOW_BARGE_IN on, which is
  // what production runs) Bob talks over turn N's reply and qualifies; before
  // playback drains, the holder makes any sound at all, which re-opens the turn
  // and takes the machine hot->active, so turn N's drain-time acknowledgment
  // never fires. Turn N+1 completes and drains, and Bob -- silent since turn N,
  // possibly gone from the channel -- is named then: the bot says "you tried to
  // speak while I was replying" about a reply two turns ago.
  //
  // Spec §9 rejected TTLs, but it rejected them for a waiting QUEUE; it never
  // considered a missed drain, so bounding qualification to its own turn is not a
  // spec violation. FloorControl is untouched (off-limits, and it stores no
  // timing anyway): a stale waiter stays in `waiting()` but can no longer clear
  // the threshold, which is exactly the intended effect.
  //
  // `withheldMs` is deliberately NOT cleared -- that is the session-scoped
  // measurement total (_endSession owns its lifetime).
  //
  // Deliberately NOT gated on `deferralEnabled`: `waitingPeakMs` is also what the
  // withheld-speech measurement log reports and what VOICE_DEFERRAL_MIN_SPEECH_MS
  // is meant to be derived from, so the measurement must measure the same
  // per-turn quantity production thresholds on. A measuring tool that quietly
  // reports something other than the production rule is the exact defect the
  // scripts/test-floor.js fix in this same wave closes.
  _clearTurnQualification(g) {
    if (!g || !g.perUser) return;
    for (const u of g.perUser.values()) { u.waitingMs = 0; u.waitingPeakMs = 0; }
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
        case 'notifyError':
          logger.warn(`voice: live error in guild ${guildId}`);
          // VoiceSessionMachine clears its own `_continuous` on an error, so
          // this is one of the places /voice listen quietly stops being what
          // the admin was told it was.
          this._noteContinuousEnded(g, guildId, 'a Live session error');
          break;
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
      // Discard the captured pre-roll, release the floor so the aborted wake
      // leaves no phantom holder, and reset every detection gate so the tail of
      // this same utterance can't immediately re-fire onWake once the sidecar
      // recovers. _resetToIdle does all of that, and puts the machine back to
      // 'idle' so a subsequent wake still works.
      this._resetToIdle(g, guildId, 'the voice sidecar is unhealthy, so no session was opened');
      return;
    }

    // Everything from here to the finally is the session open. It used to run
    // completely unguarded: any throw (converse() on a closed channel,
    // sendStart on a destroyed duplex, a sendAudio in the flush) left the
    // machine in 'active' with `g.session` null or half-built, and EVERY route
    // back to idle -- _tick's cost cap, the server-event handlers -- is
    // predicated on a session existing. The guild went deaf until /voice leave.
    //
    // The state a failed open must leave behind is the SAME state a refused one
    // leaves (the health gate above): idle machine, no session, nothing
    // buffered, no floor holder. Then the next wake word just works.
    //
    // `sessionOpening` is the flag _tick's wedge recovery uses to tell "opening,
    // be patient" from "wedged" -- the await below is seconds long on a cold
    // recall build, and a recovery that could not tell them apart would tear
    // down every session while it was still opening.
    g.sessionOpening = true;
    try {
      await this._openSession(g, guildId, userId);
    } catch (e) {
      logger.warn(`voice: session open failed in guild ${guildId}: ${e && e.stack ? e.stack : e}`);
      this._resetToIdle(g, guildId, `the session open threw (${e && e.message ? e.message : e})`);
    } finally {
      g.sessionOpening = false;
    }
  }

  // Reject with `message` if `promise` has not settled within `ms`.
  //
  // The timer is ALWAYS cleared, including on the happy path -- an uncleared
  // 15s timer per session open keeps the event loop alive that much longer and
  // shows up as a leaked handle in tests. The losing promise is left to settle
  // (or not) on its own; nothing observes it after the race.
  //
  // Timers come from `deps` when injected so tests can drive expiry
  // deterministically instead of waiting out real wall-clock.
  _withTimeout(promise, ms, message) {
    const setT = this._deps.setTimeout || setTimeout;
    const clearT = this._deps.clearTimeout || clearTimeout;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setT(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer !== null) clearT(timer); });
  }

  async _openSession(g, guildId, userId) {
    let systemPrompt = this._config.voice.systemPrompt || '';
    let recallContext = '';
    let history = [];
    try {
      const ctx = await this._withTimeout(
        this._contextBuilder({
          userId, userTag: '', channelId: g.channelId, guildId,
          userMessage: '', personalityId: 'channel-voice',
        }),
        CONTEXT_BUILD_TIMEOUT_MS,
        `context build timed out after ${CONTEXT_BUILD_TIMEOUT_MS}ms`);
      systemPrompt = ctx.systemPrompt || systemPrompt;
      recallContext = ctx.memoryBlock || '';
      history = ctx.historyTurns || [];
    } catch (e) { logger.warn(`voice: context build failed: ${e.message}`); }

    // `g` was captured before the await above, and `/voice leave` can land during
    // it — deleting the guild entry while this open is still in flight. Without
    // this re-check we would go on to call `converse()` and create a REAL Gemini
    // Live session against a guild that no longer exists: nothing holds a
    // reference to end it, so it bills until the sidecar's own session cap
    // expires. The context-build ceiling widened this window from "however long
    // the builder takes" to a guaranteed-terminating 15s, which makes the race
    // easier to hit, not harder.
    if (this._guilds.get(guildId) !== g) {
      logger.info(`voice: abandoning session open for guild ${guildId} — the guild was released while the context was building`);
      return;
    }

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
    // A CLEAN close from the sidecar. This is not redundant with 'error': the
    // sidecar exits silently on two paths (a reconnect with no resumption
    // handle, and a normal close classified `outcome = "closed"` in
    // live_bridge.py), and on both of them 'end' is the ONLY signal the bot
    // ever gets. Without this handler the guild kept a dead stream as its
    // "live" session: audio and speaker markers written into a closed duplex,
    // and -- because every route back to idle needs a session that still works
    // -- no recovery until the maxSessionSeconds cap 10 minutes later.
    //
    // It tears down the SAME way an error does, deliberately: from the bot's
    // side the two are indistinguishable in consequence (there is no stream to
    // talk on, and the Live context is gone with it), and the resumption logic
    // that could have saved the conversation lives in the sidecar, on the far
    // side of the stream that just closed. What it does NOT do is claim an
    // error: this routes through _resetToIdle rather than the machine's 'error'
    // event, so the logs say "closed", not "failed", and no error is reported
    // for what may be an entirely orderly shutdown.
    session.on('end', () => {
      if (g.session !== session) return;
      logger.warn(`voice: the sidecar closed the Converse stream in guild ${guildId} — ending the session; the next wake word opens a new one`);
      this._resetToIdle(g, guildId, 'the sidecar closed the Converse stream');
    });

    session.sendStart({ userId, channelId: g.channelId, guildId,
      systemPrompt, recallContext, history, voiceName: this._config.voice.liveVoice });

    // The pre-roll/pending flush below sends the wake-triggering utterance
    // directly via session.sendAudio, entirely outside _handleUserPcm's
    // sendSpeaker gate -- so without this, the audio that TRIGGERED the wake
    // word (the most important audio for "who is talking now") would reach
    // the model with no [SPEAKER: name] marker. Label it here, once, for the
    // wake-triggering speaker (same cached u.name as the hot path), and
    // record it so _handleUserPcm doesn't re-send the same marker for the
    // next live frame from this speaker.
    const starter = this._perUser(g, userId);
    if (starter.name && typeof session.sendSpeaker === 'function') {
      session.sendSpeaker({ userId, displayName: starter.name });
      g.lastSpeakerSent = userId;
    }

    // Flush the pre-roll (wake-phrase audio) plus anything buffered while the
    // session was opening, so a first-turn question spoken with the wake phrase
    // reaches the model. gRPC/the sidecar buffer these until the Live session is
    // ready, so ordering (pre-roll first, then live) is preserved.
    if (g.pending && g.pending.length) {
      for (const f of g.pending) session.sendAudio(f);
    }
    g.pending = null;
    g.pendingOverflowed = false;
  }

  // The one definition of "put this guild back where a wake word works again".
  //
  // Used by every path that abandons a session outside the machine's own
  // lifecycle: the health-gate refusal, a throw during the open, a clean
  // sidecar-side stream close, _tick's cost cap, and _tick's wedge recovery.
  // All of them previously either open-coded a partial reset or (the failure
  // paths) did nothing at all.
  //
  // Order matters: _endSession first (it stops playback, ends the gRPC stream,
  // clears buffers/floor/gates and nulls `g.session`), THEN a fresh machine, so
  // nothing can observe an idle machine that still points at a live session.
  _resetToIdle(g, guildId, reason) {
    this._noteContinuousEnded(g, guildId, reason);
    this._endSession(g);
    g.machine = new VoiceSessionMachine({
      followupWindowMs: this._config.voice.followupWindowMs, now: this._deps.now });
    logger.info(`voice: guild ${guildId} returned to idle (wake word required again): ${reason}`);
  }

  // /voice listen promises the admin continuous listening "until /voice leave".
  // Several paths quietly break that promise -- the maxSessionSeconds cap (600s
  // by default, and NOT overridden in the deployed overlay, so ~10 minutes into
  // every listen), a Live error (VoiceSessionMachine clears its own
  // `_continuous`), and a sidecar-side stream close. We do NOT silently
  // re-engage listen mode on those paths: the cap is a cost control and
  // re-opening a session behind the admin's back is exactly what it exists to
  // prevent. So the honest half of the fix is to say so -- here in the logs at
  // the moment it happens, and up front in the /voice listen reply, which now
  // names the cap instead of promising "until /voice leave".
  _noteContinuousEnded(g, guildId, reason) {
    if (!g || !g.continuousRequested) return;
    g.continuousRequested = false;
    logger.warn(`voice: continuous listen mode (/voice listen) ended in guild ${guildId} because ${reason} — a wake word is required again, or re-run /voice listen`);
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
    // Attribute the user turn to whoever currently holds the floor (the real
    // Discord userId). turnComplete/_persistTurn fires before the follow-up
    // window releases the floor, so holder() is still the speaker; fall back to
    // the old placeholder only for the edge where the floor was already
    // released (e.g. a teardown race).
    const speakerId = (g.floor && g.floor.holder()) || 'voice-user';
    if (userText) await this._mongo.recordChannelMessage({ ...base, authorId: speakerId, content: userText, isBot: false });
    if (botText) await this._mongo.recordChannelMessage({ ...base, authorId: 'bot', content: botText, isBot: true });
  }

  // Re-arm the follow-up deadline to a full window from now, WITHOUT reaching
  // into VoiceSessionMachine's internals (it owns `_followupAt`; the service's
  // 'armFollowup' action is deliberately a no-op). The machine already exposes
  // exactly this effect as a pair of public transitions -- the ones a real bot
  // turn goes through -- so drive it through them: onUserSpeechStart() takes
  // 'hot' -> 'active' and drops the stale deadline, onServerEvent('turnComplete')
  // takes 'active' -> 'hot' and arms followupWindowMs from now.
  //
  // Both machine calls are synchronous, so the new deadline is visible to the
  // onTick() at the bottom of the same _tick. Doing it here rather than waiting
  // for the acknowledgment's own real turnComplete is deliberate: if the model
  // never completes that turn, waiting would leave the machine wedged in
  // 'active' with no deadline at all. In continuous (/voice listen) mode the
  // machine's own `_continuous` branch keeps `_followupAt` null, as it should.
  _rearmFollowup(guildId, g) {
    const actions = [
      ...g.machine.onUserSpeechStart(),
      ...g.machine.onServerEvent({ type: 'turnComplete' }),
    ];
    this._apply(guildId, actions).catch((e) => logger.warn(`voice: follow-up re-arm apply failed: ${e.message}`));
  }

  _tick(guildId) {
    const g = this._guilds.get(guildId);
    if (!g) return;
    const now = this._deps.now();

    // Wedge recovery. Deliberately NOT gated on `g.session`: a session open
    // that failed is precisely the case where `g.session` was never set, and
    // gating the recovery on it is what made the wedge permanent. `idle` is the
    // only state in which no session is expected, and `sessionOpening` covers
    // the seconds-long legitimate window where one is on its way.
    if (!g.session && !g.sessionOpening && g.machine.state !== 'idle') {
      this._resetToIdle(g, guildId, `the machine was '${g.machine.state}' with no open session (a session open must have failed)`);
      return;
    }

    // Belt-and-suspenders cost guard: hard-cap a session's wall-clock
    // duration regardless of idle timeout / follow-up window state.
    const capMs = (this._config.voice.maxSessionSeconds || 0) * 1000;
    if (g.session && g.sessionOpenedAtMs !== null && capMs > 0 && (now - g.sessionOpenedAtMs) >= capMs) {
      logger.warn(`voice: maxSessionSeconds cap reached in guild ${guildId}, force-ending session`);
      this._resetToIdle(g, guildId, `the ${this._config.voice.maxSessionSeconds}s maxSessionSeconds cap was reached`);
      return;
    }

    // Debounced end-of-speech: once the user has been quiet for
    // speechEndSilenceMs after their last real-speech frame, tell the Live model
    // the turn is over so it finalizes promptly. This fixes turns that ambient
    // noise would otherwise hold open (streaming ambient can't stop it, but the
    // absence of REAL speech does). Sent at most once per speech->silence cycle.
    const silenceMs = (this._config.voice && this._config.voice.speechEndSilenceMs) || DEFAULT_SPEECH_END_SILENCE_MS;
    if (g.session && g.lastSpeechAt !== null && !g.audioEndSent && (now - g.lastSpeechAt) >= silenceMs) {
      if (this._clientEndpointing()) {
        try { g.session.sendAudioStreamEnd(); } catch (e) { logger.warn(`voice: audio_stream_end failed: ${e.message}`); }
      }
      g.audioEndSent = true;
      g.turnActive = false; // stop forwarding until the next speech onset
      // Keep the floor-holder's VAD gate in lockstep. This timer fires precisely
      // when that gate did NOT close on its own (no trailing silence frames --
      // Discord stops sending packets when the speaker goes quiet), so it still
      // believes speech is in progress and would never emit another rising edge
      // for the next utterance. Only the holder drives the turn, so only the
      // holder's gate needs clearing.
      const holderId = g.floor && g.floor.holder();
      const holder = holderId && g.perUser ? g.perUser.get(holderId) : null;
      if (holder && holder.vadGate && typeof holder.vadGate.reset === 'function') holder.vadGate.reset();
    }

    // --- Phase 4: announce a waiting speaker, then release the floor.
    //
    // The trigger is PLAYBACK DRAIN, not turnComplete. turnComplete only means
    // the MODEL stopped generating -- _endPlayback then ends the stream so the
    // buffered audio drains afterwards, and Live streams faster than real-time,
    // so the bot is typically still talking for seconds after turnComplete.
    // Announcing then would cut it off mid-word.
    if (this._config.voice && this._config.voice.deferralEnabled
        && g.session && !g.ackedThisTurn && g.machine.state === 'hot') {
      // Fail-safe drain check: "neither playing nor buffering", with a missing
      // player/state reading as NOT drained (see _botIsSpeaking).
      const drained = !this._botIsSpeaking(g);
      if (drained) {
        // `|| 0` here used to be the second half of a one-typo footgun: a config
        // that omits the key (or carries a NaN from a bad env value) made the bar
        // 0ms, and `>= 0` is true for EVERY named waiter on their first speech
        // frame -- the design's top-listed risk (false-positive announcement).
        // config/config.js now refuses to produce a non-positive value; this
        // mirrors that so an injected config object can't reintroduce it.
        const configuredMinMs = this._config.voice.deferralMinSpeechMs;
        const minMs = Number.isFinite(configuredMinMs) && configuredMinMs > 0
          ? configuredMinMs : DEFAULT_DEFERRAL_MIN_SPEECH_MS;
        const waiterId = g.floor.waiting().find((id) => {
          const wu = g.perUser.get(id);
          // Qualified = ONE utterance that talked OVER the bot long enough to be
          // a real interjection (waitingMs only accrues while the bot was
          // actually producing audio -- see _handleUserPcm) AND we know what to
          // call them. Never invent a name (Phase 3 rule).
          //
          // max(peak, accumulator) so both shapes work: a FINISHED utterance
          // lives in waitingPeakMs (folded on justEnded), an IN-PROGRESS one is
          // still accruing in waitingMs. Deliberately NOT their sum -- that is
          // the cross-utterance accumulation this split exists to reject.
          return wu && wu.name && Math.max(wu.waitingPeakMs || 0, wu.waitingMs || 0) >= minMs;
        });
        if (waiterId && now < (g.ackNextAttemptAt || 0)) {
          // Backing off from a previous failed send -- see the catch below.
          // Deliberately silent: this path runs every 250ms tick.
        } else if (waiterId) {
          const wu = g.perUser.get(waiterId);
          // Latch, release and clear ONLY if the nudge actually went out.
          // Swallowing the send error and releasing anyway is the worst of both
          // worlds: the model never gets the instruction, nobody is invited, and
          // the floor is dropped for nothing. On failure change nothing and let a
          // later 250ms tick retry.
          let sent = false;
          let failure = null;
          try {
            // The RETURN VALUE is the failure signal, not an exception:
            // VoiceClient's sender catches its own write error and reports it as
            // `false` (it also returns false for a stream that is already ended
            // or destroyed). Relying on a throw meant `sent` was unconditionally
            // true in production and every line below ran for nudges that never
            // left the process. The try/catch stays purely as belt-and-braces for
            // an unexpected throw from some other session implementation.
            //
            // HONEST LIMIT (mirrors the comment on VoiceClient.sendAcknowledgeWaiting):
            // `true` is not a delivery receipt. grpc-js reports a write to a
            // half-dead duplex as an async 'error' event rather than a synchronous
            // throw, so a nudge can still be lost with `sent === true`. Closing
            // that gap needs a sidecar->bot confirmation for AcknowledgeWaiting --
            // a protocol change, parked as a follow-up.
            //
            // `!== false` rather than `=== true`: only an explicit false is a
            // reported failure, so a session object that returns nothing behaves
            // exactly as it did before this contract existed.
            sent = g.session.sendAcknowledgeWaiting({ displayName: wu.name }) !== false;
          } catch (e) {
            sent = false;
            failure = e;
          }
          if (!sent) {
            // Exponential backoff on the retry. _tick is a 250ms timer, so
            // retrying on every tick means ~240 attempts (and 240 identical warn
            // lines) per 60s follow-up window and unbounded in /voice listen.
            // The message stays FULL -- what changes is how often it is emitted,
            // and each line now carries its own attempt/backoff numbers so it is
            // never a verbatim repeat.
            const reason = failure ? failure.message
              : 'the client reported the write did not go out (the Converse stream is closed or the write threw; see the VoiceClient debug line for which)';
            g.ackFailures = (g.ackFailures || 0) + 1;
            const backoffMs = Math.min(ACK_RETRY_MAX_MS, ACK_RETRY_BASE_MS * Math.pow(2, g.ackFailures - 1));
            g.ackNextAttemptAt = now + backoffMs;
            logger.warn(`voice: sendAcknowledgeWaiting failed in guild ${guildId} (attempt ${g.ackFailures}, retrying in ${backoffMs}ms): ${reason}`);
          }
          if (sent) {
            logger.info(`voice: acknowledged waiting speaker ${wu.name} in guild ${guildId} (${Math.max(wu.waitingPeakMs || 0, wu.waitingMs || 0)}ms longest single withheld utterance overlapping playback, ${wu.withheldMs || 0}ms withheld in total)`);
            g.ackedThisTurn = true;
            g.ackFailures = 0;
            g.ackNextAttemptAt = 0;
            // Release rather than hand over: if the invitation lands on nobody,
            // the next real speaker simply takes the floor and the room
            // self-corrects (see the re-take branch in _handleUserPcm, which is
            // what makes that promise true). Handing the floor to someone we have
            // not heard is how you get a deaf bot.
            g.floor.release();
            // Qualification state ONLY. `withheldMs` is the session-scoped
            // measurement counter (see _endSession): zeroing it here silently
            // reset the "Nms withheld in total" figure mid-session, corrupting
            // the very data the measurement exists to gather -- and this log line
            // above is one of its readers.
            this._clearTurnQualification(g);
            g.lastSpeakerSent = null;
            // Clear the model's idea of who is talking, or the next speaker
            // inherits this identity (the hazard Phase 3's review deferred here).
            try { if (typeof g.session.sendSpeaker === 'function') g.session.sendSpeaker({ userId: '', displayName: '' }); }
            catch (e) { logger.warn(`voice: speaker clear failed: ${e.message}`); }
            // The acknowledgment is a fresh bot turn, so give the person we just
            // invited a FULL follow-up window instead of whatever remained of the
            // original speaker's. Without this the deadline stays where the
            // previous turn left it and a late interjection gets the session torn
            // down mid-acknowledgment -- a billed turn that nobody hears.
            this._rearmFollowup(guildId, g);
          }
        }
      }
    }

    this._apply(guildId, g.machine.onTick(now)).catch((e) => logger.warn(`voice: tick apply failed: ${e.message}`));
  }

  _endSession(g) {
    // Tear down any in-progress playback so a half-streamed reply doesn't linger
    // into the next session.
    this._stopPlayback(g);
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
    // Reset audio buffers + speech-end tracking + the floor + every
    // per-speaker gate so the next idle/listen period starts clean. Discard
    // any PCM buffered mid-utterance so the next wake-word window isn't
    // skewed by leftover audio from the just-ended session.
    g.turnActive = false;
    g.pending = null;
    g.pendingOverflowed = false;
    g.lastSpeechAt = null;
    g.audioEndSent = false;
    g.lastSpeakerSent = null; // a new session re-announces the speaker
    g.ackedThisTurn = false;
    // The acknowledgment-retry backoff is per-session state: a fresh session is
    // a fresh gRPC stream, so it must not inherit the old one's failure count.
    g.ackFailures = 0;
    g.ackNextAttemptAt = 0;
    if (g.floor) g.floor.release();
    if (g.perUser) {
      for (const u of g.perUser.values()) {
        if (u.wakeGate && typeof u.wakeGate.reset === 'function') u.wakeGate.reset();
        if (u.vadGate && typeof u.vadGate.reset === 'function') u.vadGate.reset();
        u.preroll = [];
        // Scope the withheld-speech measurement (see the justEnded debug log
        // above) to a single session, not to the whole join. Without this,
        // waitingMs keeps accruing across every wake/talk/idle cycle for as
        // long as the bot stays in the channel (idle auto-leave doesn't
        // exist yet), so a threshold chosen from these numbers would be
        // reading cumulative totals as if they were per-episode durations.
        // Flag-independent on purpose: the measurement ships with
        // deferralEnabled OFF, so this can't ride on that flag.
        u.waitingMs = 0;
        u.waitingPeakMs = 0;
        u.withheldMs = 0;
      }
    }
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
    // EVERY teardown step must run, even when an earlier one throws, and the
    // map entry must go regardless.
    //
    // Two failure modes, and they pull in opposite directions:
    //
    //  - Leaving the entry behind wedges the guild forever: join() then
    //    short-circuits on `_guilds.has(guildId)` and leave() re-enters the
    //    same throwing teardown, so voice is dead there until the pod restarts.
    //    (A throwing gate reset inside _endSession is not hypothetical -- it
    //    has its own regression test.)
    //
    //  - But deleting the entry while SKIPPING connection.destroy() is worse
    //    than either: the bot stays in the voice channel with its
    //    `receiver.speaking.on('start')` handler still wired to the dead
    //    closure, and the next /voice join -- no longer short-circuited --
    //    reuses that same connection and wires a SECOND handler onto the SAME
    //    AudioReceiveStream. Every frame then reaches _handleUserPcm twice,
    //    which is exactly the duplicated-mel-window failure documented in
    //    join() above: the wake word becomes undetectable.
    //
    // So each step is attempted independently, the first error is remembered
    // and rethrown at the end (the caller still reports the failure), and the
    // delete happens unconditionally in between.
    let firstError = null;
    const step = (what, fn) => {
      try { fn(); } catch (e) {
        logger.warn(`voice: ${what} failed while leaving guild ${guildId}: ${e && e.stack ? e.stack : e}`);
        if (!firstError) firstError = e;
      }
    };
    // Inside the guarded region too: a throw here used to skip both the
    // teardown and the delete, leaking the 250ms tick timer against a guild
    // nothing could clean up afterwards.
    step('clearing the tick timer', () => { if (g.tickTimer) this._deps.clearInterval(g.tickTimer); });
    step('ending the live session', () => this._endSession(g));
    step('destroying the voice connection', () => { if (g.connection && g.connection.destroy) g.connection.destroy(); });
    this._guilds.delete(guildId);
    if (firstError) throw firstError;
    // Only on the way out of a teardown that actually completed -- a throw
    // above propagates instead, and the caller says so.
    logger.info(`voice: left guild ${guildId}`);
  }
}

module.exports = VoiceService;
