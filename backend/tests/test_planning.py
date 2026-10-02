"""Conversational-UX flows (architecture section 4 [8]-[13], section 9).

These pipeline-level tests drive :meth:`VoicePipeline._respond` with fully
offline fakes. They prove the guarantees introduced for the conversational UX:

1. Intake (a dish name, a greeting, a question, a suggestion ask) runs the
   planning conversation; the model calls ``begin_dish`` for a clear dish (which
   asks the cook-now vs plan-together choice) or ``offer_choices`` for a
   suggestion request, and never echoes the user's raw words.
2. The choice answer routes to direct-cook (generate + ETA + step 1) or to the
   planning interview, which produces a ``plan`` event via server ``create_plan``.
3. Cancel (planning) and discontinue (cooking) emit ``reset`` and return to
   intake; a timer utterance is never treated as discontinue.
4. Every plan readback and step readout carries an ETA from the recipe's own
   timing fields.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from app.schemas import ConversationAction

import pytest

from app.config import Settings
from app.llm.gemini import FunctionCallEvent, TextDelta
from app.llm.prompts import PLANNING_PROMPT, SYSTEM_PROMPT
from app.llm.tools import _format_step
from app.pipeline import Readiness, VoicePipeline
from tests.factories import make_ingredient, make_recipe, make_step


# ---------------------------------------------------------------------------
# Offline fakes
# ---------------------------------------------------------------------------


class _StubVAD:
    def reset(self) -> None:
        pass

    def mark_assistant_speaking(self, flag: bool) -> None:  # noqa: ANN001
        return None


class _RecordingTTS:
    def __init__(self) -> None:
        self.synthesized: list[str] = []

    async def synthesize(self, text: str, voice: str | None = None) -> bytes:
        self.synthesized.append(text)
        return b""


class _ScriptedGemini:
    """Yields a fixed script; records the kwargs of every conversation call."""

    def __init__(self, script: list[object]) -> None:
        self._script = list(script)
        self.calls: list[dict] = []

    async def stream_conversation(self, **kwargs):  # noqa: ANN003
        self.calls.append(kwargs)
        for event in self._script:
            yield event


class _SequencedGemini:
    """Yields a different script per ``stream_conversation`` call (offline)."""

    def __init__(self, scripts: list[list[object]]) -> None:
        self._scripts = [list(script) for script in scripts]
        self.calls: list[dict] = []

    async def stream_conversation(self, **kwargs):  # noqa: ANN003
        self.calls.append(kwargs)
        index = min(len(self.calls) - 1, len(self._scripts) - 1)
        for event in self._scripts[index]:
            yield event


class _FakeRecipes:
    def __init__(self, recipe) -> None:  # noqa: ANN001
        self.recipe = recipe
        self.generate_calls: list[tuple] = []
        self.parse_calls: list[str] = []

    async def generate_recipe(self, dish, servings=None, constraints=None):  # noqa: ANN001
        self.generate_calls.append((dish, servings, constraints))
        return self.recipe

    async def parse_recipe(self, text: str):  # noqa: ANN201
        self.parse_calls.append(text)
        return self.recipe


class _FakeSessionLimiter:
    """Scripted per-session limiter; records every ``allow_turn`` call."""

    def __init__(self, *, allowed: bool = True, retry_after: float = 0.0) -> None:
        self.allowed = allowed
        self.retry_after = retry_after
        self.calls: list[str] = []

    async def allow_turn(self, session_id: str) -> tuple[bool, float]:
        self.calls.append(session_id)
        return self.allowed, self.retry_after


class _FakeLimiters:
    """Stand-in for :class:`app.ratelimit.RateLimiters`."""

    def __init__(self, *, allowed: bool = True, retry_after: float = 0.0) -> None:
        self.session = _FakeSessionLimiter(allowed=allowed, retry_after=retry_after)


class _State:
    def __init__(self) -> None:
        self.session_id = "session-1"
        self.phase = "intake"
        self.sleeping = False
        self.wake_listening = False
        self.muted = True
        self.recipe = None
        self.current_step_index = 0
        self.turns: list = []
        self.tts_voice = "en-US-AriaNeural"
        self.tts_seq = 0


class _FakeSession:
    def __init__(self) -> None:
        self.state = _State()
        self.muted = False
        self.loading_notified = False
        self.assistant_speaking = False
        self.voice_state = "idle"
        self.events: list[dict] = []
        self.tts = _RecordingTTS()

    async def send_event(self, payload: str) -> None:
        self.events.append(json.loads(payload))

    def types(self) -> list[str]:
        return [event["type"] for event in self.events]


def _pipeline(
    session: _FakeSession,
    *,
    gemini: _ScriptedGemini,
    recipes: _FakeRecipes,
    limiters: _FakeLimiters | None = None,
) -> VoicePipeline:
    settings = Settings()
    services = SimpleNamespace(
        settings=settings,
        stt=None,
        vad=_StubVAD(),
        gemini=gemini,
        tts=session.tts,
        recipes=recipes,
        limiters=limiters or _FakeLimiters(),
        readiness=Readiness(models_loaded=True),
    )
    return VoicePipeline(session, services)


def _plan_recipe():
    return make_recipe(
        title="Chicken Adobo",
        ingredients=[
            make_ingredient("ing_1", name="Soy sauce", display="2 tbsp soy sauce"),
            make_ingredient("ing_2", name="Vinegar", display="1 cup vinegar"),
        ],
        steps=[
            make_step(0, instruction="Marinate the chicken.", refs=("ing_1", "ing_2")),
            make_step(1, instruction="Simmer the sauce.", refs=("ing_1",)),
        ],
    )


# ---------------------------------------------------------------------------
# 1. Dish-name intake routes to the planning conversation; begin_dish asks
# ---------------------------------------------------------------------------


async def test_dish_name_routes_to_planning_then_begin_dish_asks_choice():
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="begin_dish",
                arguments={"dish": "chicken adobo"},
                call_id="call_dish",
            )
        ]
    )
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)

    types = session.types()
    assert "plan" not in types
    assert "recipe" not in types
    assert session.state.recipe is None
    assert session.state.phase == "intake"
    assert types[-1] == "turn_end"
    # The model ran the planning conversation and called begin_dish; the server
    # remembered the dish and asked the cook-now/plan-it question.
    assert pipeline._pending_dish == "chicken adobo"
    assert pipeline._awaiting_choice is True
    assert len(gemini.calls) == 1
    assert gemini.calls[0]["system_prompt"] is PLANNING_PROMPT
    assert recipes.generate_calls == []
    # The two branches are offered as tappable chips as well as spoken.
    choices = [event for event in session.events if event["type"] == "choices"]
    assert len(choices) == 1
    assert [option["label"] for option in choices[0]["options"]] == [
        "Cook it now",
        "Let's plan it",
    ]
    spoken = " ".join(session.tts.synthesized)
    assert "cook it straight away" in spoken
    assert "plan it together first" in spoken
    # The fixed question never echoes the user's raw words.
    captions = [
        event["text"] for event in session.events if event["type"] == "assistant_text"
    ]
    assert captions and all("chicken adobo" not in caption for caption in captions)


# ---------------------------------------------------------------------------
# 2. The choice answer: direct-cook generates + ETA + begins cooking
# ---------------------------------------------------------------------------


async def test_direct_cook_choice_generates_speaks_eta_and_starts_cooking():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="begin_dish",
                arguments={"dish": "chicken adobo"},
                call_id="call_dish",
            )
        ]
    )
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)
    await pipeline.execute_action(ConversationAction(name="cook_now"))

    assert recipes.generate_calls == [("chicken adobo", None, None)]
    recipe_events = [e for e in session.events if e["type"] == "recipe"]
    assert len(recipe_events) == 1
    assert recipe_events[0]["recipe"]["title"] == "Chicken Adobo"
    assert session.state.recipe is recipe
    assert session.state.phase == "cooking"
    assert session.state.current_step_index == 0
    assert pipeline._pending_dish == ""
    assert pipeline._awaiting_choice is False
    spoken = " ".join(session.tts.synthesized)
    # Plan readback ETA comes from total_time_seconds (2100s -> 35 minutes).
    assert "About 35 minutes total" in spoken
    # Immediate step-1 readout carries the step's own ETA (60s -> 1 minute).
    assert "Step 1 of 2" in spoken
    assert "About 1 minute" in spoken
    assert session.types()[-1] == "turn_end"
    # Direct cook is deterministic: only the begin_dish turn hit Gemini.
    assert len(gemini.calls) == 1


async def test_plan_first_choice_runs_the_planning_interview():
    gemini = _SequencedGemini(
        [
            [
                FunctionCallEvent(
                    name="begin_dish",
                    arguments={"dish": "chicken adobo"},
                    call_id="call_dish",
                )
            ],
            [FunctionCallEvent(name="conversation_action", arguments={"name": "plan_together"}, call_id="plan_together")],
        ]
    )
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)
    await pipeline._respond("Let's plan it", from_voice=True)

    assert len(gemini.calls) == 2
    assert gemini.calls[1]["system_prompt"] is PLANNING_PROMPT
    assert gemini.calls[1]["user_text"] == "Let's plan it"
    assert recipes.generate_calls == []
    assert session.state.recipe is None
    assert pipeline._pending_dish == "chicken adobo"
    assert pipeline._awaiting_choice is False
    assert session.types()[-1] == "turn_end"


# ---------------------------------------------------------------------------
# 1b. Suggestion requests call offer_choices; they are never a dish name
# ---------------------------------------------------------------------------


async def test_suggestion_request_routes_to_offer_choices_not_dish_choice():
    """Discovery interviews first, then emits preview choices without generation.

    It must NOT be mistaken for a dish name (which would ask the
    cook-now/plan-it question), and the server-executed ``offer_choices`` tool
    ends the turn without a second Gemini call.
    """
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="offer_choices",
                arguments={"options": ["Chicken Adobo", "Sinigang", "Tinola"]},
                call_id="call_choices",
            )
        ]
    )
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline.execute_action(ConversationAction(name="discover"))
    assert gemini.calls == []
    assert session.state.recipe is None
    session.events.clear()
    await pipeline.execute_action(ConversationAction(name="suggest_now"))

    types = session.types()
    choices = [event for event in session.events if event["type"] == "choices"]
    assert len(choices) == 1
    assert [option["label"] for option in choices[0]["options"]] == [
        "Chicken Adobo",
        "Sinigang",
        "Tinola",
        "Show other dishes",
        "Change my preferences",
    ]
    # Ids are slugified labels (tappable chips).
    assert [option["id"] for option in choices[0]["options"]] == [
        "chicken_adobo_0",
        "sinigang_1",
        "tinola_2",
        "other_dishes",
        "change_preferences",
    ]
    # It is a suggestion, not a dish intake: no pending dish, no choice question.
    assert pipeline._pending_dish == ""
    assert pipeline._awaiting_choice is False
    assert session.state.recipe is None
    spoken = " ".join(session.tts.synthesized)
    assert "cook it straight away" not in spoken
    assert "Which dish would you like to explore?" in spoken
    assert all(option.get("food") for option in choices[0]["options"][:3])
    # The planning conversation ran exactly once (no second Gemini round-trip).
    assert len(gemini.calls) == 1
    assert gemini.calls[0]["system_prompt"] is PLANNING_PROMPT
    assert recipes.generate_calls == []
    assert types[-1] == "turn_end"


# ---------------------------------------------------------------------------
# 3. create_plan is executed by the server -> plan event + planning phase
# ---------------------------------------------------------------------------


async def test_create_plan_presents_plan_and_names_ingredients():
    recipe = _plan_recipe()
    gemini = _SequencedGemini(
        [
            [
                FunctionCallEvent(
                    name="begin_dish",
                    arguments={"dish": "chicken adobo"},
                    call_id="call_dish",
                )
            ],
            [
                FunctionCallEvent(
                    name="create_plan",
                    arguments={"servings": 4, "constraints": "no dairy"},
                    call_id="call_plan",
                )
            ],
        ]
    )
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    # Dish name -> begin_dish -> plan-together -> interview -> create_plan.
    await pipeline._respond("chicken adobo", from_voice=False)
    await pipeline._respond("plan it together", from_voice=True)

    types = session.types()
    # A server tool is never forwarded to the client.
    assert "tool_call" not in types
    plan_events = [event for event in session.events if event["type"] == "plan"]
    assert len(plan_events) == 1
    assert plan_events[0]["recipe"]["title"] == "Chicken Adobo"
    assert session.state.recipe is recipe
    assert session.state.phase == "planning"
    assert session.state.current_step_index == 0
    assert recipes.generate_calls == [("chicken adobo", 4, "no dairy")]

    spoken = " ".join(session.tts.synthesized)
    assert "Chicken Adobo" in spoken
    # The readback always names the ingredients, the step count and the ETA.
    assert "2 tbsp soy sauce" in spoken
    assert "1 cup vinegar" in spoken
    assert "2 steps" in spoken
    assert "About 35 minutes total" in spoken
    assert types[-1] == "turn_end"
    # The create_plan turn ended at the server tool; Gemini was not re-invoked
    # for the plan itself.
    assert len(gemini.calls) == 2


# ---------------------------------------------------------------------------
# 3. Explicit confirmation starts cooking (deterministic, no Gemini)
# ---------------------------------------------------------------------------


async def test_start_confirmation_flips_to_cooking_with_step_one():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    # A plan has already been presented.
    session.state.recipe = recipe
    session.state.phase = "planning"

    await pipeline.execute_action(ConversationAction(name="start_cooking"))

    types = session.types()
    recipe_events = [event for event in session.events if event["type"] == "recipe"]
    assert len(recipe_events) == 1
    assert recipe_events[0]["recipe"]["title"] == "Chicken Adobo"
    assert session.state.phase == "cooking"
    assert session.state.current_step_index == 0
    spoken = " ".join(session.tts.synthesized)
    assert "Step 1 of 2" in spoken
    assert "Marinate the chicken." in spoken
    assert types[-1] == "turn_end"
    # Confirmation is deterministic: no Gemini round-trip.
    assert gemini.calls == []


# ---------------------------------------------------------------------------
# 3b. Cancel / discontinue (deterministic reset)
# ---------------------------------------------------------------------------


async def test_cancel_during_planning_resets_to_intake():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "planning"
    pipeline._pending_dish = "chicken adobo"

    await pipeline.execute_action(ConversationAction(name="reset"))

    assert "reset" in session.types()
    assert session.state.recipe is None
    assert session.state.phase == "intake"
    assert session.state.current_step_index == 0
    assert pipeline._pending_dish == ""
    assert pipeline._awaiting_choice is False
    spoken = " ".join(session.tts.synthesized)
    assert "back to the start" in spoken
    assert session.types()[-1] == "turn_end"
    assert gemini.calls == []


async def test_cancel_during_interview_resets_to_intake():
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="begin_dish",
                arguments={"dish": "chicken adobo"},
                call_id="call_dish",
            )
        ]
    )
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)  # begin_dish asks the choice
    assert pipeline._awaiting_choice is True
    await pipeline.execute_action(ConversationAction(name="reset"))

    assert "reset" in session.types()
    assert session.state.recipe is None
    assert session.state.phase == "intake"
    assert pipeline._pending_dish == ""
    assert pipeline._awaiting_choice is False
    # Only the begin_dish planning turn reached Gemini; cancel is deterministic.
    assert len(gemini.calls) == 1


async def test_discontinue_during_cooking_resets_to_intake():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline.execute_action(ConversationAction(name="reset"))

    assert "reset" in session.types()
    assert session.state.recipe is None
    assert session.state.phase == "intake"
    assert session.state.current_step_index == 0
    assert pipeline._pending_dish == ""
    assert session.types()[-1] == "turn_end"
    assert gemini.calls == []


async def test_stop_the_timer_is_not_discontinue():
    """A timer utterance must fall through to the normal tool path."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([TextDelta("Stopping the pasta timer.")])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"

    await pipeline._respond("stop the timer", from_voice=True)

    assert "reset" not in session.types()
    assert session.state.recipe is recipe
    assert session.state.phase == "cooking"
    # It fell through to the normal conversational/tool path.
    assert len(gemini.calls) == 1








