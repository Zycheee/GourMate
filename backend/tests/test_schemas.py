"""Recipe validation contract (architecture §6).

The architecture states: "enforce contiguous step indices, non-empty
instruction, ``duration_seconds >= 0``, and that every ``ingredient_refs`` id
exists. Invalid Gemini output -> ``recipe_invalid`` error (EH-2)."

These tests exercise :func:`app.recipe.service.validate_recipe` and
:func:`app.recipe.service.finalize_draft` (the path Gemini output takes).
"""

from __future__ import annotations

import typing

import pytest

from app.errors import AppError, ErrorCode
from app.recipe.service import finalize_draft, validate_recipe
from app.schemas import SessionPhase, Step
from tests.factories import (
    make_draft,
    make_ingredient,
    make_ingredient_draft,
    make_recipe,
    make_step,
    make_step_draft,
)


def _assert_recipe_invalid(exc_info: pytest.ExceptionInfo[AppError]) -> None:
    assert exc_info.value.code is ErrorCode.RECIPE_INVALID
    assert exc_info.value.status_code == 400
    assert exc_info.value.recoverable is True


# ---------------------------------------------------------------------------
# Session phases (architecture §6)
# ---------------------------------------------------------------------------


def test_session_phase_includes_planning():
    assert set(typing.get_args(SessionPhase)) == {
        "intake",
        "planning",
        "cooking",
        "done",
    }


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_valid_recipe_round_trips_unchanged(recipe):
    assert validate_recipe(recipe) is recipe


def test_valid_recipe_with_ingredient_refs_passes():
    recipe = make_recipe(
        ingredients=[make_ingredient("ing_1"), make_ingredient("ing_2", name="Garlic")],
        steps=[
            make_step(0, refs=("ing_1", "ing_2")),
            make_step(1, refs=("ing_2",), duration=None),
        ],
    )
    assert validate_recipe(recipe) is recipe


# ---------------------------------------------------------------------------
# Contiguous step indices
# ---------------------------------------------------------------------------


def test_non_contiguous_step_indices_rejected():
    recipe = make_recipe(steps=[make_step(0), make_step(2)])
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)
    assert "contiguous" in exc.value.message.lower() or "expected" in exc.value.message.lower()


def test_steps_must_start_at_zero():
    recipe = make_recipe(steps=[make_step(1)])
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


def test_duplicate_step_indices_rejected():
    recipe = make_recipe(
        ingredients=[make_ingredient()],
        steps=[Step(index=0, instruction="A", duration_seconds=1, ingredient_refs=[], tip=None),
               Step(index=0, instruction="B", duration_seconds=1, ingredient_refs=[], tip=None)],
    )
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


# ---------------------------------------------------------------------------
# Non-empty instruction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("instruction", ["", "   ", "\n\t "])
def test_empty_instruction_rejected(instruction):
    recipe = make_recipe(steps=[make_step(0, instruction=instruction)])
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


def test_empty_title_rejected():
    recipe = make_recipe(title="   ")
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


def test_recipe_without_steps_rejected():
    recipe = make_recipe(steps=[])
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


# ---------------------------------------------------------------------------
# Non-negative durations and quantities
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("duration", [-0.001, -1.0, -600.0])
def test_negative_step_duration_rejected(duration):
    recipe = make_recipe(steps=[make_step(0, duration=duration)])
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


def test_zero_step_duration_is_allowed():
    recipe = make_recipe(steps=[make_step(0, duration=0.0)])
    assert validate_recipe(recipe) is recipe


def test_null_step_duration_is_allowed():
    recipe = make_recipe(steps=[make_step(0, duration=None)])
    assert validate_recipe(recipe) is recipe


def test_negative_ingredient_quantity_rejected():
    recipe = make_recipe(
        ingredients=[make_ingredient(quantity=-1.0)],
        steps=[make_step(0, refs=("ing_1",))],
    )
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


def test_empty_ingredient_name_rejected():
    recipe = make_recipe(ingredients=[make_ingredient(name="   ")], steps=[make_step(0)])
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


# ---------------------------------------------------------------------------
# Ingredient references
# ---------------------------------------------------------------------------


def test_unknown_ingredient_ref_rejected():
    recipe = make_recipe(
        ingredients=[make_ingredient("ing_1")],
        steps=[make_step(0, refs=("ghost",))],
    )
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


def test_duplicate_ingredient_ids_rejected():
    recipe = make_recipe(
        ingredients=[make_ingredient("dup"), make_ingredient("dup", name="Other")],
        steps=[make_step(0)],
    )
    with pytest.raises(AppError) as exc:
        validate_recipe(recipe)
    _assert_recipe_invalid(exc)


# ---------------------------------------------------------------------------
# finalize_draft: Gemini draft -> canonical Recipe
# ---------------------------------------------------------------------------


def test_finalize_draft_assigns_ids_and_remaps_refs():
    draft = make_draft(
        ingredients=[
            make_ingredient_draft("ing_1"),
            make_ingredient_draft("ing_2", name="Vinegar"),
        ],
        steps=[
            make_step_draft(0, refs=("ing_1", "ing_2")),
            make_step_draft(1, refs=("ing_2",)),
        ],
    )
    recipe = finalize_draft(draft, "generated")

    assert recipe.source == "generated"
    assert recipe.id and recipe.id != ""
    assert len(recipe.ingredients) == 2
    # Fresh UUIDs replace the temporary slugs.
    ids = {i.id for i in recipe.ingredients}
    assert "ing_1" not in ids and "ing_2" not in ids
    # Step refs are remapped to the assigned ingredient ids.
    assert recipe.steps[0].ingredient_refs == [recipe.ingredients[0].id, recipe.ingredients[1].id]
    assert recipe.steps[1].ingredient_refs == [recipe.ingredients[1].id]
    assert recipe.created_at


def test_finalize_draft_unknown_ref_rejected():
    draft = make_draft(steps=[make_step_draft(0, refs=("nope",))])
    with pytest.raises(AppError) as exc:
        finalize_draft(draft, "generated")
    _assert_recipe_invalid(exc)


def test_finalize_draft_duplicate_ingredient_slug_rejected():
    draft = make_draft(
        ingredients=[make_ingredient_draft("same"), make_ingredient_draft("same", name="Other")],
        steps=[],
    )
    with pytest.raises(AppError) as exc:
        finalize_draft(draft, "user_text")
    _assert_recipe_invalid(exc)


def test_finalize_draft_empty_slug_rejected():
    draft = make_draft(
        ingredients=[make_ingredient_draft("   ")],
        steps=[],
    )
    with pytest.raises(AppError) as exc:
        finalize_draft(draft, "generated")
    _assert_recipe_invalid(exc)
