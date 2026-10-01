/**
 * IngredientsPanel — collapsible ingredients list for Cook Mode
 * (design §5.2 "Ingredients panel"). Each ingredient is a tappable checkbox
 * row (strike-through + muted when checked); ticks persist per recipe id in
 * localStorage (`lib/checklist`) and reset when the recipe changes.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { useSession } from "../store/session";
import { loadChecked, toggleChecked } from "../lib/checklist";
import { fadeRise, pressProps, spring } from "../lib/motion";
import { UI } from "../lib/copy";

export default function IngredientsPanel() {
  const recipe = useSession((s) => s.recipe);
  const finished = useSession((s) => s.phase === "done");
  const [open, setOpen] = useState(false);
  const recipeId = recipe?.id ?? "";
  const [checked, setChecked] = useState<string[]>(() => loadChecked(recipeId));

  /* New recipe → reload its own checklist (a fresh recipe starts unticked). */
  useEffect(() => {
    setChecked(loadChecked(recipeId));
  }, [recipeId]);

  if (!recipe || recipe.ingredients.length === 0) return null;

  return (
    <motion.section
      aria-label={UI.plan.ingredients}
      variants={fadeRise}
      initial="hidden"
      animate="show"
      className={`w-full rounded-[24px] clay transition-colors duration-layout ease-ui ${finished ? "ingredients-finished" : ""}`}
    >
      <motion.button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        {...(open ? { "aria-controls": "cook-ingredients" } : {})}
        {...(finished ? { whileTap: pressProps.whileTap, transition: pressProps.transition } : pressProps)}
        className={`ingredients-toggle flex h-9 w-full items-center justify-between gap-3 px-4 text-left transition-colors duration-micro ease-ui ${finished ? "" : "hover:bg-surface-2"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset`}
      >
        <span className="font-mono text-11 uppercase tracking-[0.16em] text-ink-muted">
          {UI.plan.ingredients}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={[
            "h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-micro ease-ui",
            open ? "rotate-180" : ""
          ].join(" ")}
        />
      </motion.button>
      {open && (
        <motion.ul
          id="cook-ingredients"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring}
          className="flex flex-col border-t border-black/5 dark:border-white/10 px-2 pb-2.5 pt-1.5"
        >
          {recipe.ingredients.map((ingredient) => {
            const isChecked = checked.includes(ingredient.id);
            return (
              <li key={ingredient.id}>
                <motion.button
                  type="button"
                  role="checkbox"
                  aria-checked={isChecked}
                  onClick={() => setChecked(toggleChecked(recipeId, ingredient.id))}
                  {...pressProps}
                  className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-micro ease-ui hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span
                    className={[
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors duration-micro ease-ui",
                      isChecked ? "border border-accent bg-accent" : "border border-black/20 dark:border-white/25 bg-surface-2"
                    ].join(" ")}
                  >
                    <motion.span initial={false} animate={{ scale: isChecked ? 1 : 0, opacity: isChecked ? 1 : 0 }} transition={spring} className="flex h-3 w-3 shrink-0 items-center justify-center">
                      <Check size={12} className="h-3 w-3 shrink-0 text-white" aria-hidden="true" />
                    </motion.span>
                  </span>
                  <span
                    className={[
                      "text-12 sm:text-13 leading-relaxed transition-colors duration-micro ease-ui truncate",
                      isChecked ? "text-ink-muted line-through" : "text-ink"
                    ].join(" ")}
                  >
                    {ingredient.display}
                  </span>
                </motion.button>
              </li>
            );
          })}
        </motion.ul>
      )}
    </motion.section>
  );
}
