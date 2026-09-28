"""Recipe service contract (architecture §6, §8; EH-2).

The Gemini client is fully mocked, so these tests never touch the network.
They prove: draft -> canonical ``Recipe`` normalization, source tagging, and
strict validation failure with ``recipe_invalid``.
"""

from __future__ import annotations

import uuid

import pytest

from app.errors import AppError, ErrorCode
from app.recipe.service import (
    RecipeService,
    classify_intake,
    finalize_draft,
    validate_recipe,
)
from app.schemas import RecipeDraft
from tests.factories import (
    make_draft,
    make_ingredient_draft,
    make_step_draft,
)


class FakeGeminiClient:
    """Deterministic stand-in for :class:`app.llm.gemini.GeminiClient`."""

    def __init__(self, draft: RecipeDraft | None = None, error: AppError | None = None) -> None:
        self.draft = draft
        self.error = error
        self.calls: list[tuple] = []

    async def generate_recipe(self, dish, servings=None, constraints=None):
        self.calls.append(("generate_recipe", dish, servings, constraints))
        if self.error is not None:
            raise self.error
        assert self.draft is not None
        return self.draft

    async def parse_recipe(self, text):
        self.calls.append(("parse_recipe", text))
        if self.error is not None:
            raise self.error
        assert self.draft is not None
        return self.draft


def _assert_recipe_invalid(exc_info: pytest.ExceptionInfo[AppError]) -> None:
    assert exc_info.value.code is ErrorCode.RECIPE_INVALID


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------


async def test_generate_recipe_happy_path():
    draft = make_draft(
        ingredients=[
            make_ingredient_draft("ing_1"),
            make_ingredient_draft("ing_2", name="Vinegar"),
        ],
        steps=[
            make_step_draft(0, instruction="Marinate.", refs=("ing_1", "ing_2")),
            make_step_draft(1, instruction="Simmer.", refs=("ing_2",)),
        ],
    )
    client = FakeGeminiClient(draft=draft)
    service = RecipeService(client)

    recipe = await service.generate_recipe("chicken adobo", servings=2, constraints="nut-free")

    assert client.calls == [("generate_recipe", "chicken adobo", 2, "nut-free")]
    assert recipe.source == "generated"
    assert recipe.title == "Chicken Adobo"
    assert [s.index for s in recipe.steps] == [0, 1]
    assert recipe.steps[0].ingredient_refs == [recipe.ingredients[0].id, recipe.ingredients[1].id]
    # The recipe id is a real UUID; ingredient ids are assigned by the server.
    uuid.UUID(recipe.id)
    for ingredient in recipe.ingredients:
        uuid.UUID(ingredient.id)
    assert recipe.created_at


async def test_parse_recipe_happy_path_tags_user_text():
    draft = make_draft(steps=[make_step_draft(0, instruction="Mix everything.")])
    client = FakeGeminiClient(draft=draft)
    service = RecipeService(client)

    recipe = await service.parse_recipe("Mix flour and water. Bake.")

    assert client.calls == [("parse_recipe", "Mix flour and water. Bake.")]
    assert recipe.source == "user_text"


async def test_intake_recipe_routes_short_phrase_to_generate():
    draft = make_draft()
    client = FakeGeminiClient(draft=draft)
    service = RecipeService(client)

    await service.intake_recipe("chicken adobo")

    assert client.calls[0][0] == "generate_recipe"


async def test_intake_recipe_routes_multiline_text_to_parse():
    draft = make_draft()
    client = FakeGeminiClient(draft=draft)
    service = RecipeService(client)

    await service.intake_recipe("Ingredients:\n2 eggs\n1 cup flour\nMix and bake.")

    assert client.calls[0][0] == "parse_recipe"


# ---------------------------------------------------------------------------
# Validation failures surface recipe_invalid
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "draft",
    [
        make_draft(steps=[make_step_draft(0), make_step_draft(2)]),  # gap
        make_draft(steps=[make_step_draft(0, instruction="   ")]),  # empty instruction
        make_draft(steps=[make_step_draft(0, refs=("ghost",))]),  # unknown ref
        make_draft(steps=[make_step_draft(0, duration=-30)]),  # negative duration
        make_draft(steps=[]),  # no steps
        make_draft(title="   "),  # empty title
        make_draft(
            ingredients=[make_ingredient_draft("dup"), make_ingredient_draft("dup")],
            steps=[],
        ),  # duplicate slug
    ],
)
async def test_generate_recipe_validation_failure(draft):
    service = RecipeService(FakeGeminiClient(draft=draft))
    with pytest.raises(AppError) as exc:
        await service.generate_recipe("chicken adobo")
    _assert_recipe_invalid(exc)


async def test_parse_recipe_validation_failure():
    draft = make_draft(steps=[make_step_draft(0), make_step_draft(2)])
    service = RecipeService(FakeGeminiClient(draft=draft))
    with pytest.raises(AppError) as exc:
        await service.parse_recipe("some text")
    _assert_recipe_invalid(exc)


async def test_empty_dish_rejected_without_calling_gemini():
    client = FakeGeminiClient(draft=make_draft())
    service = RecipeService(client)
    with pytest.raises(AppError) as exc:
        await service.generate_recipe("   ")
    _assert_recipe_invalid(exc)
    assert client.calls == []


async def test_empty_recipe_text_rejected_without_calling_gemini():
    client = FakeGeminiClient(draft=make_draft())
    service = RecipeService(client)
    with pytest.raises(AppError) as exc:
        await service.parse_recipe("   ")
    _assert_recipe_invalid(exc)
    assert client.calls == []


async def test_gemini_error_propagates_unwrapped():
    boom = AppError(ErrorCode.LLM_TIMEOUT, "Gemini timed out.")
    service = RecipeService(FakeGeminiClient(error=boom))
    with pytest.raises(AppError) as exc:
        await service.generate_recipe("chicken adobo")
    assert exc.value is boom


# ---------------------------------------------------------------------------
# classify_intake heuristic (README "Resolved ambiguities" #1)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, expected",
    [
        ("chicken adobo", "generated"),
        ("pasta carbonara", "generated"),
        ("Ingredients:\n2 eggs", "user_text"),
        ("add 2 tbsp butter to the pan and stir", "user_text"),
        (" ".join(["word"] * 20), "user_text"),
    ],
)
def test_classify_intake(text, expected):
    assert classify_intake(text) == expected


# ---------------------------------------------------------------------------
# finalize_draft direct coverage
# ---------------------------------------------------------------------------


def test_finalize_draft_returns_validated_recipe():
    draft = make_draft(steps=[make_step_draft(0)])
    recipe = finalize_draft(draft, "user_text")
    assert validate_recipe(recipe) is recipe
    assert recipe.source == "user_text"
