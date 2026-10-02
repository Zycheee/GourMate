"""Contextual ingress and validated execution with explicitly scripted model intents (§9).

These tests assert the context and single-call routing, not a fake keyword classifier.
Live Gemini paraphrase accuracy remains an integration/device check.
"""
import pytest
from app.errors import AppError, ErrorCode
from app.llm.gemini import FunctionCallEvent, TextDelta
from app.schemas import ConversationAction
from app.recipe.discovery import Discovery
from tests.test_planning import _FakeSession, _FakeRecipes, _SequencedGemini, _ScriptedGemini, _pipeline
from tests.factories import make_recipe, make_step


def intent(name, **kwargs):
    return FunctionCallEvent(name="conversation_action", arguments={"name": name, **kwargs}, call_id="intent")


def prepared(scripts, phase="planning"):
    session = _FakeSession()
    session.state.recipe = make_recipe(title="Classic Beef Stew", steps=[make_step(i) for i in range(7)])
    session.state.phase = phase
    model = _SequencedGemini(scripts)
    pipeline = _pipeline(session, gemini=model, recipes=_FakeRecipes(session.state.recipe))
    return pipeline, session, model


async def test_beef_stew_approval_readiness_and_repeated_start():
    pipeline, session, model = prepared([[intent("approve_plan")], [intent("start_cooking")], [intent("start_cooking")], [intent("start_cooking")]])
    for text in ["it's cool", "let's cook it", "let's cook it", "start cooking"]:
        session.events.clear()
        await pipeline._respond(text, from_voice=True)
        if text == "it's cool":
            assert session.state.phase == "planning"
            assert any("Ready to start cooking?" in e.get("text", "") for e in session.events)
        else:
            assert session.state.phase == "cooking"
            assert session.state.current_step_index == 0
            assert pipeline._pending_navigation is None
            assert not any("Leave this step" in e.get("text", "") for e in session.events)
    assert len(model.calls) == 4
    assert [c["user_text"] for c in model.calls] == ["it's cool", "let's cook it", "let's cook it", "start cooking"]
    assert "Session phase: planning" in model.calls[1]["recipe_context"]
    assert "Session phase: cooking" in model.calls[2]["recipe_context"]
    assert len(session.state.recipe.steps) == 7


@pytest.mark.parametrize("text, action", [("I'm ready to cook", "start_cooking"), ("We can get cooking now", "start_cooking"), ("looks good", "approve_plan"), ("The plan sounds lovely", "approve_plan")])
async def test_paraphrases_reach_existing_turn_without_classifier(text, action):
    pipeline, session, model = prepared([[intent(action)]])
    await pipeline._respond(text, from_voice=False)
    assert len(model.calls) == 1 and model.calls[0]["user_text"] == text
    assert session.state.phase == ("cooking" if action == "start_cooking" else "planning")


@pytest.mark.parametrize("text", ["Don't start cooking yet", "I'm not ready", "Let's cook it later", "I'm done chopping, not cooking", "Yes, but could we change the sauce first?"])
async def test_no_keyword_changes_state_when_model_asks_clarification(text):
    pipeline, session, model = prepared([[TextDelta("Would you like to adjust the plan first?")]])
    original = session.state.recipe
    await pipeline._respond(text, from_voice=True)
    assert len(model.calls) == 1
    assert session.state.recipe is original and session.state.phase == "planning"
    assert session.state.current_step_index == 0
    assert not any(e["type"] in ("recipe", "done", "reset", "tool_call") for e in session.events)
    assert session.events[-1]["type"] == "turn_end"


async def test_confirmation_tool_survives_model_prelude_and_executes_once():
    pipeline, session, model = prepared([[TextDelta("Okay. "), intent("confirm")]], phase="cooking")
    await pipeline.execute_action(ConversationAction(name="advance_step"))
    session.events.clear()
    await pipeline._respond("Yes, take me to the next one", from_voice=True)
    assert "Pending navigation" in model.calls[0]["recipe_context"]
    assert session.state.current_step_index == 1
    assert len([e for e in session.events if e["type"] == "tool_call"]) == 1
    await pipeline.execute_action(ConversationAction(name="confirm"))
    assert session.state.current_step_index == 1
    assert len([e for e in session.events if e["type"] == "tool_call"]) == 1


