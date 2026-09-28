"""ConnectionRegistry caps (architecture §7 / RL-5).

Covers the same-IP newest-wins takeover and the process-global hard ceiling.
The registry is async but has no external dependencies, so these run offline and
deterministically. Sessions are lightweight fakes exposing the duck-typed
``ip`` / ``session_id`` / ``force_close`` surface the registry relies on.
"""

from __future__ import annotations

from app.ws.session import CLOSE_NORMAL, ConnectionRegistry


class FakeSession:
    def __init__(self, ip: str, session_id: str) -> None:
        self.ip = ip
        self.session_id = session_id
        self.closed_with: list[int] = []

    async def force_close(self, code: int = CLOSE_NORMAL) -> None:
        self.closed_with.append(code)


async def test_first_registration_is_ok():
    registry = ConnectionRegistry(max_per_ip=1, max_total=100)
    session = FakeSession("1.2.3.4", "s1")

    assert await registry.try_register(session) == "ok"
    assert await registry.count("1.2.3.4") == 1
    assert await registry.total() == 1
    assert session.closed_with == []


async def test_same_ip_reconnect_takes_over_and_closes_old():
    registry = ConnectionRegistry(max_per_ip=1, max_total=100)
    old = FakeSession("1.2.3.4", "s1")
    new = FakeSession("1.2.3.4", "s2")

    assert await registry.try_register(old) == "ok"
    assert await registry.try_register(new) == "takeover"

    # The replaced socket is closed with a normal close; the new one is live.
    assert old.closed_with == [CLOSE_NORMAL]
    assert new.closed_with == []
    # Counts reflect exactly one live session for the IP.
    assert await registry.count("1.2.3.4") == 1
    assert await registry.total() == 1


async def test_takeover_then_stale_release_cannot_evict_replacement():
    """The old loop's ``finally`` release must not remove the new session."""
    registry = ConnectionRegistry(max_per_ip=1, max_total=100)
    old = FakeSession("1.2.3.4", "s1")
    new = FakeSession("1.2.3.4", "s2")

    await registry.try_register(old)
    await registry.try_register(new)
    # Simulate the superseded session's run() finally firing afterwards.
    await registry.release(old)

    assert await registry.count("1.2.3.4") == 1
    assert await registry.total() == 1
    # A second, unrelated IP is still untouched by the stale release.
    assert await registry.try_register(FakeSession("5.6.7.8", "s3")) == "ok"
    assert await registry.total() == 2


async def test_distinct_ip_is_unaffected_by_per_ip_cap():
    registry = ConnectionRegistry(max_per_ip=1, max_total=100)
    assert await registry.try_register(FakeSession("1.2.3.4", "s1")) == "ok"
    assert await registry.try_register(FakeSession("5.6.7.8", "s2")) == "ok"
    assert await registry.total() == 2


async def test_global_cap_blocks_across_distinct_ips():
    registry = ConnectionRegistry(max_per_ip=10, max_total=2)

    assert await registry.try_register(FakeSession("1.1.1.1", "s1")) == "ok"
    assert await registry.try_register(FakeSession("2.2.2.2", "s2")) == "ok"
    assert await registry.total() == 2
    # Third connection, even from a fresh IP, hits the global ceiling.
    third = FakeSession("3.3.3.3", "s3")
    assert await registry.try_register(third) == "global_cap"
    assert await registry.total() == 2
    assert third.closed_with == []  # registry never closes; the caller does (1013)


async def test_global_cap_does_not_block_same_ip_takeover():
    """A takeover frees the same-IP slot even at the global ceiling."""
    registry = ConnectionRegistry(max_per_ip=1, max_total=1)
    old = FakeSession("1.2.3.4", "s1")
    new = FakeSession("1.2.3.4", "s2")

    assert await registry.try_register(old) == "ok"
    assert await registry.try_register(new) == "takeover"
    assert await registry.total() == 1
    assert old.closed_with == [CLOSE_NORMAL]


async def test_release_frees_per_ip_and_global_slots():
    registry = ConnectionRegistry(max_per_ip=1, max_total=1)
    first = FakeSession("1.2.3.4", "s1")

    assert await registry.try_register(first) == "ok"
    assert await registry.try_register(FakeSession("5.6.7.8", "s2")) == "global_cap"

    await registry.release(first)
    assert await registry.count("1.2.3.4") == 0
    assert await registry.total() == 0
    assert await registry.try_register(FakeSession("5.6.7.8", "s3")) == "ok"


async def test_release_never_underflows_global_count():
    registry = ConnectionRegistry(max_per_ip=1, max_total=5)
    await registry.release(FakeSession("never-registered", "s0"))
    assert await registry.total() == 0
