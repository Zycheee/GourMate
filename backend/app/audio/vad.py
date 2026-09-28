"""Silero VAD wrapper with start/end detection and barge-in support.

Silero is loaded once per process (lazy singleton), matching the architecture's
"model loading is process-global and lazy" rule. The v5 model consumes fixed
512-sample (32 ms) windows at 16 kHz, so incoming frames are rechunked here.

The wrapper exposes a small hysteresis state machine:

* ``speech_start`` when probability stays above ``START_THRESHOLD`` for
  ``MIN_SPEECH_FRAMES`` windows;
* ``speech_end`` when probability stays below ``END_THRESHOLD`` for
  ``MIN_SILENCE_FRAMES`` windows.

Barge-in is reported when a ``speech_start`` occurs while the assistant is
speaking (architecture section 4, step 2).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from enum import Enum
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

# Silero v5 requires exactly 512 samples per inference at 16 kHz.
WINDOW_SAMPLES = 512
WINDOW_BYTES = WINDOW_SAMPLES * 2
SAMPLE_RATE = 16000

START_THRESHOLD = 0.4
END_THRESHOLD = 0.20
MIN_SPEECH_FRAMES = 3  # ~96 ms of speech before declaring start
#: Default silence hold before end-of-utterance (~3.0 s). Kept for the standalone
#: default; the running session configures this from ``VAD_MIN_SILENCE_S``
#: (~0.8 s) so the final transcript is not delayed by a long pause.
MIN_SILENCE_FRAMES = 94


class VADEventType(str, Enum):
    """The two VAD transitions emitted to the client."""

    SPEECH_START = "speech_start"
    SPEECH_END = "speech_end"


@dataclass(slots=True)
class VADEvent:
    """A VAD transition plus whether it constitutes a barge-in."""

    kind: VADEventType
    barge_in: bool = False

    @property
    def value(self) -> str:
        return self.kind.value


class SileroVAD:
    """Lazy singleton Silero VAD with a streaming hysteresis state machine."""

    _instance: "SileroVAD | None" = None
    _instance_lock = threading.Lock()

    def __init__(self, min_silence_frames: int = MIN_SILENCE_FRAMES) -> None:
        self._model: Any = None
        self._loaded = False
        self._load_lock = threading.Lock()
        self._pending = bytearray()
        self._prob_ema = 0.0
        self._in_speech = False
        self._speech_frames = 0
        self._silence_frames = 0
        self._assistant_speaking = False
        self._min_silence_frames = max(1, int(min_silence_frames))

    # -- endpointing configuration ----------------------------------------
    def configure_min_silence(self, seconds: float) -> None:
        """Set the end-of-speech silence hold from a duration in seconds.

        The hold is the number of consecutive low-probability 32 ms windows
        required before ``speech_end`` fires. Shrinking it finalizes the turn
        (and the accurate final transcript) promptly instead of after a long
        pause. A minimum of one window is always kept.
        """
        frames = round(seconds * SAMPLE_RATE / WINDOW_SAMPLES)
        self._min_silence_frames = max(1, frames)

    @property
    def min_silence_frames(self) -> int:
        return self._min_silence_frames

    @property
    def min_silence_seconds(self) -> float:
        return self._min_silence_frames * (WINDOW_SAMPLES / SAMPLE_RATE)

    # -- singleton ---------------------------------------------------------
    @classmethod
    def get_instance(cls) -> "SileroVAD":
        """Return the process-global VAD wrapper."""
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    # -- lifecycle ---------------------------------------------------------
    def load(self) -> bool:
        """Load the Silero model (idempotent). Returns ``True`` on success.

        Safe to call from a worker thread during startup warmup.
        """
        if self._loaded:
            return True
        with self._load_lock:
            if self._loaded:
                return True
            try:
                from silero_vad import load_silero_vad  # type: ignore[import-not-found]

                self._model = load_silero_vad()
                self._loaded = True
                logger.info("Silero VAD loaded")
            except Exception:  # pragma: no cover - depends on weights/torch
                logger.exception("Failed to load Silero VAD")
                self._loaded = False
            return self._loaded

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def is_speaking(self) -> bool:
        """Whether the VAD is currently inside a speech segment."""
        return self._in_speech

    def mark_assistant_speaking(self, speaking: bool) -> None:
        """Track whether TTS audio is currently playing (for barge-in)."""
        self._assistant_speaking = speaking

    @property
    def assistant_speaking(self) -> bool:
        return self._assistant_speaking

    def reset(self) -> None:
        """Reset all streaming state. Call at the start of a session."""
        self._pending.clear()
        self._prob_ema = 0.0
        self._in_speech = False
        self._speech_frames = 0
        self._silence_frames = 0
        self._assistant_speaking = False
        if self._model is not None:
            try:
                self._model.reset_states()
            except Exception:  # pragma: no cover - model-specific
                logger.debug("Silero reset_states failed", exc_info=True)

    # -- streaming ---------------------------------------------------------
    def feed(self, pcm: bytes) -> list[VADEvent]:
        """Feed a PCM frame and return any transitions it produced.

        Frames may be any even length; bytes are buffered until full 512-sample
        windows are available. Invalid frames are ignored. If the model is not
        loaded, returns an empty list.
        """
        if not self._loaded or self._model is None or not pcm:
            return []
        if len(pcm) % 2 != 0:
            pcm = pcm[:-1]
        self._pending.extend(pcm)

        events: list[VADEvent] = []
        while len(self._pending) >= WINDOW_BYTES:
            window = bytes(self._pending[:WINDOW_BYTES])
            del self._pending[:WINDOW_BYTES]
            event = self._process_window(window)
            if event is not None:
                events.append(event)
        return events

    def _process_window(self, window: bytes) -> VADEvent | None:
        try:
            import torch  # type: ignore[import-not-found]

            samples = np.frombuffer(window, dtype=np.int16).astype(np.float32) / 32768.0
            tensor = torch.from_numpy(samples)
            with torch.no_grad():
                probability = float(self._model(tensor, SAMPLE_RATE).item())
        except Exception:  # pragma: no cover - inference failure
            logger.exception("Silero inference failed; dropping window")
            return None

        # Temporal smoothing (EMA) so a weak mic's probability does not flap
        # across the thresholds within a single utterance.
        alpha = 0.6 if probability > self._prob_ema else 0.25
        self._prob_ema += alpha * (probability - self._prob_ema)
        probability = self._prob_ema
        if not self._in_speech:
            if probability >= START_THRESHOLD:
                self._speech_frames += 1
                if self._speech_frames >= MIN_SPEECH_FRAMES:
                    self._in_speech = True
                    self._silence_frames = 0
                    barge_in = self._assistant_speaking
                    logger.info("VAD speech_start (barge_in=%s)", barge_in)
                    return VADEvent(VADEventType.SPEECH_START, barge_in=barge_in)
            else:
                self._speech_frames = 0
            return None

        if probability <= END_THRESHOLD:
            self._silence_frames += 1
            if self._silence_frames >= self._min_silence_frames:
                self._in_speech = False
                self._speech_frames = 0
                self._silence_frames = 0
                logger.info("VAD speech_end")
                return VADEvent(VADEventType.SPEECH_END)
        else:
            self._silence_frames = 0
        return None


def get_vad() -> SileroVAD:
    """Convenience accessor for the global VAD instance."""
    return SileroVAD.get_instance()


__all__ = [
    "MIN_SILENCE_FRAMES",
    "MIN_SPEECH_FRAMES",
    "SAMPLE_RATE",
    "SileroVAD",
    "VADEvent",
    "VADEventType",
    "WINDOW_BYTES",
    "WINDOW_SAMPLES",
    "get_vad",
]
