import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCookbook,
  listCookbook,
  loadFromCookbook,
  removeFromCookbook,
  saveToCookbook
} from "../cookbook";
import { makeRecipe } from "../../test/fixtures";

const KEY = "gourmate-cookbook-v1";

beforeEach(() => {
  localStorage.clear();
});

describe("cookbook save/load/clear", () => {
  it("starts empty", () => {
    expect(listCookbook()).toEqual([]);
  });

  it("saves and reloads a recipe", () => {
    const recipe = makeRecipe({ id: "r1", title: "Adobo" });
    const saved = saveToCookbook(recipe);
    expect(saved).toHaveLength(1);
    expect(listCookbook()).toEqual([recipe]);
    expect(loadFromCookbook("r1")).toEqual(recipe);
  });

  it("clears the cookbook", () => {
    saveToCookbook(makeRecipe());
    clearCookbook();
    expect(listCookbook()).toEqual([]);
  });
});

describe("ordering and de-duplication", () => {
  it("puts the most recent save first", () => {
    saveToCookbook(makeRecipe({ id: "r1" }));
    saveToCookbook(makeRecipe({ id: "r2" }));
    expect(listCookbook().map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("updates in place rather than duplicating an existing id", () => {
    saveToCookbook(makeRecipe({ id: "r1", title: "Old" }));
    saveToCookbook(makeRecipe({ id: "r2" }));
    saveToCookbook(makeRecipe({ id: "r1", title: "New" }));

    const titles = listCookbook().map((r) => r.title);
    expect(titles).toEqual(["New", "Chicken Adobo"]);
    expect(listCookbook()).toHaveLength(2);
  });
});

describe("bounds and malformed data", () => {
  it("keeps at most 50 recipes", () => {
    for (let i = 0; i < 55; i++) {
      saveToCookbook(makeRecipe({ id: `r${i}`, title: `Recipe ${i}` }));
    }
    const listed = listCookbook();
    expect(listed).toHaveLength(50);
    expect(listed[0].id).toBe("r54");
    expect(listed.map((r) => r.id)).not.toContain("r0");
  });

  it("returns [] for malformed storage", () => {
    localStorage.setItem(KEY, "{bad json");
    expect(listCookbook()).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify({ not: "array" }));
    expect(listCookbook()).toEqual([]);
  });

  it("filters entries without a string id", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([null, { title: "no id" }, makeRecipe({ id: "ok" })])
    );
    expect(listCookbook().map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("removeFromCookbook", () => {
  it("removes by id and returns the remaining list", () => {
    saveToCookbook(makeRecipe({ id: "r1" }));
    saveToCookbook(makeRecipe({ id: "r2" }));
    const remaining = removeFromCookbook("r1");
    expect(remaining.map((r) => r.id)).toEqual(["r2"]);
    expect(loadFromCookbook("r1")).toBeNull();
    expect(listCookbook().map((r) => r.id)).toEqual(["r2"]);
  });

  it("is a no-op for an unknown id", () => {
    saveToCookbook(makeRecipe({ id: "r1" }));
    expect(removeFromCookbook("nope").map((r) => r.id)).toEqual(["r1"]);
  });
});
