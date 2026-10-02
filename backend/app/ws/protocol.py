"""Serialization helpers for every server -> client event (architecture section 7).

All events are JSON text frames. ``assistant_audio`` carries base64 MP3. These
helpers are the only place that constructs outbound event payloads, which keeps
the wire contract centralized.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from pydantic import BaseModel

from ..errors import AppError, ErrorCode
from ..schemas import (
    ActivityEvent,
    AssistantAudioEvent,
    AssistantTextEvent,
    ChoiceOption,
    ChoicesEvent,
    DoneEvent,
    ErrorEvent,
    PlanEvent,
    RateLimitedEvent,
    Recipe,
    RecipeEvent,
    ReadyEvent,
    ResetEvent,
    StateEvent,
    ToolCallEvent,
    TranscriptEvent,
    TurnEndEvent,
    VadEvent,
    VoiceState,
)


def _dump(event: BaseModel) -> str:
    payload = event.model_dump(mode="json", exclude_none=False)
    for key in ("turn_id", "utterance_id"):
        if payload.get(key) is None:
            payload.pop(key, None)
    return json.dumps(payload)


def activity(sleeping: bool, wake_listening: bool, muted: bool) -> str:
    return _dump(ActivityEvent(sleeping=sleeping, wake_listening=wake_listening, muted=muted))


def ready(session_id: str) -> str:
    """``{type:"ready", session_id}`` - session established."""
    return _dump(ReadyEvent(session_id=session_id))


def vad(state: str, utterance_id: str | None = None) -> str:
    """``{type:"vad", state}`` - speech_start / speech_end."""
    return _dump(VadEvent(state=state, utterance_id=utterance_id))  # type: ignore[arg-type]


def transcript(text: str, final: bool, utterance_id: str | None = None) -> str:
    """``{type:"transcript", text, final}`` - partial/final user speech."""
    return _dump(TranscriptEvent(text=text, final=final, utterance_id=utterance_id))


def choices(options: list["ChoiceOption | dict[str, Any]"]) -> str:
    """``{type:"choices", options:[{id,label}]}`` - tappable options.

    Accepts already-built :class:`~app.schemas.ChoiceOption` objects or plain
    ``{"id": ..., "label": ...}`` dicts; Pydantic coerces the latter.
    """
    # Omit optional preview fields for backwards-compatible plain choices (§7).
    event = ChoicesEvent(options=options)
    payload = event.model_dump(exclude_none=True)
    for option, serialized in zip(event.options, payload["options"]):
        if option.food is not None:
            serialized["food"]["estimated_total_minutes"] = option.food.estimated_total_minutes
    return json.dumps(payload)


def assistant_text(text: str) -> str:
    """``{type:"assistant_text", text}`` - assistant captions."""
    return _dump(AssistantTextEvent(text=text))


def assistant_audio(seq: int, data: bytes, mime: str = "audio/mpeg") -> str:
    """``{type:"assistant_audio", seq, mime, data}`` - base64 MP3 chunk."""
    encoded = base64.b64encode(data).decode("ascii")
    return _dump(AssistantAudioEvent(seq=seq, mime=mime, data=encoded))  # type: ignore[arg-type]


def tool_call(call_id: str, name: str, arguments: dict[str, Any]) -> str:
    """``{type:"tool_call", call_id, name, arguments}`` - client must execute."""
    return _dump(ToolCallEvent(call_id=call_id, name=name, arguments=arguments))


def state(voice_state: VoiceState) -> str:
    """``{type:"state", voice_state}`` - avatar state."""
    return _dump(StateEvent(voice_state=voice_state))


def recipe(recipe: Recipe) -> str:
    """``{type:"recipe", recipe}`` - intake result; also flips the client into cooking."""
    return _dump(RecipeEvent(recipe=recipe))


def plan(recipe: Recipe) -> str:
    """``{type:"plan", recipe}`` - planning result awaiting confirmation."""
    return _dump(PlanEvent(recipe=recipe))


def reset() -> str:
    """``{type:"reset"}`` - reset the session to intake (cancel/discontinue)."""
    return _dump(ResetEvent())


def done() -> str:
    """``{type:"done"}`` - the recipe is complete (final step reached/passed)."""
    return _dump(DoneEvent())


def error(code: ErrorCode | str, message: str, recoverable: bool) -> str:
    """``{type:"error", code, message, recoverable}`` - typed error."""
    code_value = code.value if isinstance(code, ErrorCode) else code
    return _dump(ErrorEvent(code=code_value, message=message, recoverable=recoverable))


def error_from_exception(exc: AppError) -> str:
    """Serialize an :class:`AppError` into the ``error`` event."""
    return _dump(ErrorEvent(code=exc.code.value, message=exc.message, recoverable=exc.recoverable))


def rate_limited(scope: str, retry_after: float) -> str:
    """``{type:"rate_limited", scope, retry_after}`` - limit hit."""
    return _dump(RateLimitedEvent(scope=scope, retry_after=retry_after))


def turn_end(turn_id: str) -> str:
    """``{type:"turn_end", turn_id}`` - turn complete."""
    return _dump(TurnEndEvent(turn_id=turn_id))


__all__ = [
    "assistant_audio",
    "assistant_text",
    "choices",
    "done",
    "error",
    "error_from_exception",
    "plan",
    "rate_limited",
    "ready",
    "recipe",
    "reset",
    "state",
    "tool_call",
    "transcript",
    "turn_end",
    "vad",
]
