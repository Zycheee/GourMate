/**
 * GlassBackdrop — soft accent gradient orbs drifting behind the app surface.
 * Pure decoration: absolutely positioned, heavily blurred, low opacity, and
 * static under `prefers-reduced-motion` (see `.glass-orb` in index.css; the
 * CSS drift is disabled there while this entrance fade respects the app-wide
 * `MotionConfig reducedMotion="user"`). Rendered by App as the bottom layer
 * so the glass panels frost over it.
 */

import { motion } from "framer-motion";

export default function GlassBackdrop() {
  return (
    <motion.div
      aria-hidden="true"
      data-testid="glass-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.9, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <div className="glass-orb glass-orb-1" />
      <div className="glass-orb glass-orb-2" />
      <div className="glass-orb glass-orb-3" />
    </motion.div>
  );
}
