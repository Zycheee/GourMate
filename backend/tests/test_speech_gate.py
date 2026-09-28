"""Silence-gate contract for the voice turn (anti-hallucination).

Near-silent or sub-threshold utterances are measured and rejected *before*
Whisper is invoked, so a quiet mic cannot trigger the classic
``"duh duh duh..."`` hallucination. Whisper is faked; no weights or network are
touched.
"""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace

import numpy as np

from app.config import Settings
from app.pipeline import VoicePipeline

SAMPLE_RATE = 16000


class FakeSTT:
    """Records every ``transcribe`` call and returns a fixed transcript."""

    def __init__(self, text: str = "") -> None:
        self.calls: list[bytes] = []
        self._text = text

    async def transcribe(self, pcm: bytes, language: str = "en") -> str:
        self.calls.append(pcm)
        return self._text


class FakeSession:
    """Minimal session double: records emitted events and tracks voice state."""

    def __init__(self) -> None:
        self.state = SimpleNamespace()
        self.voice_state = "processing"
        self.assistant_speaking = False
        self.sent: list[dict] = []

    async def send_event(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


def _pcm(samples: np.ndarray) -> bytes:
    return samples.astype(np.int16).tobytes()


def _pipeline(stt: FakeSTT, **settings_kwargs) -> tuple[VoicePipeline, FakeSession]:
    settings = Settings(_env_file=None, **settings_kwargs)
    session = FakeSession()
    services = SimpleNamespace(settings=settings, stt=stt)
    return VoicePipeline(session, services), session


def _errors(session: FakeSession) -> list[dict]:
    return [event for event in session.sent if event["type"] == "error"]


def test_default_gate_thresholds_are_conservative():
    settings = Settings(_env_file=None)
    assert settings.stt_min_utterance_s == 0.15
    assert settings.stt_min_rms_dbfs == -120.0
    assert settings.stt_noise_margin_db == 0.0
    # End-of-speech hold is short so the final transcript lands promptly.
    assert settings.vad_min_silence_s == 0.6
    assert settings.utterance_continuation_s == 0.4


async def test_quiet_audio_is_gated_before_whisper(caplog):
    caplog.set_level(logging.INFO, logger="app.pipeline")
    stt = FakeSTT()
    pipeline, session = _pipeline(stt)

    await pipeline._run_audio_turn(_pcm(np.zeros(SAMPLE_RATE, dtype=np.int16)))  # noqa: SLF001

    assert stt.calls == []
    assert "silence gate rejected" in caplog.text
    errors = _errors(session)
    assert len(errors) == 1
    assert errors[0]["code"] == "no_speech"
    assert errors[0]["message"] == "I didn't catch that."
    assert errors[0]["recoverable"] is True
    assert session.voice_state == "idle"


async def test_short_audio_is_gated_before_whisper(caplog):
    caplog.set_level(logging.INFO, logger="app.pipeline")
    stt = FakeSTT()
    pipeline, session = _pipeline(stt)

    # Full-scale but only 0.1 s: fails the minimum-duration gate.
    short = np.full(1600, 32767, dtype=np.int16)
    await pipeline._run_audio_turn(_pcm(short))  # noqa: SLF001

    assert stt.calls == []
    assert "silence gate rejected" in caplog.text
    assert [e["code"] for e in _errors(session)] == ["no_speech"]


async def test_low_peak_audio_is_gated_before_whisper(caplog):
    caplog.set_level(logging.INFO, logger="app.pipeline")
    stt = FakeSTT()
    pipeline, session = _pipeline(stt)

    # RMS ~ -40 dBFS clears the -45 dBFS floor, but peak (0.01) is below 0.02.
    low_peak = np.full(SAMPLE_RATE, 328, dtype=np.int16)
    await pipeline._run_audio_turn(_pcm(low_peak))  # noqa: SLF001

    assert stt.calls == []
    assert "silence gate rejected" in caplog.text
    assert [e["code"] for e in _errors(session)] == ["no_speech"]


async def test_loud_audio_passes_gate_and_reaches_whisper():
    stt = FakeSTT(text="")
    pipeline, _session = _pipeline(stt)

    # 0.5 full-scale sine-ish DC at 1.0 s: above duration, RMS and peak floors.
    loud = np.full(SAMPLE_RATE, 16384, dtype=np.int16)
    await pipeline._run_audio_turn(_pcm(loud))  # noqa: SLF001

    assert len(stt.calls) == 1
    assert stt.calls[0] == _pcm(loud)


async def test_trailing_silence_does_not_dilute_the_gate(caplog):
    caplog.set_level(logging.INFO, logger="app.pipeline")
    stt = FakeSTT(text="chop the onion")
    pipeline, session = _pipeline(stt)

    # A short command followed by three seconds of silence: over the whole clip
    # the RMS is dominated by silence, but the active region is clearly speech.
    t = np.arange(int(0.4 * SAMPLE_RATE)) / SAMPLE_RATE
    speech = (0.4 * np.sin(2 * np.pi * 220.0 * t) * 32767).astype(np.int16)
    clip = np.concatenate(
        [
            np.zeros(SAMPLE_RATE // 4, dtype=np.int16),
            speech,
            np.zeros(3 * SAMPLE_RATE, dtype=np.int16),
        ]
    )

    await pipeline._run_audio_turn(_pcm(clip))  # noqa: SLF001

    assert len(stt.calls) == 1
    # Only the active region reached Whisper, not the padded silence.
    assert len(stt.calls[0]) < len(_pcm(clip))
    assert not [e for e in _errors(session) if e["code"] == "no_speech"]


async def test_log_line_reports_duration_rms_and_peak(caplog):
    caplog.set_level(logging.INFO, logger="app.pipeline")
    stt = FakeSTT()
    pipeline, _session = _pipeline(stt)

    await pipeline._run_audio_turn(  # noqa: SLF001
        _pcm(np.full(SAMPLE_RATE, 16384, dtype=np.int16))
    )

    messages = [
        record.getMessage()
        for record in caplog.records
        if record.name == "app.pipeline"
    ]
    diagnostic = next(m for m in messages if m.startswith("utterance "))
    assert diagnostic == "utterance dur=1.00s rms=0.5000 (-6.0 dBFS) peak=0.5000"


async def test_silent_audio_logs_minus_120_dbfs_floor(caplog):
    caplog.set_level(logging.INFO, logger="app.pipeline")
    stt = FakeSTT()
    pipeline, _session = _pipeline(stt)

    await pipeline._run_audio_turn(  # noqa: SLF001
        _pcm(np.zeros(SAMPLE_RATE, dtype=np.int16))
    )

    diagnostic = next(
        record.getMessage()
        for record in caplog.records
        if record.name == "app.pipeline"
        and record.getMessage().startswith("utterance ")
    )
    assert "(-120.0 dBFS)" in diagnostic
