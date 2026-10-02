"""Tool registry, argument validation and deterministic navigation.

Two responsibilities:

* Validate Gemini ``functionCall`` arguments against the tool schema before they
  are forwarded to the client (architecture section 9.3, step 2).
* Format deterministic navigation from Recipe. The legacy text resolver remains
  for compatibility; conversational ingress uses Gemini and validated actions.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..errors import AppError, ErrorCode
from ..schemas import ConversationAction, FoodPreview, Recipe
from .prompts import NAVIGATION_TOOLS

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool argument models
# ---------------------------------------------------------------------------


class _StrictToolArgs(BaseModel):
    """Base for tool argument models.

    ``extra="forbid"`` makes server-side validation reject unexpected arguments
    supplied by the model (architecture section 9.3).
    """

    model_config = ConfigDict(extra="forbid")


class AdvanceStepArgs(_StrictToolArgs):
    from_step_index: int = Field(ge=0)


class RepeatStepArgs(_StrictToolArgs):
    step_index: int = Field(ge=0)


class GoToStepArgs(_StrictToolArgs):
    step_index: int = Field(ge=0)


class CreateKitchenTimerArgs(_StrictToolArgs):
    label: str = Field(min_length=1, max_length=80)
    duration_seconds: int = Field(gt=0, le=86_400)
    related_step_index: int | None = Field(default=None, ge=0)


class CancelTimerArgs(_StrictToolArgs):
    label: str = Field(min_length=1, max_length=80)


class SubstituteIngredientArgs(_StrictToolArgs):
    ingredient: str = Field(min_length=1, max_length=120)
    reason: str | None = Field(default=None, max_length=200)


class CreatePlanArgs(_StrictToolArgs):
    """Server-executed pre-cook planning request (architecture section 9.2)."""

    servings: int | None = Field(default=None, ge=1, le=100)
    constraints: str | None = Field(default=None, max_length=1000)


class BeginDishArgs(_StrictToolArgs):
    """Server-executed dish-name intake (architecture section 9.2).

    The model calls this only when the user clearly names a dish; the server
    records it and asks the cook-now vs plan-it question. The 120-char cap keeps
    a pasted recipe from being mistaken for a dish name.
    """

    dish: str = Field(min_length=1, max_length=120)


#: One option label for ``offer_choices``: non-empty and at most 80 chars.
ChoiceLabel = Annotated[str, Field(min_length=1, max_length=80)]


class OfferChoicesArgs(_StrictToolArgs):
    """Server-executed structured-choice request (architecture section 9.2).

    The model offers contextual answers/actions or three dishes with previews;
    the server emits ``choices`` and speaks a short follow-up question.
    """

    answers: dict[Literal["cravings", "dietary", "ingredients", "time"], Annotated[str, Field(min_length=1, max_length=1000)]] | None = None
    servings: int | None = Field(default=None, ge=1, le=100)

    options: list[ChoiceLabel] = Field(min_length=2, max_length=8)
    foods: list[FoodPreview] = Field(default_factory=list, max_length=3)
    question: str | None = Field(default=None, min_length=1, max_length=500)
    actions: list[ConversationAction | None] = Field(default_factory=list, max_length=8)


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """A registered tool: schema, executor and description."""

    name: str
    model: type[BaseModel]
    executed_by: str


TOOL_REGISTRY: dict[str, ToolSpec] = {
    "conversation_action": ToolSpec("conversation_action", ConversationAction, "server"),
    "advance_step": ToolSpec("advance_step", AdvanceStepArgs, "client"),
    "repeat_step": ToolSpec("repeat_step", RepeatStepArgs, "client"),
    "go_to_step": ToolSpec("go_to_step", GoToStepArgs, "client"),
    "create_kitchen_timer": ToolSpec("create_kitchen_timer", CreateKitchenTimerArgs, "client"),
    "cancel_timer": ToolSpec("cancel_timer", CancelTimerArgs, "client"),
    "substitute_ingredient": ToolSpec("substitute_ingredient", SubstituteIngredientArgs, "client"),
    "begin_dish": ToolSpec("begin_dish", BeginDishArgs, "server"),
    "create_plan": ToolSpec("create_plan", CreatePlanArgs, "server"),
    "offer_choices": ToolSpec("offer_choices", OfferChoicesArgs, "server"),
}

#: Tools executed deterministically by the server; they never become a client
#: ``tool_call`` event and end the turn once handled (architecture section 9.2).
SERVER_TOOLS = frozenset({"begin_dish", "create_plan", "offer_choices", "conversation_action"})


def new_call_id() -> str:
    """Generate a unique tool call id shared with the client."""
    return f"call_{uuid.uuid4().hex}"


def validate_tool_call(name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
    """Validate and normalize Gemini tool arguments.

    Raises ``recipe_invalid`` when the call is unknown or arguments are malformed
    (architecture section 11 has no dedicated tool code; the "unparseable model
    output" input category is the closest fit - see README).
    """
    spec = TOOL_REGISTRY.get(name)
    if spec is None:
        raise AppError(
            ErrorCode.RECIPE_INVALID,
            f"Unknown tool '{name}'.",
            detail={"tool": name},
        )
    try:
        validated = spec.model.model_validate(arguments or {})
    except ValidationError as exc:
        raise AppError(
            ErrorCode.RECIPE_INVALID,
            f"Malformed arguments for tool '{name}'.",
            detail=exc.errors(),
        ) from exc
    result = validated.model_dump(exclude_none=True, exclude_unset=True)
    if isinstance(validated, OfferChoicesArgs) and validated.foods:
        result["foods"] = [food.model_dump() for food in validated.foods]
    return result


def is_navigation_tool(name: str) -> bool:
    """Whether a tool is a client-executed navigation readout."""
    return name in NAVIGATION_TOOLS


def is_server_tool(name: str) -> bool:
    """Whether a tool is executed by the server (never emitted as ``tool_call``)."""
    return name in SERVER_TOOLS


# ---------------------------------------------------------------------------
# Deterministic navigation
# ---------------------------------------------------------------------------


class NavigationKind(str, Enum):
    NEXT = "next"
    BACK = "back"
    REPEAT = "repeat"
    GO_TO = "go_to"
    DONE = "done"


@dataclass(slots=True)
class NavigationResult:
    """A fully resolved navigation intent with spoken text and tool call."""

    kind: NavigationKind
    new_step_index: int
    spoken_text: str
    tool_name: str
    tool_arguments: dict[str, Any]


_NEXT_RE = re.compile(
    r"\b(what'?s\s+next|what\s+is\s+next|next\s+step|go\s+next|move\s+on|go\s+on|continue|carry\s+on|skip\s+(?:(?:this|the|current)\s+)?step)\b",
    re.IGNORECASE,
)
_REPEAT_RE = re.compile(
    r"\b(repeat(?:\s+that)?|say\s+(?:that|it)\s+again|what\s+was\s+that|come\s+again|read\s+that\s+again)\b",
    re.IGNORECASE,
)
_BACK_RE = re.compile(
    r"\b(go\s+back(?:\s+one)?|back\s+up|previous(?:\s+step)?|last\s+step)\b",
    re.IGNORECASE,
)
_GO_TO_RE = re.compile(r"\bstep\s+(\d+)\b", re.IGNORECASE)
_GO_TO_VERB_RE = re.compile(r"\b(go\s+to|jump\s+to|skip\s+to)\s+step\s+(\d+)\b", re.IGNORECASE)


def _duration_minutes(seconds: float | None) -> int | None:
    """Round a duration to whole minutes (minimum 1) for spoken readouts.

    Returns ``None`` when the value is absent so callers can omit the estimate
    cleanly rather than inventing one (Value-Source Audit, architecture §6).
    """
    if seconds is None:
        return None
    return max(1, int(round(seconds / 60.0)))


def _format_step(recipe: Recipe, index: int) -> str:
    """Build the deterministic spoken readout for a step.

    Carries the step's ETA (``Step.duration_seconds``) when present so both the
    navigation shortcut and the cooking readouts state it (architecture §4 [12]).
    """
    total = len(recipe.steps)
    step = recipe.steps[index]
    parts = [f"Step {index + 1} of {total}.", step.instruction.strip()]
    minutes = _duration_minutes(step.duration_seconds)
    if minutes is not None:
        unit = "minute" if minutes == 1 else "minutes"
        parts.append(f"About {minutes} {unit}.")
    if step.tip:
        parts.append(f"Tip: {step.tip.strip()}")
    return " ".join(part for part in parts if part)


def resolve_navigation(
    text: str,
    recipe: Recipe | None,
    current_step_index: int,
    *,
    max_chars: int = 80,
) -> NavigationResult | None:
    """Resolve a pure navigation utterance without calling Gemini.

    Returns ``None`` when the utterance is not clearly navigation, in which case
    the caller falls back to the conversational LLM path. Only short utterances
    are considered to avoid false positives in freeform conversation.
    """
    if recipe is None or not recipe.steps:
        return None

    stripped = text.strip()
    if not stripped or len(stripped) > max_chars:
        return None

    total = len(recipe.steps)
    current = min(max(current_step_index, 0), total - 1)

    # Explicit "go to step N" wins over the generic back/next patterns.
    go_to_match = _GO_TO_VERB_RE.search(stripped)
    if go_to_match is None:
        go_to_match = _GO_TO_RE.search(stripped)
    if go_to_match is not None:
        groups = go_to_match.groups()
        raw = groups[-1]
        try:
            requested = int(raw)
        except (TypeError, ValueError):
            requested = -1
        target = requested - 1
        if target < 0 or target >= total:
            return NavigationResult(
                kind=NavigationKind.GO_TO,
                new_step_index=current,
                spoken_text=f"This recipe has {total} steps.",
                tool_name="go_to_step",
                tool_arguments={"step_index": current},
            )
        return NavigationResult(
            kind=NavigationKind.GO_TO,
            new_step_index=target,
            spoken_text=_format_step(recipe, target),
            tool_name="go_to_step",
            tool_arguments={"step_index": target},
        )

    if _NEXT_RE.search(stripped):
        if current >= total - 1:
            # On (or past) the final step there is nothing to advance to: signal
            # completion so the caller can finish the recipe and congratulate
            # instead of replaying the last step (architecture §4 [14]).
            return NavigationResult(
                kind=NavigationKind.DONE,
                new_step_index=current,
                spoken_text="",
                tool_name="",
                tool_arguments={},
            )
        target = current + 1
        return NavigationResult(
            kind=NavigationKind.NEXT,
            new_step_index=target,
            spoken_text=_format_step(recipe, target),
            tool_name="advance_step",
            tool_arguments={"from_step_index": current},
        )

    if _BACK_RE.search(stripped):
        target = max(current - 1, 0)
        prefix = "You're at the first step. " if current <= 0 else ""
        return NavigationResult(
            kind=NavigationKind.BACK,
            new_step_index=target,
            spoken_text=prefix + _format_step(recipe, target),
            tool_name="go_to_step",
            tool_arguments={"step_index": target},
        )

    if _REPEAT_RE.search(stripped):
        return NavigationResult(
            kind=NavigationKind.REPEAT,
            new_step_index=current,
            spoken_text=_format_step(recipe, current),
            tool_name="repeat_step",
            tool_arguments={"step_index": current},
        )

    return None


__all__ = [
    "AdvanceStepArgs",
    "BeginDishArgs",
    "CancelTimerArgs",
    "CreateKitchenTimerArgs",
    "CreatePlanArgs",
    "GoToStepArgs",
    "NavigationKind",
    "NavigationResult",
    "OfferChoicesArgs",
    "RepeatStepArgs",
    "SERVER_TOOLS",
    "SubstituteIngredientArgs",
    "TOOL_REGISTRY",
    "ToolSpec",
    "is_navigation_tool",
    "is_server_tool",
    "new_call_id",
    "resolve_navigation",
    "validate_tool_call",
]
