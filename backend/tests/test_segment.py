"""Active-region isolation for the anti-hallucination gate (architecture §3).

The VAD silence hold leaves leading/trailing non-speech in the captured
utterance. These tests prove the clip is trimmed to its speech region so a short
command followed by a long pause is neither diluted into silence nor sent to
Whisper padded with dead air.
"""

from __future__ import annotations

import numpy as np

from app.audio.segment import peak, rms, rms_dbfs, trim_silence_bounds

SAMPLE_RATE = 16000


def _pcm(samples: np.ndarray) -> bytes:
    return samples.astype(np.int16).tobytes()


def _sine(seconds: float, amplitude: float, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return (amplitude * np.sin(2 * np.pi * freq * t) * 32767).astype(np.int16)


def test_energy_helpers_handle_empty_and_silence():
    empty = np.zeros(0, dtype=np.float64)
    assert rms(empty) == 0.0
    assert peak(empty) == 0.0
    assert rms_dbfs(empty) == -120.0
    assert rms_dbfs(np.zeros(160, dtype=np.float64)) == -120.0


def test_trim_returns_empty_for_digital_silence():
    silence = _pcm(np.zeros(SAMPLE_RATE, dtype=np.int16))
    assert trim_silence_bounds(silence, sample_rate=SAMPLE_RATE) == (0, 0)


def test_trim_is_a_no_op_for_constant_loud_audio():
    loud = _pcm(np.full(SAMPLE_RATE, 16384, dtype=np.int16))
    start, end = trim_silence_bounds(loud, sample_rate=SAMPLE_RATE)
    assert (start, end) == (0, len(loud))


def test_trim_strips_leading_and_trailing_silence():
    speech = _sine(0.5, 0.3)
    padded = np.concatenate([np.zeros(SAMPLE_RATE, dtype=np.int16), speech, np.zeros(2 * SAMPLE_RATE, dtype=np.int16)])
    start, end = trim_silence_bounds(_pcm(padded), sample_rate=SAMPLE_RATE)

    # The active region must sit inside the padded clip and exclude the padding.
    start_samples = start // 2
    end_samples = end // 2
    assert SAMPLE_RATE - 400 <= start_samples <= SAMPLE_RATE + 400
    # Speech ran 1.0 s -> 1.5 s, so the active region ends near 1.5 s.
    assert int(1.4 * SAMPLE_RATE) <= end_samples <= int(1.6 * SAMPLE_RATE)
    # The surviving region contains the speech (about 0.5 s).
    survived = (end - start) / 2 / SAMPLE_RATE
    assert 0.4 <= survived <= 0.7


def test_trim_bounds_are_int16_aligned():
    mixed = _pcm(np.concatenate([np.zeros(1000, dtype=np.int16), _sine(0.2, 0.4)]))
    start, end = trim_silence_bounds(mixed, sample_rate=SAMPLE_RATE)
    assert start % 2 == 0
    assert end % 2 == 0
