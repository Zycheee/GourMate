/**
 * Test-only fixtures for the frontend contract suite.
 */
import type { KitchenTimer, Recipe } from "../types";

export function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "recipe-1",
    title: "Chicken Adobo",
    servings: 2,
    prep_time_seconds: 300,
    cook_time_seconds: 1800,
    total_time_seconds: 2100,
    ingredients: [
      {
        id: "ing-1",
        name: "Soy sauce",
        quantity: 2,
        unit: "tbsp",
        display: "2 tbsp soy sauce",
        notes: null,
        substitutions: []
      }
    ],
    steps: [
      {
        index: 0,
        instruction: "Marinate the chicken.",
        duration_seconds: 600,
        ingredient_refs: ["ing-1"],
        tip: null
      },
      {
        index: 1,
        instruction: "Simmer the sauce.",
        duration_seconds: 1200,
        ingredient_refs: ["ing-1"],
        tip: "Keep the lid on."
      }
    ],
    source: "generated",
    created_at: "2026-01-01T00:00:00+00:00",
    ...overrides
  };
}

export function makeTimer(overrides: Partial<KitchenTimer> = {}): KitchenTimer {
  return {
    id: "timer-1",
    label: "pasta",
    duration_seconds: 480,
    started_at: 1_000_000,
    ends_at: 1_000_000 + 480_000,
    status: "active",
    related_step_index: null,
    ...overrides
  };
}