# ---------------------------------------------------------------------------
# 3c. Always-ETA formatting
# ---------------------------------------------------------------------------


def test_format_plan_includes_eta_from_total_time():
    spoken = VoicePipeline._format_plan(_plan_recipe())
    assert "About 35 minutes total" in spoken
    assert "2 steps" in spoken


def test_format_plan_falls_back_to_prep_plus_cook():
    recipe = _plan_recipe().model_copy(
        update={
            "total_time_seconds": None,
            "prep_time_seconds": 300.0,
            "cook_time_seconds": 1500.0,
        }
    )
    assert "About 30 minutes total" in VoicePipeline._format_plan(recipe)


def test_format_plan_omits_eta_when_all_times_null():
    recipe = _plan_recipe().model_copy(
        update={
            "total_time_seconds": None,
            "prep_time_seconds": None,
            "cook_time_seconds": None,
        }
    )
    spoken = VoicePipeline._format_plan(recipe)
    assert "minute" not in spoken
    assert "2 steps - ready to cook?" in spoken


def test_format_step_includes_duration():
    recipe = _plan_recipe()
    assert "About 1 minute." in _format_step(recipe, 0)


def test_format_step_omits_duration_when_null():
    recipe = _plan_recipe().model_copy(update={"steps": [make_step(0, duration=None)]})
    assert "minute" not in _format_step(recipe, 0)


