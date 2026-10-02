import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContextChoices from "../ContextChoices";
import { useSession } from "../../store/session";
import type { ChoiceOption, FoodPreview } from "../../types";

const food: FoodPreview = {
  name: "Chicken Adobo", description: "Chicken in a tangy garlic sauce.",
  estimated_total_minutes: 55, popularity: "A familiar family favourite.",
  difficulty: "Easy", key_ingredients: ["Chicken", "Garlic"], fit: "Matches your comfort-food craving.",
  image_url: "https://upload.wikimedia.org/chicken-adobo.jpg", image_credit: "Photographer", image_license: "CC BY 2.0",
  image_source: "https://commons.wikimedia.org/wiki/File:Chicken_adobo.jpg"
};
const dish: ChoiceOption = { id: "adobo", label: "Chicken Adobo", food };
beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ image_url: null }) })));
afterEach(() => { cleanup(); useSession.getState().setChoices(null); vi.unstubAllGlobals(); });

function mount(options: ChoiceOption[] = [dish]) {
  useSession.getState().setChoices(options);
  const send = vi.fn();
  render(<ContextChoices onSendText={send} />);
  return send;
}

describe("food preview choices", () => {
  it("opens without selecting, shows all details, and explicitly chooses", () => {
    const send = mount();
    fireEvent.click(screen.getByRole("button", { name: "Chicken Adobo" }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Chicken Adobo" })).toBeInTheDocument();
    expect(screen.getByText(food.description)).toBeInTheDocument();
    expect(screen.getByText("Estimated total: 55 min")).toBeInTheDocument();
    expect(screen.getByText(food.popularity)).toBeInTheDocument();
    expect(screen.getByText(food.fit)).toBeInTheDocument();
    expect(screen.getByText("Easy")).toBeInTheDocument();
    expect(screen.getByText("Chicken, Garlic")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("src", "https://upload.wikimedia.org/chicken-adobo.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Choose this dish" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Chicken Adobo");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useSession.getState().choices).toBeNull();
  });

  it("back dismisses without selection and preserves options", () => {
    const send = mount();
    fireEvent.click(screen.getByRole("button", { name: "Chicken Adobo" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to options" }));
    expect(send).not.toHaveBeenCalled();
    expect(useSession.getState().choices).toHaveLength(1);
  });

  it("traps focus, closes on Escape, and restores the opener", () => {
    mount();
    const opener = screen.getByRole("button", { name: "Chicken Adobo" });
    opener.focus(); fireEvent.click(opener);
    const first = screen.getByRole("button", { name: "Close food preview" });
    const last = screen.getByRole("button", { name: "Back to options" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("uses a placeholder when an image fails or is missing", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Chicken Adobo" }));
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText("Image unavailable")).toBeInTheDocument();
    expect(screen.getByText(food.description)).toBeInTheDocument();
  });

  it("supports uncatalogued dishes without a photo or known estimate", async () => {
    mount([{ ...dish, food: { ...food, name: "New dish", image_url: null, estimated_total_minutes: null } }]);
    fireEvent.click(screen.getByRole("button", { name: "Chicken Adobo" }));
    await waitFor(() => expect(screen.getByText("Image unavailable")).toBeInTheDocument());
    expect(screen.getByText("Cooking time available with recipe")).toBeInTheDocument();
  });

  it.each([null, [{ id: "next", label: "Next step" }]])("closes stale previews on replacement or reset", (options) => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Chicken Adobo" }));
    act(() => useSession.getState().setChoices(options));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ordinary actions submit immediately using optional submission text", () => {
    const send = mount([{ id: "revise", label: "Adjust the plan", submit_text: "Change my recipe" }]);
    fireEvent.click(screen.getByRole("button", { name: "Adjust the plan" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Change my recipe");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("loads a remote photo for a new dish while keeping text immediately available", async () => {
    const lookup = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ image_url: "https://upload.wikimedia.org/lentils.jpg", image_credit: "Author", image_license: "CC0", image_source: "https://commons.wikimedia.org/wiki/File:Lentils.jpg" }) });
    vi.stubGlobal("fetch", lookup);
    mount([{ ...dish, food: { ...food, name: "Lentil Stew", image_url: null } }]);
    fireEvent.click(screen.getByRole("button", { name: "Chicken Adobo" }));
    expect(screen.getByText(food.description)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "https://upload.wikimedia.org/lentils.jpg"));
    expect(JSON.parse(lookup.mock.calls[0][1].body)).toEqual({ dish: "Lentil Stew" });
    expect(screen.getByText(/Photo: Author/)).toBeVisible();
  });
  it("keeps text and selection available when photo lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const send = mount([{ ...dish, food: { ...food, image_url: null } }]);
    fireEvent.click(screen.getByRole("button", { name: "Chicken Adobo" }));
    await waitFor(() => expect(screen.getByText("Image unavailable")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Choose this dish" }));
    expect(send).toHaveBeenCalledWith("Chicken Adobo");
  });

});
