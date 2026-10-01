import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useClosingSurface, usePanelProgress } from "../useChefLayout";

describe("panel motion preferences", () => {
  it("places panels immediately and removes closing surfaces with reduced motion", () => {
    const { result, rerender } = renderHook(({ open }) => {
      const progress = usePanelProgress(open, true);
      return { progress, present: useClosingSurface(open, progress) };
    }, { initialProps: { open: true } });
    const allocation = result.current.progress;
    expect(result.current.present).toBe(true);
    rerender({ open: false });
    expect(result.current.progress.get()).toBe(0);
    expect(result.current.present).toBe(false);
    rerender({ open: true });
    expect(result.current.progress).toBe(allocation);
    expect(result.current.progress.get()).toBe(1);
    expect(result.current.present).toBe(true);
  });
});
