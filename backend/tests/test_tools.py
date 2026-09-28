"""Tool registry + deterministic navigation contract (architecture §4, §9.2, §9.3).

Two guarantees are proven here:

1. The registry exposes exactly the tools in §9.2 and rejects unknown or
   malformed calls with ``recipe_invalid``.
2. Pure navigation intents are answered deterministically from the ``Recipe``
   and never touch Gemini.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.llm.tools import (
    SERVER_TOOLS,
    TOOL_REGISTRY,
    NavigationKind,
    is_navigation_tool,
    is_server_tool,
    resolve_navigation,
    validate_tool_call,
)
from app.pipeline import Readiness, VoicePipeline
from tests.factories import make_ingredient, make_recipe, make_step

EXPECTED_TOOLS = {
    "advance_step",
    "repeat_step",
    "go_to_step",
    "create_kitchen_timer",
    "cancel_timer",
    "substitute_ingredient",
    "begin_dish",
    "create_plan",
    "offer_choices",
}

EXPECTED_SERVER_TOOLS = {"begin_dish", "create_plan", "offer_choices"}


# ---------------------------------------------------------------------------
# Registry completeness
# ---------------------------------------------------------------------------


def test_registry_exposes_exactly_the_section_9_2_tools():
    assert set(TOOL_REGISTRY) == EXPECTED_TOOLS


def test_client_tools_are_client_executed_and_server_tools_are_server():
    client_tools = {
        name for name, spec in TOOL_REGISTRY.items() if spec.executed_by == "client"
    }
    server_tools = {
        name for name, spec in TOOL_REGISTRY.items() if spec.executed_by == "server"
    }
    assert client_tools == EXPECTED_TOOLS - EXPECTED_SERVER_TOOLS
    assert server_tools == EXPECTED_SERVER_TOOLS
    assert SERVER_TOOLS == frozenset(EXPECTED_SERVER_TOOLS)


def test_is_server_tool_classification():
    assert is_server_tool("begin_dish") is True
    assert is_server_tool("create_plan") is True
    assert is_server_tool("offer_choices") is True
    assert is_server_tool("advance_step") is False
    assert is_server_tool("substitute_ingredient") is False


def test_navigation_tool_classification():
    assert is_navigation_tool("advance_step") is True
    assert is_navigation_tool("repeat_step") is True
    assert is_navigation_tool("go_to_step") is True
    assert is_navigation_tool("create_kitchen_timer") is False
    assert is_navigation_tool("cancel_timer") is False
    assert is_navigation_tool("substitute_ingredient") is False


# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------


def test_validate_valid_calls_normalizes_arguments():
    assert validate_tool_call("advance_step", {"from_step_index": 2}) == {"from_step_index": 2}
    assert validate_tool_call("repeat_step", {"step_index": 0}) == {"step_index": 0}
    assert validate_tool_call("go_to_step", {"step_index": 3}) == {"step_index": 3}
    assert validate_tool_call(
        "create_kitchen_timer", {"label": "pasta", "duration_seconds": 480}
    ) == {"label": "pasta", "duration_seconds": 480}
    assert validate_tool_call(
        "create_kitchen_timer",
        {"label": "pasta", "duration_seconds": 480, "related_step_index": 1},
    ) == {"label": "pasta", "duration_seconds": 480, "related_step_index": 1}
    assert validate_tool_call("cancel_timer", {"label": "pasta"}) == {"label": "pasta"}
    assert validate_tool_call("substitute_ingredient", {"ingredient": "cream"}) == {
        "ingredient": "cream"
    }
    # create_plan has two optional args; omit-null normalization applies.
    assert validate_tool_call("create_plan", {}) == {}
    assert validate_tool_call("create_plan", {"servings": 4}) == {"servings": 4}
    assert validate_tool_call(
        "create_plan", {"servings": 4, "constraints": "no dairy"}
    ) == {"servings": 4, "constraints": "no dairy"}
    # offer_choices carries 2..8 short option labels.
    assert validate_tool_call("offer_choices", {"options": ["Adobo", "Sinigang"]}) == {
        "options": ["Adobo", "Sinigang"]
    }
    # begin_dish carries the clearly named dish (1..120 chars).
    assert validate_tool_call("begin_dish", {"dish": "chicken adobo"}) == {
        "dish": "chicken adobo"
    }


@pytest.mark.parametrize(
    "args",
    [
        {},  # missing dish
        {"dish": ""},  # empty
        {"dish": "x" * 121},  # over the 120-char cap
        {"dish": 42},  # wrong type
        {"dish": "adobo", "extra": True},  # unexpected key
    ],
)
def test_begin_dish_malformed_arguments_rejected(args):
    with pytest.raises(AppError) as exc:
        validate_tool_call("begin_dish", args)
    assert exc.value.code is ErrorCode.RECIPE_INVALID


@pytest.mark.parametrize(
    "args",
    [
        {"options": ["only one"]},  # below the minimum of 2
        {"options": ["a", "b", "c", "d", "e", "f", "g", "h", "i"]},  # above the max of 8
        {"options": ["ok", "x" * 81]},  # an option label is too long
        {"options": ["ok", ""]},  # an option label is empty
        {"options": "Adobo, Sinigang"},  # wrong type
        {"options": ["a", "b"], "extra": True},  # unexpected key
    ],
)
def test_offer_choices_malformed_arguments_rejected(args):
    with pytest.raises(AppError) as exc:
        validate_tool_call("offer_choices", args)
    assert exc.value.code is ErrorCode.RECIPE_INVALID


@pytest.mark.parametrize(
    "args",
    [
        {"servings": 0},  # below the minimum
        {"servings": 101},  # above the maximum
        {"servings": "four"},  # wrong type
        {"constraints": "x" * 1001},  # too long
        {"extra": True},  # unexpected key
    ],
)
def test_create_plan_malformed_arguments_rejected(args):
    with pytest.raises(AppError) as exc:
        validate_tool_call("create_plan", args)
    assert exc.value.code is ErrorCode.RECIPE_INVALID


def test_unknown_tool_rejected():
    with pytest.raises(AppError) as exc:
        validate_tool_call("delete_recipe", {})
    assert exc.value.code is ErrorCode.RECIPE_INVALID
    assert "Unknown tool" in exc.value.message


@pytest.mark.parametrize(
    "name, args",
    [
        ("advance_step", {}),  # missing required
        ("advance_step", {"from_step_index": -1}),  # negative index
        ("repeat_step", {"step_index": "one"}),  # wrong type
        ("go_to_step", None),  # no arguments at all
        ("create_kitchen_timer", {"label": "pasta"}),  # missing duration
        ("create_kitchen_timer", {"label": "", "duration_seconds": 10}),  # empty label
        ("create_kitchen_timer", {"label": "pasta", "duration_seconds": 0}),  # non-positive
        ("cancel_timer", {"label": "pasta", "extra": True}),  # unexpected key
        ("substitute_ingredient", {}),  # missing ingredient
    ],
)
def test_malformed_arguments_rejected_where_schema_requires(name, args):
    # Tool-argument models use ``extra="forbid"`` (architecture §9.3), so both
    # malformed values and unexpected keys are rejected with ``recipe_invalid``.
    with pytest.raises(AppError) as exc:
        validate_tool_call(name, args)
    assert exc.value.code is ErrorCode.RECIPE_INVALID
    assert "Malformed arguments" in exc.value.message


# ---------------------------------------------------------------------------
# Deterministic navigation (no Gemini)
# ---------------------------------------------------------------------------


@pytest.fixture
def nav_recipe():
    return make_recipe(
        ingredients=[make_ingredient("ing_1"), make_ingredient("ing_2", name="Vinegar")],
        steps=[
            make_step(0, instruction="Marinate the chicken.", refs=("ing_1",), duration=600),
            make_step(1, instruction="Simmer for twenty minutes.", refs=("ing_1", "ing_2"), duration=1200),
            make_step(2, instruction="Serve with rice.", refs=(), duration=None),
        ],
    )


def test_resolve_navigation_next(nav_recipe):
    result = resolve_navigation("what's next", nav_recipe, 0)
    assert result is not None
    assert result.kind is NavigationKind.NEXT
    assert result.new_step_index == 1
    assert result.tool_name == "advance_step"
    assert result.tool_arguments == {"from_step_index": 0}
    assert "Simmer for twenty minutes." in result.spoken_text
    assert "Step 2 of 3" in result.spoken_text


def test_resolve_navigation_repeat_does_not_advance(nav_recipe):
    result = resolve_navigation("repeat", nav_recipe, 1)
    assert result is not None
    assert result.kind is NavigationKind.REPEAT
    assert result.new_step_index == 1
    assert result.tool_name == "repeat_step"
    assert result.tool_arguments == {"step_index": 1}


def test_resolve_navigation_back_clamps_at_first(nav_recipe):
    result = resolve_navigation("go back", nav_recipe, 0)
    assert result is not None
    assert result.kind is NavigationKind.BACK
    assert result.new_step_index == 0
    assert result.tool_name == "go_to_step"
    assert result.tool_arguments == {"step_index": 0}
    assert result.spoken_text.startswith("You're at the first step.")


def test_resolve_navigation_next_at_last_returns_done(nav_recipe):
    """Asking for "next" on the final step signals completion, not a replay.

    The index is left on the last step, no tool is forwarded to the client, and
    the spoken text is empty so the pipeline can speak its own congratulation
    (architecture §4 [14]).
    """
    result = resolve_navigation("continue", nav_recipe, 2)
    assert result is not None
    assert result.kind is NavigationKind.DONE
    assert result.new_step_index == 2
    assert result.tool_name == ""
    assert result.tool_arguments == {}
    assert result.spoken_text == ""


def test_resolve_navigation_go_to_step(nav_recipe):
    result = resolve_navigation("go to step 3", nav_recipe, 0)
    assert result is not None
    assert result.kind is NavigationKind.GO_TO
    assert result.new_step_index == 2
    assert result.tool_arguments == {"step_index": 2}


def test_resolve_navigation_go_to_out_of_range_is_safe(nav_recipe):
    result = resolve_navigation("go to step 99", nav_recipe, 1)
    assert result is not None
    assert result.new_step_index == 1  # unchanged
    assert "3 steps" in result.spoken_text


def test_resolve_navigation_returns_none_for_freeform(nav_recipe):
    assert resolve_navigation("how much soy sauce did I use?", nav_recipe, 0) is None
    assert resolve_navigation("my garlic is burning", nav_recipe, 0) is None


def test_resolve_navigation_returns_none_without_recipe():
    assert resolve_navigation("what's next", None, 0) is None


def test_resolve_navigation_ignores_long_utterances(nav_recipe):
    long_text = "what's next " + "and then keep talking " * 10
    assert resolve_navigation(long_text, nav_recipe, 0, max_chars=80) is None


# -- pipeline-level proof that navigation bypasses Gemini --------------------


class _ExplodingGemini:
    """Any call to Gemini is a hard test failure."""

    async def stream_conversation(self, **kwargs):  # noqa: ANN003
        raise AssertionError("Gemini must not be called for deterministic navigation")
        yield  # pragma: no cover


class _NeverRecipes:
    async def intake_recipe(self, text):  # noqa: ANN001
        raise AssertionError("recipe intake must not be called for navigation")


class _StubVAD:
    def mark_assistant_speaking(self, flag: bool) -> None:  # noqa: ANN001
        return None


class _StubTTS:
    async def synthesize(self, text: str, voice: str | None = None) -> bytes:  # noqa: ANN001
        return b""


class _State:
    def __init__(self) -> None:
        self.session_id = "session-1"
        self.phase = "cooking"
        self.recipe = None
        self.current_step_index = 0
        self.turns: list = []
        self.tts_voice = "en-US-AriaNeural"
        self.tts_seq = 0


class _FakeSession:
    def __init__(self, recipe) -> None:
        self.state = _State()
        self.state.recipe = recipe
        self.muted = False
        self.loading_notified = False
        self.assistant_speaking = False
        self.voice_state = "idle"
        self.events: list[dict] = []

    async def send_event(self, payload: str) -> None:
        self.events.append(json.loads(payload))


async def test_pipeline_navigation_emits_tool_call_without_gemini(nav_recipe):
    settings = Settings()
    services = SimpleNamespace(
        settings=settings,
        stt=None,
        vad=_StubVAD(),
        gemini=_ExplodingGemini(),
        tts=_StubTTS(),
        recipes=_NeverRecipes(),
        limiters=None,
        readiness=Readiness(models_loaded=True),
    )
    session = _FakeSession(nav_recipe)
    pipeline = VoicePipeline(session, services)

    await pipeline._respond("what's next", from_voice=False)

    events = session.events
    types = [e["type"] for e in events]
    assert "tool_call" in types, types
    tool = next(e for e in events if e["type"] == "tool_call")
    assert tool["name"] == "advance_step"
    assert tool["arguments"] == {"from_step_index": 0}
    assert types[-1] == "turn_end"
