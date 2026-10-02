/** Keep expanding effects inside the camera's visible plane, with a safe margin. */
export function fitRingScale(radius: number, desired: number, width: number, height: number): number {
  return Math.min(desired, Math.max(0, Math.min(width, height) * 0.42 / radius));
}
