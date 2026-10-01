/** Keep the WebGL camera aspect fixed while fitting its presentation into the free space. */
export function chefScale(width: number, height: number, panelProgress: number): number {
  const progress = Math.max(0, Math.min(1, panelProgress));
  const cap = Math.min(720 / 540, 800 / 640) * (1 - progress) + progress;
  return Math.max(0, Math.min(width / 540, height / 640, cap));
}
