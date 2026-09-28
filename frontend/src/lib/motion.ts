/**
 * motion.ts — shared motion vocabulary so every surface moves like one hand.
 * `MotionConfig reducedMotion="user"` at the app root disables transform
 * movement for users who ask for it (opacity fades remain); these helpers are
 * safe under that config. Springs map the design's micro/feedback feel to
 * framer-motion transitions.
 */

import type { MotionProps, Transition, Variants } from "framer-motion";

/** Soft spring — panels, sheets, cards, toggles. */
export const spring: Transition = { type: "spring", stiffness: 380, damping: 32, mass: 0.9 };

/** Snappier spring for press feedback. */
export const pressSpring: Transition = { type: "spring", stiffness: 520, damping: 30, mass: 0.7 };

/**
 * Mirrors the model's react-spring config (Avatar3D `SPRING`): mass 1 /
 * tension 170 / friction 26 → stiffness 170 / damping 26, so DOM overlays
 * glide with the avatar instead of trailing it.
 */
export const modelSpring: Transition = { type: "spring", mass: 1, stiffness: 170, damping: 26 };

/**
 * Hover/tap micro-interaction shared by buttons and icon controls
 * (44px targets, focus rings, and semantics stay on the element).
 */
export const pressProps: Pick<MotionProps, "whileHover" | "whileTap" | "transition"> = {
  whileHover: { scale: 1.03 },
  whileTap: { scale: 0.97 },
  transition: pressSpring
};

/** Fade + rise — cards, chips, and notifications appear. */
export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: spring }
};

/** Chat thread container — orchestrates per-item entrance variants. */
export const threadVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } }
};

/** Chat bubble — small rise + fade as each turn lands. */
export const bubbleVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: spring }
};
