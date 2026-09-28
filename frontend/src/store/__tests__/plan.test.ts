/**
 * Planning flow contract (architecture §6 `SessionPhase`, §7 `plan` event).
 *
 * `setPlan` lands the recipe carried by the §7 `plan` server event in the
 * "planning" phase (awaiting confirmation) — distinct from `setRecipe`, which
 * drops straight into "cooking". Mirrors the persistence patterns already used
 * in `session.test.ts` (partialize round-trip + direct localStorage rehydrate).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useSession } from "../session";
import type { ServerMessage, SessionPhase } from "../../types";
import { makeRecipe } from "../../test/fixtures";

const PERSIST_KEY = "gourmate-session-v1";

const persistApi = (
  useSession as unknown as { persist: { rehydrate: () => Promise<void> } }
).persist;

const initialState = useSession.getState();

beforeEach(() => {
  localStorage.clear();
  useSession.setState(initialState, true);
});

describe("setPlan", () => {
  it("sets the recipe, resets the step index and enters planning", () => {
    const recipe = makeRecipe();
    useSession.getState().setPlan(recipe);

    const s = useSession.getState();
    expect(s.phase).toBe("planning");
    expect(s.recipe).toEqual(recipe);
    expect(s.currentStepIndex).toBe(0);
  });

  it("resets the step index to 0 even after navigation", () => {
    useSession.getState().setRecipe(makeRecipe());
    useSession.getState().setStepIndex(1);
    expect(useSession.getState().currentStepIndex).toBe(1);

    useSession.getState().setPlan(makeRecipe({ id: "recipe-2" }));
    expect(useSession.getState().phase).toBe("planning");
    expect(useSession.getState().currentStepIndex).toBe(0);
  });

  it("regression: setRecipe still enters cooking, not planning", () => {
    useSession.getState().setPlan(makeRecipe());
    expect(useSession.getState().phase).toBe("planning");

    useSession.getState().setRecipe(makeRecipe());
    expect(useSession.getState().phase).toBe("cooking");
    expect(useSession.getState().currentStepIndex).toBe(0);
  });
});

describe("sessionSnapshot after setPlan", () => {
  it("emits the planning phase and the recipe in the §7 SessionState shape", () => {
    const recipe = makeRecipe();
    useSession.getState().setPlan(recipe);

    const snapshot = useSession.getState().sessionSnapshot("sid-plan");
    expect(snapshot).toEqual({
      session_id: "sid-plan",
      phase: "planning",
      recipe,
      current_step_index: 0,
      timers: [],
      turns: []
    });
  });
});

describe("persistence (localStorage)", () => {
  it("partialize writes the planning phase + recipe", () => {
    const recipe = makeRecipe();
    useSession.getState().setPlan(recipe);

    const raw = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? "{}");
    expect(raw.state.phase).toBe("planning");
    expect(raw.state.recipe).toEqual(recipe);
    expect(raw.state.currentStepIndex).toBe(0);
  });

  it("round-trips the planning phase and recipe through rehydrate", async () => {
    const recipe = makeRecipe();
    useSession.getState().setPlan(recipe);

    await persistApi.rehydrate();

    const s = useSession.getState();
    expect(s.phase).toBe("planning");
    expect(s.recipe).toEqual(recipe);
    expect(s.currentStepIndex).toBe(0);
  });

  it("merge keeps planning when restoring a persisted payload directly", async () => {
    const recipe = makeRecipe();
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        version: 0,
        state: {
          phase: "planning",
          recipe,
          currentStepIndex: 0,
          timers: [],
          transcript: [],
          muted: false,
          settings: {
            voice: "en-US-JennyNeural",
            micDeviceId: null,
            timerSound: true,
            theme: "auto"
          },
          onboarded: false
        }
      })
    );

    await persistApi.rehydrate();

    const s = useSession.getState();
    expect(s.phase).toBe("planning");
    expect(s.recipe).toEqual(recipe);
  });
});

describe("§7 `plan` event / SessionPhase contract", () => {
  it("accepts a `plan` server message and the planning phase literal", () => {
    const recipe = makeRecipe();
    // Compile-time: the §7 `plan` event is a member of ServerMessage …
    const message: ServerMessage = { type: "plan", recipe };
    // … and "planning" is a member of the SessionPhase union (architecture §6).
    const phase: SessionPhase = "planning";

    expect(message.type).toBe("plan");
    if (message.type === "plan") {
      expect(message.recipe).toEqual(recipe);
    }
    expect(phase).toBe("planning");
  });
});
