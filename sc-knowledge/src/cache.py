"""In-process TTL cache with stale-on-error, and a sliding-window rate limiter."""
import asyncio
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal


@dataclass
class CacheResult:
    value: Any
    status: Literal["hit", "miss", "stale"]
    age_s: float


class TTLCache:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._data: dict[str, tuple[float, Any]] = {}  # key -> (stored_at, value)
        self._locks: dict[str, asyncio.Lock] = {}

    async def get_or_fetch(self, key: str, ttl: float,
                           fetch: Callable[[], Awaitable[Any]]) -> CacheResult:
        now = self._clock()
        entry = self._data.get(key)
        if entry and now - entry[0] < ttl:
            return CacheResult(entry[1], "hit", now - entry[0])
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = self._clock()
            entry = self._data.get(key)
            if entry and now - entry[0] < ttl:
                return CacheResult(entry[1], "hit", now - entry[0])
            try:
                value = await fetch()
            except Exception:
                if entry is not None:
                    return CacheResult(entry[1], "stale", now - entry[0])
                raise
            self._data[key] = (self._clock(), value)
            return CacheResult(value, "miss", 0.0)


class RateLimiter:
    def __init__(self, max_calls: int, per_seconds: float,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self._max = max_calls
        self._per = per_seconds
        self._clock = clock
        self._sleep = sleep
        self._stamps: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = self._clock()
                while self._stamps and now - self._stamps[0] >= self._per:
                    self._stamps.popleft()
                if len(self._stamps) < self._max:
                    self._stamps.append(now)
                    return
                await self._sleep(self._per - (now - self._stamps[0]))
