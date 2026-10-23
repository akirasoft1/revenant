// utils/chatProgress.js
// "Still working" signals for slow chat turns.
//
// A turn whose model call runs a grounded Google Search can take minutes
// (220s for one Gemini call on 2026-10-23; three calls over 60s that week).
// Discord's own indicators don't cover that: a deferred /chat shows a static
// "is thinking…" that reads as hung after a minute, and channel.sendTyping()
// expires after ~10s, so a mention turn showed nothing at all for most of the
// wait. Users resent their question, assuming the bot had given up.
//
// Two helpers, both failure-isolated (a progress signal must never fail or
// delay the turn it decorates):
//   - startTypingKeepAlive: re-sends the typing indicator until stopped.
//   - startSlowTurnNotice:  after `afterMs`, runs onSlow once, then onTick
//     every `tickMs`; stop() resolves only after any in-flight callback, so a
//     late status edit can never land on top of the final answer.

const logger = require('../logger');

const TYPING_KEEPALIVE_MS = 8000;      // Discord drops the indicator after ~10s
const SLOW_TURN_NOTICE_AFTER_MS = 30000;
const SLOW_TURN_TICK_MS = 15000;
const SLOW_TURN_REACTION = '⏳';

function formatElapsed(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}m ${seconds}s`;
}

function slowChatStatusText(elapsedMs) {
  return `⏳ Still working on your reply (${formatElapsed(elapsedMs)} so far). ` +
    'Answers that search the web can take a few minutes. No need to resend.';
}

function startTypingKeepAlive(channel, { intervalMs = TYPING_KEEPALIVE_MS } = {}) {
  if (!channel || typeof channel.sendTyping !== 'function') return () => {};
  const send = () => {
    try {
      Promise.resolve(channel.sendTyping()).catch(err =>
        logger.debug(`chat progress: sendTyping failed: ${err.message}`));
    } catch (err) {
      logger.debug(`chat progress: sendTyping failed: ${err.message}`);
    }
  };
  send();
  let timer = setInterval(send, intervalMs);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

function startSlowTurnNotice({
  afterMs = SLOW_TURN_NOTICE_AFTER_MS,
  tickMs = SLOW_TURN_TICK_MS,
  onSlow,
  onTick = null,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  let fired = false;
  let stopped = false;
  let inFlight = null;
  let startTimer = null;
  let tickTimer = null;

  const run = (fn) => {
    if (stopped || inFlight || typeof fn !== 'function') return;
    const elapsed = now() - startedAt;
    inFlight = Promise.resolve()
      .then(() => fn(elapsed))
      .catch(err => logger.debug(`chat progress: slow-turn notice failed: ${err.message}`))
      .finally(() => { inFlight = null; });
  };

  startTimer = setTimeout(() => {
    startTimer = null;
    if (stopped) return;
    fired = true;
    run(onSlow);
    if (onTick) {
      tickTimer = setInterval(() => run(onTick), tickMs);
      tickTimer.unref?.();
    }
  }, afterMs);
  startTimer.unref?.();

  return {
    fired: () => fired,
    async stop() {
      stopped = true;
      if (startTimer) clearTimeout(startTimer);
      if (tickTimer) clearInterval(tickTimer);
      startTimer = null;
      tickTimer = null;
      if (inFlight) await inFlight;
    },
  };
}

module.exports = {
  startTypingKeepAlive,
  startSlowTurnNotice,
  formatElapsed,
  slowChatStatusText,
  TYPING_KEEPALIVE_MS,
  SLOW_TURN_NOTICE_AFTER_MS,
  SLOW_TURN_TICK_MS,
  SLOW_TURN_REACTION,
};