async def test_unrelated_timer_tool_cancels_pending_navigation():
    pipeline, session, model = prepared([[FunctionCallEvent(name="create_kitchen_timer", arguments={"label": "sauce", "duration_seconds": 60}, call_id="timer"), TextDelta("A minute for the sauce.")]], phase="cooking")
    await pipeline.execute_action(ConversationAction(name="advance_step"))
    await pipeline._respond("Instead, set a minute for this sauce", from_voice=True)
    assert pipeline._pending_navigation is None
    assert session.state.current_step_index == 0


async def test_interview_context_and_semantic_answers_skip_known_fields():
    model = _SequencedGemini([[intent("discover", answers={"ingredients": "eggplant and coconut milk", "time": "half an hour"})], [intent("update_preferences", answers={"cravings": "a curry"})], [intent("update_preferences", answers={"dietary": "no peanuts"}), FunctionCallEvent(name="offer_choices", arguments={"options": ["Vegetable Curry", "Fried Rice", "Omelette"]}, call_id="foods")]])
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=model, recipes=_FakeRecipes(make_recipe()))
    for text in ["Can you help me decide? My fridge has eggplant and coconut milk; I have half an hour", "Maybe a curry", "Anything except peanuts"]:
        await pipeline._respond(text, from_voice=True)
    assert pipeline._discovery.asked == ["cravings", "dietary"]
    assert pipeline._discovery.answers["dietary"] == "no peanuts"
    assert "Pending category: dietary" in model.calls[-1]["recipe_context"]
    assert len(model.calls) == 3
    options = [e for e in session.events if e["type"] == "choices"][-1]["options"]
    assert all(c.get("food") for c in options[:3])


async def test_suggest_now_uses_collected_answers_in_same_model_response():
    pipeline, session, model = prepared([[intent("suggest_now", answers={"ingredients": "rice and tofu"}), FunctionCallEvent(name="offer_choices", arguments={"options": ["Fried Rice", "Vegetable Curry", "Tomato Pasta"]}, call_id="foods")]], phase="intake")
    session.state.recipe = None
    await pipeline._respond("Give me some ideas already, using my rice and tofu", from_voice=False)
    assert len(model.calls) == 1
    assert pipeline._discovery.answers["ingredients"] == "rice and tofu"
    assert not pipeline._discovery.asked
    assert all(c.get("food") for c in [e for e in session.events if e["type"] == "choices"][-1]["options"][:3])


async def test_model_revision_retains_existing_allergies_and_new_constraints():
    pipeline, session, model = prepared([[intent("update_preferences", answers={"dietary": "no soy"}, servings=4), FunctionCallEvent(name="create_plan", arguments={"constraints": "Use coconut aminos"}, call_id="revise")]])
    pipeline._discovery = Discovery(active=True, ready=True, answers={"dietary": "no peanuts"})
    await pipeline._respond("Four portions, please, and avoid soy too", from_voice=False)
    _, servings, constraints = pipeline._services.recipes.generate_calls[-1]
    assert servings == 4 and "no peanuts" in constraints and "no soy" in constraints
    assert len(model.calls) == 1


@pytest.mark.parametrize("arguments", [{"name": "go_to_step", "step_index": 100}, {"name": "start_cooking"}, {"name": "confirm"}, {"name": "parse_recipe", "value": "Ingredients: eggs"}, {"name": "plan_together"}, {"name": "select_dish", "value": "pasta"}])
async def test_model_actions_cannot_replace_or_advance_cooking_recipe(arguments):
    pipeline, session, model = prepared([[FunctionCallEvent(name="conversation_action", arguments=arguments, call_id="bad")]], phase="cooking")
    original = session.state.recipe
    await pipeline._respond("A request", from_voice=False)
    assert session.state.recipe is original and session.state.current_step_index == 0
    assert session.state.phase == "cooking"
    assert not any(e["type"] in ("plan", "recipe", "tool_call") for e in session.events)


async def test_invalid_action_and_model_failure_preserve_recipe():
    pipeline, session, model = prepared([[intent("advance_step", unknown="bypass")]], phase="cooking")
    original = session.state.recipe
    await pipeline._respond("A request", from_voice=False)
    assert session.state.recipe is original and session.state.current_step_index == 0
    assert any("couldn't understand" in e.get("text", "") for e in session.events)
    async def fail(**kwargs):
        raise AppError(ErrorCode.LLM_TIMEOUT, "Unavailable")
        yield
    model.stream_conversation = fail
    await pipeline._respond("let's cook it", from_voice=False)
    assert session.state.recipe is original and session.state.current_step_index == 0
    assert session.events[-1]["type"] == "turn_end"


