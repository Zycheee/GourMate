import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import IngredientsPanel from "../components/IngredientsPanel";
import { useSession } from "../store/session";
import { makeRecipe } from "../test/fixtures";
import { UI } from "../lib/copy";

beforeEach(() => {
  localStorage.removeItem("gourmate-checklist-v1");
  useSession.getState().setRecipe(makeRecipe());
});

it("retains ingredient completion, checkmarks and persistence", () => {
  const first = render(<IngredientsPanel />);
  fireEvent.click(screen.getByRole("button", { name: UI.plan.ingredients }));
  const ingredient = screen.getByRole("checkbox", { name: "2 tbsp soy sauce" });
  fireEvent.click(ingredient);
  expect(ingredient).toHaveAttribute("aria-checked", "true");
  expect(ingredient.querySelector("svg")).not.toBeNull();
  first.unmount();
  render(<IngredientsPanel />);
  fireEvent.click(screen.getByRole("button", { name: UI.plan.ingredients }));
  const restored = screen.getByRole("checkbox", { name: "2 tbsp soy sauce" });
  expect(restored).toHaveAttribute("aria-checked", "true");
  fireEvent.click(restored);
  expect(restored).toHaveAttribute("aria-checked", "false");
});

it("keeps the finished-cooking Ingredients dropdown functional", async () => {
  useSession.setState({ phase: "done" });
  render(<IngredientsPanel />);
  const dropdown = screen.getByRole("button", { name: UI.plan.ingredients });
  expect(dropdown).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(dropdown);
  expect(dropdown).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "2 tbsp soy sauce" })).toBeVisible());
  fireEvent.click(dropdown);
  expect(dropdown).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
