import { describe, expect, it } from "vitest";
import { chefScale } from "../chefLayout";

describe("contained chef presentation", () => {
  it("fits a fixed-aspect canvas inside the free area across panel transition frames", () => {
    for (const width of [390, 768, 1023, 1024, 1440, 1920]) {
      for (const height of [220, 560, 800]) {
        for (let progress = 0; progress <= 1; progress += .05) {
          const gap = 20 * progress;
          const group = (width - gap) * .6 * progress;
          const available = width - group - gap - 24;
          const scale = chefScale(available, height, progress);
          expect(540 * scale).toBeLessThanOrEqual(available + .001);
          expect(640 * scale).toBeLessThanOrEqual(height + .001);
          expect(540 * scale).toBeLessThanOrEqual(720);
          expect(640 * scale).toBeLessThanOrEqual(800);
        }
      }
    }
  });
  it("grows within the caps and handles short or empty presentation areas", () => {
    expect(chefScale(1200, 1000, 0)).toBe(1.25);
    expect(chefScale(1200, 1000, 1)).toBe(1);
    expect(chefScale(800, 100, 0)).toBe(100 / 640);
    expect(chefScale(0, 640, 1)).toBe(0);
    expect(chefScale(500, -10, 0)).toBe(0);
  });
});