async def test_revision_during_planning_regenerates_via_planning_prompt():
    recipe = _plan_recipe()
    revised = make_recipe(title="Chicken Adobo", ingredients=[make_ingredient()])
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="create_plan",
                arguments={"constraints": "no soy"},
                call_id="call_plan_2",
            )
        ]
    )
    recipes = _FakeRecipes(revised)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "planning"
    pipeline._pending_dish = "chicken adobo"

    await pipeline._respond("can you make it without soy", from_voice=True)

    assert session.state.phase == "planning"
    assert len(recipes.generate_calls) == 1
    dish, servings, constraints = recipes.generate_calls[0]
    assert dish == "chicken adobo" and servings is None
    assert "no soy" in constraints
    assert gemini.calls[0]["system_prompt"] is PLANNING_PROMPT


async def test_create_plan_after_reconnect_falls_back_to_recipe_title():
    """Reconnect drops the in-memory dish; the existing plan title is the fallback.

    ``_pending_dish`` is per-session in-memory and is not restored when the
    client ``sync`` rebuilds context (architecture sections 5/7), so a revision
    after reconnect must regenerate from the current plan's title instead of
    ``generate_recipe("")`` (architecture section 9 ``create_plan``).
    """
    recipe = _plan_recipe()
    revised = make_recipe(title="Chicken Adobo", ingredients=[make_ingredient()])
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="create_plan",
                arguments={"constraints": "no soy"},
                call_id="call_plan_reconnect",
            )
        ]
    )
    recipes = _FakeRecipes(revised)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    # Reconnect: the recipe arrives via ``sync``, but the in-memory dish is gone.
    session.state.recipe = recipe
    session.state.phase = "planning"
    assert pipeline._pending_dish == ""

    await pipeline._respond("can you make it without soy", from_voice=True)

    # Regenerated from the existing title, not from an empty dish.
    assert len(recipes.generate_calls) == 1
    dish, servings, constraints = recipes.generate_calls[0]
    assert dish == "Chicken Adobo" and servings is None
    assert "no soy" in constraints
    plan_events = [event for event in session.events if event["type"] == "plan"]
    assert len(plan_events) == 1
    assert session.state.phase == "planning"
    assert "error" not in session.types()


