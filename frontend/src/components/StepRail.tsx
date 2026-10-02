/**
 * StepRail — read-only progress indicator with real order (design §1, §5.1).
 * Recipe navigation is voice-only (design §6); the rail never takes input.
 */

import { useSession } from "../store/session";
import { UI } from "../lib/copy";

export default function StepRail() {
  const recipe = useSession((s) => s.recipe);
  const currentStepIndex = useSession((s) => s.currentStepIndex);
  const steps = recipe?.steps ?? [];
  const total = steps.length;
  if (!recipe || total === 0) return null;
  const completion = Math.round(((currentStepIndex + 1) / total) * 100);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-2 font-mono text-9 uppercase tracking-[0.12em] text-ink-muted tabular-nums">
        <p>{UI.stepOf(currentStepIndex + 1, total)}</p>
        <p>{completion}% complete</p>
      </div>
      <ol
        aria-label={`Recipe progress: step ${currentStepIndex + 1} of ${total}`}
        className="mt-3 flex items-center justify-between gap-2"
      >
        {steps.map((step) => {
          const done = step.index < currentStepIndex;
          const active = step.index === currentStepIndex;
          return (
            <li key={step.index} className="flex-none">
              <span
                aria-current={active ? "step" : undefined}
                title={`Step ${step.index + 1}`}
                className={[
                  "block rounded-full transition-all duration-state ease-ui",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  active
                    ? "h-3 w-3 bg-tallow ring-2 ring-accent/45"
                    : done
                      ? "h-2.5 w-2.5 bg-verdigris/70"
                      : "h-2 w-2 bg-steel/35"
                ].join(" ")}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
