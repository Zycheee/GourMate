"""Silero VAD endpointing configuration (architecture §4).

The end-of-speech silence hold is now duration-configurable so the accurate
final transcript lands promptly instead of after the old ~3 s pause. These tests
exercise the configuration math only (no model inference).
"""

from __future__ import annotations

from app.audio.vad import MIN_SILENCE_FRAMES, SAMPLE_RATE, WINDOW_SAMPLES, SileroVAD


def test_default_min_silence_is_the_module_constant():
    vad = SileroVAD()
    assert vad.min_silence_frames == MIN_SILENCE_FRAMES


def test_configure_min_silence_converts_seconds_to_windows():
    vad = SileroVAD()
    vad.configure_min_silence(0.8)  # 0.8 s / 32 ms = 25 windows
    assert vad.min_silence_frames == 25
    assert abs(vad.min_silence_seconds - 0.8) < 0.05


def test_configure_min_silence_clamps_to_one_window():
    vad = SileroVAD()
    vad.configure_min_silence(0.0001)
    assert vad.min_silence_frames == 1
    expected = WINDOW_SAMPLES / SAMPLE_RATE
    assert abs(vad.min_silence_seconds - expected) < 1e-6
