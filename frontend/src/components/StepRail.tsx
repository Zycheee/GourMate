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

  return (
    <div className="w-full">
      <p className="font-mono text-12 uppercase tracking-[0.18em] text-ink-muted tabular-nums">
        {UI.stepOf(currentStepIndex + 1, total)}
      </p>
      <ol
        aria-label={`Recipe progress: step ${currentStepIndex + 1} of ${total}`}
        className="mt-3 flex items-center gap-0"
      >
        {steps.map((step, i) => {
          const done = step.index < currentStepIndex;
          const active = step.index === currentStepIndex;
          return (
            <li key={step.index} className="flex flex-1 items-center last:flex-none">
              <span
                aria-current={active ? "step" : undefined}
                title={`Step ${step.index + 1}`}
                className={[
                  "block rounded-full transition-all duration-state ease-ui",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  active
                    ? "h-3 w-3 bg-accent ring-2 ring-accent/40 ring-offset-2 ring-offset-bg"
                    : done
                      ? "h-2.5 w-2.5 bg-tallow/80"
                      : "h-2.5 w-2.5 bg-steel/35"
                ].join(" ")}
              />
              {i < total - 1 && (
                <span
                  aria-hidden="true"
                  className={[
                    "mx-1 h-px flex-1 transition-colors duration-state ease-ui",
                    done ? "bg-tallow/60" : "bg-steel/25"
                  ].join(" ")}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
