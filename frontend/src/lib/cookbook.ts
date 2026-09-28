/**
 * Local cookbook — localStorage persistence for recipes (FR-7.1).
 * Anonymous and user-clearable; nothing is stored server-side.
 */

import type { Recipe } from "../types";

const KEY = "gourmate-cookbook-v1";

export function listCookbook(): Recipe[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is Recipe => Boolean(r) && typeof (r as Recipe).id === "string");
  } catch {
    return [];
  }
}

export function loadFromCookbook(id: string): Recipe | null {
  return listCookbook().find((r) => r.id === id) ?? null;
}

export function saveToCookbook(recipe: Recipe): Recipe[] {
  const recipes = listCookbook().filter((r) => r.id !== recipe.id);
  recipes.unshift(recipe);
  const trimmed = recipes.slice(0, 50);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded — keep the in-memory list.
  }
  return trimmed;
}

export function removeFromCookbook(id: string): Recipe[] {
  const recipes = listCookbook().filter((r) => r.id !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(recipes));
  } catch {
    /* ignore */
  }
  return recipes;
}

export function clearCookbook(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