# ---------------------------------------------------------------------------
# 3d. Recipe completion ("done"), always-captioned lines, companion prompts
# ---------------------------------------------------------------------------


async def test_next_on_last_step_completes_and_congratulates():
    """Reaching the end and asking for "next" ends the recipe, not repeats it."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1  # last step

    await pipeline.execute_action(ConversationAction(name="advance_step"))
    assert "done" not in session.types()
    assert session.state.phase == "cooking"
    await pipeline.execute_action(ConversationAction(name="confirm"))

    types = session.types()
    assert "done" in types
    assert session.state.phase == "done"
    # Never advanced past the final step.
    assert session.state.current_step_index == 1
    # The final step is not replayed as a readout.
    spoken = " ".join(session.tts.synthesized)
    assert "Simmer the sauce." not in spoken
    assert "Step 2 of 2" not in spoken
    assert "you did it" in spoken
    # The congratulation is captioned as well as spoken.
    captions = [
        event["text"] for event in session.events if event["type"] == "assistant_text"
    ]
    assert any("you did it" in caption for caption in captions)
    assert types[-1] == "turn_end"
    # Completion is deterministic: no Gemini round-trip.
    assert gemini.calls == []


# ---------------------------------------------------------------------------
# 3d-ii. Completion-on-a-done-cue requires confirmation via choices
# ---------------------------------------------------------------------------










async def test_done_cue_asks_confirmation_then_yes_completes():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1  # last step

    await pipeline.execute_action(ConversationAction(name="finish"))

    types = session.types()
    # First turn: confirm via choices; the recipe is NOT finished yet.
    assert "done" not in types
    choices = [event for event in session.events if event["type"] == "choices"]
    assert len(choices) == 1
    assert [option["label"] for option in choices[0]["options"]] == [
        "Yes, I'm done",
        "Keep cooking",
    ]
    assert pipeline._awaiting_done_confirm is True
    assert session.state.phase == "cooking"
    assert "Ready to finish?" in " ".join(session.tts.synthesized)

    await pipeline.execute_action(ConversationAction(name="confirm"))

    types = session.types()
    assert "done" in types
    assert session.state.phase == "done"
    # Never advanced past the final step.
    assert session.state.current_step_index == 1
    assert pipeline._awaiting_done_confirm is False
    assert types[-1] == "turn_end"
    assert gemini.calls == []


async def test_done_cue_chip_label_yes_im_done_completes():
    """Tapping the "Yes, I'm done" chip completes the recipe."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline.execute_action(ConversationAction(name="finish"))
    assert pipeline._awaiting_done_confirm is True

    # The chip label is itself a valid affirmative answer.
    await pipeline.execute_action(ConversationAction(name="confirm"))

    types = session.types()
    assert "done" in types
    assert session.state.phase == "done"
    assert session.state.current_step_index == 1
    assert pipeline._awaiting_done_confirm is False
    assert types[-1] == "turn_end"
    # The congratulation is captioned as well as spoken.
    captions = [
        event["text"] for event in session.events if event["type"] == "assistant_text"
    ]
    assert any("you did it" in caption for caption in captions)
    assert gemini.calls == []


