"""Discovery and confirmation journeys with offline voice/text services (§4/§7)."""
import json
import asyncio
from pathlib import Path

import pytest
import numpy as np

from app.llm.gemini import FunctionCallEvent, TextDelta
from app.recipe.discovery import Discovery, GALLERY, gallery_food
from app.schemas import ConversationAction, ChoiceOption, FoodPreview
from app.ws import protocol
from tests.test_planning import _FakeRecipes, _FakeSession, _ScriptedGemini, _pipeline, _plan_recipe
from tests.factories import make_recipe, make_step


def setup_cooking(script=()):
    recipe = make_recipe(steps=[make_step(i) for i in range(3)])
    session = _FakeSession()
    session.state.recipe = recipe
    session.state.phase = "cooking"
    gemini = _ScriptedGemini(list(script))
    pipeline = _pipeline(session, gemini=gemini, recipes=_FakeRecipes(recipe))
    return pipeline, session, gemini


@pytest.mark.parametrize("utterance,target", [("next step", 1), ("previous step", 0), ("go to step 3", 2)])
async def test_transition_waits_for_explicit_confirmation(utterance, target):
    pipeline, session, gemini = setup_cooking()
    session.state.current_step_index = 1 if utterance == "previous step" else 0
    before = session.state.current_step_index
    await pipeline.execute_action(ConversationAction(name="go_to_step", step_index=target))
    assert session.state.current_step_index == before
    assert not any(e["type"] == "tool_call" for e in session.events)
    choices = next(e for e in session.events if e["type"] == "choices")
    assert [c["label"] for c in choices["options"]] == ["Continue", "Stay here"]
    await pipeline.execute_action(ConversationAction(name="confirm"))
    assert session.state.current_step_index == target
    assert len([e for e in session.events if e["type"] == "tool_call"]) == 1
    assert gemini.calls == []
    assert pipeline._pending_navigation is None


@pytest.mark.parametrize("utterance,target", [("skip this step", 1), ("skip to step 3", 2)])
async def test_explicit_skip_bypasses_only_this_confirmation(utterance, target):
    pipeline, session, gemini = setup_cooking()
    await pipeline.execute_action(ConversationAction(name="skip_to_step", step_index=target))
    assert session.state.current_step_index == target
    assert pipeline._pending_navigation is None
    assert gemini.calls == []
    await pipeline.execute_action(ConversationAction(name="go_to_step", step_index=session.state.current_step_index-1))
    assert session.state.current_step_index == target
    assert pipeline._pending_navigation is not None


@pytest.mark.parametrize("utterance", ["repeat", "go to step 1"])
async def test_same_step_requires_no_confirmation(utterance):
    pipeline, session, _ = setup_cooking()
    await pipeline.execute_action(ConversationAction(name="go_to_step", step_index=0))
    assert pipeline._pending_navigation is None
    assert any(e["type"] == "tool_call" for e in session.events)


async def test_declining_and_unrelated_input_clear_pending_actions():
    pipeline, session, gemini = setup_cooking([TextDelta("Turn the heat down.")])
    await pipeline.execute_action(ConversationAction(name="advance_step"))
    await pipeline.execute_action(ConversationAction(name="decline"))
    assert session.state.current_step_index == 0
    assert pipeline._pending_navigation is None
    await pipeline.execute_action(ConversationAction(name="advance_step"))
    await pipeline._respond("The pan is smoking", from_voice=True)
    assert pipeline._pending_navigation is None
    assert session.state.current_step_index == 0
    assert len(gemini.calls) == 1
    assert session.events[-1]["type"] == "turn_end"


async def test_model_tool_cannot_bypass_confirmation_or_use_stale_index():
    script = [FunctionCallEvent(name="advance_step", arguments={"from_step_index": 1}, call_id="llm_nav")]
    pipeline, session, gemini = setup_cooking(script)
    session.state.current_step_index = 1
    await pipeline._respond("I have finished chopping; what do I do after this?", from_voice=False)
    assert session.state.current_step_index == 1
    assert not any(e["type"] == "tool_call" for e in session.events)
    await pipeline.execute_action(ConversationAction(name="confirm"))
    assert session.state.current_step_index == 2
    assert len(gemini.calls) == 1


