"""Offline browser fixture: uvicorn tests.manual_ux_app:app --port 8080.

Never deploy this fixture. It makes no Gemini, model-download or TTS calls;
all scripted answers are for exercising the real UI and WebSocket pipeline.
"""
import re

import app.main as main
from app.llm.gemini import FunctionCallEvent, TextDelta
from app.recipe.discovery import gallery_food
from tests.factories import make_ingredient, make_recipe, make_step
from tests.test_ws import _build_fake_services, FakeGemini, FakeVAD


class PreviewVAD(FakeVAD):
    def feed(self, pcm):
        # Ignore capture frames if a previously opened local client reconnects.
        # This fixture is for text/UI testing, never real speech recognition.
        return []


class PreviewGemini(FakeGemini):
    """Explicit fixture responses, not a production intent classifier."""
    async def stream_conversation(self, **kwargs):
        text = kwargs.get("user_text", "").strip().lower()
        actions = {
            "classic beef stew": {"name": "select_dish", "value": "Classic Beef Stew"},
            "it's cool": {"name": "approve_plan"},
            "let's cook it": {"name": "start_cooking"},
            "start cooking": {"name": "start_cooking"},
            "what should i cook?": {"name": "discover"},
            "i have chicken, no peanuts, and thirty minutes": {"name": "discover", "answers": {"ingredients": "chicken", "dietary": "no peanuts", "time": "thirty minutes"}},
        }
        if text in actions:
            yield FunctionCallEvent(name="conversation_action", arguments=actions[text], call_id="fixture_intent")
        elif text.startswith("suggest three matching dishes"):
            names = ["Chicken Adobo", "Tinola", "Chicken Stir-Fry"]
            foods = [gallery_food(name) for name in names]
            for food in foods:
                food["fit"] = "A comforting chicken dish that suits the ingredients you mentioned."
            yield FunctionCallEvent(name="offer_choices", arguments={"options": names, "foods": foods}, call_id="preview_choices")
        else:
            yield TextDelta("Keep the heat gentle and let me know when you're ready.")


recipe = make_recipe(title="Classic Beef Stew", ingredients=[
    make_ingredient("ing_1", name="Beef chuck", display="2 pounds beef chuck"),
    make_ingredient("ing_2", name="Flour", display="1/4 cup flour"),
    make_ingredient("ing_3", name="Broth", display="4 cups beef broth"),
], steps=[
    make_step(0, instruction="Combine the chicken, soy sauce, vinegar and garlic.", refs=("ing_1", "ing_2", "ing_3")),
    make_step(1, instruction="Simmer gently until the chicken is fully cooked.", refs=("ing_1",), duration=1800),
    make_step(2, instruction="Serve the chicken and sauce with steamed rice.", refs=("ing_1",)),
])
recipe.steps = [make_step(i, instruction=instruction, refs=("ing_1",)) for i, instruction in enumerate(["Toss the beef cubes with flour in a bowl until evenly coated.", "Brown the beef in oil.", "Soften the onion and garlic.", "Add broth and simmer the beef.", "Add the carrots and potatoes.", "Simmer until tender and season.", "Serve the stew warm."])]
recipe.total_time_seconds = 9000
services = _build_fake_services(recipe)
services.vad = PreviewVAD()
services.settings.session_min_turn_gap_s = 0.01
services.gemini = PreviewGemini()
main.build_services = lambda settings: (services, services.limiters)
app = main.create_app()