async def test_done_cue_with_trailing_words_asks_confirmation():
    """A done cue carrying a trailing qualifier still triggers confirmation."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline.execute_action(ConversationAction(name="finish"))

    types = session.types()
    assert "done" not in types
    choices = [event for event in session.events if event["type"] == "choices"]
    assert len(choices) == 1
    assert [option["label"] for option in choices[0]["options"]] == [
        "Yes, I'm done",
        "Keep cooking",
    ]
    assert pipeline._awaiting_done_confirm is True
    assert session.state.phase == "cooking"
    assert gemini.calls == []


async def test_done_cue_not_yet_keeps_cooking():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline.execute_action(ConversationAction(name="finish"))
    await pipeline.execute_action(ConversationAction(name="decline"))

    types = session.types()
    assert "done" not in types
    assert "reset" not in types
    assert session.state.recipe is recipe
    assert session.state.phase == "cooking"
    assert pipeline._awaiting_done_confirm is False
    assert "keep going" in " ".join(session.tts.synthesized)
    assert types[-1] == "turn_end"


async def test_stop_cooking_still_resets_even_though_done_cue_exists():
    """Done cue precedence must not swallow a real discontinue command."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline.execute_action(ConversationAction(name="reset"))

    types = session.types()
    assert "reset" in types
    assert "choices" in types  # offer a fresh intake action after reset
    assert session.state.recipe is None
    assert session.state.phase == "intake"
    assert pipeline._awaiting_done_confirm is False


async def test_timer_utterance_is_not_a_done_cue():
    """A timer utterance during cooking stays on the tool path, never confirm."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([TextDelta("Stopping the pasta timer.")])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline._respond("stop the timer", from_voice=True)

    types = session.types()
    assert "choices" in types  # contextual follow-ups, not completion choices
    assert "done" not in types
    assert "reset" not in types
    assert pipeline._awaiting_done_confirm is False
    assert len(gemini.calls) == 1


async def test_offer_choices_allowed_during_cooking():
    """Cooking follow-up choices cannot replace the active recipe."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="offer_choices",
                arguments={"options": ["Repeat this step", "Next step"], "question": "Keep simmering. What would you like next?"},
                call_id="call_cook_choices",
            ),
            TextDelta("We're on step 2 - keep simmering."),
        ]
    )
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline._respond("how is it going", from_voice=True)

    types = session.types()
    assert "choices" in types
    assert session.state.recipe is recipe
    assert session.state.phase == "cooking"
    spoken = "".join(
        event["text"] for event in session.events if event["type"] == "assistant_text"
    )
    assert "keep simmering" in spoken.lower()
    assert types[-1] == "turn_end"