@pytest.mark.parametrize("index", [0, 2])
async def test_finish_requires_confirmation_at_any_step(index):
    pipeline, session, gemini = setup_cooking()
    session.state.current_step_index = index
    await pipeline.execute_action(ConversationAction(name="finish"))
    assert session.state.phase == "cooking"
    if index == 0:
        assert any("not at the last step" in e.get("text", "") for e in session.events)
    await pipeline.execute_action(ConversationAction(name="decline"))
    assert session.state.phase == "cooking"
    await pipeline.execute_action(ConversationAction(name="finish"))
    await pipeline.execute_action(ConversationAction(name="confirm"))
    assert session.state.phase == "done"
    assert session.state.current_step_index == index
    assert gemini.calls == []


async def test_skipping_last_step_completes_without_confirmation():
    pipeline, session, gemini = setup_cooking()
    session.state.current_step_index = 2
    await pipeline.execute_action(ConversationAction(name="skip_to_step", step_index=session.state.current_step_index+1))
    assert session.state.phase == "done"
    assert gemini.calls == []


async def test_reset_replacement_and_disconnect_invalidate_pending_actions():
    pipeline, session, _ = setup_cooking()
    await pipeline.execute_action(ConversationAction(name="advance_step"))
    pipeline.clear_pending_actions()  # disconnect/sync hook
    assert pipeline._pending_navigation is None
    await pipeline.execute_action(ConversationAction(name="advance_step"))
    await pipeline._present_plan(_plan_recipe())
    assert pipeline._pending_navigation is None
    pipeline._discovery = Discovery(active=True, answers={"dietary": "vegetarian"})
    await pipeline._reset_session()
    assert pipeline._discovery.answers == {}
    assert not pipeline._discovery.active
    assert session.state.recipe is None


async def test_disconnect_cancels_work_before_clearing_pending_state():
    pipeline, session, _ = setup_cooking()
    await pipeline.execute_action(ConversationAction(name="advance_step"))
    pipeline._turn_task = asyncio.create_task(asyncio.sleep(60))
    await pipeline.shutdown()
    assert pipeline._turn_task.cancelled()
    assert pipeline._pending_navigation is None
    assert pipeline._discovery.answers == {}


def test_interview_skips_known_information_and_accepts_free_form():
    discovery = Discovery(active=True, answers={"cravings": "Italian", "dietary": "vegetarian", "ingredients": "tomatoes", "time": "30 minutes"}, servings=2)
    assert discovery.next_question() is None
    assert discovery.servings == 2
    discovery = Discovery(active=True)
    for answer in ["Something crunchy", "No shellfish", "Tofu and cabbage", "No preference"]:
        assert discovery.next_question() is not None
        discovery.answers[discovery.pending] = answer
        discovery.pending = None
    assert discovery.next_question() is None
    assert len(discovery.asked) == 4
    assert discovery.answers["dietary"] == "No shellfish"


async def test_complete_discovery_and_selection_carry_constraints_into_direct_cook():
    script = [FunctionCallEvent(name="offer_choices", arguments={"options": ["Chicken Adobo", "Tinola", "Chicken Stir-Fry"]}, call_id="foods")]
    session = _FakeSession()
    recipes = _FakeRecipes(_plan_recipe())
    gemini = _ScriptedGemini(script)
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    await pipeline.execute_action(ConversationAction(name="discover"))
    for key, answer in zip(["cravings", "dietary", "ingredients", "time"], ["Filipino", "Dairy-free", "I have chicken and vegetables", "30 minutes for 2 people"]):
        await pipeline.execute_action(ConversationAction(name="update_preferences", answers={key: answer}, servings=2 if key == "time" else None))
    assert len(gemini.calls) == 1
    assert len(pipeline._discovery.answers) == 4
    options = [e for e in session.events if e["type"] == "choices"][-1]["options"]
    assert len(options) == 5
    assert all(c.get("food") for c in options[:3])
    await pipeline.execute_action(ConversationAction(name="select_dish", value="Chicken Adobo"))
    assert len(gemini.calls) == 1  # selection needs no inference
    await pipeline.execute_action(ConversationAction(name="cook_now"))
    dish, servings, constraints = recipes.generate_calls[-1]
    assert dish == "Chicken Adobo" and servings == 2
    assert "Dairy-free" in constraints and "30 minutes" in constraints
    assert session.state.phase == "cooking"


