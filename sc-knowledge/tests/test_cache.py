import pytest
from src.cache import TTLCache, RateLimiter


class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t


async def test_miss_then_hit_then_expire():
    clk = Clock(); c = TTLCache(clock=clk); calls = []
    async def fetch():
        calls.append(1); return len(calls)
    r1 = await c.get_or_fetch("k", 10, fetch)
    assert (r1.value, r1.status) == (1, "miss")
    clk.t += 5
    r2 = await c.get_or_fetch("k", 10, fetch)
    assert (r2.value, r2.status, r2.age_s) == (1, "hit", 5.0)
    clk.t += 6
    r3 = await c.get_or_fetch("k", 10, fetch)
    assert (r3.value, r3.status) == (2, "miss")


async def test_stale_on_error_serves_expired_entry():
    clk = Clock(); c = TTLCache(clock=clk)
    async def ok(): return "v1"
    async def boom(): raise RuntimeError("upstream down")
    await c.get_or_fetch("k", 10, ok)
    clk.t += 100
    r = await c.get_or_fetch("k", 10, boom)
    assert (r.value, r.status, r.age_s) == ("v1", "stale", 100.0)


async def test_error_without_entry_raises():
    c = TTLCache(clock=Clock())
    async def boom(): raise RuntimeError("down")
    with pytest.raises(RuntimeError):
        await c.get_or_fetch("k", 10, boom)


async def test_rate_limiter_sleeps_when_window_full():
    clk = Clock(); slept = []
    async def fake_sleep(s):
        slept.append(s); clk.t += s
    rl = RateLimiter(2, 60.0, clock=clk, sleep=fake_sleep)
    await rl.acquire(); await rl.acquire()
    await rl.acquire()
    assert slept and abs(slept[0] - 60.0) < 1e-6


# --- peek (non-fetching read) -------------------------------------------------

async def test_peek_absent_returns_none_and_never_fetches():
    c = TTLCache(clock=Clock())
    assert c.peek("k") is None


async def test_peek_fresh_then_expired():
    clk = Clock(); c = TTLCache(clock=clk)
    async def ok(): return "v1"
    await c.get_or_fetch("k", 10, ok)
    clk.t += 4
    r = c.peek("k", ttl=10)
    assert (r.value, r.status, r.age_s) == ("v1", "hit", 4.0)
    clk.t += 20
    r = c.peek("k", ttl=10)
    assert (r.value, r.status, r.age_s) == ("v1", "stale", 24.0)
    # no ttl given -> the stored value is reported as-is
    assert c.peek("k").value == "v1"


# --- failure backoff ------------------------------------------------------------

async def test_failure_backoff_serves_stale_without_refetching():
    clk = Clock(); c = TTLCache(clock=clk, failure_backoff_s=30); calls = []
    async def ok(): return "v1"
    async def boom():
        calls.append(1); raise RuntimeError("upstream down")
    await c.get_or_fetch("k", 10, ok)
    clk.t += 100
    r1 = await c.get_or_fetch("k", 10, boom)
    assert r1.status == "stale" and calls == [1]
    clk.t += 10  # inside the backoff window: no new upstream attempt
    r2 = await c.get_or_fetch("k", 10, boom)
    assert (r2.value, r2.status) == ("v1", "stale") and calls == [1]
    clk.t += 25  # backoff elapsed (35s since failure): re-attempt
    r3 = await c.get_or_fetch("k", 10, boom)
    assert r3.status == "stale" and calls == [1, 1]


async def test_failure_backoff_without_entry_reraises_without_refetching():
    clk = Clock(); c = TTLCache(clock=clk, failure_backoff_s=30); calls = []
    async def boom():
        calls.append(1); raise RuntimeError("down")
    with pytest.raises(RuntimeError):
        await c.get_or_fetch("k", 10, boom)
    clk.t += 5
    with pytest.raises(RuntimeError):
        await c.get_or_fetch("k", 10, boom)
    assert calls == [1]
    clk.t += 30
    with pytest.raises(RuntimeError):
        await c.get_or_fetch("k", 10, boom)
    assert calls == [1, 1]


async def test_success_after_backoff_clears_failure_state():
    clk = Clock(); c = TTLCache(clock=clk, failure_backoff_s=30)
    state = {"fail": True}
    async def fetch():
        if state["fail"]:
            raise RuntimeError("down")
        return "v2"
    with pytest.raises(RuntimeError):
        await c.get_or_fetch("k", 10, fetch)
    clk.t += 31; state["fail"] = False
    r = await c.get_or_fetch("k", 10, fetch)
    assert (r.value, r.status) == ("v2", "miss")
    clk.t += 11; state["fail"] = True  # expired again; a fresh failure is attempted, not backed off
    r = await c.get_or_fetch("k", 10, fetch)
    assert (r.value, r.status) == ("v2", "stale")


async def test_failure_backoff_is_per_key():
    clk = Clock(); c = TTLCache(clock=clk, failure_backoff_s=30)
    async def boom(): raise RuntimeError("down")
    async def ok(): return "fine"
    with pytest.raises(RuntimeError):
        await c.get_or_fetch("a", 10, boom)
    r = await c.get_or_fetch("b", 10, ok)
    assert (r.value, r.status) == ("fine", "miss")