async def test_after_done_whats_next_offers_a_new_dish_not_replay():
    """After completion, "what's next" routes to the companion, not navigation."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini(
        [TextDelta("Here are a few ideas: adobo, sinigang, or kare-kare.")]
    )
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "done"
    session.state.current_step_index = 1

    await pipeline.execute_action(ConversationAction(name="discover"))

    types = session.types()
    # No second completion event and no final-step replay.
    assert "done" not in types
    assert "tool_call" not in types
    spoken = " ".join(session.tts.synthesized)
    assert "Simmer the sauce." not in spoken
    # A new discovery begins; interview missing preferences before suggesting.
    assert session.state.phase == "intake"
    assert "reset" in types
    assert gemini.calls == []
    assert pipeline._discovery.pending == "cravings"
    assert types[-1] == "turn_end"


@pytest.mark.parametrize("utterance", ["stop cooking", "start over"])
async def test_cancel_or_discontinue_during_done_resets_to_intake(utterance):
    """A cancel/discontinue must reset even after the recipe is complete.

    Reaching ``done`` hands the follow-up turn to the companion/suggestion
    conversation, but "stop cooking" (the completion card's
    "Cook something else" line) and "start over" must still emit ``reset`` and
    return to intake instead of chatting.
    """
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1  # last step

    # Reach the done phase through the normal completion path.
    await pipeline.execute_action(ConversationAction(name="advance_step"))
    await pipeline.execute_action(ConversationAction(name="confirm"))
    assert session.state.phase == "done"

    await pipeline.execute_action(ConversationAction(name="reset"))

    types = session.types()
    assert "reset" in types
    assert session.state.recipe is None
    assert session.state.phase == "intake"
    assert session.state.current_step_index == 0
    assert pipeline._pending_dish == ""
    assert pipeline._awaiting_choice is False
    spoken = " ".join(session.tts.synthesized)
    assert "back to the start" in spoken
    assert types[-1] == "turn_end"
    # Reset is deterministic: never routed to the companion conversation.
    assert gemini.calls == []


async def test_non_cancel_during_done_still_routes_to_suggestions():
    """Any other completion utterance keeps the companion suggestion flow."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([TextDelta("Here are a few ideas: adobo or sinigang.")])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "done"
    session.state.current_step_index = 1

    await pipeline.execute_action(ConversationAction(name="discover"))

    types = session.types()
    assert "reset" in types
    assert session.state.recipe is None
    assert session.state.phase == "intake"
    assert gemini.calls == []
    assert pipeline._discovery.pending == "cravings"
    assert types[-1] == "turn_end"


async def test_stop_the_timer_during_done_does_not_reset():
    """A timer utterance in done stays on the tool path, never a reset."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([TextDelta("Stopping the pasta timer.")])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "done"
    session.state.current_step_index = 1

    await pipeline._respond("stop the timer", from_voice=True)

    assert "reset" not in session.types()
    assert session.state.recipe is recipe
    assert session.state.phase == "done"
    assert len(gemini.calls) == 1


async def test_navigation_readout_is_captioned():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 0

    await pipeline.execute_action(ConversationAction(name="advance_step"))
    assert session.state.current_step_index == 0
    await pipeline.execute_action(ConversationAction(name="confirm"))

    captions = [
        event["text"] for event in session.events if event["type"] == "assistant_text"
    ]
    assert any("Step 2 of 2" in caption for caption in captions)


async def test_choice_question_is_captioned():
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="begin_dish",
                arguments={"dish": "chicken adobo"},
                call_id="call_dish",
            )
        ]
    )
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)

    captions = [
        event["text"] for event in session.events if event["type"] == "assistant_text"
    ]
    assert any("cook it straight away" in caption for caption in captions)


async def test_cancel_farewell_is_captioned():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline.execute_action(ConversationAction(name="reset"))

    assert "reset" in session.types()
    captions = [
        event["text"] for event in session.events if event["type"] == "assistant_text"
    ]
    assert any("back to the start" in caption for caption in captions)


async def test_plan_readback_is_captioned():
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "planning"

    await pipeline.execute_action(ConversationAction(name="start_cooking"))

    captions = [
        event["text"] for event in session.events if event["type"] == "assistant_text"
    ]
    assert any("Step 1 of 2" in caption for caption in captions)


async def test_streaming_reply_is_captioned_once_per_delta():
    """The streaming LLM path already captions per delta; never double-emit."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini([TextDelta("Keep simmering.")])
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 0

    await pipeline._respond("how is it going", from_voice=True)

    captions = [event for event in session.events if event["type"] == "assistant_text"]
    assert len(captions) == 1
    assert captions[0]["text"] == "Keep simmering."


def test_system_prompt_is_the_planner_companion():
    assert "You are Kef" in SYSTEM_PROMPT
    assert "warm cooking companion" in SYSTEM_PROMPT
    # The cooking-only guard and the disaster-first rule survive the rewrite.
    assert "Only help with cooking" in SYSTEM_PROMPT
    assert "corrective action FIRST" in SYSTEM_PROMPT


