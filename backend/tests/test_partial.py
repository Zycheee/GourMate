"""Live partial-transcription contract (approach A).

While an utterance is being captured, a fast partial model re-decodes the
growing audio and emits ``transcript{final:false}`` on a cadence. These tests
use a fake model and a minimal session double; no weights/network are touched.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import numpy as np
from types import SimpleNamespace

from app.audio.buffer import AudioRingBuffer
from app.config import Settings
from app.pipeline import VoicePipeline


class FakeSTT:
    def __init__(self, text: str) -> None:
        self.text = text
        self.calls: list[bytes] = []

    async def transcribe(self, pcm: bytes, language: str = "en") -> str:
        self.calls.append(pcm)
        return self.text


class SequenceSTT:
    """Returns a scripted hypothesis per call (simulates decoder variance)."""

    def __init__(self, texts: list[str]) -> None:
        self._texts = list(texts)
        self._i = 0

    async def transcribe(self, pcm: bytes, language: str = "en") -> str:  # noqa: ARG002
        text = self._texts[min(self._i, len(self._texts) - 1)]
        self._i += 1
        return text


class FakeSession:
    def __init__(self) -> None:
        self.audio = AudioRingBuffer(max_buffer_s=60.0, max_utterance_s=30.0)
        self.sent: list[dict] = []
        self.voice_state = "listening"
        self.assistant_speaking = False
        self.state = SimpleNamespace(session_id="s1")

    async def send_event(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


def _pipeline(stt_partial) -> tuple[VoicePipeline, FakeSession]:
    settings = Settings(_env_file=None)
    session = FakeSession()
    services = SimpleNamespace(settings=settings, stt=stt_partial, stt_partial=stt_partial)
    return VoicePipeline(session, services), session


async def test_partial_transcript_emitted_while_capturing():
    stt = FakeSTT("i want to cook")
    pipeline, session = _pipeline(stt)
    session.audio.begin_utterance()
    session.audio.extend_utterance(b"\x00\x00" * 6000)  # ~0.375 s

    await pipeline._run_partial()  # noqa: SLF001

    partials = [
        e for e in session.sent if e.get("type") == "transcript" and e.get("final") is False
    ]
    assert partials and partials[0]["text"] == "i want to cook"


async def test_partial_skipped_when_not_capturing():
    stt = FakeSTT("x")
    pipeline, session = _pipeline(stt)
    session.audio.extend_utterance(b"\x00\x00" * 6000)  # buffered but not capturing

    await pipeline._run_partial()  # noqa: SLF001

    assert [e for e in session.sent if e.get("type") == "transcript"] == []


async def test_partial_stabilizes_with_local_agreement():
    # The raw decoder output drifts between ticks; the caption must commit the
    # agreed prefix and only the tail may change.
    stt = SequenceSTT(["i want to cook", "i want to cook chicken"])
    pipeline, session = _pipeline(stt)
    session.audio.begin_utterance()
    session.audio.extend_utterance(b"\x00\x00" * 6000)

    await pipeline._run_partial()  # noqa: SLF001
    await pipeline._run_partial()  # noqa: SLF001

    partials = [
        e for e in session.sent if e.get("type") == "transcript" and e.get("final") is False
    ]
    assert [p["text"] for p in partials] == ["i want to cook", "i want to cook chicken"]


class FakeStreamingEngine:
    """Minimal streaming engine double: records feeds, returns fixed text."""

    available = True

    def __init__(self, text: str) -> None:
        self.text = text
        self.feeds: list[bytes] = []
        self.streams = 0
        self.finished = 0

    def create_stream(self):
        self.streams += 1
        return object()

    def accept(self, _stream, pcm: bytes) -> str:
        self.feeds.append(pcm)
        return self.text

    def finish(self, _stream) -> str:
        self.finished += 1
        return self.text


async def test_streaming_engine_drives_partials():
    engine = FakeStreamingEngine("chop the onion")
    settings = Settings(_env_file=None)
    session = FakeSession()
    services = SimpleNamespace(
        settings=settings, stt=FakeSTT("unused"), stt_partial=None, streaming_stt=engine
    )
    pipeline = VoicePipeline(session, services)
    pipeline._begin_streaming_caption()  # noqa: SLF001 - as _on_speech_start does

    session.audio.begin_utterance()
    session.audio.extend_utterance(b"\x00\x00" * 6000)

    await pipeline._run_partial()  # noqa: SLF001

    partials = [
        e for e in session.sent if e.get("type") == "transcript" and e.get("final") is False
    ]
    assert partials and partials[0]["text"] == "chop the onion"
    assert engine.feeds, "engine must receive the new audio"
    # A second tick only forwards audio that arrived since the previous tick.
    await pipeline._run_partial()  # noqa: SLF001
    assert len(engine.feeds) == 1


async def test_streaming_tail_flush_emits_at_speech_end():
    # Burst delivery: the partial task is cancelled, but the tail flush at
    # speech_end must still emit the spoken line for the live caption.
    engine = FakeStreamingEngine("chop the onion finely")
    settings = Settings(_env_file=None)
    session = FakeSession()
    services = SimpleNamespace(
        settings=settings, stt=FakeSTT("unused"), stt_partial=None, streaming_stt=engine
    )
    pipeline = VoicePipeline(session, services)
    pipeline._begin_streaming_caption()  # noqa: SLF001
    stream = pipeline._stream_obj  # noqa: SLF001

    session.audio.begin_utterance()
    pcm = b"\x00\x00" * 6000
    session.audio.extend_utterance(pcm)

    await pipeline._flush_streaming_tail(stream, pcm)  # noqa: SLF001

    partials = [
        e for e in session.sent if e.get("type") == "transcript" and e.get("final") is False
    ]
    assert partials and partials[0]["text"] == "chop the onion finely"
    assert engine.finished == 1


async def test_speech_end_does_not_block_on_tail_flush():
    # A slow streaming flush must not stall speech_end (which would freeze the
    # receive loop and make the mic look "stuck").
    class SlowEngine(FakeStreamingEngine):
        def finish(self, _stream) -> str:
            time.sleep(0.3)
            return self.text

    engine = SlowEngine("chop the onion")
    settings = Settings(_env_file=None, transcription_only=True)
    session = FakeSession()
    services = SimpleNamespace(
        settings=settings, stt=FakeSTT("unused"), stt_partial=None, streaming_stt=engine
    )
    pipeline = VoicePipeline(session, services)
    pipeline._begin_streaming_caption()  # noqa: SLF001

    session.audio.begin_utterance()
    session.audio.extend_utterance(b"\x00\x00" * 6000)

    started = time.monotonic()
    await pipeline._on_speech_end()  # noqa: SLF001
    elapsed = time.monotonic() - started
    assert elapsed < 0.2, "speech_end must not await the streaming tail flush"

    pipeline._cancel_continuation()  # noqa: SLF001 - don't leave the timer pending
    await asyncio.sleep(0.4)  # let the background tail flush finish


class FakeLimiters:
    """Minimal limiter bundle: always allow a turn."""

    class session:  # noqa: N801 - stands in for RateLimiters.session
        @staticmethod
        async def allow_turn(_session_id: str) -> tuple[bool, float]:
            return True, 0.0


async def test_transcription_only_emits_final_without_reply(caplog):
    caplog.set_level(logging.INFO, logger="app.pipeline")
    stt = FakeSTT("hello there")
    settings = Settings(_env_file=None, transcription_only=True)
    session = FakeSession()
    services = SimpleNamespace(
        settings=settings, stt=stt, stt_partial=None, limiters=FakeLimiters()
    )
    pipeline = VoicePipeline(session, services)

    await pipeline._run_audio_turn(  # noqa: SLF001
        np.full(16000, 16384, dtype=np.int16).tobytes()
    )

    types = [e.get("type") for e in session.sent]
    assert "turn_end" in types
    finals = [
        e for e in session.sent if e.get("type") == "transcript" and e.get("final") is True
    ]
    assert finals and finals[0]["text"] == "hello there"
    # The final transcript is echoed to the backend terminal (operator feed).
    assert "final: hello there" in caplog.text
    # The reply engine (Gemini / TTS / tools) must not run in transcription-only.
    assert not any(
        e.get("type") in ("assistant_text", "assistant_audio", "tool_call")
        for e in session.sent
    )
    assert not any(e.get("type") == "error" for e in session.sent)