async def test_explicit_buttons_do_not_invoke_model():
    pipeline, session, model = prepared([])
    await pipeline.start_action(ConversationAction(name="start_cooking"))
    await pipeline._turn_task
    await pipeline.start_action(ConversationAction(name="advance_step"))
    await pipeline._turn_task
    assert session.state.current_step_index == 0
    await pipeline.start_action(ConversationAction(name="decline"))
    await pipeline._turn_task
    assert session.state.current_step_index == 0 and not model.calls


async def test_atomic_food_recommendations_record_final_interview_answer():
    pipeline, session, model = prepared([[FunctionCallEvent(name="offer_choices", arguments={"options": ["Fried Rice", "Omelette", "Tomato Pasta"], "answers": {"dietary": "no peanuts"}}, call_id="foods")]], phase="intake")
    session.state.recipe = None
    pipeline._discovery = Discovery(active=True, pending="dietary", answers={"cravings": "comfort food", "ingredients": "rice and eggs", "time": "20 minutes"}, asked=["dietary"])
    await pipeline._respond("No peanuts; I'm allergic", from_voice=False)
    assert pipeline._discovery.answers["dietary"] == "no peanuts"
    assert len(model.calls) == 1
    assert model.calls[0]["pending_preference"] == "dietary"
    foods = [c for e in session.events if e["type"] == "choices" for c in e["options"] if c.get("food")]
    assert len(foods) == 3
    await pipeline.execute_action(ConversationAction(name="select_dish", value="Fried Rice"))
    await pipeline.execute_action(ConversationAction(name="cook_now"))
    assert "no peanuts" in pipeline._services.recipes.generate_calls[-1][2]


async def test_unrecorded_interview_answer_withholds_food_and_preserves_state():
    pipeline, session, model = prepared([[FunctionCallEvent(name="offer_choices", arguments={"options": ["Fried Rice", "Omelette", "Tomato Pasta"]}, call_id="foods")]], phase="intake")
    session.state.recipe = None
    pipeline._discovery = Discovery(active=True, pending="dietary", answers={"ingredients": "eggs"}, asked=["dietary"])
    await pipeline._respond("No peanuts; I'm allergic", from_voice=False)
    assert pipeline._discovery.pending == "dietary"
    assert session.state.recipe is None
    assert not any(c.get("food") for e in session.events if e["type"] == "choices" for c in e["options"])
    assert any("clarify" in e.get("text", "") for e in session.events)


async def test_partial_recommendation_calls_cannot_skip_interview():
    pipeline, session, model = prepared([[FunctionCallEvent(name="offer_choices", arguments={"options": ["Fried Rice", "Omelette", "Tomato Pasta"], "answers": {"ingredients": "rice and eggs"}}, call_id="foods")]], phase="intake")
    session.state.recipe = None
    await pipeline._respond("Meal request", from_voice=False)
    assert not any(c.get("food") for e in session.events if e["type"] == "choices" for c in e["options"])
    assert pipeline._discovery.asked == ["cravings"]
    assert len(model.calls) == 1


async def test_immediate_suggestion_intent_supplies_dishes_and_preferences_atomically():
    from app.recipe.discovery import gallery_food
    names = ["Fried Rice", "Omelette", "Tomato Pasta"]
    pipeline, session, model = prepared([[intent("suggest_now", options=names, foods=[gallery_food(name) for name in names], answers={"ingredients": "rice and eggs"})]], phase="intake")
    session.state.recipe = None
    await pipeline._respond("Just give me ideas now", from_voice=False)
    foods = [c for e in session.events if e["type"] == "choices" for c in e["options"] if c.get("food")]
    assert len(foods) == 3 and not pipeline._discovery.asked
    assert pipeline._discovery.answers["ingredients"] == "rice and eggs"
    assert len(model.calls) == 1


async def test_model_stale_navigation_source_is_rejected():
    pipeline, session, model = prepared([[FunctionCallEvent(name="advance_step", arguments={"from_step_index": 0}, call_id="stale")]], phase="cooking")
    session.state.current_step_index = 1
    await pipeline._respond("What is next?", from_voice=False)
    assert session.state.current_step_index == 1
    assert pipeline._pending_navigation is None
    assert not any(e["type"] == "tool_call" for e in session.events)
