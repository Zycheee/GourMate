/**
 * avatarOffset.ts — single source of truth for the horizontal glide offset
 * that keeps the model (and the step-progress ring) centred in the free space
 * the open floating panel cards leave: `offsetPx = (leftInset - rightInset) / 2`
 * (right positive). Desktop only — below 1024px the cards don't apply and the
 * offset is 0.
 */


export function computeAvatarOffsetPx(
  _chatOpen?: boolean,
  _infoOpen?: boolean,
  _width?: number
): number {
  return 0;
}

/** Live pixel offset for the current panel state and viewport width. */
export function useAvatarOffsetPx(): number {
  return 0;
}
