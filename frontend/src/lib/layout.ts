import type { Settings } from "../types";

type PanelLayout = Pick<Settings, "chatSide" | "plannerSide" | "sameSideOrder">;

export function swapPanelLayout(layout: PanelLayout): PanelLayout {
  if (layout.chatSide === layout.plannerSide) {
    return {
      ...layout,
      sameSideOrder: layout.sameSideOrder === "chat-first" ? "planner-first" : "chat-first"
    };
  }

  return {
    ...layout,
    chatSide: layout.plannerSide,
    plannerSide: layout.chatSide
  };
}