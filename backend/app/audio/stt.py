"""faster-whisper STT wrapper (lazy, English-only).

English uses ``small.en`` (default ``WHISPER_MODEL``) for maximum kitchen
accuracy. The model is loaded once per process and cached under ``HF_HOME``.

Transcription is CPU-bound and therefore executed in a worker thread via
``asyncio.to_thread`` so the event loop keeps servicing audio frames during
finalization.

Decoding runs greedy (``beam_size=1``) at ``temperature=0.0`` with a culinary
``initial_prompt`` biasing ingredients, units and numbers. This trades a little
accuracy for much lower CPU latency; see architecture section 3 and techstack
D-1.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

import numpy as np

from ..errors import AppError, ErrorCode

logger = logging.getLogger(__name__)


class WhisperSTT:
    """Lazy singleton wrapper around a ``faster_whisper.WhisperModel``."""

    _instance: "WhisperSTT | None" = None
    _instance_lock = threading.Lock()

    def __init__(
        self,
        model_size: str = "small.en",
        device: str = "cpu",
        compute_type: str = "int8_float32",
        initial_prompt: str | None = None,
        beam_size: int = 1,
        hotwords: str | None = None,
    ) -> None:
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type
        self._initial_prompt = initial_prompt
        self._beam_size = beam_size
        self._hotwords = hotwords
        #: Cache keyed by model size; the model is preloaded by ``load``.
        self._models: dict[str, Any] = {}
        self._loaded = False
        self._load_lock = threading.Lock()

    @classmethod
    def get_instance(
        cls,
        model_size: str = "small.en",
        initial_prompt: str | None = None,
        beam_size: int = 1,
        compute_type: str = "int8_float32",
        hotwords: str | None = None,
    ) -> "WhisperSTT":
        """Return the process-global STT wrapper, creating it on first use.

        Configuration is only applied when the singleton is first created;
        subsequent calls return the already-configured instance.
        """
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls(
                        model_size=model_size,
                        initial_prompt=initial_prompt,
                        beam_size=beam_size,
                        compute_type=compute_type,
                        hotwords=hotwords,
                    )
        return cls._instance

    def load(self) -> bool:
        """Load the model. Safe to call from a worker thread."""
        return self._ensure_model(self._model_size) is not None

    def _ensure_model(self, model_size: str) -> Any | None:
        """Return the cached model, loading it if needed."""
        cached = self._models.get(model_size)
        if cached is not None:
            return cached
        with self._load_lock:
            cached = self._models.get(model_size)
            if cached is not None:
                return cached
            model = self._load_model(model_size)
            if model is not None:
                self._models[model_size] = model
                self._loaded = True
            return model

    def _load_model(self, model_size: str) -> Any | None:
        try:
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]

            model = WhisperModel(
                model_size,
                device=self._device,
                compute_type=self._compute_type,
            )
            logger.info(
                "faster-whisper '%s' loaded (device=%s, compute=%s)",
                model_size,
                self._device,
                self._compute_type,
            )
            return model
        except Exception:  # pragma: no cover - depends on weights
            logger.exception("Failed to load faster-whisper '%s'", model_size)
            return None

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def model_size(self) -> str:
        return self._model_size

    @property
    def beam_size(self) -> int:
        return self._beam_size

    @property
    def initial_prompt(self) -> str | None:
        return self._initial_prompt

    @property
    def hotwords(self) -> str | None:
        return self._hotwords

    async def transcribe(self, pcm_int16: bytes) -> str:
        """Transcribe 16 kHz mono Int16 PCM into plain text.

        Returns an empty string when no speech is recognized. Raises
        ``engine_loading`` when the model cannot be loaded.
        """
        if not pcm_int16:
            return ""
        model = await asyncio.to_thread(self._ensure_model, self._model_size)
        if model is None:
            raise AppError(
                ErrorCode.ENGINE_LOADING,
                f"Speech model '{self._model_size}' is not loaded yet.",
            )

        audio = np.frombuffer(pcm_int16, dtype=np.int16).astype(np.float32) / 32768.0
        return await asyncio.to_thread(self._transcribe_sync, model, audio)

    def _transcribe_sync(self, model: Any, audio: np.ndarray) -> str:
        # Anti-hallucination: only forward the long culinary ``initial_prompt``
        # when the clip is long enough to justify it. A long prompt on a short
        # or quiet clip is a known faster-whisper hallucination trigger, so it is
        # omitted (``None``) for sub-second audio.
        initial_prompt = (
            self._initial_prompt
            if (self._initial_prompt and len(audio) / 16000 >= 1.0)
            else None
        )
        segments, _info = model.transcribe(
            audio,
            language="en",
            beam_size=self._beam_size,
            temperature=0.0,
            vad_filter=False,  # ingress VAD already determined the utterance
            condition_on_previous_text=False,
            # Documented faster-whisper (1.2.x) hallucination guards: drop
            # no-speech windows, reject repetitive/high-compression output, and
            # discard low-confidence segments.
            no_speech_threshold=0.6,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            hotwords=self._hotwords,
            initial_prompt=initial_prompt,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        if not text:
            # Every segment was dropped by the thresholds above: report silence.
            return ""
        return text


def get_stt(
    model_size: str = "small.en",
    initial_prompt: str | None = None,
    beam_size: int = 1,
    compute_type: str = "int8_float32",
    hotwords: str | None = None,
) -> WhisperSTT:
    """Convenience accessor for the global STT instance."""
    return WhisperSTT.get_instance(
        model_size=model_size,
        initial_prompt=initial_prompt,
        beam_size=beam_size,
        compute_type=compute_type,
        hotwords=hotwords,
    )


__all__ = ["WhisperSTT", "get_stt"]
