"""WebSocket wire-protocol contract (architecture §7) against the golden manifest.

Each outbound serializer must produce exactly the event ``type`` and field names
listed in architecture §7. The event/tool/error name sets are asserted against
``contracts/ws-events.json`` so backend drift fails CI.
"""

from __future__ import annotations

import base64
import json
import typing

import pytest

from app.errors import ErrorCode
from app.llm.tools import TOOL_REGISTRY
from app.schemas import (
    AssistantAudioEvent,
    AssistantTextEvent,
    ChoiceOption,
    ChoicesEvent,
    ControlAction,
    ControlEvent,
    DoneEvent,
    ErrorEvent,
    PlanEvent,
    RateLimitedEvent,
    RecipeEvent,
    RecipeStateEvent,
    ReadyEvent,
    ResetEvent,
    StartEvent,
    StateEvent,
    SyncEvent,
    TextInputEvent,
    ToolCallEvent,
    ToolResultEvent,
    TranscriptEvent,
    TurnEndEvent,
    VadEvent,
    ServerEvent,
)
from app.ws import protocol

SERVER_EVENT_CLASSES = [
    ReadyEvent,
    VadEvent,
    TranscriptEvent,
    ChoicesEvent,
    AssistantTextEvent,
    AssistantAudioEvent,
    ToolCallEvent,
    StateEvent,
    RecipeEvent,
    PlanEvent,
    DoneEvent,
    ResetEvent,
    ErrorEvent,
    RateLimitedEvent,
    TurnEndEvent,
]

CLIENT_EVENT_CLASSES = [
    StartEvent,
    SyncEvent,
    ControlEvent,
    TextInputEvent,
    ToolResultEvent,
    RecipeStateEvent,
]


def _payload(raw: str) -> dict:
    return json.loads(raw)


def _event_type(cls) -> str:
    """Read the ``type`` discriminator literal from a Pydantic event model.

    Server models give ``type`` a default; client models mark it required. Both
    expose the literal through the field annotation, so read it from there.
    """
    annotation = cls.model_fields["type"].annotation
    args = typing.get_args(annotation)
    assert args, f"{cls.__name__}.type is not a Literal"
    return args[0]


# ---------------------------------------------------------------------------
# Golden manifest assertions
# ---------------------------------------------------------------------------


def test_server_event_type_strings_match_golden(contract):
    actual = {_event_type(cls) for cls in SERVER_EVENT_CLASSES}
    assert actual == set(contract["server_to_client"])


def test_server_union_matches_exported_classes():
    assert set(typing.get_args(ServerEvent)) == set(SERVER_EVENT_CLASSES)


def test_client_event_type_strings_match_golden(contract):
    actual = {_event_type(cls) for cls in CLIENT_EVENT_CLASSES}
    assert actual == set(contract["client_to_server"])


def test_tool_names_match_golden(contract):
    assert set(TOOL_REGISTRY) == set(contract["tool_names"])


def test_choices_event_options_shape():
    """``choices`` carries ``{id,label}`` option objects (architecture §7)."""
    data = _payload(
        protocol.choices(
            [
                ChoiceOption(id="adobo", label="Chicken Adobo"),
                {"id": "sinigang", "label": "Sinigang"},
            ]
        )
    )
    assert data["type"] == "choices"
    assert data["options"] == [
        {"id": "adobo", "label": "Chicken Adobo"},
        {"id": "sinigang", "label": "Sinigang"},
    ]


def test_error_codes_match_golden(contract):
    assert {code.value for code in ErrorCode} == set(contract["error_codes"])


def test_control_actions_match_golden(contract):
    assert set(typing.get_args(ControlAction)) == set(contract["control_actions"])


# ---------------------------------------------------------------------------
# Exact serialized field names per §7
# ---------------------------------------------------------------------------


