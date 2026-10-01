/** Pre-cook recipe overview: ingredients and preparation share the available width. */
import { Clock3, Users } from "lucide-react";
import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { fadeRise } from "../lib/motion";
import { UI } from "../lib/copy";
import { recipeTotalMinutes } from "../lib/eta";

export default function PlanCard() {
  const recipe = useSession((s) => s.recipe);
  if (!recipe) return null;
  const etaMinutes = recipeTotalMinutes(recipe);
  return (
    <motion.section aria-label={UI.plan.planTitle} variants={fadeRise} initial="hidden" animate="show" className="recipe-overview">
      <header className="recipe-title-block">
        <h2>{recipe.title}</h2>
        <div className="recipe-metadata">
          {recipe.servings != null && <span><Users size={16} aria-hidden="true" /> {UI.plan.servings} {recipe.servings}</span>}
          {etaMinutes != null && <span><Clock3 size={16} aria-hidden="true" /> {UI.plan.eta(etaMinutes)}</span>}
        </div>
      </header>
      <div className="recipe-preparation">
        <section className="recipe-ingredients">
          <h3>{UI.plan.ingredients}<span>{recipe.ingredients.length}</span></h3>
          <ul>{recipe.ingredients.map((ingredient) => <li key={ingredient.id}><span className="ingredient-dot" aria-hidden="true" /><span>{ingredient.display}</span></li>)}</ul>
        </section>
        <section className="recipe-method">
          <h3>The plan<span>{recipe.steps.length} steps</span></h3>
          <ol>{recipe.steps.map((step) => (
            <li key={step.index}>
              <span className="method-number">{step.index + 1}</span>
              <div><p>{step.instruction}</p>{step.duration_seconds != null && <span className="method-duration"><Clock3 size={12} aria-hidden="true" /> {Math.round(step.duration_seconds / 60)} min</span>}</div>
            </li>
          ))}</ol>
        </section>
      </div>
    </motion.section>
  );
}
