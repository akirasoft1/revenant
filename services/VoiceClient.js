// gRPC client for the Python voice sidecar.
//
// Mirrors services/AgentClient.js: proto load + fixed-interval health polling
// (isHealthy() answers whether the last successful health response was within
// unhealthyThresholdMs), plus a converse() that opens the bidirectional
// Converse stream and surfaces server events as named EventEmitter events.

'use strict';
const { EventEmitter } = require('events');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const logger = require('../logger');

class VoiceClient {
  constructor({
    address,
    protoPath,
    healthIntervalMs = 5000,
    unhealthyThresholdMs = 30000,
    healthDeadlineMs = 2000,
  }) {
    this.address = address;
    this.unhealthyThresholdMs = unhealthyThresholdMs;
    this.healthDeadlineMs = healthDeadlineMs;
    this._lastHealthyAt = 0;
    this._wasHealthy = null; // null = never reported, true/false = last seen
    this._closed = false;

    const def = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(def).discordbot.voice;
    this._stub = new proto.Voice(address, grpc.credentials.createInsecure());

    this._healthTimer = setInterval(() => this._healthCheck(), healthIntervalMs);
    if (this._healthTimer.unref) this._healthTimer.unref();
    this._healthCheck();
  }

  _healthCheck() {
    if (this._closed) return;
    const deadline = new Date(Date.now() + this.healthDeadlineMs);
    this._stub.Health({}, { deadline }, (err, resp) => {
      if (this._closed) return;
      const ok = !err && resp && resp.healthy;
      if (ok) {
        this._lastHealthyAt = Date.now();
      }
      // Log state transitions only — never every tick.
      if (this._wasHealthy === null || this._wasHealthy !== ok) {
        if (ok) {
          logger.info(`VoiceClient health OK -> ${this.address}`);
        } else {
          const reason = err ? `${err.code || ''} ${err.message || err}`.trim() : 'no response';
          logger.warn(`VoiceClient health FAILING -> ${this.address}: ${reason}`);
        }
        this._wasHealthy = ok;
      }
    });
  }

  isHealthy() {
    return Date.now() - this._lastHealthyAt < this.unhealthyThresholdMs;
  }

