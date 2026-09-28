"""PCM ring-buffer contract (architecture §3, §10 RL-3).

Covers append/drop rules, eviction at the retention cap, snapshot windows and
utterance accumulation/extraction.
"""

from __future__ import annotations

from app.audio.buffer import BYTES_PER_SAMPLE, AudioRingBuffer

SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE


def _pcm(seconds: float) -> bytes:
    return bytes(int(seconds * BYTES_PER_SECOND))


# ---------------------------------------------------------------------------
# Append / malformed frame handling (audio_corrupt)
# ---------------------------------------------------------------------------


def test_append_valid_frame_returns_true_and_grows_buffer():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    assert buf.append(_pcm(0.04)) is True
    assert buf.buffered_bytes == int(0.04 * BYTES_PER_SECOND)
    assert buf.dropped_frames == 0


def test_append_empty_frame_dropped():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    assert buf.append(b"") is False
    assert buf.buffered_bytes == 0


def test_append_odd_length_frame_dropped():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    assert buf.append(b"\x01\x02\x03") is False
    assert buf.dropped_frames == 1
    assert buf.buffered_bytes == 0


def test_append_oversized_frame_dropped():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0, max_frame_bytes=100)
    assert buf.append(b"\x00" * 102) is False
    assert buf.dropped_frames == 1
    assert buf.buffered_bytes == 0


# ---------------------------------------------------------------------------
# Eviction at the buffer cap
# ---------------------------------------------------------------------------


def test_buffer_evicts_oldest_bytes_at_cap():
    # 1 second retention, 8192-byte frames.
    buf = AudioRingBuffer(max_buffer_s=1.0, max_utterance_s=0.5)
    max_bytes = int(1.0 * BYTES_PER_SECOND)

    frames = [bytes([i + 1]) * 8000 for i in range(5)]
    for frame in frames:
        assert buf.append(frame) is True

    assert buf.buffered_bytes == max_bytes
    assert buf.buffered_seconds <= 1.0
    # The tail retained must be the most recent max_bytes across the stream.
    stream = b"".join(frames)
    assert buf.snapshot() == stream[-max_bytes:]


def test_snapshot_window_returns_most_recent_seconds():
    # max_frame_bytes must exceed a 0.5 s frame (16000 bytes) or it is dropped.
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0, max_frame_bytes=20000)
    first = b"\x11" * (BYTES_PER_SECOND // 2)  # 0.5 s
    second = b"\x22" * (BYTES_PER_SECOND // 2)  # 0.5 s
    buf.append(first)
    buf.append(second)

    assert buf.snapshot(0.5) == second
    assert buf.snapshot(10.0) == first + second


def test_clear_empties_buffer():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    buf.append(b"\x00" * 100)
    buf.clear()
    assert buf.buffered_bytes == 0
    assert buf.snapshot() == b""


# ---------------------------------------------------------------------------
# Utterance capture / extraction
# ---------------------------------------------------------------------------


def test_utterance_extraction_round_trip():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    assert buf.capturing is False

    buf.begin_utterance()
    assert buf.capturing is True
    buf.extend_utterance(b"\x01\x02")
    buf.extend_utterance(b"\x03\x04")

    assert buf.utterance_bytes == 4
    assert buf.utterance_seconds == 4 / BYTES_PER_SECOND

    captured = buf.finish_utterance()
    assert captured == b"\x01\x02\x03\x04"
    assert buf.capturing is False
    assert buf.utterance_bytes == 0


def test_extend_utterance_ignored_when_not_capturing():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    buf.extend_utterance(b"\x01\x02")
    assert buf.utterance_bytes == 0


def test_extend_utterance_ignores_odd_length_and_empty():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    buf.begin_utterance()
    buf.extend_utterance(b"")
    buf.extend_utterance(b"\x01\x02\x03")
    assert buf.utterance_bytes == 0


def test_begin_utterance_restarts_capture():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    buf.begin_utterance()
    buf.extend_utterance(b"\x01\x02")
    buf.begin_utterance()  # restart clears prior capture
    assert buf.utterance_bytes == 0
    buf.extend_utterance(b"\x09\x09")
    assert buf.finish_utterance() == b"\x09\x09"


def test_reset_utterance_discards_without_returning():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    buf.begin_utterance()
    buf.extend_utterance(b"\x05\x06")
    buf.reset_utterance()
    assert buf.capturing is False
    assert buf.utterance_bytes == 0


def test_utterance_cap_reached():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=0.1)
    cap_bytes = int(0.1 * BYTES_PER_SECOND)
    assert buf.max_utterance_seconds == 0.1

    buf.begin_utterance()
    buf.extend_utterance(bytes(cap_bytes - 2))
    assert buf.utterance_cap_reached is False
    buf.extend_utterance(b"\x00\x00")
    assert buf.utterance_cap_reached is True


def test_peek_utterance_does_not_stop_capture():
    buf = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
    buf.begin_utterance()
    payload = b"\x01\x00" * 100
    buf.extend_utterance(payload)
    assert buf.peek_utterance() == payload
    assert buf.capturing is True
    assert buf.finish_utterance() == payload