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
