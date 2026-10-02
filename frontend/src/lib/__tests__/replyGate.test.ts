import { describe, expect, it } from "vitest";
import { ReplyGate } from "../replyGate";
import { fitRingScale } from "../effectBounds";

describe("reply identity", () => {
  it("keeps sentence chunks continuous and rejects late cancelled audio", () => {
    const gate = new ReplyGate();
    expect(gate.accept("first", true)).toBe("start");
    expect(gate.accept("first", true)).toBe("continue");
    gate.cancel();
    expect(gate.accept("first", true)).toBe("ignore");
    expect(gate.accept("second", true)).toBe("start");
    expect(gate.accept("first", true)).toBe("ignore");
    expect(gate.accept("second", false)).toBe("continue");
  });
  it("does not let a late state start an obsolete reply", () => {
    const gate = new ReplyGate();
    expect(gate.accept("old", false)).toBe("ignore");
    gate.accept("current", true);
    gate.accept("new", true);
    expect(gate.accept("current", true)).toBe("ignore");
  });
});

describe("ring camera bounds", () => {
  it.each([[1.5, 1.8], [0.9, 1.8], [2.4, 1.3]])("fits the full ring into a %s by %s plane", (width, height) => {
    for (const radius of [0.4, 0.62]) {
      expect(fitRingScale(radius, 2.5, width, height) * radius * 2).toBeLessThanOrEqual(Math.min(width, height) * 0.84 + 1e-10);
    }
  });
});
