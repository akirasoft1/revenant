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
          session.emit('error', new Error(ev.error.message || 'voice sidecar error'));
          break;
        default:
          break;
      }
    });
    call.on('error', (err) => session.emit('error', err));
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
