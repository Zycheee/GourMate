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
      className="min-h-[240px] w-full rounded-[20px] bg-gradient-to-br from-[#087A59] to-[#07553F] px-4 py-4 transition-colors duration-layout ease-ui shadow-[4px_8px_20px_rgba(0,0,0,0.14)]"
    >
      <p className="font-mono text-12 uppercase tracking-[0.18em] text-tallow tabular-nums">
        {UI.stepOf(currentStepIndex + 1, total)}
      </p>
      {/* Focus mode enlarges the step for at-a-glance reading. */}
      <h2
        className={[
          "mt-3 font-display font-semibold leading-[1.35] text-white",
          focusMode ? "text-18" : "text-16"
        ].join(" ")}
      >
        {step.instruction}
      </h2>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1">
        {step.duration_seconds != null && (
          <p className="rounded-full bg-white/10 px-3 py-1 font-mono text-10 text-white/80 tabular-nums">
            {Math.round(step.duration_seconds / 60)} min
          </p>
        )}
        {/* Recipe total ETA — hidden when the recipe carries no time fields. */}
        {etaMinutes != null && (
          <p className="font-mono text-10 text-white/65 tabular-nums">
            {UI.plan.totalEta(etaMinutes)}
          </p>
        )}
      </div>
      {step.tip && (
        <div className="mt-4 border-t border-white/15 pt-3">
          <p className="font-mono text-9 font-semibold uppercase tracking-[0.12em] text-tallow">Chef's note:</p>
          <p className="mt-1 text-11 leading-relaxed text-white/75">{step.tip}</p>
        </div>
      )}
    </motion.section>
  );
}
