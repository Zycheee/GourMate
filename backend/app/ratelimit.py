"""Async-safe rate limiting primitives (architecture sections 10, spec RL-1..RL-5).

Three independent layers:

* ``RestTokenBucket`` - per-IP token bucket for the REST recipe endpoints.
* ``SessionRateLimiter`` - per-session minimum turn gap plus utterance/buffer caps.
* ``DailyGeminiCounter`` - process-global daily ceiling on Gemini calls.

All three are guarded by ``asyncio.Lock`` and safe to share across sessions.
The architecture documents an in-process design; migration to Redis is only
required if the backend is horizontally scaled (architecture section 15).
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from .errors import AppError, ErrorCode

logger = logging.getLogger(__name__)

Clock = Callable[[], float]


class TokenBucket:
    """A classic token bucket.

    ``rate_per_minute`` tokens are added continuously; ``capacity`` bounds the
    burst. Async-safe via an internal lock.
    """

    def __init__(
        self,
        rate_per_minute: float,
        capacity: int,
        *,
        clock: Clock = time.monotonic,
    ) -> None:
        if rate_per_minute <= 0:
            raise ValueError("rate_per_minute must be positive")
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._rate_per_second = rate_per_minute / 60.0
        self._capacity = float(capacity)
        self._tokens = float(capacity)
        self._clock = clock
        self._updated = clock()
        self._lock = asyncio.Lock()

    async def try_acquire(self, tokens: float = 1.0) -> tuple[bool, float]:
        """Attempt to consume ``tokens``.

        Returns ``(allowed, retry_after_seconds)``. ``retry_after`` is ``0.0``
        when the request is allowed.
        """
        async with self._lock:
            now = self._clock()
            elapsed = max(0.0, now - self._updated)
            self._tokens = min(self._capacity, self._tokens + elapsed * self._rate_per_second)
            self._updated = now

            if self._tokens >= tokens:
                self._tokens -= tokens
                return True, 0.0

            deficit = tokens - self._tokens
            retry_after = deficit / self._rate_per_second
            return False, retry_after

    async def available(self) -> float:
        """Return the current token count (for diagnostics)."""
        async with self._lock:
            now = self._clock()
            elapsed = max(0.0, now - self._updated)
            self._tokens = min(self._capacity, self._tokens + elapsed * self._rate_per_second)
            self._updated = now
            return self._tokens


class RestTokenBucket:
    """Per-key (IP) token bucket registry for REST endpoints."""

    def __init__(
        self,
        rate_per_minute: float,
        burst: int,
        *,
        max_keys: int = 10_000,
        clock: Clock = time.monotonic,
    ) -> None:
        self._rate = rate_per_minute
        self._burst = burst
        self._max_keys = max_keys
        self._clock = clock
        self._buckets: dict[str, TokenBucket] = {}
        self._lock = asyncio.Lock()

    async def _bucket_for(self, key: str) -> TokenBucket:
        bucket = self._buckets.get(key)
        if bucket is None:
            if len(self._buckets) >= self._max_keys:
                # Evict the least-recently-updated bucket to bound memory.
                self._buckets.pop(next(iter(self._buckets)), None)
            bucket = TokenBucket(self._rate, self._burst, clock=self._clock)
            self._buckets[key] = bucket
        return bucket

    async def check(self, key: str, tokens: float = 1.0) -> tuple[bool, float]:
        """Consume a token for ``key``; returns ``(allowed, retry_after)``."""
        async with self._lock:
            bucket = await self._bucket_for(key)
        return await bucket.try_acquire(tokens)

    @staticmethod
    def retry_after_header(retry_after: float) -> str:
        """Format the ``Retry-After`` header value (whole seconds, minimum 1)."""
        return str(max(1, math.ceil(retry_after)))


class SessionRateLimiter:
    """Per-session turn throttling and audio cap checks (RL-2, RL-3)."""

    def __init__(
        self,
        min_turn_gap_s: float,
        max_utterance_s: float,
        max_buffer_s: float,
        *,
        clock: Clock = time.monotonic,
    ) -> None:
        self._min_gap = min_turn_gap_s
        self._max_utterance = max_utterance_s
        self._max_buffer = max_buffer_s
        self._clock = clock
        self._last_turn: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def allow_turn(self, session_id: str) -> tuple[bool, float]:
        """Record a finalized turn if the minimum gap has elapsed.

        Returns ``(allowed, retry_after)``. On success the timestamp is updated.
        """
        async with self._lock:
            now = self._clock()
            last = self._last_turn.get(session_id)
            if last is not None:
                elapsed = now - last
                if elapsed < self._min_gap:
                    return False, self._min_gap - elapsed
            self._last_turn[session_id] = now
            return True, 0.0

    async def forget(self, session_id: str) -> None:
        """Drop session state when a socket closes."""
        async with self._lock:
            self._last_turn.pop(session_id, None)

    def check_utterance(self, seconds: float) -> None:
        """Raise ``audio_too_long`` when an utterance exceeds the cap."""
        if seconds > self._max_utterance:
            raise AppError(
                ErrorCode.AUDIO_TOO_LONG,
                f"Utterance of {seconds:.1f}s exceeds {self._max_utterance:.1f}s cap.",
            )

    def utterance_cap_reached(self, seconds: float) -> bool:
        """Whether capture should be force-flushed at the utterance cap."""
        return seconds >= self._max_utterance

    def buffer_cap_reached(self, seconds: float) -> bool:
        """Whether the ring buffer has hit its retention cap."""
        return seconds >= self._max_buffer

    @property
    def max_utterance_s(self) -> float:
        return self._max_utterance

    @property
    def max_buffer_s(self) -> float:
        return self._max_buffer


@dataclass
class DailyCounterSnapshot:
    """Diagnostic snapshot of the global daily counter."""

    day: str
    used: int
    cap: int
    remaining: int


class DailyGeminiCounter:
    """Process-global daily ceiling on Gemini calls (RL-4).

    The counter resets automatically when the UTC date changes. ``try_consume``
    is async-safe and the intended single choke point for every Gemini request.
    """

    def __init__(self, cap: int, *, now: Callable[[], datetime] | None = None) -> None:
        self._cap = cap
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._day = self._today()
        self._used = 0
        self._lock = asyncio.Lock()

    def _today(self) -> str:
        return self._now().date().isoformat()

    def _rollover_locked(self) -> None:
        today = self._today()
        if today != self._day:
            logger.info("daily Gemini counter rollover %s -> %s", self._day, today)
            self._day = today
            self._used = 0

    async def try_consume(self) -> tuple[bool, int]:
        """Consume one Gemini call.

        Returns ``(allowed, remaining)``. When ``allowed`` is ``False`` the
        caller must raise/surface ``rate_limited`` (scope ``gemini_daily``).
        """
        async with self._lock:
            self._rollover_locked()
            if self._used >= self._cap:
                return False, 0
            self._used += 1
            return True, self._cap - self._used

    async def snapshot(self) -> DailyCounterSnapshot:
        """Return the current counter state without consuming."""
        async with self._lock:
            self._rollover_locked()
            return DailyCounterSnapshot(
                day=self._day,
                used=self._used,
                cap=self._cap,
                remaining=self._cap - self._used,
            )


@dataclass
class RateLimiters:
    """Bundle of the three limiter layers, injected into the app and sessions."""

    rest: RestTokenBucket
    session: SessionRateLimiter
    gemini_daily: DailyGeminiCounter
    health: RestTokenBucket = field(default=None)  # type: ignore[assignment]

    @classmethod
    def from_settings(cls, settings: object) -> "RateLimiters":
        """Construct all limiters from a :class:`app.config.Settings` instance."""
        return cls(
            rest=RestTokenBucket(
                rate_per_minute=getattr(settings, "rest_rate_limit"),
                burst=getattr(settings, "rest_rate_burst"),
            ),
            session=SessionRateLimiter(
                min_turn_gap_s=getattr(settings, "session_min_turn_gap_s"),
                max_utterance_s=getattr(settings, "max_utterance_s"),
                max_buffer_s=getattr(settings, "max_buffer_s"),
            ),
            gemini_daily=DailyGeminiCounter(cap=getattr(settings, "gemini_daily_cap")),
            health=RestTokenBucket(
                rate_per_minute=getattr(settings, "health_rate_limit"),
                burst=max(5, getattr(settings, "health_rate_limit") // 6),
            ),
        )


__all__ = [
    "DailyCounterSnapshot",
    "DailyGeminiCounter",
    "RateLimiters",
    "RestTokenBucket",
    "SessionRateLimiter",
    "TokenBucket",
]