async def test_revision_reuses_preferences_and_accepts_new_servings():
    session = _FakeSession()
    recipe = _plan_recipe()
    session.state.recipe = recipe
    session.state.phase = "planning"
    gemini = _ScriptedGemini([FunctionCallEvent(name="create_plan", arguments={"servings": 4, "constraints": "Add more vegetables"}, call_id="revise")])
    recipes = _FakeRecipes(recipe)
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    pipeline._discovery = Discovery(active=True, ready=True, answers={"dietary": "No peanuts", "time": "30 minutes"})
    await pipeline._respond("Make it for 4 people and add vegetables", from_voice=False)
    assert recipes.generate_calls[-1][1] == 4
    constraints = recipes.generate_calls[-1][2]
    assert "No peanuts" in constraints and "Add more vegetables" in constraints
    assert session.state.phase == "planning"


async def test_complete_voice_pipeline_journey_with_offline_stt():
    session = _FakeSession()
    recipes = _FakeRecipes(_plan_recipe())
    from tests.test_planning import _SequencedGemini
    intents = [{"name": "discover"}, *[{"name": "update_preferences", "answers": {key: value}} for key, value in zip(["cravings", "dietary", "ingredients", "time"], ["Filipino", "No peanuts", "chicken", "30 minutes"])], {"name": "select_dish", "value": "Chicken Adobo"}, {"name": "cook_now"}, {"name": "advance_step"}, {"name": "confirm"}, {"name": "finish"}, {"name": "confirm"}]
    scripts = [[FunctionCallEvent(name="conversation_action", arguments=action, call_id=f"intent_{i}")] for i, action in enumerate(intents)]
    scripts[4].append(FunctionCallEvent(name="offer_choices", arguments={"options": ["Chicken Adobo", "Tinola", "Chicken Stir-Fry"]}, call_id="foods"))
    gemini = _SequencedGemini(scripts)
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)

    class ScriptedSTT:
        text = ""

        async def transcribe(self, pcm):
            return self.text

    stt = ScriptedSTT()
    pipeline._services.stt = stt
    pcm = np.full(16000, 16384, dtype=np.int16).tobytes()
    for text in ["What should I cook?", "Filipino", "No peanuts", "I have chicken", "30 minutes", "Chicken Adobo", "Cook it now", "next step", "Continue", "I'm done", "Yes"]:
        stt.text = text
        await pipeline._run_audio_turn(pcm)
    assert session.state.phase == "done"
    assert session.state.current_step_index == 1
    assert "No peanuts" in recipes.generate_calls[-1][2]
    assert len(gemini.calls) == 11
    transcripts = [e for e in session.events if e["type"] == "transcript"]
    assert len(transcripts) == 11 and all(e["final"] for e in transcripts)
    assert not any(e["type"] == "error" for e in session.events)


async def test_suggest_now_other_dishes_and_change_preferences():
    session = _FakeSession()
    gemini = _ScriptedGemini([FunctionCallEvent(name="offer_choices", arguments={"options": ["Omelette", "Tomato Pasta", "Fried Rice"]}, call_id="foods")])
    pipeline = _pipeline(session, gemini=gemini, recipes=_FakeRecipes(_plan_recipe()))
    await pipeline.execute_action(ConversationAction(name="discover", answers={"ingredients": "eggs"}))
    await pipeline.execute_action(ConversationAction(name="suggest_now"))
    assert "ingredients" in pipeline._discovery.answers
    await pipeline.execute_action(ConversationAction(name="suggest_now"))
    assert len(gemini.calls) == 2
    assert "Omelette" in gemini.calls[-1]["recipe_context"]
    await pipeline.execute_action(ConversationAction(name="change_preferences"))
    assert pipeline._discovery.answers == {}
    assert pipeline._discovery.pending == "cravings"


async def test_next_meal_reuses_session_preferences_after_completion():
    pipeline, session, gemini = setup_cooking([FunctionCallEvent(name="offer_choices", arguments={"options": ["Omelette", "Tomato Pasta", "Fried Rice"]}, call_id="new_foods")])
    pipeline._discovery = Discovery(active=True, ready=True, answers={"cravings": "Italian", "dietary": "No peanuts", "ingredients": "Tomatoes", "time": "30 minutes"})
    session.state.phase = "done"
    await pipeline.execute_action(ConversationAction(name="discover"))
    assert session.state.phase == "intake" and session.state.recipe is None
    assert pipeline._discovery.answers["dietary"] == "No peanuts"
    assert len(gemini.calls) == 1
    assert "No peanuts" in gemini.calls[0]["recipe_context"]


