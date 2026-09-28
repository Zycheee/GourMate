/**
 * PlanCard — the pre-cook plan panel (design §5.1 "Planning state").
 * Shown while `phase === "planning"`: the generated recipe (ingredients +
 * ordered steps) awaiting explicit confirmation. "Let's cook" confirms by
 * voice-proxy (`sendText` with `UI.plan.letsCookText`); the revision chips
 * send short tweaks that regenerate the plan through the planning
 * conversation (architecture §7 `plan` event → this card re-renders).
 */

import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { fadeRise, pressProps } from "../lib/motion";
import { UI } from "../lib/copy";
import { recipeTotalMinutes } from "../lib/eta";

/** Common pre-cook tweaks — each is sent as a short revision request. */
const REVISION_CHIPS = [UI.plan.forTwo, UI.plan.forFour, UI.plan.noDairy] as const;

export default function PlanCard({ onSendText }: { onSendText: (text: string) => void }) {
  const recipe = useSession((s) => s.recipe);
  if (!recipe) return null;
  const etaMinutes = recipeTotalMinutes(recipe);

  return (
    <motion.section
      aria-label={UI.plan.planTitle}
      variants={fadeRise}
      initial="hidden"
      animate="show"
      className="w-full rounded-2xl glass px-4 py-3.5 sm:px-5 sm:py-4 shadow-warm transition-colors duration-layout ease-ui"
    >
      <h2 className="font-mono text-11 uppercase tracking-[0.18em] text-tallow">
        {UI.plan.planTitle}
      </h2>
      <p className="mt-1 font-display text-18 sm:text-20 font-semibold leading-snug tracking-tight text-ink">
        {recipe.title}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-12 sm:text-13 text-ink-muted">
        {recipe.servings != null && (
          <span>
            {UI.plan.servings} {recipe.servings}
          </span>
        )}
        {/* Total estimate from the recipe's own time fields — hidden when unknown. */}
        {etaMinutes != null && <span>{UI.plan.eta(etaMinutes)}</span>}
      </div>

      {/* Ingredients — one line per `display` (design §5.2 plan view). */}
      <h3 className="mt-3.5 font-mono text-11 uppercase tracking-[0.16em] text-ink-muted">
        {UI.plan.ingredients}
      </h3>
      <ul className="mt-1.5 flex flex-col gap-1">
        {recipe.ingredients.map((ingredient) => (
          <li key={ingredient.id} className="text-12 sm:text-13 leading-relaxed text-ink">
            {ingredient.display}
          </li>
        ))}
      </ul>

      {/* Ordered steps — numbered, duration shown when the step carries one. */}
      <ol className="mt-3.5 flex flex-col gap-1.5">
        {recipe.steps.map((step) => (
          <li key={step.index} className="flex gap-2.5">
            <span className="mt-0.5 font-mono text-11 tabular-nums text-tallow">
              {step.index + 1}
            </span>
            <span className="text-12 sm:text-13 leading-relaxed text-ink">
              {step.instruction}
              {step.duration_seconds != null && (
                <span className="ml-1.5 font-mono text-11 text-ink-muted tabular-nums">
                  {Math.round(step.duration_seconds / 60)} min
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>

      {/* Confirm / revise — cooking starts only on explicit confirmation. */}
      <p className="mt-3.5 text-12 sm:text-13 text-ink-muted">{UI.plan.readyToCook}</p>
      <motion.button
        type="button"
        onClick={() => onSendText(UI.plan.letsCookText)}
        {...pressProps}
        className="mt-2.5 h-9 sm:h-10 w-full rounded-xl bg-accent-strong px-4 text-13 sm:text-14 font-medium text-white shadow-sm transition-colors duration-micro ease-ui hover:bg-accent-strong/90 active:bg-accent-strong/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        {UI.plan.letsCook}
      </motion.button>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {REVISION_CHIPS.map((label) => (
          <motion.button
            key={label}
            type="button"
            onClick={() => onSendText(label)}
            {...pressProps}
            className="h-8 sm:h-8.5 rounded-full border border-black/5 dark:border-white/10 bg-surface/80 dark:bg-surface-2/80 px-3 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
          >
            {label}
          </motion.button>
        ))}
      </div>
    </motion.section>
  );
}
