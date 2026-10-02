import { describe, expect, it } from "vitest";
import { swapPanelLayout } from "../layout";

describe("swapPanelLayout", () => {
  it("swaps the default opposite-side layout and swaps back", () => {
    const initial = {
      chatSide: "left" as const,
      plannerSide: "right" as const,
      sameSideOrder: "chat-first" as const
    };
    const swapped = swapPanelLayout(initial);

    expect(swapped).toEqual({
      chatSide: "right",
      plannerSide: "left",
      sameSideOrder: "chat-first"
    });
    expect(swapPanelLayout(swapped)).toEqual(initial);
  });

  it("swaps order when both panels are on the left and swaps back", () => {
    const initial = {
      chatSide: "left" as const,
      plannerSide: "left" as const,
      sameSideOrder: "chat-first" as const
    };
    const swapped = swapPanelLayout(initial);

    expect(swapped).toEqual({
      chatSide: "left",
      plannerSide: "left",
      sameSideOrder: "planner-first"
    });
    expect(swapPanelLayout(swapped)).toEqual(initial);
  });

  it("swaps order when both panels are on the right and swaps back", () => {
    const initial = {
      chatSide: "right" as const,
      plannerSide: "right" as const,
      sameSideOrder: "chat-first" as const
    };
    const swapped = swapPanelLayout(initial);

    expect(swapped).toEqual({
      chatSide: "right",
      plannerSide: "right",
      sameSideOrder: "planner-first"
    });
    expect(swapPanelLayout(swapped)).toEqual(initial);
  });

  it("swaps back from the reverse opposite-side layout", () => {
    const initial = {
      chatSide: "right" as const,
      plannerSide: "left" as const,
      sameSideOrder: "chat-first" as const
    };
    const swapped = swapPanelLayout(initial);

    expect(swapped).toEqual({
      chatSide: "left",
      plannerSide: "right",
      sameSideOrder: "chat-first"
    });
    expect(swapPanelLayout(swapped)).toEqual(initial);
  });
});