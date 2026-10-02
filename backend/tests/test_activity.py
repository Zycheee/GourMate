"""Sleep capture isolation and cancellation, with offline VAD/STT/TTS (§7)."""
import asyncio
from unittest.mock import AsyncMock

import numpy as np
import pytest

from tests.test_planning import _FakeSession, _FakeRecipes, _ScriptedGemini, _pipeline, _plan_recipe
from app.audio.buffer import AudioRingBuffer
from app.audio.vad import VADEvent, VADEventType


def setup_pipeline(text=""):
    session = _FakeSession()
    session.state.sleeping = True
    session.state.wake_listening = True
    session.state.muted = True
    pipeline = _pipeline(session, gemini=_ScriptedGemini([]), recipes=_FakeRecipes(_plan_recipe()))
    pipeline._services.stt = type("STT", (), {"transcribe": AsyncMock(return_value=text)})()
    pipeline._services.vad.reset = lambda: None
    pcm = (np.sin(np.arange(16000) * 0.12) * 9000).astype(np.int16).tobytes()
    return session, pipeline, pcm


@pytest.mark.parametrize("phrase", ["Kef", "Keef", "Hey Keef", "Hello Keef!", "Okay Kef.", "OK, Keef", "hEy, KEF!"])
async def test_bare_wake_is_acknowledged_without_gemini(phrase):
    session, pipeline, pcm = setup_pipeline(phrase)
    await pipeline._run_audio_turn(pcm)
    assert session.state.sleeping is False
    assert session.events[0]["type"] == "activity"
    assert "assistant_text" in session.types()
    assert "transcript" not in session.types()
    assert not pipeline._services.gemini.calls


async def test_wake_request_strips_only_wake_prefix():
    session, pipeline, pcm = setup_pipeline("Hey Kef, what can I cook with eggs?")
    pipeline._respond = AsyncMock()
    await pipeline._run_audio_turn(pcm)
    pipeline._respond.assert_awaited_once_with("what can I cook with eggs?", from_voice=True)
    assert [e["text"] for e in session.events if e["type"] == "transcript"] == ["what can I cook with eggs?"]


@pytest.mark.parametrize("text", ["what should I cook", "I said hello Kef yesterday", "Kefir", "Hey chef"])
async def test_unrelated_sleep_speech_is_invisible(text):
    session, pipeline, pcm = setup_pipeline(text)
    await pipeline._run_audio_turn(pcm)
    assert session.events == []
    assert session.state.turns == []
    assert not pipeline._services.gemini.calls


async def test_delayed_transcription_is_rejected_after_mute():
    session, pipeline, pcm = setup_pipeline("Hey Kef, cook eggs")
    started, release = asyncio.Event(), asyncio.Event()
    async def delayed(_):
        started.set()
        await release.wait()
        return "Hey Kef, cook eggs"
    pipeline._services.stt.transcribe = delayed
    task = asyncio.create_task(pipeline._run_audio_turn(pcm))
    await started.wait()
    await pipeline.discard_input()
    release.set()
    await task
    assert session.state.sleeping is True
    assert not session.events


async def test_text_replacement_cancels_processing_and_clears_capture():
    session, pipeline, _ = setup_pipeline()
    started = asyncio.Event()
    cancelled = []
    async def reply(text):
        if text == "old":
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.append(text)
                raise
    pipeline.handle_text_input = reply
    pipeline._continuation_pcm.extend(b"unfinished")
    await pipeline.start_text_input("old")
    await started.wait()
    await pipeline.start_text_input("new")
    await pipeline._turn_task
    assert cancelled == ["old"]
    assert not pipeline._continuation_pcm
    assert session.state.sleeping is False


async def test_playback_keeps_vad_open_and_silence_does_not_interrupt():
    session, pipeline, pcm = setup_pipeline()
    session.state.sleeping = False
    session.state.wake_listening = False
    session.state.muted = False
    session.audio = AudioRingBuffer(60, 30)
    session.assistant_speaking = True
    feed = []
    pipeline._services.vad.feed = lambda frame: feed.append(frame) or []
    await pipeline.handle_audio(bytes(1024))
    assert feed == [bytes(1024)]
    assert session.assistant_speaking is True
    pipeline._services.vad.feed = lambda frame: [VADEvent(VADEventType.SPEECH_START, barge_in=True)]
    await pipeline.handle_audio(pcm[:1024])
    assert session.assistant_speaking is False
    assert session.audio.capturing is True
    assert any(e["type"] == "vad" and e["state"] == "speech_start" for e in session.events)


async def test_mute_submits_captured_speech_once_without_continuation_delay():
    session, pipeline, pcm = setup_pipeline("I have eggs")
    session.state.sleeping = False
    session.state.wake_listening = False
    session.audio = AudioRingBuffer(60, 30)
    session.audio.begin_utterance()
    session.audio.extend_utterance(pcm)
    pipeline._utterance_id = "capture"
    pipeline._continuation_task = asyncio.create_task(asyncio.sleep(60))
    pipeline._respond = AsyncMock()
    await pipeline.submit_input("capture")
    await pipeline._turn_task
    await pipeline.submit_input("capture")
    assert pipeline._services.stt.transcribe.await_count == 1
    pipeline._respond.assert_awaited_once_with("I have eggs", from_voice=True)
    assert [e["utterance_id"] for e in session.events if e["type"] == "transcript"] == ["capture"]
    assert not session.audio.capturing and not session.audio.snapshot()
    assert pipeline._continuation_task is None
    assert session.state.muted is True


