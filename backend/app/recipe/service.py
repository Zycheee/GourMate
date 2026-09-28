"""Recipe pipeline: generate, parse and validate into a canonical ``Recipe``.

This module is the only place that turns model output into the server's
``Recipe`` schema. Validation is strict (architecture section 6): invalid Gemini
output raises ``recipe_invalid`` (EH-2) rather than being silently repaired.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from ..config import Settings, get_settings
from ..errors import AppError, ErrorCode
from ..llm.gemini import GeminiClient
from ..ratelimit import DailyGeminiCounter
from ..schemas import (
    Ingredient,
    IngredientDraft,
    Recipe,
    RecipeDraft,
    RecipeSource,
    Step,
    StepDraft,
)

logger = logging.getLogger(__name__)

# Markers that suggest the user dictated/pasted a full recipe rather than naming a dish.
_PARSE_MARKERS = (
    "ingredient",
    "ingredients",
    "tablespoon",
    "teaspoon",
    "tbsp",
    "tsp",
    "cup",
    "grams",
    "ounces",
    "recipe",
    "instructions",
    "method",
)
_INTAKE_WORD_THRESHOLD = 20


def classify_intake(text: str) -> RecipeSource:
    """Heuristically decide whether intake text is a dish name or a full recipe.

    Architecture section 7 sends a single ``text_input`` payload with no mode
    flag, so the server decides: long/marked-up text is treated as a dictated
    recipe (``user_text``) and a short phrase as a dish to generate
    (``generated``). See README "Resolved ambiguities".
    """
    stripped = text.strip()
    if "\n" in stripped:
        return "user_text"
    words = stripped.split()
    lowered = stripped.lower()
    if len(words) >= _INTAKE_WORD_THRESHOLD:
        return "user_text"
    if any(marker in lowered for marker in _PARSE_MARKERS) and len(words) >= 8:
        return "user_text"
    return "generated"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _finalize_ingredients(
    drafts: list[IngredientDraft],
) -> tuple[list[Ingredient], dict[str, str]]:
    """Assign UUIDs to ingredients and return the draft-id -> uuid map."""
    id_map: dict[str, str] = {}
    ingredients: list[Ingredient] = []
    for draft in drafts:
        draft_id = draft.id.strip()
        if not draft_id:
            raise AppError(ErrorCode.RECIPE_INVALID, "Ingredient is missing an id.")
        if draft_id in id_map:
            raise AppError(
                ErrorCode.RECIPE_INVALID,
                f"Duplicate ingredient id '{draft_id}'.",
            )
        new_id = str(uuid.uuid4())
        id_map[draft_id] = new_id
        ingredients.append(
            Ingredient(
                id=new_id,
                name=draft.name.strip(),
                quantity=draft.quantity,
                unit=draft.unit,
                display=draft.display.strip() or draft.name.strip(),
                notes=draft.notes,
                substitutions=[],
            )
        )
    return ingredients, id_map


def _finalize_steps(drafts: list[StepDraft], id_map: dict[str, str]) -> list[Step]:
    """Map step ingredient refs to real ids and preserve ordering."""
    steps: list[Step] = []
    for draft in drafts:
        refs: list[str] = []
        for ref in draft.ingredient_refs:
            mapped = id_map.get(ref.strip())
            if mapped is None:
                raise AppError(
                    ErrorCode.RECIPE_INVALID,
                    f"Step {draft.index} references unknown ingredient '{ref}'.",
                )
            refs.append(mapped)
        steps.append(
            Step(
                index=draft.index,
                instruction=draft.instruction,
                duration_seconds=draft.duration_seconds,
                ingredient_refs=refs,
                tip=draft.tip,
            )
        )
    return steps


def finalize_draft(draft: RecipeDraft, source: RecipeSource) -> Recipe:
    """Convert a validated-adjacent model draft into a canonical ``Recipe``.

    Assigns fresh UUIDs for the recipe and ingredients, remaps step ingredient
    references, then validates the result.
    """
    ingredients, id_map = _finalize_ingredients(draft.ingredients)
    steps = _finalize_steps(draft.steps, id_map)
    recipe = Recipe(
        id=str(uuid.uuid4()),
        title=draft.title.strip(),
        servings=draft.servings,
        prep_time_seconds=draft.prep_time_seconds,
        cook_time_seconds=draft.cook_time_seconds,
        total_time_seconds=draft.total_time_seconds,
        ingredients=ingredients,
        steps=steps,
        source=source,
        created_at=_now_iso(),
    )
    return validate_recipe(recipe)


def validate_recipe(recipe: Recipe) -> Recipe:
    """Strictly validate a recipe per architecture section 6.

    Raises ``recipe_invalid`` on any violation.
    """
    if not recipe.title.strip():
        raise AppError(ErrorCode.RECIPE_INVALID, "Recipe title is empty.")
    if not recipe.steps:
        raise AppError(ErrorCode.RECIPE_INVALID, "Recipe has no steps.")

    ingredient_ids = {ingredient.id for ingredient in recipe.ingredients}
    if len(ingredient_ids) != len(recipe.ingredients):
        raise AppError(ErrorCode.RECIPE_INVALID, "Recipe has duplicate ingredient ids.")

    for expected, step in enumerate(recipe.steps):
        if step.index != expected:
            raise AppError(
                ErrorCode.RECIPE_INVALID,
                f"Step indices must be contiguous from 0; expected {expected}, got {step.index}.",
            )
        if not step.instruction.strip():
            raise AppError(ErrorCode.RECIPE_INVALID, f"Step {step.index} has an empty instruction.")
        if step.duration_seconds is not None and step.duration_seconds < 0:
            raise AppError(
                ErrorCode.RECIPE_INVALID,
                f"Step {step.index} has a negative duration.",
            )
        for ref in step.ingredient_refs:
            if ref not in ingredient_ids:
                raise AppError(
                    ErrorCode.RECIPE_INVALID,
                    f"Step {step.index} references unknown ingredient id '{ref}'.",
                )

    for ingredient in recipe.ingredients:
        if not ingredient.name.strip():
            raise AppError(ErrorCode.RECIPE_INVALID, "Ingredient has an empty name.")
        if ingredient.quantity is not None and ingredient.quantity < 0:
            raise AppError(
                ErrorCode.RECIPE_INVALID,
                f"Ingredient '{ingredient.name}' has a negative quantity.",
            )

    return recipe


class RecipeService:
    """Generate/parse recipes using a shared :class:`GeminiClient`."""

    def __init__(self, client: GeminiClient) -> None:
        self._client = client

    async def generate_recipe(
        self,
        dish: str,
        servings: int | None = None,
        constraints: str | None = None,
    ) -> Recipe:
        """Generate a recipe for a dish name, then validate it."""
        cleaned = dish.strip()
        if not cleaned:
            raise AppError(ErrorCode.RECIPE_INVALID, "Dish name is empty.")
        draft = await self._client.generate_recipe(cleaned, servings, constraints)
        return finalize_draft(draft, "generated")

    async def parse_recipe(self, text: str) -> Recipe:
        """Parse user recipe text, then validate it."""
        cleaned = text.strip()
        if not cleaned:
            raise AppError(ErrorCode.RECIPE_INVALID, "Recipe text is empty.")
        draft = await self._client.parse_recipe(cleaned)
        return finalize_draft(draft, "user_text")

    async def intake_recipe(self, text: str) -> Recipe:
        """Route WS intake text to generate or parse based on ``classify_intake``."""
        if classify_intake(text) == "user_text":
            return await self.parse_recipe(text)
        return await self.generate_recipe(text)


# ---------------------------------------------------------------------------
# Module-level convenience wrappers (contract-named entry points)
# ---------------------------------------------------------------------------

_default_service: RecipeService | None = None


def _default_client() -> GeminiClient:
    settings: Settings = get_settings()
    return GeminiClient.get_instance(settings, DailyGeminiCounter(cap=settings.gemini_daily_cap))


def _get_default_service() -> RecipeService:
    global _default_service
    if _default_service is None:
        _default_service = RecipeService(_default_client())
    return _default_service


async def generate_recipe(
    dish: str,
    servings: int | None = None,
    constraints: str | None = None,
) -> Recipe:
    """Generate and validate a recipe via the process-global service."""
    return await _get_default_service().generate_recipe(dish, servings, constraints)


async def parse_recipe(text: str) -> Recipe:
    """Parse and validate recipe text via the process-global service."""
    return await _get_default_service().parse_recipe(text)


__all__ = [
    "RecipeService",
    "classify_intake",
    "finalize_draft",
    "generate_recipe",
    "parse_recipe",
    "validate_recipe",
]
