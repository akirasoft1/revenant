'use strict';

// Active-speaker floor arbitration for a shared voice room. Pure logic: no I/O,
// no timers. One holder at a time; others who speak are recorded as "waiting"
// (the signal a future phase uses for "let me finish X, then get to Y").
class FloorControl {
  constructor() {
    this._holder = null;
    this._waiting = new Set();
  }

  grant(userId) {
    if (this._holder === null) { this._holder = userId; return true; }
    if (this._holder === userId) return true;   // already holds it
    this._waiting.add(userId);                   // someone else wants in
    return false;
  }

  holder() { return this._holder; }
  isHolder(userId) { return this._holder === userId; }
  noteWaiting(userId) { if (userId !== this._holder) this._waiting.add(userId); }
  waiting() { return Array.from(this._waiting); }
  release() { this._holder = null; this._waiting.clear(); }
}

module.exports = FloorControl;
