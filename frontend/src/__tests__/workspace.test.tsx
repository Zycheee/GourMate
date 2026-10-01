import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { useSession } from "../store/session";
import { makeRecipe } from "../test/fixtures";
import { UI } from "../lib/copy";

const voice = vi.hoisted(() => ({ start: vi.fn(), sendText: vi.fn(), toggleMute: vi.fn(), setVoice: vi.fn(), restartMic: vi.fn(), disconnect: vi.fn(), interrupt: vi.fn() }));
vi.mock("../hooks/useVoiceSession", () => ({ useVoiceSession: () => voice }));
vi.mock("../components/Avatar3D", () => ({ default: () => <div data-testid="chef" /> }));
vi.mock("../lib/audio", () => ({ getMicLevel: () => 0, isAudioUnlocked: () => true, resumeAudioContext: async () => true }));
const initial = useSession.getState();

beforeEach(() => {
  useSession.setState({ ...initial, onboarded: true, settings: { ...initial.settings, theme: "light" } }, true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

describe("mobile cooking workspace", () => {
  it("keeps the workspace, chef and draft intact when a microphone notice appears and is dismissed", async () => {
    render(<App />);
    const chef = await screen.findByTestId("chef");
    const workspace = chef.closest("main");
    const presentation = chef.closest(".chef-presentation");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep my question" } });
    act(() => useSession.getState().setToast({ kind: "error", message: "Microphone unavailable. Please check permissions." }));
    const notice = screen.getByRole("alert");
    expect(workspace).not.toContainElement(notice);
    expect(screen.getByTestId("chef")).toBe(chef);
    expect(chef.closest(".chef-presentation")).toBe(presentation);
    expect(workspace).toHaveStyle({ "--panel-progress": "1" });
    fireEvent.click(screen.getByRole("button", { name: UI.dismiss }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox")).toHaveValue("Keep my question");
    expect(screen.getByTestId("chef")).toBe(chef);
    expect(workspace).toHaveStyle({ "--panel-progress": "1" });
  });
  it("keeps the chat draft when switching tabs and supports keyboard navigation", async () => {
    render(<App />);
    const draft = screen.getByRole("textbox", { name: UI.composerPlaceholder });
    fireEvent.change(draft, { target: { value: "I have mushrooms" } });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Conversation" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Recipe" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Recipe" })).toHaveFocus();
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(screen.getByRole("textbox", { name: UI.composerPlaceholder })).toHaveValue("I have mushrooms");
    fireEvent.click(screen.getByRole("button", { name: UI.send }));
    expect(voice.sendText).toHaveBeenCalledWith("I have mushrooms");
    await screen.findByTestId("chef");
  });

  it("opens the recipe on arrival and preserves explicit cooking confirmation", async () => {
    render(<App />);
    act(() => useSession.getState().setPlan(makeRecipe()));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Recipe" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Chicken Adobo" })).toBeVisible());
    expect(voice.sendText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: UI.plan.letsCook })).not.toBeInTheDocument();
    act(() => useSession.getState().setChoices([{ id: "start_cooking", label: "Let's cook" }]));
    fireEvent.click(screen.getByRole("button", { name: "Let's cook" }));
    expect(voice.sendText).toHaveBeenCalledWith("Let's cook");
    expect(useSession.getState().choices).toBeNull();
  });

  it("restores cooking content with microphone access and exits focus when opening chat", async () => {
    useSession.getState().setRecipe(makeRecipe());
    render(<App />);
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Cooking" }));
    fireEvent.click(screen.getByRole("button", { name: UI.mute }));
    expect(voice.toggleMute).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: UI.focusMode }));
    expect(useSession.getState().focusMode).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(useSession.getState().focusMode).toBe(false);
    expect(screen.getByRole("textbox", { name: UI.composerPlaceholder })).toBeVisible();
    await screen.findByTestId("chef");
  });

  it("shows no generic intake actions and keeps offered choices available when collapsed", async () => {
    useSession.getState().addChat({ role: "user", text: "Hello" });
    render(<App />);
    expect(screen.queryByRole("button", { name: UI.plan.cookNow })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: UI.plan.planIt })).not.toBeInTheDocument();
    act(() => useSession.getState().setChoices([{ id: "cook", label: "Cook it now" }, { id: "plan", label: "Let's plan it" }]));
    fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));
    expect(screen.getAllByRole("button", { name: "Cook it now" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cook it now" }));
    expect(useSession.getState().choices).toBeNull();
    expect(await screen.findByTestId("chef")).toBeVisible();
  });

  it("restores desktop panels without losing the draft", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<App />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Minimize Conversation" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Recipe" })).toHaveAttribute("aria-expanded", "false");
  });

  it("starts with a restored recipe hidden behind its folder tab", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useSession.getState().setPlan(makeRecipe());
    render(<App />);
    expect(screen.getByRole("button", { name: "Recipe" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Chicken Adobo" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recipe" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Chicken Adobo" })).toBeVisible());
  });

  it("centers the same chef when both panels close, retaining one choice group and the draft", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<App />);
    const chef = await screen.findByTestId("chef");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My unfinished question" } });
    act(() => { useSession.getState().setPlan(makeRecipe()); useSession.getState().setChoices([{ id: "start_cooking", label: "Let's cook" }]); });
    expect(screen.queryByRole("button", { name: "Recipe" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Minimize Conversation" }));
    expect(screen.getByRole("main")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("chef")).toBe(chef);
    expect(screen.getAllByRole("button", { name: "Let's cook" })).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chicken Adobo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recipe" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(screen.getByRole("textbox")).toHaveValue("My unfinished question");
    expect(screen.getByRole("main")).toHaveAttribute("data-expanded", "false");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Chicken Adobo" })).toBeVisible());
    expect(screen.getAllByRole("button", { name: "Let's cook" })).toHaveLength(1);
  });

  it("preserves the draft when crossing the desktop breakpoint", () => {
    let desktopChange: ((event: { matches: boolean }) => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false,
      addEventListener: (_type: string, listener: typeof desktopChange) => { if (query === "(min-width: 1024px)") desktopChange = listener; }, removeEventListener: vi.fn() })));
    render(<App />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Still writing" } });
    act(() => desktopChange?.({ matches: true }));
    expect(screen.getByRole("textbox")).toHaveValue("Still writing");
    act(() => desktopChange?.({ matches: false }));
    expect(screen.getByRole("textbox")).toHaveValue("Still writing");
  });

  it("keeps a revised plan pending while the drawer is collapsed and restores its tab", async () => {
    useSession.getState().setPlan(makeRecipe());
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));
    act(() => useSession.getState().setPlan(makeRecipe({ title: "Updated mushroom recipe" })));
    expect(screen.queryByRole("heading", { name: "Updated mushroom recipe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Recipe" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Updated mushroom recipe" })).toBeVisible());
    expect(screen.getByRole("button", { name: "Collapse panel" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps recipe arrivals hidden with Conversation and restores them together", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize Conversation" }));
    act(() => useSession.getState().setPlan(makeRecipe()));
    expect(screen.getByRole("main")).toHaveAttribute("data-expanded", "true");
    expect(screen.queryByRole("button", { name: "Recipe" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Chicken Adobo" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Minimize Recipe" }));
    expect(screen.getByRole("button", { name: "Recipe" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Minimize Conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(screen.queryByRole("heading", { name: "Chicken Adobo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recipe" })).toBeVisible();
    await screen.findByTestId("chef");
  });

  it("keeps Conversation visible during desktop cooking focus", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useSession.getState().setRecipe(makeRecipe());
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: UI.focusMode }));
    expect(screen.getByRole("textbox")).toBeVisible();
    expect(screen.getByRole("group", { name: "Cooking controls" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Minimize Conversation" }));
    expect(screen.queryByRole("group", { name: "Cooking controls" })).not.toBeInTheDocument();
    await screen.findByTestId("chef");
  });

  it("returns to conversation when a focused cooking session ends", async () => {
    useSession.getState().setRecipe(makeRecipe());
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: UI.focusMode }));
    act(() => useSession.setState({ phase: "intake", recipe: null }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true"));
    expect(useSession.getState().focusMode).toBe(false);
    expect(screen.getByRole("textbox", { name: UI.composerPlaceholder })).toBeVisible();
  });
});
