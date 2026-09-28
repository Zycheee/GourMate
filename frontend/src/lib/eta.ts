/**
 * eta.ts — recipe time estimates (architecture §6 `Recipe` time fields).
 * The total is `total_time_seconds` when present, else `prep + cook`; when
 * nothing is known we return `null` and the UI hides the estimate — a value
 * is never fabricated (e.g. no invented remaining-time countdown).
 */

import type { Recipe } from "../types";

export type RecipeTimes = Pick<
  Recipe,
  "total_time_seconds" | "prep_time_seconds" | "cook_time_seconds"
>;

/** Total recipe time in whole minutes, or `null` when it is not derivable. */
export function recipeTotalMinutes(recipe: RecipeTimes | null | undefined): number | null {
  if (!recipe) return null;
  if (recipe.total_time_seconds != null && recipe.total_time_seconds > 0) {
    return Math.round(recipe.total_time_seconds / 60);
  }
  if (recipe.prep_time_seconds == null && recipe.cook_time_seconds == null) return null;
  const seconds = (recipe.prep_time_seconds ?? 0) + (recipe.cook_time_seconds ?? 0);
  return seconds > 0 ? Math.round(seconds / 60) : null;
}
