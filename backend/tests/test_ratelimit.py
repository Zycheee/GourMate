"""Rate-limit contract (architecture §10, spec RL-1..RL-4).

Covers the per-IP REST token bucket, per-session turn gap, utterance/buffer
caps and the global daily Gemini ceiling. All limiters take an injectable clock
so the tests are fully deterministic (no sleeping).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.ratelimit import (
    DailyGeminiCounter,
    RateLimiters,
    RestTokenBucket,
    SessionRateLimiter,
    TokenBucket,
)


class FakeClock:
    """A monotonic-style clock advanced explicitly by the test."""

    def __init__(self, value: float = 0.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


# ---------------------------------------------------------------------------
# TokenBucket / RestTokenBucket (RL-1)
# ---------------------------------------------------------------------------


async def test_token_bucket_allows_burst_then_denies():
    clock = FakeClock()
    bucket = TokenBucket(rate_per_minute=10, capacity=5, clock=clock)

    for _ in range(5):
        allowed, retry_after = await bucket.try_acquire()
        assert allowed is True
        assert retry_after == 0.0

    allowed, retry_after = await bucket.try_acquire()
    assert allowed is False
    # 10/min == 1 token per 6 s.
    assert retry_after == pytest.approx(6.0, abs=1e-6)


async def test_token_bucket_refills_over_time():
    clock = FakeClock()
    bucket = TokenBucket(rate_per_minute=10, capacity=5, clock=clock)
    for _ in range(5):
        await bucket.try_acquire()

    clock.advance(6.0)
    allowed, _ = await bucket.try_acquire()
    assert allowed is True

    # Never exceeds capacity even after a long idle period.
    clock.advance(600.0)
    assert await bucket.available() == pytest.approx(5.0)


async def test_token_bucket_rejects_invalid_construction():
    with pytest.raises(ValueError):
        TokenBucket(rate_per_minute=0, capacity=5)
    with pytest.raises(ValueError):
        TokenBucket(rate_per_minute=10, capacity=0)


async def test_rest_bucket_is_per_key():
    clock = FakeClock()
    rest = RestTokenBucket(rate_per_minute=10, burst=5, clock=clock)

    for _ in range(5):
        assert (await rest.check("1.2.3.4"))[0] is True
    assert (await rest.check("1.2.3.4"))[0] is False

    # A different IP has its own full bucket.
    for _ in range(5):
        assert (await rest.check("5.6.7.8"))[0] is True


def test_retry_after_header_rounds_up_and_has_floor_of_one():
    assert RestTokenBucket.retry_after_header(6.0) == "6"
    assert RestTokenBucket.retry_after_header(0.1) == "1"
    assert RestTokenBucket.retry_after_header(0.0) == "1"
    assert RestTokenBucket.retry_after_header(60.4) == "61"


async def test_rest_bucket_evicts_when_key_cap_reached():
    clock = FakeClock()
    rest = RestTokenBucket(rate_per_minute=10, burst=5, max_keys=2, clock=clock)
    await rest.check("a")
    await rest.check("b")
    await rest.check("c")  # evicts "a"
    # "a" is re-created with a full bucket.
    for _ in range(5):
        assert (await rest.check("a"))[0] is True


# ---------------------------------------------------------------------------
# SessionRateLimiter (RL-2, RL-3)
# ---------------------------------------------------------------------------


async def test_min_turn_gap_enforced_and_resets_after_gap():
    clock = FakeClock()
    limiter = SessionRateLimiter(
        min_turn_gap_s=1.5, max_utterance_s=30.0, max_buffer_s=60.0, clock=clock
    )

    allowed, retry_after = await limiter.allow_turn("s1")
    assert (allowed, retry_after) == (True, 0.0)

    allowed, retry_after = await limiter.allow_turn("s1")
    assert allowed is False
    assert retry_after == pytest.approx(1.5, abs=1e-6)

    clock.advance(1.5)
    allowed, _ = await limiter.allow_turn("s1")
    assert allowed is True


async def test_min_turn_gap_is_per_session():
    clock = FakeClock()
    limiter = SessionRateLimiter(
        min_turn_gap_s=1.5, max_utterance_s=30.0, max_buffer_s=60.0, clock=clock
    )
    assert (await limiter.allow_turn("s1"))[0] is True
    assert (await limiter.allow_turn("s1"))[0] is False
    # Another session is unaffected.
    assert (await limiter.allow_turn("s2"))[0] is True


async def test_forget_releases_session_state():
    clock = FakeClock()
    limiter = SessionRateLimiter(
        min_turn_gap_s=1.5, max_utterance_s=30.0, max_buffer_s=60.0, clock=clock
    )
    await limiter.allow_turn("s1")
    await limiter.forget("s1")
    assert (await limiter.allow_turn("s1"))[0] is True


def test_utterance_cap():
    limiter = SessionRateLimiter(min_turn_gap_s=1.5, max_utterance_s=30.0, max_buffer_s=60.0)
    limiter.check_utterance(29.9)
    limiter.check_utterance(30.0)  # boundary is allowed
    with pytest.raises(AppError) as exc:
        limiter.check_utterance(30.1)
    assert exc.value.code is ErrorCode.AUDIO_TOO_LONG
    assert limiter.utterance_cap_reached(30.0) is True
    assert limiter.utterance_cap_reached(29.99) is False


def test_buffer_cap():
    limiter = SessionRateLimiter(min_turn_gap_s=1.5, max_utterance_s=30.0, max_buffer_s=60.0)
    assert limiter.buffer_cap_reached(60.0) is True
    assert limiter.buffer_cap_reached(59.99) is False
    assert limiter.max_utterance_s == 30.0
    assert limiter.max_buffer_s == 60.0


# ---------------------------------------------------------------------------
# DailyGeminiCounter (RL-4)
# ---------------------------------------------------------------------------


async def test_daily_counter_enforces_cap():
    counter = DailyGeminiCounter(cap=2)
    allowed, remaining = await counter.try_consume()
    assert (allowed, remaining) == (True, 1)
    allowed, remaining = await counter.try_consume()
    assert (allowed, remaining) == (True, 0)
    allowed, remaining = await counter.try_consume()
    assert (allowed, remaining) == (False, 0)

    snap = await counter.snapshot()
    assert snap.used == 2
    assert snap.cap == 2
    assert snap.remaining == 0


async def test_daily_counter_rolls_over_at_utc_midnight():
    current = {"now": datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc)}

    def now() -> datetime:
        return current["now"]

    counter = DailyGeminiCounter(cap=1, now=now)
    assert (await counter.try_consume())[0] is True
    assert (await counter.try_consume())[0] is False

    current["now"] = current["now"] + timedelta(days=1)
    assert (await counter.try_consume())[0] is True
    snap = await counter.snapshot()
    assert snap.used == 1
    assert snap.day == "2026-05-02"


# ---------------------------------------------------------------------------
# Bundle wiring from settings
# ---------------------------------------------------------------------------


def test_rate_limiters_from_settings_defaults():
    settings = Settings()
    limiters = RateLimiters.from_settings(settings)
    assert limiters.session.max_utterance_s == 120.0
    assert limiters.session.max_buffer_s == 60.0
    assert limiters.gemini_daily._cap == 500
    assert limiters.rest._burst == 5
    assert limiters.rest._rate == 10