  converse() {
    const call = this._stub.Converse();
    const session = new EventEmitter();

    call.on('data', (ev) => {
      switch (ev.event) {
        case 'audio':
          session.emit('audio', Buffer.from(ev.audio.pcm));
          break;
        case 'input_transcript':
          session.emit('inputTranscript', ev.input_transcript.text);
          break;
        case 'output_transcript':
          session.emit('outputTranscript', ev.output_transcript.text);
          break;
        case 'turn_complete':
          session.emit('turnComplete');
          break;
        case 'interrupted':
          session.emit('interrupted');
          break;
        case 'error':
          // Same teardown hazard as the transport-error handler below, and this
          // is the MORE likely trigger: the sidecar reports failures over the
          // DATA stream, not the transport one — `live_bridge.py` wraps every
          // non-normal-close exception in a `VoiceServerEvent(error=ErrorEvent)`.
          // `session.end()` only half-closes our write side, so the server keeps
          // delivering until it closes its own; an ErrorEvent in flight when
          // `_endSession` runs `removeAllListeners()` lands here with no listener.
          if (session.listenerCount('error') > 0) {
            session.emit('error', new Error(ev.error.message || 'voice sidecar error'));
          } else {
            logger.warn(`voice: sidecar error event after session teardown (no listener attached): ${(ev.error && ev.error.message) || 'voice sidecar error'}`);
          }
          break;
        default:
          break;
      }
    });
    // `EventEmitter.emit('error')` is special: with no 'error' listener attached,
    // Node THROWS the emitted error rather than dropping it. VoiceService's
    // `_endSession` calls `session.removeAllListeners()` and then `session.end()`,
    // but this gRPC handler stays wired to the underlying call — so a stream error
    // arriving in the window after teardown (sidecar rescheduled, Live connection
    // dropped, or simply the error that CAUSED the teardown arriving late) would
    // throw ERR_UNHANDLED_ERROR synchronously inside the gRPC callback and take
    // the whole bot process down, not just voice.
    call.on('error', (err) => {
      if (session.listenerCount('error') > 0) {
        session.emit('error', err);
        return;
      }
      logger.warn(`voice: gRPC stream error after session teardown (no listener attached): ${err.message}`);
    });
    call.on('end', () => session.emit('end'));

    session.sendStart = (s) =>
      call.write({
        session_start: {
          user_id: s.userId || '',
          user_tag: s.userTag || '',
          channel_id: s.channelId || '',
          guild_id: s.guildId || '',
          system_prompt: s.systemPrompt || '',
          recall_context: s.recallContext || '',
          voice_name: s.voiceName || '',
          history: Array.isArray(s.history) ? s.history.map((t) => ({ role: t.role, content: t.content })) : [],
        },
      });
    session.sendAudio = (buf) => call.write({ audio: { pcm: buf } });
    session.sendAudioStreamEnd = () => {
      try {
        call.write({ audio_stream_end: {} });
      } catch (e) {
        logger.debug(`VoiceClient sendAudioStreamEnd write threw: ${e.message}`);
      }
    };
    session.sendSpeaker = ({ userId, displayName }) => {
      try {
        call.write({ set_speaker: { user_id: userId || '', display_name: displayName || '' } });
      } catch (e) {
        logger.debug(`VoiceClient sendSpeaker write threw: ${e.message}`);
      }
    };
    // Returns TRUE when the event was handed to the stream, FALSE when it
    // provably was not. Unlike its sibling senders this one reports its outcome,
    // because its caller (VoiceService's Phase 4 deferral) latches
    // `ackedThisTurn`, releases the floor and clears every qualification counter
    // on the strength of it -- doing that for a nudge that never left the
    // process means nobody is acknowledged and no retry ever fires.
    //
    // HONEST LIMIT: this is NOT a delivery receipt. grpc-js surfaces a write to a
    // duplex the server has already torn down as an asynchronous 'error' event on
    // the call, not a synchronous throw, so a `true` here means only "as far as
    // this process can tell, it went out" -- not "the sidecar received it". A
    // half-dead stream can still swallow the nudge silently. The real fix is a
    // sidecar->bot confirmation for AcknowledgeWaiting, which is a protocol change
    // and is deliberately parked as a follow-up.
    session.sendAcknowledgeWaiting = ({ displayName }) => {
      // A stream we have already ended or destroyed cannot carry this at all.
      // Node reports that asynchronously, long after the caller has decided the
      // ack "went out"; checking it here turns one real failure mode into an
      // honest synchronous false instead of a lie.
      if (call.writableEnded || call.destroyed) {
        logger.debug(`VoiceClient sendAcknowledgeWaiting skipped: the Converse stream is already closed (writableEnded=${!!call.writableEnded}, destroyed=${!!call.destroyed})`);
        return false;
      }
      try {
        call.write({ acknowledge_waiting: { display_name: displayName || '' } });
        return true;
      } catch (e) {
        logger.debug(`VoiceClient sendAcknowledgeWaiting write threw: ${e.message}`);
        return false;
      }
    };
    session.end = () => {
      try {
        call.write({ session_end: {} });
      } catch (e) {
        logger.debug(`VoiceClient session.end write threw: ${e.message}`);
      }
      call.end();
    };
    return session;
  }

  close() {
    this._closed = true;
    if (this._healthTimer) clearInterval(this._healthTimer);
    if (this._stub && typeof this._stub.close === 'function') {
      try {
        this._stub.close();
      } catch (e) {
        logger.debug(`VoiceClient stub.close threw: ${e.message}`);
      }
    }
  }
}

module.exports = VoiceClient;
