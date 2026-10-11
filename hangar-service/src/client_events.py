"""Browser-reported client events (currently: failed image loads)."""
import logging
import time
from collections import deque
from typing import Callable
from urllib.parse import urlsplit


class SlidingWindowLimiter:
    """At most ``limit`` allowed calls per ``window_s`` per key (in memory, per
    instance). Tracks at most ``max_keys`` keys; beyond that the oldest key is
    dropped."""

    def __init__(self, limit: int = 20, window_s: float = 60, clock: Callable[[], float] = time.monotonic,
                 max_keys: int = 10_000) -> None:
        self._limit, self._window, self._clock, self._max_keys = limit, window_s, clock, max_keys
        self._hits: dict[str, deque] = {}

    def allow(self, key: str) -> bool:
        now = self._clock()
        q = self._hits.get(key)
        if q is None:
            if len(self._hits) >= self._max_keys:
                self._hits.pop(next(iter(self._hits)))
            q = self._hits[key] = deque()
        while q and now - q[0] >= self._window:
            q.popleft()
        if len(q) >= self._limit:
            return False
        q.append(now)
        return True

    def tracked_keys(self) -> int:
        return len(self._hits)


def log_image_error(logger: logging.Logger, *, url: str, context: str, member: str | None) -> None:
    """One WARNING per report; the URL is logged whole, never truncated."""
    try:
        host = urlsplit(url).hostname
    except ValueError:
        host = None
    logger.warning("hangar: image load failed host=%s url=%s context=%s member=%s",
                   host, url, context, member)