async def test_named_dish_keeps_explicit_initial_constraints():
    session = _FakeSession()
    gemini = _ScriptedGemini([FunctionCallEvent(name="conversation_action", arguments={"name": "select_dish", "value": "Chicken Adobo", "servings": 4, "answers": {"dietary": "without peanuts"}}, call_id="named")])
    recipes = _FakeRecipes(_plan_recipe())
    pipeline = _pipeline(session, gemini=gemini, recipes=recipes)
    await pipeline._respond("Chicken adobo for 4 people, without peanuts", from_voice=False)
    await pipeline.execute_action(ConversationAction(name="cook_now"))
    assert recipes.generate_calls[-1][1] == 4
    assert "without peanuts" in recipes.generate_calls[-1][2]


async def test_unknown_food_keeps_metadata_without_using_model_image_urls():
    session = _FakeSession()
    pipeline = _pipeline(session, gemini=_ScriptedGemini([]), recipes=_FakeRecipes(_plan_recipe()))
    food = {"name": "Lentil Stew", "description": "A savoury lentil stew.", "estimated_total_minutes": 35,
            "popularity": "Filling and adaptable.", "difficulty": "Easy", "key_ingredients": ["Lentils"],
            "fit": "Uses your lentils.", "image_url": "https://example.com/untrusted.jpg"}
    await pipeline._emit_choices(["Lentil Stew", "Show other dishes"], [food])
    options = next(e for e in session.events if e["type"] == "choices")["options"]
    assert options[0]["food"]["description"] == food["description"]
    assert "image_url" not in options[0]["food"]


async def test_choices_follow_urgent_advice_and_keep_model_choices():
    script = [TextDelta("Turn off the heat."), FunctionCallEvent(name="offer_choices", arguments={"options": ["Help rescue it", "Repeat this step"], "question": "Would you like help rescuing it?"}, call_id="help")]
    pipeline, session, gemini = setup_cooking(script)
    await pipeline._respond("It's burning!", from_voice=True)
    choice_events = [e for e in session.events if e["type"] == "choices"]
    assert len(choice_events) == 1
    assert choice_events[0]["options"][0]["label"] == "Help rescue it"
    advice_index = next(i for i, e in enumerate(session.events) if e.get("text") == "Turn off the heat.")
    assert advice_index < session.events.index(choice_events[0])
    assert session.tts.synthesized[0] == "Turn off the heat."
    assert len(gemini.calls) == 1


def test_gallery_photos_are_remote_and_attributed():
    root = Path(__file__).resolve().parents[2]
    records = json.loads((root / "frontend/public/food/attributions.json").read_text(encoding="utf-8"))
    assert len(records) == len(GALLERY) == 12
    for food, record in zip(GALLERY, records):
        assert food["image_url"].startswith(("https://upload.wikimedia.org/", "https://thumb.wikimedia.org/"))
        assert food["image_url"] == record["image_url"]
        assert food["image_credit"] == record["author"]
        assert food["image_source"] == record["source"]
        FoodPreview.model_validate(gallery_food(food["name"]))


def test_preview_shape_matches_golden_contract_and_plain_choices_stay_compatible():
    contract = json.loads((Path(__file__).resolve().parents[2] / "contracts/ws-events.json").read_text())
    assert set(ChoiceOption.model_fields) == set(contract["choice_option"]["required"] + contract["choice_option"]["optional"])
    assert set(FoodPreview.model_fields) == set(contract["food_preview"]["required"] + contract["food_preview"]["optional"])
    assert json.loads(protocol.choices([{"id": "yes", "label": "Yes"}]))["options"] == [{"id": "yes", "label": "Yes"}]
    food = gallery_food("Omelette")
    food["estimated_total_minutes"] = None
    assert json.loads(protocol.choices([{"id": "food", "label": "Omelette", "food": food}]))["options"][0]["food"]["estimated_total_minutes"] is None