def _expected_field_cases(recipe):
    return [
        (protocol.ready("session-1"), "ready", {"type", "session_id"}),
        (protocol.vad("speech_start"), "vad", {"type", "state"}),
        (protocol.transcript("hello", True), "transcript", {"type", "text", "final"}),
        (
            protocol.choices([{"id": "a", "label": "Adobo"}]),
            "choices",
            {"type", "options"},
        ),
        (protocol.assistant_text("hi there"), "assistant_text", {"type", "text"}),
        (protocol.assistant_audio(0, b"\x01\x02\x03"), "assistant_audio", {"type", "seq", "mime", "data"}),
        (
            protocol.tool_call("call_1", "advance_step", {"from_step_index": 0}),
            "tool_call",
            {"type", "call_id", "name", "arguments"},
        ),
        (protocol.state("answering"), "state", {"type", "voice_state"}),
        (protocol.recipe(recipe), "recipe", {"type", "recipe"}),
        (protocol.reset(), "reset", {"type"}),
        (protocol.plan(recipe), "plan", {"type", "recipe"}),
        (protocol.done(), "done", {"type"}),
        (
            protocol.error(ErrorCode.RECIPE_INVALID, "bad", True),
            "error",
            {"type", "code", "message", "recoverable"},
        ),
        (protocol.rate_limited("session_turn", 1.5), "rate_limited", {"type", "scope", "retry_after"}),
        (protocol.turn_end("turn-1"), "turn_end", {"type", "turn_id"}),
    ]


def test_every_serializer_matches_section_7_field_names(recipe):
    for raw, event_type, expected_fields in _expected_field_cases(recipe):
        data = _payload(raw)
        assert data["type"] == event_type
        assert set(data.keys()) == expected_fields, (event_type, data)


def test_every_serialized_type_is_in_golden(contract, recipe):
    for raw, event_type, _fields in _expected_field_cases(recipe):
        assert event_type in contract["server_to_client"]


def test_done_event_and_phase_are_in_golden(contract):
    # ``done`` is a payload-free server event and a terminal session phase.
    assert _payload(protocol.done()) == {"type": "done"}
    assert "done" in contract["server_to_client"]
    assert "done" in contract["session_phases"]


def test_vad_states_match_golden(contract):
    for state in contract["vad_states"]:
        assert _payload(protocol.vad(state))["state"] == state


def test_assistant_audio_is_base64_mpeg():
    raw = protocol.assistant_audio(7, b"abc")
    data = _payload(raw)
    assert data["seq"] == 7
    assert data["mime"] == "audio/mpeg"
    assert base64.b64decode(data["data"]) == b"abc"


def test_error_from_exception_matches_error_event():
    from app.errors import AppError

    exc = AppError(ErrorCode.AUDIO_TOO_LONG, "too long", recoverable=True)
    data = _payload(protocol.error_from_exception(exc))
    assert data == {
        "type": "error",
        "code": "audio_too_long",
        "message": "too long",
        "recoverable": True,
    }


# ---------------------------------------------------------------------------
# Client event parsing round-trips
# ---------------------------------------------------------------------------


def test_parse_each_client_event_round_trips(recipe):
    from app.schemas import parse_client_event

    payloads = [
        {"type": "start"},
        {
            "type": "sync",
            "state": {
                "session_id": "s1",
                "phase": "cooking",
                "recipe": recipe.model_dump(),
                "current_step_index": 1,
                "timers": [],
            },
        },
        {"type": "control", "action": "mute"},
        {"type": "control", "action": "set_voice", "voice": "en-US-GuyNeural"},
        {"type": "text_input", "text": "hello"},
        {"type": "tool_result", "call_id": "c1", "result": {"ok": True}},
        {"type": "recipe_state", "current_step_index": 2},
    ]
    for payload in payloads:
        event = parse_client_event(payload)
        assert event.type == payload["type"]


def test_control_event_voice_is_optional():
    from app.schemas import parse_client_event

    with_voice = parse_client_event(
        {"type": "control", "action": "set_voice", "voice": "en-GB-RyanNeural"}
    )
    assert with_voice.voice == "en-GB-RyanNeural"
    bare = parse_client_event({"type": "control", "action": "mute"})
    assert bare.voice is None


def test_parse_client_event_rejects_unknown_type():
    from pydantic import ValidationError

    from app.schemas import parse_client_event

    with pytest.raises(ValidationError):
        parse_client_event({"type": "not_a_real_event"})


def test_parse_client_event_rejects_extra_fields():
    from pydantic import ValidationError

    from app.schemas import parse_client_event

    with pytest.raises(ValidationError):
        parse_client_event({"type": "start", "extra": True})
