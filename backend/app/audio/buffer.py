"""PCM16 16 kHz mono ring buffer with utterance extraction.

The buffer serves two jobs:

1. Retain a bounded window of recent audio (``max_buffer_s``) for VAD context and
   memory safety. Old bytes are evicted from the front.
2. Capture the audio between ``begin_utterance`` and ``finish_utterance`` so the
   final utterance can be handed to faster-whisper.

Nothing here is persisted. Buffers are per-session and freed when the socket
closes or the utterance is consumed.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

BYTES_PER_SAMPLE = 2  # Int16 mono


class AudioRingBuffer:
    """A bounded byte buffer for Int16 PCM plus an utterance accumulator.

    Parameters
    ----------
    max_buffer_s:
        Maximum seconds retained in the ring (RL-3, default 60 s).
    max_utterance_s:
        Maximum seconds captured for a single utterance (RL-3, default 30 s).
    sample_rate:
        Samples per second (fixed at 16 kHz by the transport contract).
    max_frame_bytes:
        Frames larger than this are dropped as malformed (input cap).
    """

    def __init__(
        self,
        max_buffer_s: float,
        max_utterance_s: float,
        *,
        sample_rate: int = 16000,
        max_frame_bytes: int = 8192,
    ) -> None:
        self._sample_rate = sample_rate
        self._bytes_per_second = sample_rate * BYTES_PER_SAMPLE
        self._max_bytes = int(max_buffer_s * self._bytes_per_second)
        self._max_utterance_bytes = int(max_utterance_s * self._bytes_per_second)
        self._max_frame_bytes = max_frame_bytes
        self._buf = bytearray()
        self._utterance = bytearray()
        self._capturing = False
        self._dropped_frames = 0

    # -- ring buffer -------------------------------------------------------
    def append(self, pcm: bytes) -> bool:
        """Append a PCM frame to the ring buffer.

        Malformed frames (empty, odd byte length, or oversized) are dropped and
        ``False`` is returned; valid frames always return ``True``. This matches
        the ``audio_corrupt`` handling: drop the frame, continue.
        """
        if not pcm:
            return False
        if len(pcm) > self._max_frame_bytes:
            self._dropped_frames += 1
            logger.warning("dropping oversized audio frame (%d bytes)", len(pcm))
            return False
        if len(pcm) % BYTES_PER_SAMPLE != 0:
            self._dropped_frames += 1
            logger.warning("dropping odd-length audio frame (%d bytes)", len(pcm))
            return False

        self._buf.extend(pcm)
        overflow = len(self._buf) - self._max_bytes
        if overflow > 0:
            del self._buf[:overflow]
        return True

    def snapshot(self, seconds: float | None = None) -> bytes:
        """Return the most recent ``seconds`` of buffered audio (or all of it).

        A non-positive ``seconds`` yields an empty window rather than the whole
        buffer (``buf[-0:]`` would otherwise be the full slice).
        """
        if seconds is None:
            return bytes(self._buf)
        if seconds <= 0:
            return b""
        wanted = int(seconds * self._bytes_per_second)
        if wanted >= len(self._buf):
            return bytes(self._buf)
        return bytes(self._buf[-wanted:])

    def clear(self) -> None:
        """Drop all buffered audio."""
        self._buf.clear()

    @property
    def buffered_seconds(self) -> float:
        """Seconds currently retained in the ring."""
        return len(self._buf) / self._bytes_per_second

    @property
    def buffered_bytes(self) -> int:
        return len(self._buf)

    @property
    def dropped_frames(self) -> int:
        return self._dropped_frames

    # -- utterance capture -------------------------------------------------
    @property
    def capturing(self) -> bool:
        """Whether an utterance is currently being captured."""
        return self._capturing

    def begin_utterance(self) -> None:
        """Start (or restart) utterance capture."""
        self._utterance.clear()
        self._capturing = True

    def extend_utterance(self, pcm: bytes) -> None:
        """Append valid PCM to the active utterance accumulator."""
        if not self._capturing or not pcm:
            return
        if len(pcm) % BYTES_PER_SAMPLE != 0:
            return
        self._utterance.extend(pcm)

    def finish_utterance(self) -> bytes:
        """Stop capturing and return the captured PCM (may be empty)."""
        self._capturing = False
        data = bytes(self._utterance)
        self._utterance.clear()
        return data

    def peek_utterance(self) -> bytes:
        """Return the captured PCM so far without stopping capture."""
        return bytes(self._utterance)

    def reset_utterance(self) -> None:
        """Discard the current utterance without returning it."""
        self._capturing = False
        self._utterance.clear()

    @property
    def utterance_seconds(self) -> float:
        """Seconds captured so far for the active utterance."""
        return len(self._utterance) / self._bytes_per_second

    @property
    def utterance_bytes(self) -> int:
        return len(self._utterance)

    @property
    def utterance_cap_reached(self) -> bool:
        """Whether the utterance has reached the max-utterance cap."""
        return len(self._utterance) >= self._max_utterance_bytes

    @property
    def max_utterance_seconds(self) -> float:
        return self._max_utterance_bytes / self._bytes_per_second


__all__ = ["AudioRingBuffer", "BYTES_PER_SAMPLE"]
