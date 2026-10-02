/**
 * StepProgressRing — a subtle DOM SVG progress ring centered on the avatar in
 * Cook Mode: the arc shows `(currentStepIndex + 1) / total` and a small
 * "Step N of M" label sits under the model. Decorative overlay
 * `pointer-events-none`); the dash offset springs so step changes glide.
 * Hidden outside cooking.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useSession } from "../store/session";
import { modelSpring } from "../lib/motion";
import { UI } from "../lib/copy";

const VIEW = 200;
const RADIUS = 92;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function StepProgressRing() {
  const phase = useSession((s) => s.phase);
  const recipe = useSession((s) => s.recipe);
  const currentStepIndex = useSession((s) => s.currentStepIndex);

  const total = recipe?.steps.length ?? 0;
  const visible = phase === "cooking" && total > 0;
  const progress = Math.min(1, (currentStepIndex + 1) / total);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="step-progress"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          <div className="relative">
            <svg
              viewBox={`0 0 ${VIEW} ${VIEW}`}
              className="assistant-progress-ring -rotate-90"
              aria-hidden="true"
            >
              <circle
                cx={VIEW / 2}
                cy={VIEW / 2}
                r={RADIUS}
                fill="none"
                stroke="rgb(var(--accent-rgb) / 0.14)"
                strokeWidth={2.5}
              />
              <motion.circle
                cx={VIEW / 2}
                cy={VIEW / 2}
                r={RADIUS}
                fill="none"
                stroke="rgb(var(--accent-rgb) / 0.75)"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                initial={{ strokeDashoffset: CIRCUMFERENCE }}
                animate={{ strokeDashoffset: CIRCUMFERENCE * (1 - progress) }}
                transition={modelSpring}
              />
            </svg>
            <p className="absolute left-1/2 top-full mt-6 -translate-x-1/2 whitespace-nowrap font-mono text-10 uppercase tracking-[0.16em] text-ink-muted">
              {UI.stepOf(currentStepIndex + 1, total)}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