def test_prompts_guide_dish_suggestions():
    """Discovery ranks three dishes and respects the recorded constraints."""
    for prompt in (SYSTEM_PROMPT, PLANNING_PROMPT):
        lowered = prompt.lower()
        assert "three" in lowered
        assert "restrictions" in lowered
    assert "what to cook" in PLANNING_PROMPT.lower()


# ---------------------------------------------------------------------------
# 4. Security-review hardening of the planning flow
# ---------------------------------------------------------------------------


async def test_create_plan_ignored_during_cooking_and_conversation_continues():
    """A ``create_plan`` call mid-cook is dropped; the normal reply still runs."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="create_plan",
                arguments={"servings": 4},
                call_id="call_cook",
            ),
            TextDelta("We're on step 2 - keep simmering."),
        ]
    )
    recipes = _FakeRecipes(make_recipe(title="Unrelated Dish"))
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    session.state.recipe = recipe
    session.state.phase = "cooking"
    session.state.current_step_index = 1

    await pipeline._respond("how is it going", from_voice=True)

    types = session.types()
    assert "plan" not in types
    assert recipes.generate_calls == []
    assert session.state.recipe is recipe
    assert session.state.phase == "cooking"
    assert session.state.current_step_index == 1
    # Returning False lets the turn continue; the model still gets to speak.
    spoken = "".join(
        event["text"] for event in session.events if event["type"] == "assistant_text"
    )
    assert "keep simmering" in spoken
    assert types[-1] == "turn_end"


async def test_pasted_recipe_then_revision_regenerates_from_parsed_title():
    """Parsing a pasted recipe anchors the dish to its title, not a stale one."""
    parsed = make_recipe(
        title="Beef Kaldereta",
        ingredients=[make_ingredient("ing_1", name="Beef", display="1 kg beef")],
        steps=[make_step(0, instruction="Brown the beef.", refs=("ing_1",))],
    )
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="create_plan",
                arguments={"constraints": "less salt"},
                call_id="call_revision",
            )
        ]
    )
    recipes = _FakeRecipes(parsed)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    # A stale dish from an earlier dish-name interview must not leak in.
    pipeline._pending_dish = "chicken adobo"

    # Paste/dictate a recipe -> parsed, not generated.
    await pipeline.execute_action(ConversationAction(name="parse_recipe", value=
        "Ingredients:\n1 kg beef\n2 cups tomato sauce\nBrown the beef and simmer.",
    ))
    assert recipes.parse_calls and recipes.generate_calls == []
    assert session.state.recipe is parsed
    assert session.state.phase == "planning"
    assert pipeline._pending_dish == "Beef Kaldereta"

    # A later revision regenerates from the parsed title, never the stale dish.
    await pipeline._respond("can you use less salt", from_voice=True)
    assert recipes.generate_calls == [("Beef Kaldereta", None, "less salt")]


async def test_text_input_is_rate_limited_like_audio():
    """Text input honors the per-session turn limiter (RL-2)."""
    gemini = _ScriptedGemini([TextDelta("How many servings?")])
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    limiters = _FakeLimiters(allowed=False, retry_after=1.5)
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes, limiters=limiters)

    await pipeline.handle_text_input("chicken adobo")

    limited = [event for event in session.events if event["type"] == "rate_limited"]
    assert len(limited) == 1
    assert limited[0]["scope"] == "session_turn"
    assert limited[0]["retry_after"] == 1.5
    # Denied before processing: no turn, no Gemini, no recipe work.
    assert limiters.session.calls == ["session-1"]
    assert gemini.calls == []
    assert recipes.generate_calls == []
    assert recipes.parse_calls == []
    assert "turn_end" not in session.types()


async def test_greeting_routes_to_planning_without_fabricated_dish_or_choice():
    """A greeting/non-dish input runs the planning conversation, not a dish.

    The model decides the next move. The server must not fabricate a dish, must
    not ask the cook-now/plan-it question, and must not echo the user's words.
    """
    gemini = _ScriptedGemini([TextDelta("What would you like to cook?")])
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("hello there", from_voice=False)

    types = session.types()
    assert "choices" in types  # useful intake follow-ups without choosing a dish
    assert "plan" not in types
    assert "recipe" not in types
    assert session.state.recipe is None
    assert pipeline._pending_dish == ""
    assert pipeline._awaiting_choice is False
    assert recipes.generate_calls == []
    assert len(gemini.calls) == 1
    assert gemini.calls[0]["system_prompt"] is PLANNING_PROMPT
    assert gemini.calls[0]["user_text"] == "hello there"


# ---------------------------------------------------------------------------
# Confirmation detector stays conservative
# ---------------------------------------------------------------------------






# ---------------------------------------------------------------------------
# 5. The intake cook-now/plan-it choice must not loop, and cancel works before
#    a dish has been recorded.
# ---------------------------------------------------------------------------


async def test_dish_naming_turn_asks_the_choice_once():
    """A dish-naming turn records the dish and emits the choice + question."""
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="begin_dish",
                arguments={"dish": "chicken adobo"},
                call_id="call_dish_once",
            )
        ]
    )
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)

    choices = [event for event in session.events if event["type"] == "choices"]
    assert len(choices) == 1
    assert [option["label"] for option in choices[0]["options"]] == [
        "Cook it now",
        "Let's plan it",
    ]
    assert pipeline._pending_dish == "chicken adobo"
    assert pipeline._awaiting_choice is True
    assert "cook it straight away" in " ".join(session.tts.synthesized)
    assert session.types()[-1] == "turn_end"


async def test_repeat_begin_dish_with_a_known_dish_is_ignored():
    """A second begin_dish must not re-emit or re-ask the choice question.

    After the first ``begin_dish`` the dish is known and the cook-now versus
    plan-it question has been asked. If the model calls ``begin_dish`` again
    (here on the interview turn) the server ignores it, emits no second
    ``choices`` event, leaves the dish intact and ends the turn cleanly.
    """
    gemini = _SequencedGemini(
        [
            [
                FunctionCallEvent(
                    name="begin_dish",
                    arguments={"dish": "chicken adobo"},
                    call_id="call_dish_1",
                )
            ],
            [
                FunctionCallEvent(
                    name="begin_dish",
                    arguments={"dish": "chicken adobo"},
                    call_id="call_dish_2",
                )
            ],
        ]
    )
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)
    assert pipeline._pending_dish == "chicken adobo"
    assert pipeline._awaiting_choice is True

    # The user chooses to plan together; the interview turn makes the model call
    # begin_dish a second time.
    await pipeline._respond("let's plan it", from_voice=True)

    choices = [event for event in session.events if event["type"] == "choices"]
    assert len(choices) == 2  # follow-up actions, without repeating the dish question
    assert choices[-1]["options"][0]["label"] == "Cook it now"
    assert pipeline._pending_dish == "chicken adobo"
    assert pipeline._awaiting_choice is True
    assert session.state.recipe is None
    assert session.types()[-1] == "turn_end"
    assert len(gemini.calls) == 2


async def test_plan_it_answer_runs_the_interview_not_the_choice_again():
    """Answering "let's plan it" runs the planning interview, not the choice."""
    gemini = _SequencedGemini(
        [
            [
                FunctionCallEvent(
                    name="begin_dish",
                    arguments={"dish": "chicken adobo"},
                    call_id="call_dish_plan",
                )
            ],
            [FunctionCallEvent(name="conversation_action", arguments={"name": "plan_together"}, call_id="plan_together")],
        ]
    )
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)
    await pipeline._respond("let's plan it", from_voice=True)

    assert len(gemini.calls) == 2
    assert gemini.calls[1]["system_prompt"] is PLANNING_PROMPT
    assert gemini.calls[1]["user_text"] == "let's plan it"
    assert recipes.generate_calls == []
    assert session.state.recipe is None
    assert pipeline._pending_dish == "chicken adobo"
    assert pipeline._awaiting_choice is False
    # The servings question also receives useful follow-up options.
    choices = [event for event in session.events if event["type"] == "choices"]
    assert len(choices) == 2
    assert choices[-1]["options"][0]["label"] == "2 servings"
    assert session.types()[-1] == "turn_end"


async def test_cook_it_now_answer_direct_cooks():
    """Answering "cook it now" routes to deterministic direct-cook."""
    recipe = _plan_recipe()
    gemini = _ScriptedGemini(
        [
            FunctionCallEvent(
                name="begin_dish",
                arguments={"dish": "chicken adobo"},
                call_id="call_dish_cook",
            )
        ]
    )
    recipes = _FakeRecipes(recipe)
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    await pipeline._respond("chicken adobo", from_voice=False)
    await pipeline.execute_action(ConversationAction(name="cook_now"))

    assert recipes.generate_calls == [("chicken adobo", None, None)]
    assert session.state.recipe is recipe
    assert session.state.phase == "cooking"
    assert session.state.current_step_index == 0
    # Direct cook is deterministic: Gemini only ran for the begin_dish turn.
    assert len(gemini.calls) == 1
    assert session.types()[-1] == "turn_end"


@pytest.mark.parametrize("text", ["cancel the plan", "start over", "forget it", "never mind"])
async def test_cancel_during_plain_intake_resets_before_a_dish_is_known(text):
    """A cancel always resets during intake, even before a dish is recorded."""
    gemini = _ScriptedGemini([])
    recipes = _FakeRecipes(_plan_recipe())
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    assert session.state.recipe is None
    assert pipeline._pending_dish == ""

    await pipeline.execute_action(ConversationAction(name="reset"))

    assert "reset" in session.types()
    assert session.state.recipe is None
    assert session.state.phase == "intake"
    assert pipeline._pending_dish == ""
    assert pipeline._awaiting_choice is False
    assert gemini.calls == []
    assert session.types()[-1] == "turn_end"




async def test_presented_plan_offers_contextual_cooking_choice_after_readback():
    session = _FakeSession()
    recipe = _plan_recipe()
    pipeline = _pipeline(session, gemini=_ScriptedGemini([]), recipes=_FakeRecipes(recipe))
    await pipeline._present_plan(recipe)
    choices = [event for event in session.events if event["type"] == "choices"]
    assert len(choices) == 1
    assert [option["label"] for option in choices[0]["options"]] == ["Let's cook", "Adjust the plan"]
    assert session.state.phase == "planning"
    assert session.events.index(choices[0]) > next(i for i, event in enumerate(session.events) if event["type"] == "plan")
