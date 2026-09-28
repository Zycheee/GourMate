/**
 * Copy contract (design §8): every §11 error code must have a copy string, and
 * every §7 voice state must have an aria label. Cross-checked against the
 * golden manifest so a new error code cannot ship without a message.
 */
import { describe, expect, it } from "vitest";
import { COPY, ERROR_COPY, UI, timerDoneMessage, VOICES } from "../copy";
import goldenRaw from "../../../../contracts/ws-events.json?raw";

const GOLDEN = JSON.parse(goldenRaw) as {
  error_codes: string[];
  voice_states: string[];
};

describe("ERROR_COPY coverage", () => {
  it("defines exactly one entry per §11 error code", () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual([...GOLDEN.error_codes].sort());
  });

  it("gives every code a string (tts_failed may be intentionally empty)", () => {
    for (const code of GOLDEN.error_codes) {
      expect(typeof ERROR_COPY[code], `missing copy for ${code}`).toBe("string");
    }
    // tts_failed degrades to text-only, so its spoken copy is empty by design.
    expect(ERROR_COPY.tts_failed).toBe("");
  });

  it("has no unknown extra codes", () => {
    for (const key of Object.keys(ERROR_COPY)) {
      expect(GOLDEN.error_codes).toContain(key);
    }
  });
});

describe("aria voice-state labels", () => {
  it("covers every §7 voice state plus the derived error state", () => {
    for (const state of GOLDEN.voice_states) {
      expect(UI.ariaVoiceState[state as keyof typeof UI.ariaVoiceState]).toBeTruthy();
    }
    expect(UI.ariaVoiceState.error).toBeTruthy();
  });
});

describe("copy helpers", () => {
  it("keeps the spec's intake prompt and refusal strings verbatim", () => {
    expect(COPY.intakePrompt).toBe("What are we cooking?");
    expect(COPY.outOfScope).toBe(
      "I'm just here for the cooking. Want me to get back to the sear?"
    );
    expect(UI.sessionStartGreeting).toBe("What are we cooking?");
  });

  it("builds a possessive timer-done line", () => {
    expect(timerDoneMessage("pasta")).toBe("pasta's ready.");
    expect(timerDoneMessage("Tomatoes")).toBe("tomatoes' ready.");
    // The default label is lowercased to fit the spoken sentence.
    expect(timerDoneMessage("   ")).toBe("timer's ready.");
  });

  it("ships the voice picker options with edge-tts ids", () => {
    expect(VOICES.length).toBeGreaterThan(0);
    for (const voice of VOICES) {
      expect(voice.id).toMatch(/^[a-z]{2,3}-[A-Z]{2}-.+Neural$/);
      expect(voice.label).toBeTruthy();
    }
  });
});
