// Progress signals for slow chat turns. A turn whose model call runs a grounded
// Google Search can take minutes (220s observed 2026-10-23); without a signal
// the user sees nothing change and resends, assuming the bot gave up.
const {
  startTypingKeepAlive,
  startSlowTurnNotice,
  formatElapsed,
  slowChatStatusText,
} = require('../../utils/chatProgress');

describe('formatElapsed', () => {
  test.each([
    [0, '0s'],
    [999, '0s'],
    [30000, '30s'],
    [59999, '59s'],
    [60000, '1m 00s'],
    [125000, '2m 05s'],
    [3600000, '60m 00s'],
  ])('%i ms -> %s', (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe('slowChatStatusText', () => {
  test('names the elapsed time and tells the user not to resend', () => {
    const text = slowChatStatusText(45000);
    expect(text).toContain('45s');
    expect(text.toLowerCase()).toContain('still working');
    expect(text.toLowerCase()).toContain('no need to resend');
  });
});

describe('startTypingKeepAlive', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('sends typing immediately and re-sends every interval until stopped', async () => {
    const channel = { sendTyping: jest.fn().mockResolvedValue(undefined) };
    const stop = startTypingKeepAlive(channel, { intervalMs: 8000 });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(8000);
    expect(channel.sendTyping).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(16000);
    expect(channel.sendTyping).toHaveBeenCalledTimes(4);

    stop();
    jest.advanceTimersByTime(60000);
    expect(channel.sendTyping).toHaveBeenCalledTimes(4);
  });

  test('a failing sendTyping never throws or stops the keep-alive', async () => {
    const channel = { sendTyping: jest.fn().mockRejectedValue(new Error('Missing Access')) };
    const stop = startTypingKeepAlive(channel, { intervalMs: 8000 });
    await Promise.resolve();
    jest.advanceTimersByTime(8000);
    await Promise.resolve();
    expect(channel.sendTyping).toHaveBeenCalledTimes(2);
    stop();
  });

  test('a channel without sendTyping is a no-op', () => {
    const stop = startTypingKeepAlive({}, { intervalMs: 8000 });
    expect(() => stop()).not.toThrow();
  });

  test('stop is idempotent', () => {
    const channel = { sendTyping: jest.fn().mockResolvedValue(undefined) };
    const stop = startTypingKeepAlive(channel);
    stop();
    expect(() => stop()).not.toThrow();
  });
});

describe('startSlowTurnNotice', () => {
  let now;
  beforeEach(() => {
    jest.useFakeTimers();
    now = 1_000_000;
  });
  afterEach(() => jest.useRealTimers());

  const clock = () => now;
  const advance = async (ms) => {
    now += ms;
    jest.advanceTimersByTime(ms);
    // let any callback promise chains settle
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  test('a fast turn never fires the notice', async () => {
    const onSlow = jest.fn();
    const onTick = jest.fn();
    const notice = startSlowTurnNotice({ afterMs: 30000, tickMs: 15000, onSlow, onTick, now: clock });
    await advance(29000);
    await notice.stop();
    await advance(60000);
    expect(onSlow).not.toHaveBeenCalled();
    expect(onTick).not.toHaveBeenCalled();
    expect(notice.fired()).toBe(false);
  });

  test('fires onSlow at afterMs, then onTick every tickMs with the elapsed time', async () => {
    const onSlow = jest.fn().mockResolvedValue(undefined);
    const onTick = jest.fn().mockResolvedValue(undefined);
    const notice = startSlowTurnNotice({ afterMs: 30000, tickMs: 15000, onSlow, onTick, now: clock });

    await advance(30000);
    expect(onSlow).toHaveBeenCalledWith(30000);
    expect(notice.fired()).toBe(true);
    expect(onTick).not.toHaveBeenCalled();

    await advance(15000);
    expect(onTick).toHaveBeenLastCalledWith(45000);
    await advance(15000);
    expect(onTick).toHaveBeenLastCalledWith(60000);
    expect(onTick).toHaveBeenCalledTimes(2);

    await notice.stop();
    await advance(60000);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  test('without onTick only onSlow runs', async () => {
    const onSlow = jest.fn().mockResolvedValue(undefined);
    const notice = startSlowTurnNotice({ afterMs: 30000, tickMs: 15000, onSlow, now: clock });
    await advance(90000);
    expect(onSlow).toHaveBeenCalledTimes(1);
    await notice.stop();
  });

  test('stop() waits for an in-flight callback so a late status edit cannot overwrite the answer', async () => {
    let resolveSlow;
    const order = [];
    const onSlow = jest.fn(() => new Promise((r) => { resolveSlow = () => { order.push('status-edit'); r(); }; }));
    const notice = startSlowTurnNotice({ afterMs: 30000, tickMs: 15000, onSlow, now: clock });
    await advance(30000);
    expect(onSlow).toHaveBeenCalled();

    const stopped = notice.stop().then(() => order.push('stopped'));
    await Promise.resolve();
    expect(order).toEqual([]);
    resolveSlow();
    await stopped;
    expect(order).toEqual(['status-edit', 'stopped']);
  });

  test('ticks never overlap: a slow tick is skipped, not stacked', async () => {
    let resolveTick;
    const onSlow = jest.fn().mockResolvedValue(undefined);
    const onTick = jest.fn(() => new Promise((r) => { resolveTick = r; }));
    const notice = startSlowTurnNotice({ afterMs: 30000, tickMs: 15000, onSlow, onTick, now: clock });
    await advance(30000);
    await advance(15000);               // tick 1 starts and hangs
    await advance(15000);               // tick 2 due while tick 1 in flight -> skipped
    expect(onTick).toHaveBeenCalledTimes(1);
    resolveTick();
    await advance(0);                   // let tick 1's promise chain settle
    await advance(15000);               // tick 3 runs
    expect(onTick).toHaveBeenCalledTimes(2);
    resolveTick();
    await notice.stop();
  });

  test('callback failures are swallowed and later ticks still run', async () => {
    const onSlow = jest.fn().mockRejectedValue(new Error('Unknown interaction'));
    const onTick = jest.fn().mockRejectedValue(new Error('rate limited'));
    const notice = startSlowTurnNotice({ afterMs: 30000, tickMs: 15000, onSlow, onTick, now: clock });
    await advance(30000);
    await advance(15000);
    await advance(15000);
    expect(onTick).toHaveBeenCalledTimes(2);
    await expect(notice.stop()).resolves.toBeUndefined();
  });

  test('stop is idempotent', async () => {
    const notice = startSlowTurnNotice({ afterMs: 30000, onSlow: jest.fn(), now: clock });
    await notice.stop();
    await expect(notice.stop()).resolves.toBeUndefined();
  });
});
