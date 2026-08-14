'use strict';

class VoiceSessionMachine {
  constructor({ followupWindowMs = 15000, now = () => Date.now() } = {}) {
    this._followupWindowMs = followupWindowMs;
    this._now = now;
    this._state = 'idle';
    this._followupAt = null;
    this._continuous = false; // set by forceListen(): stay open, never idle-out
  }

  get state() { return this._state; }

  onWake() {
    if (this._state !== 'idle') return [];
    this._state = 'active';
    return [{ type: 'startSession' }];
  }

  // Admin override (/voice listen): open a session immediately with NO wake word
  // and keep listening between turns (no re-wake). Unlike onWake, the follow-up
  // window never idles it out -- only /voice leave or the max-session cap ends it.
  forceListen() {
    if (this._state !== 'idle') return [];
    this._state = 'active';
    this._continuous = true;
    return [{ type: 'startSession' }];
  }

  onServerEvent(evt) {
    switch (evt.type) {
      case 'audio':
        return [{ type: 'play', pcm: evt.pcm }];
      case 'interrupted':
        return [{ type: 'stopPlayback' }];
      case 'turnComplete':
        if (this._state === 'active') {
          this._state = 'hot';
          if (this._continuous) {
            // Continuous listen: stay hot with no teardown timer, so a series of
            // questions needs no wake word and never idles out on its own.
            this._followupAt = null;
            return [];
          }
          this._followupAt = this._now() + this._followupWindowMs;
          return [{ type: 'armFollowup', atMs: this._followupAt }];
        }
        return [];
      case 'error':
        this._state = 'idle';
        this._followupAt = null;
        this._continuous = false;
        return [{ type: 'endSession' }, { type: 'notifyError' }];
      default:
        return []; // transcripts handled by the service
    }
  }

  onUserSpeechStart() {
    if (this._state === 'hot') {
      this._state = 'active';
      this._followupAt = null;
      return [{ type: 'cancelFollowup' }];
    }
    return [];
  }

  onTick(nowMs) {
    if (this._state === 'hot' && this._followupAt !== null && nowMs >= this._followupAt) {
      this._state = 'idle';
      this._followupAt = null;
      return [{ type: 'endSession' }];
    }
    return [];
  }
}

module.exports = VoiceSessionMachine;
