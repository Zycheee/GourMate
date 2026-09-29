/**
 * avatarOffset.ts — single source of truth for the horizontal glide offset
 * that keeps the model (and the step-progress ring) centred in the free space
 * the open floating panel cards leave: `offsetPx = (leftInset - rightInset) / 2`
 * (right positive). Desktop only — below 1024px the cards don't apply and the
 * offset is 0.
 */

import { useEffect, useState } from "react";
import { useSession } from "../store/session";

const CHAT_CARD_WIDTH = 380;
const INFO_CARD_WIDTH = 360;
const INFO_CARD_WIDTH_XL = 400;
const CARD_GAP = 16;
const DESKTOP_MIN = 1024;
const XL_MIN = 1280;

/** Pure offset maths in CSS pixels (right positive). */
export function computeAvatarOffsetPx(
  chatOpen: boolean,
  infoOpen: boolean,
  width: number
): number {
  if (width < DESKTOP_MIN) return 0;
  const leftInset = chatOpen ? CHAT_CARD_WIDTH + CARD_GAP : 0;
  const rightInset = infoOpen
    ? (width >= XL_MIN ? INFO_CARD_WIDTH_XL : INFO_CARD_WIDTH) + CARD_GAP
    : 0;
  return (leftInset - rightInset) / 2;
}

/** Live pixel offset for the current panel state and viewport width. */
export function useAvatarOffsetPx(): number {
  const chatOpen = useSession((s) => s.chatOpen);
  const infoOpen = useSession((s) => s.infoOpen);
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? DESKTOP_MIN : window.innerWidth
  );

  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return computeAvatarOffsetPx(chatOpen, infoOpen, width);
}
