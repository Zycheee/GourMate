/** Recipe workspace — generous content area with phase-specific hierarchy. */
import { BookOpen, ChefHat, Check, PanelRightClose } from "lucide-react";
import IngredientsPanel from "./IngredientsPanel";
import PlanCard from "./PlanCard";
import StepCard from "./StepCard";
import StepRail from "./StepRail";
import TimerRings from "./TimerRings";
import { useSession } from "../store/session";
import { UI } from "../lib/copy";

export default function InfoPanel({ onSendText, onMinimize }: {
  onSendText: (text: string) => void;
  onMinimize?: () => void;
}) {
  const phase = useSession((s) => s.phase);
  const recipe = useSession((s) => s.recipe);
  const heading = phase === "intake" ? "Something good starts here"
    : phase === "planning" ? "Your recipe, your way"
    : phase === "cooking" ? "One step at a time" : "Made with a little help";
  return (
    <section className="recipe-workspace" aria-label="Recipe workspace" id="info-panel">
      <header className="panel-header recipe-workspace-heading">
        <h2 className="panel-header-title"><BookOpen size={16} aria-hidden="true" /><span>Recipe</span></h2>
        {onMinimize && <button type="button" className="panel-minimize clay-control" aria-label="Minimize Recipe" title="Minimize Recipe" onClick={onMinimize}><PanelRightClose size={16} aria-hidden="true" /></button>}
        {recipe && <span className="phase-tag">{phase === "planning" ? "Review & adjust" : phase === "cooking" ? "In progress" : phase === "done" ? "Complete" : "Recipe"}</span>}
      </header>
      <div className="recipe-scroll">
        <div className="recipe-phase-heading">
          <p className="workspace-eyebrow">YOUR KITCHEN</p>
          <h1>{heading}</h1>
        </div>
        {!recipe ? (
          <div className="recipe-empty">
            <div className="empty-emblem clay-soft"><ChefHat size={38} strokeWidth={1.6} aria-hidden="true" /></div>
            <p className="workspace-eyebrow">FROM YOUR FIRST IDEA TO THE LAST BITE</p>
            <h2>What sounds good?</h2>
            <p>Bring a dish you love, a few ingredients, or a recipe you want to try. I’ll help turn it into a plan you can cook.</p>
            <div className="workspace-benefits">
              <span><Check size={14} aria-hidden="true" /> A plan that fits you</span>
              <span><Check size={14} aria-hidden="true" /> Guidance as you cook</span>
              <span><Check size={14} aria-hidden="true" /> Timers along the way</span>
            </div>
          </div>
        ) : (
          <>
            {phase !== "planning" && (
              <div className="cooking-recipe-heading">
                <h2>{recipe.title}</h2>
                {recipe.servings != null && <span>Serves {recipe.servings}</span>}
              </div>
            )}
            {phase === "planning" && <PlanCard />}
            {phase === "cooking" && (
              <div className="cooking-content">
                <div className="flex flex-wrap gap-2" role="group" aria-label="Cooking controls">
                  <button className="clay-control rounded-full px-3 py-2 text-12" onClick={() => onSendText(UI.quick.nextText)}>{UI.quick.next}</button>
                  <button className="clay-control rounded-full px-3 py-2 text-12" onClick={() => onSendText(UI.quick.repeatText)}>{UI.quick.repeat}</button>
                </div>
                <StepRail />
                <StepCard />
                <div className="cooking-support"><IngredientsPanel /><TimerRings /></div>
              </div>
            )}
            {phase === "done" && (
              <div className="completion-content">
                <h2>{UI.done.title}</h2>
                <p>{UI.done.body}</p>
                <button className="clay-primary" onClick={() => onSendText(UI.plan.stopCookingText)}>{UI.done.action}</button>
                <IngredientsPanel />
              </div>
            )}
          </>
        )}
      </div>
      {recipe && (phase === "planning" || phase === "cooking") && (
        <footer className="recipe-footer">
          <span>{phase === "planning" ? "Make it yours before we begin." : "You can ask for help at any step."}</span>
          <div className="flex flex-wrap items-center gap-2">
            {phase === "cooking" && <button className="clay-primary" onClick={() => onSendText(UI.plan.doneCookingText)}>{UI.plan.doneCooking}</button>}
            <button className="quiet-action" onClick={() => onSendText(phase === "planning" ? UI.plan.cancelPlanText : UI.plan.stopCookingText)}>{phase === "planning" ? UI.plan.cancelPlan : UI.plan.stopCooking}</button>
          </div>
        </footer>
      )}
    </section>
  );
}
