'use strict';

class VoiceSessionMachine {
  constructor({ followupWindowMs = 15000, now = () => Date.now() } = {}) {
    this._followupWindowMs = followupWindowMs;
    this._now = now;
    this._state = 'idle';
    this._followupAt = null;
  }

  get state() { return this._state; }

  onWake() {
    if (this._state !== 'idle') return [];
    this._state = 'active';
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
          this._followupAt = this._now() + this._followupWindowMs;
          return [{ type: 'armFollowup', atMs: this._followupAt }];
        }
        return [];
      case 'error':
        this._state = 'idle';
        this._followupAt = null;
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
