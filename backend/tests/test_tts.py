"""edge-tts synthesis timeout contract (architecture §7, §11, spec EH-5).

A hung synth must raise ``tts_failed`` (degrading the turn to text-only) rather
than block the turn forever.
"""

from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

import pytest

from app.config import ALLOWED_TTS_VOICES, Settings, is_allowed_voice
from app.errors import AppError, ErrorCode
from app.tts.edge import EdgeTTS


class _RecordingCommunicate:
    """edge-tts stand-in that records the voice id and yields one audio chunk."""

    instances: list["_RecordingCommunicate"] = []

    def __init__(self, text, voice, *, rate, volume):  # noqa: ANN001
        self.text = text
        self.voice = voice
        self.rate = rate
        self.volume = volume
        _RecordingCommunicate.instances.append(self)

    async def stream(self):
        yield {"type": "audio", "data": b"\x01\x02"}


def _install_recorder(monkeypatch) -> None:
    _RecordingCommunicate.instances = []
    monkeypatch.setitem(
        sys.modules, "edge_tts", SimpleNamespace(Communicate=_RecordingCommunicate)
    )


def test_default_tts_timeout_is_configured():
    assert Settings.model_fields["tts_timeout_s"].default == 15.0


def test_allowlist_covers_the_configured_default():
    assert "en-US-AriaNeural" in ALLOWED_TTS_VOICES
    assert is_allowed_voice("en-GB-RyanNeural")
    assert not is_allowed_voice("not-a-voice")
    assert not is_allowed_voice("")


async def test_synthesize_uses_voice_override(monkeypatch):
    _install_recorder(monkeypatch)
    tts = EdgeTTS(Settings(tts_voice="en-US-AriaNeural"))

    assert await tts.synthesize("hello", voice="en-GB-RyanNeural") == b"\x01\x02"
    assert _RecordingCommunicate.instances[-1].voice == "en-GB-RyanNeural"


async def test_synthesize_defaults_to_configured_voice(monkeypatch):
    _install_recorder(monkeypatch)
    tts = EdgeTTS(Settings(tts_voice="en-US-AriaNeural"))

    await tts.synthesize("hello")
    assert _RecordingCommunicate.instances[-1].voice == "en-US-AriaNeural"


async def test_stream_sentences_forwards_voice_override(monkeypatch):
    _install_recorder(monkeypatch)
    tts = EdgeTTS(Settings(tts_voice="en-US-AriaNeural"))

    chunks = [
        chunk
        async for chunk in tts.stream_sentences(
            ["one two", "three four"], voice="en-GB-SoniaNeural"
        )
    ]

    assert len(chunks) == 2
    assert {c.voice for c in _RecordingCommunicate.instances} == {"en-GB-SoniaNeural"}


async def test_stream_chunked_text_forwards_voice_override(monkeypatch):
    _install_recorder(monkeypatch)
    tts = EdgeTTS(Settings(tts_voice="en-US-AriaNeural"))

    async def deltas():
        yield "First sentence. Second sentence."

    chunks = [
        chunk
        async for chunk in tts.stream_chunked_text(
            deltas(), voice="en-AU-NatashaNeural"
        )
    ]

    assert len(chunks) == 2
    assert {c.voice for c in _RecordingCommunicate.instances} == {"en-AU-NatashaNeural"}


async def test_synthesis_timeout_raises_tts_failed(monkeypatch):
    class HangingCommunicate:
        def __init__(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            pass

        async def stream(self):
            await asyncio.sleep(30)
            yield {}  # pragma: no cover - never reached before the timeout

    monkeypatch.setitem(
        sys.modules, "edge_tts", SimpleNamespace(Communicate=HangingCommunicate)
    )
    tts = EdgeTTS(Settings(tts_timeout_s=0.01))

    with pytest.raises(AppError) as info:
        await tts.synthesize("hello there")

    assert info.value.code is ErrorCode.TTS_FAILED


async def test_blank_text_short_circuits_without_synthesis(monkeypatch):
    def _explode(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("Communicate must not be constructed for blank text")

    monkeypatch.setitem(sys.modules, "edge_tts", SimpleNamespace(Communicate=_explode))
    tts = EdgeTTS(Settings(tts_timeout_s=0.01))
    assert await tts.synthesize("   ") == b""
