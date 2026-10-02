"""Opt-in live Gemini smoke check using test Recipe/TTS, never a classifier call.
Run from backend: python -m tests.manual_intent_check
Requires configured GEMINI_API_KEY. Not collected by the offline test suite.
"""
import asyncio
from app.config import Settings
from app.llm.gemini import GeminiClient
from app.ratelimit import DailyGeminiCounter
from tests.test_contextual_intent import prepared
from app.schemas import ConversationAction


async def main():
    pipeline, session, _ = prepared([])
    pipeline._services.gemini = GeminiClient(Settings(), DailyGeminiCounter(cap=20))
    for text, phase in [("it's cool", "planning"), ("let's cook it", "cooking"), ("start cooking", "cooking"), ("I'm not ready to move on yet", "cooking")]:
        session.events.clear()
        await pipeline._respond(text, from_voice=False)
        print({"request": text, "phase": session.state.phase, "step": session.state.current_step_index + 1,
               "errors": [e["code"] for e in session.events if e["type"] == "error"],
               "reply": "".join(e["text"] for e in session.events if e["type"] == "assistant_text")})
        assert not any(e["type"] == "error" for e in session.events)
        assert session.state.phase == phase and session.state.current_step_index == 0
        assert pipeline._pending_navigation is None

    pipeline, session, _ = prepared([], phase="intake")
    session.state.recipe = None
    pipeline._services.gemini = GeminiClient(Settings(), DailyGeminiCounter(cap=20))
    for text in ["I don't know what to cook. I can only spare twenty minutes, and have eggs and leftover rice in the fridge.", "Something savoury and filling", "No peanuts; I'm allergic"]:
        session.events.clear()
        await pipeline._respond(text, from_voice=False)
        print({"request": text, "asked": pipeline._discovery.asked, "answers": pipeline._discovery.answers,
               "errors": [e["code"] for e in session.events if e["type"] == "error"],
               "reply": "".join(e["text"] for e in session.events if e["type"] == "assistant_text"),
               "options": [c["label"] for e in session.events if e["type"] == "choices" for c in e["options"]]})
        assert not any(e["type"] == "error" for e in session.events)
    assert 1 <= len(pipeline._discovery.asked) <= 4
    assert "peanut" in pipeline._discovery.answers["dietary"].lower()
    food_choices = [c for e in session.events if e["type"] == "choices" for c in e["options"] if c.get("food")]
    assert len(food_choices) == 3
    await pipeline._respond("Just give me some other meal ideas now", from_voice=False)
    assert pipeline._discovery.answers["dietary"]
    await pipeline.execute_action(ConversationAction(name="select_dish", value=food_choices[0]["food"]["name"]))
    await pipeline.execute_action(ConversationAction(name="cook_now"))
    assert "peanut" in pipeline._services.recipes.generate_calls[-1][2].lower()


if __name__ == "__main__":
    asyncio.run(main())
