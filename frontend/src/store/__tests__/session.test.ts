/**
 * Session store contract (architecture §5 "State ownership").
 *
 * Proves that persisted fields hydrate from localStorage, ephemeral fields do
 * not leak into persistence, and timers recompute from `ends_at` on resume.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PANEL_LAYOUT, useSession, SYNC_TURN_WINDOW } from "../session";
import { makeRecipe, makeTimer } from "../../test/fixtures";

const PERSIST_KEY = "gourmate-session-v1";

const persistApi = (
  useSession as unknown as { persist: { rehydrate: () => Promise<void> } }
).persist;

const initialState = useSession.getState();

beforeEach(() => {
  localStorage.clear();
  useSession.setState(initialState, true);
});

describe("defaults", () => {
  it("starts in intake with no recipe and idle voice state", () => {
    const s = useSession.getState();
    expect(s.phase).toBe("intake");
    expect(s.recipe).toBeNull();
    expect(s.currentStepIndex).toBe(0);
    expect(s.timers).toEqual([]);
    expect(s.voiceState).toBe("idle");
    expect(s.connection).toBe("idle");
  });
});

describe("recipe + step navigation", () => {
  it("setRecipe enters cooking mode and resets the step index", () => {
    const recipe = makeRecipe();
    useSession.getState().setRecipe(recipe);
    expect(useSession.getState().phase).toBe("cooking");
    expect(useSession.getState().recipe).toEqual(recipe);
    expect(useSession.getState().currentStepIndex).toBe(0);
  });

  it("setRecipe(null) returns to intake", () => {
    useSession.getState().setRecipe(makeRecipe());
    useSession.getState().setRecipe(null);
    expect(useSession.getState().phase).toBe("intake");
    expect(useSession.getState().recipe).toBeNull();
  });

  it("setStepIndex clamps to the recipe bounds", () => {
    useSession.getState().setRecipe(makeRecipe());
    useSession.getState().setStepIndex(1);
    expect(useSession.getState().currentStepIndex).toBe(1);

    useSession.getState().setStepIndex(99);
    expect(useSession.getState().currentStepIndex).toBe(1); // 2 steps -> max index 1

    useSession.getState().setStepIndex(-5);
    expect(useSession.getState().currentStepIndex).toBe(0);
  });

  it("setStepIndex is a no-op without a recipe", () => {
    useSession.getState().setStepIndex(3);
    expect(useSession.getState().currentStepIndex).toBe(0);
  });
});

describe("timers", () => {
  it("adds timers and mirrors them to localStorage", () => {
    const timer = makeTimer({ id: "t1" });
    useSession.getState().addTimer(timer);
    expect(useSession.getState().timers).toEqual([timer]);
    expect(JSON.parse(localStorage.getItem("gourmate-timers-v1") ?? "[]")).toEqual([timer]);
  });

  it("hydrateTimers recomputes expired active timers from ends_at", () => {
    const now = Date.now();
    const expired = makeTimer({ id: "expired", ends_at: now - 1, status: "active" });
    const future = makeTimer({ id: "future", ends_at: now + 60_000, status: "active" });
    useSession.getState().setTimers([expired, future]);

    const completed = useSession.getState().hydrateTimers();

    expect(completed.map((t) => t.id)).toEqual(["expired"]);
    const state = useSession.getState();
    expect(state.timers.find((t) => t.id === "expired")?.status).toBe("done");
    expect(state.timers.find((t) => t.id === "future")?.status).toBe("active");
    expect(state.pulsedTimerIds).toEqual(["expired"]);
  });

  it("cancelTimerByLabel matches case-insensitively and is idempotent", () => {
    useSession.getState().setTimers([makeTimer({ id: "t1", label: "pasta", status: "active" })]);
    const target = useSession.getState().cancelTimerByLabel("PASTA");
    expect(target?.id).toBe("t1");
    expect(useSession.getState().timers[0].status).toBe("cancelled");
    expect(useSession.getState().cancelTimerByLabel("pasta")).toBeNull();
  });
});

describe("sessionSnapshot", () => {
  it("emits the §7 SessionState shape", () => {
    const recipe = makeRecipe();
    useSession.getState().setRecipe(recipe);
    useSession.getState().setStepIndex(1);

    const snapshot = useSession.getState().sessionSnapshot("sid-1");
    expect(snapshot).toEqual({
      session_id: "sid-1",
      phase: "cooking",
      recipe,
      current_step_index: 1,
      timers: [],
      turns: []
    });
  });

  it("falls back to the stored session id then an empty string", () => {
    expect(useSession.getState().sessionSnapshot(null).session_id).toBe("");
    useSession.getState().setSessionId("stored-id");
    expect(useSession.getState().sessionSnapshot(null).session_id).toBe("stored-id");
  });

  it("mirrors the recent transcript into turns for the sync message", () => {
    useSession.getState().addChat({ role: "user", text: "what's next" });
    useSession.getState().addChat({ role: "assistant", text: "Sear the salmon." });
    useSession.getState().addChat({ role: "tool", text: "tool:advance_step" });

    const snapshot = useSession.getState().sessionSnapshot("sid-2");
    expect(snapshot.turns?.map((t) => t.text)).toEqual([
      "what's next",
      "Sear the salmon.",
      "tool:advance_step"
    ]);
    expect(snapshot.turns?.[0].role).toBe("user");
  });

  it("caps turns at the sync window and keeps the most recent", () => {
    for (let i = 0; i < SYNC_TURN_WINDOW + 5; i++) {
      useSession.getState().addChat({ role: "user", text: `turn ${i}` });
    }
    const snapshot = useSession.getState().sessionSnapshot(null);
    expect(snapshot.turns).toHaveLength(SYNC_TURN_WINDOW);
    expect(snapshot.turns?.[0].text).toBe("turn 5");
    expect(snapshot.turns?.[SYNC_TURN_WINDOW - 1].text).toBe(
      `turn ${SYNC_TURN_WINDOW + 4}`
    );
  });

  it("round-trips turns through persistence", async () => {
    useSession.getState().addChat({ role: "user", text: "how much butter" });
    useSession.getState().addChat({
      role: "assistant",
      text: "Two tablespoons.",
      tool_call: { call_id: "c1", name: "repeat_step", arguments: { step_index: 0 } }
    });

    await persistApi.rehydrate();

    const snapshot = useSession.getState().sessionSnapshot(null);
    expect(snapshot.turns?.map((t) => t.text)).toEqual([
      "how much butter",
      "Two tablespoons."
    ]);
    expect(snapshot.turns?.[1].tool_call?.name).toBe("repeat_step");
  });
});

describe("persistence (localStorage)", () => {
  it("persists same-side panel order and reset restores the default layout", async () => {
    useSession.getState().setSettings({
      chatSide: "right",
      plannerSide: "right",
      sameSideOrder: "planner-first"
    });

    await persistApi.rehydrate();

    expect(useSession.getState().settings).toMatchObject({
      chatSide: "right",
      plannerSide: "right",
      sameSideOrder: "planner-first"
    });

    useSession.getState().setSettings(DEFAULT_PANEL_LAYOUT);
    expect(useSession.getState().settings).toMatchObject({
      chatSide: "left",
      plannerSide: "right",
      sameSideOrder: "chat-first"
    });
  });

  it("hydrates persisted fields and keeps ephemeral fields transient", async () => {
    const recipe = makeRecipe();
    const timer = makeTimer();
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        version: 0,
        state: {
          phase: "cooking",
          recipe,
          currentStepIndex: 1,
          timers: [timer],
          transcript: [],
          muted: true,
          settings: {
            voice: "en-GB-SoniaNeural",
            micDeviceId: "mic-2",
            timerSound: false,
            theme: "dark"
          },
          onboarded: true
        }
      })
    );

    await persistApi.rehydrate();

    const s = useSession.getState();
    expect(s.phase).toBe("cooking");
    expect(s.recipe).toEqual(recipe);
    expect(s.currentStepIndex).toBe(1);
    expect(s.timers).toEqual([timer]);
    expect(s.muted).toBe(true);
    expect(s.settings.voice).toBe("en-GB-SoniaNeural");
    expect(s.settings.theme).toBe("dark");
    expect(s.onboarded).toBe(true);

    // Ephemeral, server-authoritative fields are not part of the persisted slice.
    expect(s.voiceState).toBe("idle");
    expect(s.connection).toBe("idle");
    expect(s.sessionId).toBeNull();
  });

  it("partialize excludes ephemeral state from the written payload", () => {
    useSession.getState().setVoiceState("listening");
    useSession.getState().setConnection("open");
    useSession.getState().setSessionId("sid");
    useSession.getState().setSettings({ theme: "light" });

    const raw = JSON.parse(localStorage.getItem(PERSIST_KEY) ?? "{}");
    expect(raw.state.voiceState).toBeUndefined();
    expect(raw.state.connection).toBeUndefined();
    expect(raw.state.sessionId).toBeUndefined();
    expect(raw.state.settings.theme).toBe("light");
  });
});
