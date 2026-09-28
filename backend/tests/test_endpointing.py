"""Utterance continuation / endpointing (architecture section 4).

A sentence split by a short pause must be transcribed as **one** utterance, not
several fragments. These tests drive ``_on_speech_start``/``_on_speech_end`` with
a fake session; no weights or network are touched.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import numpy as np

from app.audio.buffer import AudioRingBuffer
from app.config import Settings
from app.pipeline import VoicePipeline

START = SimpleNamespace(barge_in=False)


class FakeSTT:
    def __init__(self, text: str = "hello there") -> None:
        self.text = text
        self.calls: list[bytes] = []

    async def transcribe(self, pcm: bytes, language: str = "en") -> str:
        self.calls.append(pcm)
        return self.text


class FakeLimiters:
    class session:  # noqa: N801 - stands in for RateLimiters.session
        @staticmethod
        async def allow_turn(_session_id: str) -> tuple[bool, float]:
            return True, 0.0


class FakeSession:
    def __init__(self) -> None:
        self.audio = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
        self.sent: list[dict] = []
        self.voice_state = "idle"
        self.assistant_speaking = False
        self.state = SimpleNamespace(session_id="s1")

    async def send_event(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


def _loud(samples: int) -> bytes:
    # Full-scale DC passes the silence gate so a real turn runs.
    return np.full(samples, 16384, dtype=np.int16).tobytes()


def _pipeline() -> tuple[VoicePipeline, FakeSession]:
    settings = Settings(
        _env_file=None,
        transcription_only=True,
        utterance_continuation_s=0.05,
    )
    session = FakeSession()
    services = SimpleNamespace(
        settings=settings,
        stt=FakeSTT(),
        stt_partial=None,
        streaming_stt=None,
        limiters=FakeLimiters(),
    )
    return VoicePipeline(session, services), session


async def test_continuation_merges_segments_into_one_turn():
    pipeline, session = _pipeline()

    # Segment 1
    await pipeline._on_speech_start(START)  # noqa: SLF001
    session.audio.extend_utterance(_loud(6000))
    await pipeline._on_speech_end()  # noqa: SLF001

    # Segment 2 arrives before the continuation window elapses.
    await pipeline._on_speech_start(START)  # noqa: SLF001
    session.audio.extend_utterance(_loud(4000))
    await pipeline._on_speech_end()  # noqa: SLF001

    # Let the continuation window expire and the turn finish.
    await asyncio.sleep(0.2)

    finals = [
        e for e in session.sent if e.get("type") == "transcript" and e.get("final") is True
    ]
    assert len(finals) == 1, "one sentence must produce one final transcript"
    assert len(pipeline._turn_pcm) == (6000 + 4000) * 2  # noqa: SLF001


async def test_single_segment_finalizes_after_window():
    pipeline, session = _pipeline()

    await pipeline._on_speech_start(START)  # noqa: SLF001
    session.audio.extend_utterance(_loud(6000))
    await pipeline._on_speech_end()  # noqa: SLF001

    # Not finalized until the continuation window elapses.
    assert not [e for e in session.sent if e.get("type") == "transcript"]

    await asyncio.sleep(0.2)
    finals = [
        e for e in session.sent if e.get("type") == "transcript" and e.get("final") is True
    ]
    assert len(finals) == 1
    assert len(pipeline._turn_pcm) == 6000 * 2  # noqa: SLF001


async def test_speech_end_emitted_once_per_utterance():
    pipeline, session = _pipeline()

    await pipeline._on_speech_start(START)  # noqa: SLF001
    session.audio.extend_utterance(_loud(6000))
    await pipeline._on_speech_end()  # noqa: SLF001

    # The intermediary pause must not emit a speech_end to the client.
    assert not [e for e in session.sent if e.get("type") == "vad" and e.get("state") == "speech_end"]

    await asyncio.sleep(0.2)
    ends = [
        e for e in session.sent if e.get("type") == "vad" and e.get("state") == "speech_end"
    ]
    assert len(ends) == 1
