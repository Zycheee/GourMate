/**
 * StepCard — the hero of Cook Mode (design §5.1). Step titles use the display
 * face at ≥28 px for distance legibility (design §7).
 */

import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { fadeRise } from "../lib/motion";
import { UI } from "../lib/copy";
import { recipeTotalMinutes } from "../lib/eta";

export default function StepCard() {
  const recipe = useSession((s) => s.recipe);
  const currentStepIndex = useSession((s) => s.currentStepIndex);
  const focusMode = useSession((s) => s.focusMode);

  const steps = recipe?.steps ?? [];
  const step = steps.find((s) => s.index === currentStepIndex) ?? steps[currentStepIndex] ?? null;
  const total = steps.length;
  const etaMinutes = recipeTotalMinutes(recipe);

  if (!recipe || !step) return null;

  return (
    <motion.section
      aria-label={UI.stepAria(currentStepIndex + 1, total)}
      variants={fadeRise}
      initial="hidden"
      animate="show"
      className="w-full rounded-[24px] clay px-4 py-3.5 sm:px-5 sm:py-4 clay transition-colors duration-layout ease-ui"
    >
      <p className="font-mono text-11 uppercase tracking-[0.18em] text-tallow tabular-nums">
        {UI.stepOf(currentStepIndex + 1, total)}
      </p>
      {/* Focus mode enlarges the step for at-a-glance reading. */}
      <h2
        className={[
          "mt-1.5 font-display font-semibold leading-snug tracking-tight text-ink",
          focusMode ? "text-28 sm:text-40" : "text-18 sm:text-20"
        ].join(" ")}
      >
        {step.instruction}
      </h2>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {step.duration_seconds != null && (
          <p className="font-mono text-12 text-ink-muted tabular-nums">
            {Math.round(step.duration_seconds / 60)} min
          </p>
        )}
        {/* Recipe total ETA — hidden when the recipe carries no time fields. */}
        {etaMinutes != null && (
          <p className="font-mono text-12 text-ink-muted tabular-nums">
            {UI.plan.totalEta(etaMinutes)}
          </p>
        )}
        {step.tip && <p className="text-12 text-ink-muted">{step.tip}</p>}
      </div>
    </motion.section>
  );
}
