/**
 * checklist.ts — per-recipe ingredient check-off state, persisted in
 * localStorage so a refresh keeps ticks. Keyed by recipe id; the UI reloads
 * (and effectively resets) whenever the recipe changes.
 */

const KEY = "gourmate-checklist-v1";

type ChecklistMap = Record<string, string[]>;

function readAll(): ChecklistMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ChecklistMap) : {};
  } catch {
    return {};
  }
}

function writeAll(map: ChecklistMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore quota errors */
  }
}

/** Checked ingredient ids for one recipe (empty when none). */
export function loadChecked(recipeId: string): string[] {
  return readAll()[recipeId] ?? [];
}

/** Toggle one ingredient and return the updated checked list. */
export function toggleChecked(recipeId: string, ingredientId: string): string[] {
  const all = readAll();
  const current = all[recipeId] ?? [];
  const next = current.includes(ingredientId)
    ? current.filter((id) => id !== ingredientId)
    : [...current, ingredientId];
  all[recipeId] = next;
  writeAll(all);
  return next;
}

/** Remove all persisted ingredient check-offs with the cookbook. */
export function clearChecklist(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
