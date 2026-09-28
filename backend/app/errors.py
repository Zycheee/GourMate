"""Typed error taxonomy (architecture doc section 11).

Every failure path in the backend raises :class:`AppError` carrying one of the
``ErrorCode`` values. No bare exceptions reach the transport layer: the WS
session and the REST error handlers convert ``AppError`` into typed payloads.
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class ErrorCode(str, Enum):
    """The complete error taxonomy from architecture section 11."""

    OUT_OF_SCOPE = "out_of_scope"
    RECIPE_INVALID = "recipe_invalid"
    AUDIO_TOO_LONG = "audio_too_long"
    NO_SPEECH = "no_speech"
    AUDIO_CORRUPT = "audio_corrupt"
    MIC_DENIED = "mic_denied"
    LLM_TIMEOUT = "llm_timeout"
    LLM_RATE = "llm_rate"
    LLM_BLOCKED = "llm_blocked"
    LLM_CONFIG = "llm_config"
    TTS_FAILED = "tts_failed"
    RATE_LIMITED = "rate_limited"
    ENGINE_LOADING = "engine_loading"
    WS_DROPPED = "ws_dropped"


#: Whether the client should offer a retry for each code by default.
DEFAULT_RECOVERABLE: dict[ErrorCode, bool] = {
    ErrorCode.OUT_OF_SCOPE: True,
    ErrorCode.RECIPE_INVALID: True,
    ErrorCode.AUDIO_TOO_LONG: True,
    ErrorCode.NO_SPEECH: True,
    ErrorCode.AUDIO_CORRUPT: True,
    ErrorCode.MIC_DENIED: False,
    ErrorCode.LLM_TIMEOUT: True,
    ErrorCode.LLM_RATE: True,
    ErrorCode.LLM_BLOCKED: True,
    ErrorCode.LLM_CONFIG: True,
    ErrorCode.TTS_FAILED: True,
    ErrorCode.RATE_LIMITED: True,
    ErrorCode.ENGINE_LOADING: True,
    ErrorCode.WS_DROPPED: True,
}

#: REST status mapping (architecture sections 8 and 11).
REST_STATUS: dict[ErrorCode, int] = {
    ErrorCode.OUT_OF_SCOPE: 400,
    ErrorCode.RECIPE_INVALID: 400,
    ErrorCode.AUDIO_TOO_LONG: 400,
    ErrorCode.NO_SPEECH: 400,
    ErrorCode.AUDIO_CORRUPT: 400,
    ErrorCode.MIC_DENIED: 400,
    ErrorCode.LLM_TIMEOUT: 502,
    ErrorCode.LLM_RATE: 502,
    ErrorCode.LLM_BLOCKED: 502,
    ErrorCode.LLM_CONFIG: 502,
    ErrorCode.TTS_FAILED: 502,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.ENGINE_LOADING: 503,
    ErrorCode.WS_DROPPED: 500,
}

#: Spoken fallbacks. Canonical strings shared with the frontend copy map.
SPOKEN_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.OUT_OF_SCOPE: "I'm just here for the cooking. Want me to get back to it?",
    ErrorCode.RECIPE_INVALID: "I couldn't read that one. Paste it again, or tell me the dish.",
    ErrorCode.AUDIO_TOO_LONG: "That was a long one — try a shorter ask.",
    ErrorCode.NO_SPEECH: "",
    ErrorCode.AUDIO_CORRUPT: "I lost part of that. Say it once more.",
    ErrorCode.MIC_DENIED: "I need mic access to cook hands-free. Turn it on in your browser settings.",
    ErrorCode.LLM_TIMEOUT: "My brain's not responding right now. Give me a moment.",
    ErrorCode.LLM_RATE: "I'm getting too many requests. Give me a few seconds.",
    ErrorCode.LLM_BLOCKED: "I can't help with that one. Want to get back to the dish?",
    ErrorCode.LLM_CONFIG: "I can't reach my brain right now. Check the Gemini setup.",
    ErrorCode.TTS_FAILED: "",
    ErrorCode.RATE_LIMITED: "Give me a few seconds before the next one.",
    ErrorCode.ENGINE_LOADING: "One sec — I'm just waking up.",
    ErrorCode.WS_DROPPED: "I lost the connection. Reconnecting…",
}

#: Human-readable default message per code, used when none is supplied.
DEFAULT_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.OUT_OF_SCOPE: "Request is outside the cooking scope.",
    ErrorCode.RECIPE_INVALID: "Recipe could not be parsed or failed validation.",
    ErrorCode.AUDIO_TOO_LONG: "Utterance exceeded the maximum duration.",
    ErrorCode.NO_SPEECH: "No speech detected in the utterance.",
    ErrorCode.AUDIO_CORRUPT: "Malformed PCM audio frame.",
    ErrorCode.MIC_DENIED: "Microphone permission was lost.",
    ErrorCode.LLM_TIMEOUT: "Gemini did not respond in time.",
    ErrorCode.LLM_RATE: "Gemini rate limit or quota reached.",
    ErrorCode.LLM_BLOCKED: "Gemini blocked the response for safety reasons.",
    ErrorCode.LLM_CONFIG: "Gemini is misconfigured (missing/invalid key or unsupported model).",
    ErrorCode.TTS_FAILED: "edge-tts synthesis failed; continuing text-only.",
    ErrorCode.RATE_LIMITED: "Rate limit exceeded.",
    ErrorCode.ENGINE_LOADING: "Models are still loading.",
    ErrorCode.WS_DROPPED: "WebSocket connection dropped.",
}


class AppError(Exception):
    """A typed, transport-agnostic application error.

    Parameters
    ----------
    code:
        The taxonomy code from architecture section 11.
    message:
        Optional developer-facing message. Falls back to ``DEFAULT_MESSAGES``.
    recoverable:
        Whether the client should offer a retry. Defaults per ``DEFAULT_RECOVERABLE``.
    retry_after:
        Optional seconds hint for backoff (used by ``rate_limited`` / ``429``).
    detail:
        Optional structured context (never sent verbatim to the client).
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        *,
        recoverable: bool | None = None,
        retry_after: float | None = None,
        detail: Any = None,
    ) -> None:
        self.code = code
        self.message = message or DEFAULT_MESSAGES.get(code, code.value)
        self.recoverable = (
            DEFAULT_RECOVERABLE.get(code, True) if recoverable is None else recoverable
        )
        self.retry_after = retry_after
        self.detail = detail
        super().__init__(f"{code.value}: {self.message}")

    @property
    def status_code(self) -> int:
        """The REST status code derived from the taxonomy (architecture section 8)."""
        if self.code is ErrorCode.RATE_LIMITED:
            return 429
        return REST_STATUS.get(self.code, 500)

    @property
    def spoken_message(self) -> str:
        """A short spoken fallback suitable for TTS, or an empty string."""
        return SPOKEN_MESSAGES.get(self.code, "")

    def to_ws_payload(self) -> dict[str, Any]:
        """Serialize into the ``{type:"error", ...}`` WS event fields."""
        return {
            "type": "error",
            "code": self.code.value,
            "message": self.message,
            "recoverable": self.recoverable,
        }

    def to_rest_payload(self) -> dict[str, Any]:
        """Serialize into the uniform REST error body."""
        payload: dict[str, Any] = {
            "code": self.code.value,
            "message": self.message,
            "recoverable": self.recoverable,
        }
        if self.retry_after is not None:
            payload["retry_after"] = self.retry_after
        return payload


def status_for(code: ErrorCode) -> int:
    """Return the REST status code for a taxonomy code."""
    if code is ErrorCode.RATE_LIMITED:
        return 429
    return REST_STATUS.get(code, 500)


__all__ = [
    "AppError",
    "DEFAULT_MESSAGES",
    "DEFAULT_RECOVERABLE",
    "ErrorCode",
    "REST_STATUS",
    "SPOKEN_MESSAGES",
    "status_for",
]
