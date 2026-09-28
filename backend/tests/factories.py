"""Deterministic object factories for the backend contract tests."""

from __future__ import annotations

from app.schemas import (
    Ingredient,
    IngredientDraft,
    Recipe,
    RecipeDraft,
    Step,
    StepDraft,
)


def make_ingredient(
    id: str = "ing_1",
    *,
    name: str = "Soy sauce",
    quantity: float | None = 2.0,
    unit: str | None = "tbsp",
    display: str | None = None,
) -> Ingredient:
    return Ingredient(
        id=id,
        name=name,
        quantity=quantity,
        unit=unit,
        display=display if display is not None else f"{quantity} {unit} {name}",
        notes=None,
        substitutions=[],
    )


def make_step(
    index: int,
    *,
    instruction: str = "Do the thing.",
    refs: tuple[str, ...] = (),
    duration: float | None = 60.0,
    tip: str | None = None,
) -> Step:
    return Step(
        index=index,
        instruction=instruction,
        duration_seconds=duration,
        ingredient_refs=list(refs),
        tip=tip,
    )


def make_recipe(
    *,
    id: str = "recipe-1",
    title: str = "Chicken Adobo",
    ingredients: list[Ingredient] | None = None,
    steps: list[Step] | None = None,
    source: str = "generated",
) -> Recipe:
    if ingredients is None:
        ingredients = [make_ingredient()]
    if steps is None:
        steps = [make_step(0, refs=("ing_1",))]
    return Recipe(
        id=id,
        title=title,
        servings=2,
        prep_time_seconds=300.0,
        cook_time_seconds=1800.0,
        total_time_seconds=2100.0,
        ingredients=ingredients,
        steps=steps,
        source=source,  # type: ignore[arg-type]
        created_at="2026-01-01T00:00:00+00:00",
    )


def make_ingredient_draft(
    id: str = "ing_1",
    *,
    name: str = "Soy sauce",
    quantity: float | None = 2.0,
    unit: str | None = "tbsp",
    display: str | None = None,
) -> IngredientDraft:
    return IngredientDraft(
        id=id,
        name=name,
        quantity=quantity,
        unit=unit,
        display=display if display is not None else f"{quantity} {unit} {name}",
        notes=None,
    )


def make_step_draft(
    index: int,
    *,
    instruction: str = "Do the thing.",
    refs: tuple[str, ...] = (),
    duration: float | None = 60.0,
    tip: str | None = None,
) -> StepDraft:
    return StepDraft(
        index=index,
        instruction=instruction,
        duration_seconds=duration,
        ingredient_refs=list(refs),
        tip=tip,
    )


def make_draft(
    *,
    title: str = "Chicken Adobo",
    ingredients: list[IngredientDraft] | None = None,
    steps: list[StepDraft] | None = None,
) -> RecipeDraft:
    if ingredients is None:
        ingredients = [make_ingredient_draft()]
    if steps is None:
        steps = [make_step_draft(0, refs=("ing_1",))]
    return RecipeDraft(
        title=title,
        servings=2,
        prep_time_seconds=300.0,
        cook_time_seconds=1800.0,
        total_time_seconds=2100.0,
        ingredients=ingredients,
        steps=steps,
    )


__all__ = [
    "make_draft",
    "make_ingredient",
    "make_ingredient_draft",
    "make_recipe",
    "make_step",
    "make_step_draft",
]
