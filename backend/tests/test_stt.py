"""faster-whisper STT accuracy contract (techstack D-1, architecture §3).

Guards the accuracy upgrades described in techstack D-1:

* English-only ``small.en`` is the default model;
* decoding runs a configurable beam width at ``temperature=0.0``;
* a culinary ``initial_prompt`` is forwarded to the model to bias ingredients,
  units and numbers.

Fully offline: ``faster_whisper.WhisperModel`` is replaced by a recording fake,
so no weights or network are touched.
"""

from __future__ import annotations

import numpy as np
import pytest
from pydantic import ValidationError

from app.audio.stt import WhisperSTT, get_stt
from app.config import Settings
from app.errors import AppError, ErrorCode

DEFAULT_PROMPT = Settings.model_fields["whisper_initial_prompt"].default
TEST_PROMPT = "kitchen terms: teaspoon, simmer, garlic"


class _Segment:
    """Minimal stand-in for a faster-whisper segment."""

    def __init__(self, text: str) -> None:
        self.text = text


class _RecordingModel:
    """Fake ``WhisperModel`` that records every ``transcribe`` call."""

    def __init__(self) -> None:
        self.calls: list[tuple[np.ndarray, dict]] = []

    def transcribe(self, audio: np.ndarray, **kwargs):
        self.calls.append((audio, kwargs))
        return [_Segment(" add one teaspoon of salt "), _Segment("then stir")], None


def _loaded_stt(**kwargs) -> tuple[WhisperSTT, _RecordingModel]:
    stt = WhisperSTT(**kwargs)
    model = _RecordingModel()
    stt._models[stt.model_size] = model  # noqa: SLF001 - test seam for the offline fake
    stt._loaded = True  # noqa: SLF001
    return stt, model


# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------


def test_default_model_is_small_en():
    assert Settings.model_fields["whisper_model"].default == "small.en"
    assert Settings.model_fields["whisper_compute_type"].default == "int8_float32"


def test_default_hotwords_include_cuisine_terms():
    hot = Settings.model_fields["whisper_hotwords"].default.lower()
    assert "adobo" in hot
    assert "filipino" in hot


def test_default_beam_size_is_greedy():
    # Latency-first final pass: greedy decoding (beam_size=1).
    assert Settings.model_fields["whisper_beam_size"].default == 1


def test_default_prompt_is_empty_opt_in():
    # A domain prompt seeds hallucinated filler on noisy audio; opt-in only.
    assert Settings.model_fields["whisper_initial_prompt"].default == ""

def test_beam_size_must_be_positive():
    with pytest.raises(ValidationError):
        Settings(whisper_beam_size=0)


# ---------------------------------------------------------------------------
# Decoding parameters are forwarded to the model
# ---------------------------------------------------------------------------


async def test_transcribe_forwards_beam_size_and_initial_prompt():
    stt, model = _loaded_stt(initial_prompt=TEST_PROMPT, beam_size=5)

    pcm = np.zeros(16000, dtype=np.int16).tobytes()  # 1.0 s clip: prompt applies
    text = await stt.transcribe(pcm)

    assert text == "add one teaspoon of salt then stir"
    assert len(model.calls) == 1
    _audio, kwargs = model.calls[0]
    assert kwargs["beam_size"] == 5
    assert kwargs["initial_prompt"] == TEST_PROMPT
    assert kwargs["temperature"] == 0.0
    assert kwargs["language"] == "en"
    assert kwargs["vad_filter"] is False
    assert kwargs["condition_on_previous_text"] is False


async def test_custom_beam_size_and_prompt_are_forwarded():
    stt, model = _loaded_stt(initial_prompt="custom kitchen terms", beam_size=2)

    await stt.transcribe(np.zeros(16000, dtype=np.int16).tobytes())  # 1.0 s clip

    _audio, kwargs = model.calls[0]
    assert kwargs["beam_size"] == 2
    assert kwargs["initial_prompt"] == "custom kitchen terms"


async def test_empty_audio_short_circuits_without_model_call():
    stt, model = _loaded_stt(initial_prompt=TEST_PROMPT, beam_size=5)
    assert await stt.transcribe(b"") == ""
    assert model.calls == []


async def test_transcribe_before_load_raises_engine_loading(monkeypatch):
    stt = WhisperSTT()
    # The loader cannot fetch weights in the offline suite: report loading.
    monkeypatch.setattr(stt, "_load_model", lambda model_size: None)
    with pytest.raises(AppError) as info:
        await stt.transcribe(b"\x00" * 32)
    assert info.value.code is ErrorCode.ENGINE_LOADING


# ---------------------------------------------------------------------------
# English-only decoding
# ---------------------------------------------------------------------------