async def test_mute_during_transcription_accepts_original_once_and_aliases_identity():
    session, pipeline, pcm = setup_pipeline()
    session.state.sleeping = False
    session.state.wake_listening = False
    session.audio = AudioRingBuffer(60, 30)
    started, release = asyncio.Event(), asyncio.Event()
    async def transcribe(_):
        started.set()
        await release.wait()
        return "I am ready"
    pipeline._services.stt.transcribe = AsyncMock(side_effect=transcribe)
    pipeline._respond = AsyncMock()
    pipeline._utterance_id = "original"
    pipeline._schedule_turn(pcm)
    await started.wait()
    await pipeline.submit_input("submitted")
    release.set()
    await pipeline._turn_task
    assert pipeline._services.stt.transcribe.await_count == 1
    assert [e["utterance_id"] for e in session.events if e["type"] == "transcript"] == ["submitted"]
    pipeline._respond.assert_awaited_once()


@pytest.mark.parametrize("pcm_kind", ["empty", "silence", "short_speech"])
async def test_empty_silent_and_short_mute_produce_no_chat(pcm_kind):
    session, pipeline, pcm = setup_pipeline("")
    session.state.sleeping = False
    session.state.wake_listening = False
    session.audio = AudioRingBuffer(60, 30)
    data = b"" if pcm_kind == "empty" else bytes(len(pcm)) if pcm_kind == "silence" else pcm[:1000]
    session.audio.begin_utterance()
    session.audio.extend_utterance(data)
    await pipeline.submit_input("silence")
    if pipeline._turn_task:
        await pipeline._turn_task
    assert not session.state.turns
    assert not any(e["type"] in ("transcript", "assistant_text", "error") for e in session.events)
    pipeline._services.stt.transcribe.assert_not_awaited()


@pytest.mark.parametrize("phrase", ["Keef", "Hey Kef, help me cook eggs"])
async def test_manual_mute_of_wake_phrase_can_wake_without_unmuting(phrase):
    session, pipeline, pcm = setup_pipeline(phrase)
    session.state.wake_listening = False  # hardware stopped by mute control
    session.audio = AudioRingBuffer(60, 30)
    session.audio.begin_utterance()
    session.audio.extend_utterance(pcm)
    pipeline._respond = AsyncMock()
    await pipeline.submit_input("wake", wake_only=True)
    await pipeline._turn_task
    assert session.state.sleeping is False and session.state.muted is True
    assert not pipeline._services.gemini.calls
    if phrase == "Keef":
        assert not any(e["type"] == "transcript" for e in session.events)
        pipeline._respond.assert_not_awaited()
    else:
        pipeline._respond.assert_awaited_once_with("help me cook eggs", from_voice=True)


async def test_submit_falls_back_to_pre_vad_tail_and_accepts_short_even_frame():
    session, pipeline, pcm = setup_pipeline("Keef")
    session.audio = AudioRingBuffer(60, 30)
    for i in range(0, 8000, 1024):
        assert session.audio.append(pcm[i:min(i+1024,8000)])
    session.state.wake_listening = False
    await pipeline.submit_input("tail", wake_only=True)
    await pipeline._turn_task
    assert session.state.sleeping is False and session.state.muted is True
    assert pipeline._services.stt.transcribe.await_count == 1


async def test_fresh_capture_after_mute_has_separate_identity_and_no_old_words():
    session, pipeline, pcm = setup_pipeline("first")
    session.state.sleeping = False
    session.state.wake_listening = False
    session.audio = AudioRingBuffer(60, 30)
    pipeline._respond = AsyncMock()
    for identity, text in [("one", "first"), ("two", "second")]:
        pipeline._services.stt.transcribe.return_value = text
        session.audio.begin_utterance()
        session.audio.extend_utterance(pcm)
        pipeline._utterance_id = identity
        await pipeline.submit_input(identity)
        await pipeline._turn_task
    assert [e["text"] for e in session.events if e["type"] == "transcript"] == ["first", "second"]
    assert [e["utterance_id"] for e in session.events if e["type"] == "transcript"] == ["one", "two"]


async def test_queued_second_recording_preserves_identity_after_first_stt():
    session, pipeline, pcm = setup_pipeline()
    session.state.sleeping = False
    session.state.wake_listening = False
    session.audio = AudioRingBuffer(60, 30)
    started, release = asyncio.Event(), asyncio.Event()
    calls = []
    async def transcribe(_):
        calls.append(1)
        if len(calls) == 1:
            started.set()
            await release.wait()
            return "first"
        return "second"
    pipeline._services.stt.transcribe = transcribe
    pipeline._respond = AsyncMock()
    pipeline._utterance_id = "first_id"
    pipeline._schedule_turn(pcm)
    await started.wait()
    session.audio.begin_utterance()
    session.audio.extend_utterance(pcm)
    pipeline._utterance_id = "second_id"
    await pipeline.submit_input("second_id")
    release.set()
    first = pipeline._turn_task
    await first
    await asyncio.sleep(0)
    await pipeline._turn_task
    assert [e["utterance_id"] for e in session.events if e["type"] == "transcript"] == ["first_id", "second_id"]
    assert len(calls) == 2
