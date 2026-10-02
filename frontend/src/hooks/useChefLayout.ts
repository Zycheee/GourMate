import { useLayoutEffect, useRef, useState } from "react";
import { animate, useMotionValue, type MotionValue } from "framer-motion";
import { chefScale } from "../lib/chefLayout";

/** One allocation drives both the content track and the chef's remaining region. */
export function usePanelProgress(open: boolean, reducedMotion: boolean | null) {
  const progress = useMotionValue(open ? 1 : 0);
  useLayoutEffect(() => {
    if (reducedMotion) { progress.set(open ? 1 : 0); return; }
    const animation = animate(progress, open ? 1 : 0, {
      duration: 0.36, ease: [0.22, 1, 0.36, 1]
    });
    return () => animation.stop();
  }, [open, reducedMotion, progress]);
  return progress;
}

/** Retain the surface during its closing animation, without retaining interaction. */
export function useClosingSurface(open: boolean, progress: MotionValue<number>) {
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => {
    if (open) { setPresent(true); return; }
    if (progress.get() === 0) setPresent(false);
    return progress.on("change", value => { if (value === 0) setPresent(false); });
  }, [open, progress]);
  return open || present;
}

export function useChefLayout(open: boolean, reducedMotion: boolean | null) {
  const progress = usePanelProgress(open, reducedMotion);
  const presentationRef = useRef<HTMLDivElement>(null);
  const portraitRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const presentation = presentationRef.current;
    const portrait = portraitRef.current;
    if (!presentation || !portrait) return;
    const fit = () => {
      // Read the current layout, including intermediate animation frames and
      // viewport changes, rather than guessing from the full viewport width.
      const { width, height } = presentation.getBoundingClientRect();
      const scale = chefScale(width - 16, height - 16, progress.get());
      portrait.style.setProperty("--chef-scale", String(scale));
      // The decorative circle shares the canvas anchor and stays inside the
      // measured area, including short screens and intermediate panel frames.
      presentation.style.setProperty("--chef-circle", `${Math.max(0, Math.min(width, height, Math.max(320, 640 * scale * .85)))}px`);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(presentation);
    return () => observer.disconnect();
  }, [progress]);

  return { progress, presentationRef, portraitRef };
}