async def test_transcribe_always_decodes_as_english():
    stt, model = _loaded_stt(initial_prompt=TEST_PROMPT, beam_size=1)

    await stt.transcribe(np.zeros(16000, dtype=np.int16).tobytes())

    _audio, kwargs = model.calls[0]
    assert kwargs["language"] == "en"


# ---------------------------------------------------------------------------
# Anti-hallucination decoding guards
# ---------------------------------------------------------------------------


async def test_anti_hallucination_decoding_parameters_are_forwarded():
    stt, model = _loaded_stt(initial_prompt=TEST_PROMPT, beam_size=5)

    await stt.transcribe(np.zeros(16000, dtype=np.int16).tobytes())

    _audio, kwargs = model.calls[0]
    assert kwargs["no_speech_threshold"] == 0.6
    assert kwargs["compression_ratio_threshold"] == 2.4
    assert kwargs["log_prob_threshold"] == -1.0


async def test_initial_prompt_omitted_for_short_clip():
    stt, model = _loaded_stt(initial_prompt=TEST_PROMPT, beam_size=5)

    await stt.transcribe(np.zeros(8000, dtype=np.int16).tobytes())  # 0.5 s

    _audio, kwargs = model.calls[0]
    assert kwargs["initial_prompt"] is None


async def test_initial_prompt_included_at_one_second_boundary():
    stt, model = _loaded_stt(initial_prompt=TEST_PROMPT, beam_size=5)

    await stt.transcribe(np.zeros(16000, dtype=np.int16).tobytes())  # exactly 1.0 s

    _audio, kwargs = model.calls[0]
    assert kwargs["initial_prompt"] == TEST_PROMPT


async def test_initial_prompt_omitted_when_not_configured():
    stt, model = _loaded_stt(initial_prompt=None, beam_size=5)

    await stt.transcribe(np.zeros(16000, dtype=np.int16).tobytes())

    _audio, kwargs = model.calls[0]
    assert kwargs["initial_prompt"] is None


async def test_all_segments_dropped_returns_empty_string():
    stt = WhisperSTT(initial_prompt=TEST_PROMPT, beam_size=5)

    class _EmptyModel:
        def transcribe(self, audio: np.ndarray, **kwargs):  # noqa: ANN001, ARG002
            return [], None

    stt._models[stt.model_size] = _EmptyModel()  # noqa: SLF001 - offline test seam
    stt._loaded = True  # noqa: SLF001

    assert await stt.transcribe(np.zeros(16000, dtype=np.int16).tobytes()) == ""


# ---------------------------------------------------------------------------
# Speech-gate configuration
# ---------------------------------------------------------------------------


def test_default_speech_gate_thresholds():
    assert Settings.model_fields["stt_min_utterance_s"].default == 0.15
    assert Settings.model_fields["stt_min_rms_dbfs"].default == -120.0
    assert Settings.model_fields["stt_noise_margin_db"].default == 0.0


def test_stt_min_utterance_must_be_positive():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, stt_min_utterance_s=0.0)


def test_stt_min_rms_dbfs_accepts_negative_values():
    settings = Settings(_env_file=None, stt_min_rms_dbfs=-60.0)
    assert settings.stt_min_rms_dbfs == -60.0


# ---------------------------------------------------------------------------
# Singleton threading
# ---------------------------------------------------------------------------


def test_get_instance_threads_configuration():
    original = WhisperSTT._instance  # noqa: SLF001 - preserve global state
    WhisperSTT._instance = None  # noqa: SLF001
    try:
        instance = get_stt(model_size="tiny.en", initial_prompt="p", beam_size=3)
        assert instance.model_size == "tiny.en"
        assert instance.initial_prompt == "p"
        assert instance.beam_size == 3

        # Subsequent calls return the already-configured singleton.
        assert get_stt() is instance
    finally:
        WhisperSTT._instance = original  # noqa: SLF001


async def test_transcribe_forwards_hotwords():
    stt, model = _loaded_stt(hotwords="adobo, sinigang", beam_size=5)

    await stt.transcribe(np.zeros(16000, dtype=np.int16).tobytes())

    _audio, kwargs = model.calls[0]
    assert kwargs["hotwords"] == "adobo, sinigang"

async def test_short_wake_uses_name_bias_without_long_culinary_prompt():
    stt, model = _loaded_stt(hotwords="adobo, sinigang", initial_prompt="A long culinary glossary")
    await stt.transcribe_wake(np.zeros(6400, dtype=np.int16).tobytes())
    _audio, kwargs = model.calls[-1]
    assert "Keef" in kwargs["hotwords"] and "Kef" in kwargs["hotwords"]
    assert "adobo" not in kwargs["hotwords"]
    assert kwargs["initial_prompt"] is None
