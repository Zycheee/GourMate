/**
 * The avatar now owns a contained stage, so surrounding panels never displace it.
 * This hook remains shared with the 3D placement code; figure motion is unchanged.
 */
export function useAvatarOffsetPx(): number {
  return 0;
}
