"""Pydantic v2 models for the GourMate contract.

These models reproduce architecture doc sections 6 (data schemas), 7 (WebSocket
protocol) and 8 (REST bodies) exactly. Do not rename fields or event types
without updating contracts/ws-events.json first.

Notes on resolved ambiguities are recorded in ``backend/README.md``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

# ---------------------------------------------------------------------------
# Section 6 - Data schemas
# ---------------------------------------------------------------------------

RecipeSource = Literal["generated", "user_text"]
VoiceState = Literal["idle", "listening", "submitting", "processing", "answering", "triage"]
SessionPhase = Literal["intake", "planning", "cooking", "done"]
TimerStatus = Literal["active", "paused", "done", "cancelled"]
ChatRole = Literal["user", "assistant", "tool"]
VadState = Literal["speech_start", "speech_end"]
ControlAction = Literal["mute", "unmute", "barge_in", "set_voice", "sleep", "wake"]


ActionName = Literal['start_cooking', 'approve_plan', 'cook_now', 'plan_together', 'discover', 'update_preferences', 'suggest_now', 'change_preferences', 'confirm', 'decline', 'finish', 'reset', 'skip_to_step', 'advance_step', 'repeat_step', 'go_to_step', 'select_dish', 'ask_help', 'parse_recipe']



class Substitution(BaseModel):
    """An advisory substitute for an ingredient (never mutates the recipe)."""

    substitute: str
    ratio: str | None = None
    note: str | None = None


class Ingredient(BaseModel):
    """A single recipe ingredient with optional structured quantity."""

    id: str
    name: str
    quantity: float | None = None
    unit: str | None = None
    display: str
    notes: str | None = None
    substitutions: list[Substitution] = Field(default_factory=list)


class Step(BaseModel):
    """One ordered instruction. ``index`` is 0-based and must be contiguous."""

    index: int
    instruction: str
    duration_seconds: float | None = None
    ingredient_refs: list[str] = Field(default_factory=list)
    tip: str | None = None


class Recipe(BaseModel):
    """The single source of truth mirrored from the client (architecture §1)."""

    id: str
    title: str
    servings: int | None = None
    prep_time_seconds: float | None = None
    cook_time_seconds: float | None = None
    total_time_seconds: float | None = None
    ingredients: list[Ingredient]
    steps: list[Step]
    source: RecipeSource
    created_at: str


class KitchenTimer(BaseModel):
    """Client-owned timer. The server is stateless for timers (architecture §5)."""

    id: str
    label: str
    duration_seconds: int
    started_at: int
    ends_at: int
    status: TimerStatus
    related_step_index: int | None = None


class ToolCall(BaseModel):
    """A tool invocation attached to a chat turn or emitted by the server."""

    call_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ChatTurn(BaseModel):
    """A single turn of the recent conversation window."""

    id: str
    role: ChatRole
    text: str
    tool_call: ToolCall | None = None
    ts: int


class SessionState(BaseModel):
    """Full client state, sent on connect/reconnect via the ``sync`` event."""

    session_id: str
    phase: SessionPhase
    recipe: Recipe | None = None
    current_step_index: int = 0
    timers: list[KitchenTimer] = Field(default_factory=list)
    # Additive (optional) extension so reconnect can restore the recent window;
    # architecture section 5 mirrors ChatTurn server-side but section 6 does not
    # list it on SessionState. See README "Resolved ambiguities".
    turns: list[ChatTurn] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Recipe draft models (Gemini structured output)
# ---------------------------------------------------------------------------


class IngredientDraft(BaseModel):
    """Model-authored ingredient. ``id`` is a temporary slug used by step refs."""

    id: str
    name: str
    quantity: float | None = None
    unit: str | None = None
    display: str
    notes: str | None = None


class StepDraft(BaseModel):
    """Model-authored step. ``ingredient_refs`` point at ``IngredientDraft.id``."""

    index: int
    instruction: str
    duration_seconds: float | None = None
    ingredient_refs: list[str] = Field(default_factory=list)
    tip: str | None = None


class RecipeDraft(BaseModel):
    """What Gemini returns before the service validates and normalizes it."""

    title: str
    servings: int | None = None
    prep_time_seconds: float | None = None
    cook_time_seconds: float | None = None
    total_time_seconds: float | None = None
    ingredients: list[IngredientDraft] = Field(default_factory=list)
    steps: list[StepDraft] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Section 7 - Client -> Server events
# ---------------------------------------------------------------------------


class _ClientEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartEvent(_ClientEvent):
    type: Literal["start"]


class SyncEvent(_ClientEvent):
    type: Literal["sync"]
    state: SessionState


class ControlEvent(_ClientEvent):
    type: Literal["control"]
    action: ControlAction
    # ``set_voice`` carries the session's edge-tts voice id (validated against
    # the backend allow-list); other actions leave it unset (architecture §7).
    voice: str | None = None
    wake_listening: bool | None = None
    enable_mic: bool | None = None
    pending_audio: Literal["submit", "discard"] | None = None
    utterance_id: str | None = Field(default=None, min_length=1, max_length=80)


class TextInputEvent(_ClientEvent):
    type: Literal["text_input"]
    text: str = Field(min_length=1)


class ActionInputEvent(_ClientEvent):
    type: Literal["action_input"]
    action: ConversationAction


class ToolResultEvent(_ClientEvent):
    type: Literal["tool_result"]
    call_id: str = Field(min_length=1)
    result: dict[str, Any] = Field(default_factory=dict)


class RecipeStateEvent(_ClientEvent):
    """State update after client-side navigation.

    Architecture section 7 specifies ``{type:"recipe_state", ...}`` without a
    concrete payload; the fields below mirror the mutable parts of SessionState.
    """

    type: Literal["recipe_state"]
    recipe: Recipe | None = None
    current_step_index: int | None = None
    phase: SessionPhase | None = None
    timers: list[KitchenTimer] | None = None


ClientEvent = Annotated[
    Union[
        StartEvent,
        SyncEvent,
        ControlEvent,
        TextInputEvent,
        ActionInputEvent,
        ToolResultEvent,
        RecipeStateEvent,
    ],
    Field(discriminator="type"),
]

CLIENT_EVENT_ADAPTER: TypeAdapter[ClientEvent] = TypeAdapter(ClientEvent)


def parse_client_event(payload: dict[str, Any]) -> ClientEvent:
    """Validate a decoded JSON object into a typed client event."""
    return CLIENT_EVENT_ADAPTER.validate_python(payload)


# ---------------------------------------------------------------------------
# Section 7 - Server -> Client events
# ---------------------------------------------------------------------------


class _ServerEvent(BaseModel):
    """Base class for server events; subclasses set a literal ``type``."""


class FoodImageRequest(BaseModel):
    dish: str = Field(min_length=1, max_length=120)


class FoodImageResponse(BaseModel):
    image_url: str | None = None
    image_credit: str | None = None
    image_source: str | None = None
    image_license: str | None = None


class FoodPreview(BaseModel):
    """Discovery information only; never recipe state (architecture §6–§7)."""

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=600)
    estimated_total_minutes: int | None = Field(ge=1, le=1440)
    popularity: str = Field(min_length=1, max_length=600)
    difficulty: Literal["Easy", "Moderate", "Advanced"]
    key_ingredients: list[str] = Field(min_length=1, max_length=12)
    fit: str = Field(min_length=1, max_length=600)
    image_url: str | None = None
    image_credit: str | None = None
    image_source: str | None = None
    image_license: str | None = None


class ConversationAction(BaseModel):
    """Validated conversational intent, executed by the server (§7, §9)."""
    model_config = ConfigDict(extra="forbid")
    name: ActionName
    value: str | None = Field(default=None, max_length=20000)
    step_index: int | None = Field(default=None, ge=0)
    servings: int | None = Field(default=None, ge=1, le=100)
    answers: dict[Literal["cravings", "dietary", "ingredients", "time"], Annotated[str, Field(min_length=1, max_length=1000)]] | None = None

    options: list[Annotated[str, Field(min_length=1, max_length=80)]] | None = Field(default=None, min_length=3, max_length=3)
    foods: list[FoodPreview] | None = Field(default=None, min_length=3, max_length=3)
    question: str | None = Field(default=None, max_length=240)


class ChoiceOption(BaseModel):
    """One tappable structured choice (architecture §7)."""

    id: str
    label: str
    submit_text: str | None = None
    food: FoodPreview | None = None
    action: ConversationAction | None = None


class ActivityEvent(_ServerEvent):
    type: Literal["activity"] = "activity"
    sleeping: bool
    wake_listening: bool
    muted: bool


class ReadyEvent(_ServerEvent):
    type: Literal["ready"] = "ready"
    session_id: str


class VadEvent(_ServerEvent):
    type: Literal["vad"] = "vad"
    state: VadState
    utterance_id: str | None = None


class TranscriptEvent(_ServerEvent):
    type: Literal["transcript"] = "transcript"
    text: str
    final: bool
    utterance_id: str | None = None


class ChoicesEvent(_ServerEvent):
    """Tappable multiple-choice options (architecture §7, ``offer_choices``).

    Interview answers, three dish previews, contextual actions and confirmations.
    A food choice opens a preview first; selection submits ``submit_text`` or
    ``label`` as the next utterance, or its typed action. Preview information is not Recipe state.
    """

    type: Literal["choices"] = "choices"
    options: list[ChoiceOption]

    turn_id: str | None = None

class AssistantTextEvent(_ServerEvent):
    type: Literal["assistant_text"] = "assistant_text"
    text: str

    turn_id: str | None = None

class AssistantAudioEvent(_ServerEvent):
    type: Literal["assistant_audio"] = "assistant_audio"
    seq: int
    mime: Literal["audio/mpeg"] = "audio/mpeg"
    data: str  # base64-encoded MP3

    turn_id: str | None = None

class ToolCallEvent(_ServerEvent):
    type: Literal["tool_call"] = "tool_call"
    call_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class StateEvent(_ServerEvent):
    type: Literal["state"] = "state"
    voice_state: VoiceState

    turn_id: str | None = None

class RecipeEvent(_ServerEvent):
    type: Literal["recipe"] = "recipe"
    recipe: Recipe


class PlanEvent(_ServerEvent):
    """Pre-cook planning result awaiting explicit confirmation (architecture §7)."""

    type: Literal["plan"] = "plan"
    recipe: Recipe


class DoneEvent(_ServerEvent):
    """Recipe complete - the final step was reached or passed (architecture §4 [14]).

    A terminal phase, not a ``current_step_index`` advance: the client shows the
    completion state, the avatar celebrates, and ``what's next`` offers a new
    dish (§9.1). Reset clears it.
    """

    type: Literal["done"] = "done"


class ResetEvent(_ServerEvent):
    """Session reset to intake - a planning cancel or a cooking discontinue.

    The client clears its recipe, step index and timers and returns to Intake;
    the recipe is retained in the local cookbook (architecture §7).
    """

    type: Literal["reset"] = "reset"


class ErrorEvent(_ServerEvent):
    type: Literal["error"] = "error"
    code: str
    message: str
    recoverable: bool


class RateLimitedEvent(_ServerEvent):
    type: Literal["rate_limited"] = "rate_limited"
    scope: str
    retry_after: float


class TurnEndEvent(_ServerEvent):
    type: Literal["turn_end"] = "turn_end"
    turn_id: str


ServerEvent = Union[
    ActivityEvent,
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


# ---------------------------------------------------------------------------
# Section 8 - REST request/response bodies
# ---------------------------------------------------------------------------


class GenerateRecipeRequest(BaseModel):
    """Body for ``POST /api/recipes/generate``."""

    model_config = ConfigDict(extra="forbid")

    dish: str = Field(min_length=1, max_length=300)
    servings: int | None = Field(default=None, ge=1, le=100)
    constraints: str | None = Field(default=None, max_length=1000)


class ParseRecipeRequest(BaseModel):
    """Body for ``POST /api/recipes/parse``."""

    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)


class TtsPreviewRequest(BaseModel):
    """Body for ``POST /api/tts/preview`` (architecture section 8)."""

    model_config = ConfigDict(extra="forbid")

    voice: str = Field(min_length=1, max_length=80)


class HealthResponse(BaseModel):
    """Body for ``GET /api/health`` (architecture section 8)."""

    status: str
    models_loaded: bool
    gemini_ok: bool


class ErrorResponse(BaseModel):
    """Uniform REST error body. Mirrors the WS ``error`` event fields."""

    code: str
    message: str
    recoverable: bool
    retry_after: float | None = None


__all__ = [
    "AssistantAudioEvent",
    "AssistantTextEvent",
    "ChatRole",
    "ChatTurn",
    "ChoiceOption",
    "ChoicesEvent",
    "ClientEvent",
    "ControlAction",
    "ControlEvent",
    "DoneEvent",
    "ErrorEvent",
    "ErrorResponse",
    "GenerateRecipeRequest",
    "HealthResponse",
    "Ingredient",
    "IngredientDraft",
    "KitchenTimer",
    "ParseRecipeRequest",
    "PlanEvent",
    "RateLimitedEvent",
    "Recipe",
    "RecipeDraft",
    "RecipeEvent",
    "RecipeSource",
    "RecipeStateEvent",
    "ReadyEvent",
    "ResetEvent",
    "SessionPhase",
    "SessionState",
    "StartEvent",
    "StateEvent",
    "Step",
    "StepDraft",
    "Substitution",
    "SyncEvent",
    "TextInputEvent",
    "TimerStatus",
    "ToolCall",
    "TtsPreviewRequest",
    "ToolCallEvent",
    "ToolResultEvent",
    "TranscriptEvent",
    "TurnEndEvent",
    "VadEvent",
    "VadState",
    "VoiceState",
    "parse_client_event",
]
