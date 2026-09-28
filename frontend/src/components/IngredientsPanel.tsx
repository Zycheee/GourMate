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
      className="w-full rounded-lg glass shadow-warm transition-colors duration-layout ease-ui"
    >
      <motion.button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        {...(open ? { "aria-controls": "cook-ingredients" } : {})}
        {...pressProps}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors duration-micro ease-ui hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset sm:px-6"
      >
        <span className="font-mono text-12 uppercase tracking-[0.16em] text-ink-muted">
          {UI.plan.ingredients}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={[
            "h-4 w-4 shrink-0 text-ink-muted transition-transform duration-micro ease-ui",
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
          className="flex flex-col border-t border-white/10 px-2 pb-3 pt-2 sm:px-3"
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
                  className="flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors duration-micro ease-ui hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span
                    className={[
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors duration-micro ease-ui",
                      isChecked ? "border-accent bg-accent" : "border-white/25 bg-surface-2"
                    ].join(" ")}
                  >
                    <motion.span
                      initial={false}
                      animate={{ scale: isChecked ? 1 : 0, opacity: isChecked ? 1 : 0 }}
                      transition={spring}
                      className="flex items-center justify-center"
                    >
                      <Check className="h-3.5 w-3.5 text-white" aria-hidden="true" />
                    </motion.span>
                  </span>
                  <span
                    className={[
                      "text-14 leading-relaxed transition-colors duration-micro ease-ui",
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
