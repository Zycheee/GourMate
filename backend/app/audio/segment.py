"""PCM segment energy helpers (architecture section 3, anti-hallucination gate).

VAD emits ``speech_end`` only after a silence hold, so the captured utterance
contains leading/trailing non-speech frames. Measuring RMS over that whole clip
dilutes the speech energy (a short command followed by a long pause looks
near-silent) and feeds Whisper dead air. These helpers isolate the active
region and measure it directly.
"""

from __future__ import annotations

import numpy as np

#: A frame is "active" when its RMS is within this many dB of the loudest frame
#: in the clip. 30 dB spans normal speech dynamics while excluding room tone.
DEFAULT_REL_FLOOR_DB = 30.0
#: Frame size (ms) for the scroll. ~20 ms is a good speech/non-speech boundary.
DEFAULT_FRAME_MS = 20.0
#: RMS below this linear amplitude is treated as digital silence.
_SILENCE_EPS = 1e-7


def _to_float(pcm: bytes) -> np.ndarray:
    """Convert Int16 PCM bytes to normalized float64 samples."""
    if not pcm:
        return np.zeros(0, dtype=np.float64)
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768.0


def rms(samples: np.ndarray) -> float:
    """Root-mean-square of normalized samples (0.0 for an empty array)."""
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples))))


def rms_dbfs(samples: np.ndarray) -> float:
    """RMS expressed in dBFS; digital silence floors at -120 dBFS."""
    value = rms(samples)
    if value <= 0.0:
        return -120.0
    return 20.0 * float(np.log10(value))


def peak(samples: np.ndarray) -> float:
    """Peak absolute amplitude of normalized samples (0.0 when empty)."""
    if samples.size == 0:
        return 0.0
    return float(np.max(np.abs(samples)))


def trim_silence_bounds(
    pcm: bytes,
    *,
    sample_rate: int = 16000,
    frame_ms: float = DEFAULT_FRAME_MS,
    rel_floor_db: float = DEFAULT_REL_FLOOR_DB,
) -> tuple[int, int]:
    """Return ``(start_byte, end_byte)`` of the active (speech) region in ``pcm``.

    The clip is scanned in ``frame_ms`` frames; a frame is active when its RMS is
    within ``rel_floor_db`` of the loudest frame. The returned bounds are byte
    offsets into ``pcm`` (always Int16-aligned). A clip that is entirely
    silent/empty yields ``(0, 0)``.
    """
    if not pcm or len(pcm) < 2:
        return (0, 0)
    samples = _to_float(pcm)
    frame = max(1, int(sample_rate * frame_ms / 1000.0))
    total_frames = samples.size // frame
    if total_frames < 1:
        # Shorter than one frame: active iff it carries real energy.
        return (0, samples.size * 2) if peak(samples) > _SILENCE_EPS else (0, 0)
    trimmed = samples[: total_frames * frame].reshape(total_frames, frame)
    frame_rms = np.sqrt(np.mean(np.square(trimmed), axis=1))
    loudest = float(frame_rms.max())
    if loudest <= _SILENCE_EPS:
        return (0, 0)
    threshold = loudest * (10.0 ** (-rel_floor_db / 20.0))
    active = np.nonzero(frame_rms >= threshold)[0]
    if active.size == 0:
        return (0, 0)
    start_sample = int(active[0]) * frame
    end_sample = (int(active[-1]) + 1) * frame
    return (start_sample * 2, end_sample * 2)


__all__ = [
    "DEFAULT_FRAME_MS",
    "DEFAULT_REL_FLOOR_DB",
    "peak",
    "rms",
    "rms_dbfs",
    "trim_silence_bounds",
]
