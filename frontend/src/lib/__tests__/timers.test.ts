import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTimers,
  createTimer,
  formatMMSS,
  loadTimers,
  notifyTimerDone,
  recomputeTimers,
  remainingMs,
  saveTimers,
  requestNotificationPermission
} from "../timers";
import { makeTimer } from "../../test/fixtures";

const KEY = "gourmate-timers-v1";

beforeEach(() => {
  localStorage.clear();
});

describe("createTimer", () => {
  it("computes started_at/ends_at from the supplied clock", () => {
    const timer = createTimer({ label: "pasta", duration_seconds: 480, now: 1_000_000 });
    expect(timer.started_at).toBe(1_000_000);
    expect(timer.ends_at).toBe(1_000_000 + 480_000);
    expect(timer.duration_seconds).toBe(480);
    expect(timer.status).toBe("active");
    expect(timer.related_step_index).toBeNull();
    expect(timer.id).toBeTruthy();
  });

  it("clamps duration to a minimum of one second and rounds", () => {
    expect(createTimer({ label: "x", duration_seconds: 0, now: 0 }).duration_seconds).toBe(1);
    expect(createTimer({ label: "x", duration_seconds: -5, now: 0 }).duration_seconds).toBe(1);
    expect(createTimer({ label: "x", duration_seconds: 12.6, now: 0 }).duration_seconds).toBe(13);
  });

  it("defaults an empty label to 'Timer' and keeps related_step_index", () => {
    const timer = createTimer({
      label: "   ",
      duration_seconds: 10,
      related_step_index: 2,
      now: 0
    });
    expect(timer.label).toBe("Timer");
    expect(timer.related_step_index).toBe(2);
  });
});

describe("persistence", () => {
  it("save/load round-trips timers", () => {
    const timers = [makeTimer({ id: "a" }), makeTimer({ id: "b" })];
    saveTimers(timers);
    expect(loadTimers()).toEqual(timers);
  });

  it("clearTimers removes the stored value", () => {
    saveTimers([makeTimer()]);
    clearTimers();
    expect(loadTimers()).toEqual([]);
  });

  it("returns [] for missing, malformed or non-array storage", () => {
    expect(loadTimers()).toEqual([]);

    localStorage.setItem(KEY, "{not json");
    expect(loadTimers()).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify({ not: "an array" }));
    expect(loadTimers()).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify([null, { label: "no id" }, makeTimer({ id: "ok" })]));
    expect(loadTimers().map((t) => t.id)).toEqual(["ok"]);
  });
});

describe("recomputeTimers (recompute from ends_at)", () => {
  it("marks active timers whose deadline passed as done and reports them", () => {
    const now = 1_000_000;
    const expired = makeTimer({ id: "expired", ends_at: now - 1, status: "active" });
    const future = makeTimer({ id: "future", ends_at: now + 1, status: "active" });

    const { timers, completed } = recomputeTimers([expired, future], now);

    expect(completed.map((t) => t.id)).toEqual(["expired"]);
    expect(completed[0].status).toBe("done");
    expect(timers.find((t) => t.id === "expired")?.status).toBe("done");
    expect(timers.find((t) => t.id === "future")?.status).toBe("active");
  });

  it("treats ends_at === now as complete (boundary)", () => {
    const now = 5_000;
    const boundary = makeTimer({ id: "b", ends_at: now, status: "active" });
    const { completed } = recomputeTimers([boundary], now);
    expect(completed.map((t) => t.id)).toEqual(["b"]);
  });

  it("does not resurrect cancelled or done timers", () => {
    const now = 10_000;
    const cancelled = makeTimer({ id: "c", ends_at: now - 1, status: "cancelled" });
    const done = makeTimer({ id: "d", ends_at: now - 1, status: "done" });
    const { timers, completed } = recomputeTimers([cancelled, done], now);
    expect(completed).toEqual([]);
    expect(timers.map((t) => t.status)).toEqual(["cancelled", "done"]);
  });

  it("returns a new array and does not mutate the input", () => {
    const now = 10_000;
    const input = [makeTimer({ id: "x", ends_at: now - 1, status: "active" })];
    const { timers } = recomputeTimers(input, now);
    expect(timers).not.toBe(input);
    expect(input[0].status).toBe("active");
  });
});

describe("remainingMs", () => {
  it("returns the clamped remaining time for active timers", () => {
    const timer = makeTimer({ ends_at: 2_000, status: "active" });
    expect(remainingMs(timer, 1_000)).toBe(1_000);
    expect(remainingMs(timer, 3_000)).toBe(0);
  });

  it("returns 0 for done and cancelled timers regardless of ends_at", () => {
    expect(remainingMs(makeTimer({ status: "done", ends_at: 9_999 }), 0)).toBe(0);
    expect(remainingMs(makeTimer({ status: "cancelled", ends_at: 9_999 }), 0)).toBe(0);
  });
});

describe("formatMMSS", () => {
  it.each([
    [0, "00:00"],
    [1, "00:01"],
    [59, "00:59"],
    [60, "01:00"],
    [61, "01:01"],
    [480, "08:00"],
    [3661, "61:01"]
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(formatMMSS(seconds)).toBe(expected);
  });

  it("rounds up fractional seconds and clamps negatives to zero", () => {
    expect(formatMMSS(0.1)).toBe("00:01");
    expect(formatMMSS(-10)).toBe("00:00");
  });
});

describe("notifications", () => {
  it("does not throw when Notification and AudioContext are unavailable", () => {
    expect(() => notifyTimerDone(makeTimer({ label: "pasta" }), false)).not.toThrow();
    expect(() => requestNotificationPermission()).not.toThrow();
  });

  it("attempts a chime when sound is enabled", () => {
    const timer = makeTimer({ label: "pasta" });
    // playChime is best-effort; in jsdom it fails silently inside its own try/catch.
    expect(() => notifyTimerDone(timer, true)).not.toThrow();
  });

  it("uses the label in the timer-done message", async () => {
    const copy = await import("../copy");
    expect(copy.timerDoneMessage("pasta")).toBe("pasta's ready.");
    expect(copy.timerDoneMessage("eggs")).toBe("eggs' ready.");
    // The default label is lowercased to fit the spoken sentence.
    expect(copy.timerDoneMessage("")).toBe("timer's ready.");
  });
});
