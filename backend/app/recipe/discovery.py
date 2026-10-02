"""Bounded, session-only discovery interview (architecture §4, §9).

The interview collects preferences, not a Recipe. Gemini ranks dishes using
these answers; all recipe generation still goes through RecipeService.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path


GALLERY = json.loads(Path(__file__).with_name("food-gallery.json").read_text(encoding="utf-8"))


def gallery_food(name: str) -> dict | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
    for food in GALLERY:
        names = [food["name"], *food.get("aliases", [])]
        if normalized in [re.sub(r"[^a-z0-9]+", " ", n.lower()).strip() for n in names]:
            return {k: v for k, v in food.items() if k != "aliases"}
    return None


QUESTIONS = {
    "cravings": ("What kind of food are you in the mood for?", ["Filipino", "Italian", "Something comforting"]),
    "dietary": ("Any dietary needs or allergies I should account for?", ["No restrictions", "Vegetarian", "Dairy-free"]),
    "ingredients": ("What ingredients do you have? You can name them in your own words.", ["Chicken and vegetables", "Rice and eggs", "Pantry staples"]),
    "time": ("How much time do you have to cook?", ["15 minutes", "30 minutes", "About an hour"]),
}


@dataclass
class Discovery:
    active: bool = False
    ready: bool = False
    pending: str | None = None
    answers: dict[str, str] = field(default_factory=dict)
    suggested: list[str] = field(default_factory=list)
    servings: int | None = None
    asked: list[str] = field(default_factory=list)

    def next_question(self) -> tuple[str, list[str]] | None:
        if self.ready or len(self.asked) >= 4:
            self.ready = True
            return None
        for key, (question, options) in QUESTIONS.items():
            if key not in self.answers and key not in self.asked:
                self.pending = key
                self.asked.append(key)
                # Keep each question to four choices; restrictions need explicit
                # acknowledgement, whereas preferences may be skipped (§9).
                extras = ["Suggest now"] if key == "dietary" else ["No preference", "Suggest now"]
                return question, [*options[:4-len(extras)], *extras]
        self.ready = True
        return None

    def constraints(self) -> str:
        return "; ".join(f"{key}: {value}" for key, value in self.answers.items())

    def context(self) -> str:
        return (
            "Discovery answers (reuse these, never ask answered questions): " + self.constraints()
            + f". Servings: {self.servings or 'unknown'}"
            + f". Pending category: {self.pending or 'none'}. Asked {len(self.asked)} of at most four questions. Ready for suggestions: {self.ready}. "
            + "When ready, suggest exactly three suitable dishes with full food previews using offer_choices. Otherwise update semantically understood preferences and let the server ask the next missing category. "
            "Explain fit, honour restrictions, and do not claim live trending rankings. "
            "If restrictions make a dish unsuitable, exclude it. If essential allergy details are unclear, "
            "ask one clarification with choices before proposing dishes. "
            "Previously offered dishes: " + ", ".join(self.suggested[-12:])
        )
