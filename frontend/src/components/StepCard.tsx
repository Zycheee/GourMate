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
      className="w-full rounded-lg glass px-6 py-5 shadow-warm transition-colors duration-layout ease-ui sm:px-8 sm:py-6"
    >
      <p className="font-mono text-12 uppercase tracking-[0.18em] text-tallow tabular-nums">
        {UI.stepOf(currentStepIndex + 1, total)}
      </p>
      {/* Focus mode enlarges the step for at-a-glance reading. */}
      <h2
        className={[
          "mt-2 font-display font-semibold leading-tight text-ink",
          focusMode ? "text-40 sm:text-56" : "text-28"
        ].join(" ")}
      >
        {step.instruction}
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1">
        {step.duration_seconds != null && (
          <p className="font-mono text-14 text-ink-muted tabular-nums">
            {Math.round(step.duration_seconds / 60)} min
          </p>
        )}
        {/* Recipe total ETA — hidden when the recipe carries no time fields. */}
        {etaMinutes != null && (
          <p className="font-mono text-14 text-ink-muted tabular-nums">
            {UI.plan.totalEta(etaMinutes)}
          </p>
        )}
        {step.tip && <p className="text-14 text-ink-muted">{step.tip}</p>}
      </div>
    </motion.section>
  );
}
