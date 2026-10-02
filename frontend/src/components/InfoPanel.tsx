/**
 * InfoPanel — the info column beside the avatar (desktop) / a collapsible
 * bottom sheet above the chat composer (mobile).
 *
 * Desktop ≥1024px: a right-hand frosted column (`w-[360px] xl:w-[400px]`)
 * holding the recipe title and the phase body — PlanCard while planning,
 * ingredients + step rail + step card while cooking. A single vertically
 * centered tab on the right edge toggles collapse to a short edge pill; the
 * panel ↔ pill swap animates through `AnimatePresence` (fade + slide/scale).
 *
 * Mobile <1024px: a bottom-sheet handle bar stacked above the chat drawer;
 * expanded shows the same body in a scrollable sheet. Renders nothing during
 * intake on mobile (there is no plan or step content yet).
 */

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, ChevronUp, Volume2 } from "lucide-react";
import IngredientsPanel from "./IngredientsPanel";
import PlanCard from "./PlanCard";
import StepCard from "./StepCard";
import StepRail from "./StepRail";
import TimerRings from "./TimerRings";
import { useSession } from "../store/session";
import { useMediaQuery } from "../lib/useMediaQuery";
import { pressProps, spring } from "../lib/motion";
import { UI } from "../lib/copy";

export default function InfoPanel({ onSendText }: { onSendText: (text: string) => void }) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const phase = useSession((s) => s.phase);
  const recipe = useSession((s) => s.recipe);
  /* Shared panel state (the avatar glides around open cards). */
  const infoOpen = useSession((s) => s.infoOpen);
  const setInfoOpen = useSession((s) => s.setInfoOpen);
  const setChatOpen = useSession((s) => s.setChatOpen);

  const sheetOpen = !isDesktop && infoOpen;
  const bodyRef = useRef<HTMLDivElement>(null);

  /* Auto-open the Planner when the session enters planning/cooking — only on
     the transition, so a manual minimize during cooking is never overridden. */
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const from = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (from === phase) return;
    if (phase === "planning" || phase === "cooking") setInfoOpen(true);
  }, [phase, setInfoOpen]);

  /* The panel label is the Planner persona in every phase; the body stays
     phase-specific (plan / steps / completion / empty). */
  const railLabel = UI.chefName;
  const panelName = UI.chefName;

  /* Secondary cancel / discontinue — sends the line and lets the server's
     §7 `reset` event bring the session back to intake (visually quiet, the
     accent primary stays reserved for "Let's cook"). */
  const cancelLabel = phase === "planning" ? UI.plan.cancelPlan : UI.plan.stopCooking;
  const cancelText = phase === "planning" ? UI.plan.cancelPlanText : UI.plan.stopCookingText;

  const body = (
    <div className="flex flex-col gap-3">
      {(phase === "planning" || phase === "cooking") && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Done cooking is the primary completion cue; the discontinue line
              stays secondary (visually quiet). */}
          {phase === "cooking" && (
            <motion.button
              type="button"
              onClick={() => onSendText(UI.plan.doneCookingText)}
              {...pressProps}
              className="inline-flex min-h-9 flex-1 items-center justify-center rounded-full bg-tallow px-3 py-2 text-11 font-semibold text-[#27352A] shadow-[0_4px_14px_rgba(224,112,42,0.2)] transition-colors duration-micro ease-ui hover:bg-tallow/90 active:bg-tallow/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <><Check className="mr-1.5 h-3.5 w-3.5" />{UI.plan.doneCooking}</>
            </motion.button>
          )}
          <motion.button
            type="button"
            onClick={() => onSendText(cancelText)}
            {...pressProps}
            className="inline-flex min-h-9 flex-1 items-center justify-center rounded-full clay-btn px-3 py-2 text-11 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {cancelLabel}
          </motion.button>
        </div>
      )}
      {/* Completion card — the recipe is done; "Cook something else" sends the
          discontinue line and the server's `reset` returns to intake. */}
      {phase === "done" && (
        <div className="w-full rounded-2xl clay-card px-6 py-5 transition-colors duration-layout ease-ui sm:px-8 sm:py-6">
          <h2 className="font-display text-28 font-semibold leading-tight text-ink">
            {UI.done.title}
          </h2>
          <p className="mt-2 text-16 leading-relaxed text-ink-muted">{UI.done.body}</p>
          <motion.button
            type="button"
            onClick={() => onSendText(UI.plan.stopCookingText)}
            {...pressProps}
            className="mt-4 min-h-[44px] w-full rounded-md bg-accent-strong px-6 py-3 text-16 font-medium text-white transition-colors duration-micro ease-ui hover:bg-accent-strong/90 active:bg-accent-strong/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            {UI.done.action}
          </motion.button>
        </div>
      )}
      {/* Live kitchen timers — visible in planning and cooking (design §5.3). */}
      <TimerRings />
      {phase === "planning" && <PlanCard onSendText={onSendText} />}
      {phase === "cooking" && (
        <>
          <IngredientsPanel />
          <StepRail />
          <StepCard />
        </>
      )}
      {/* Reference after completion: the final step + ingredients. */}
      {phase === "done" && (
        <>
          <IngredientsPanel />
          <StepCard />
        </>
      )}
      {/* No plan yet — the Planner waits for the first dish. */}
      {!recipe && <p className="text-16 leading-relaxed text-ink-muted">{UI.plan.empty}</p>}
    </div>
  );

  /**
   * Round minimize handle — centered on the panel's inner edge, half on / half
   * off the card. `x`/`y` live in motion (not translate classes) so hover/tap
   * scaling cannot clobber the centering.
   */
  /* ------------------------------ desktop ------------------------------ */

  if (isDesktop) {
    return (
      <AnimatePresence initial={false} mode="wait">
          <motion.aside
            key="info-panel"
            id="info-panel"
            aria-label={panelName}
            className="gourmate-planner-panel planner-panel relative z-20 order-2 flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[22px] clay-card lg:order-none"
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 14 }}
            transition={spring}
          >
            {/* Header row — the Planner label (the brand echo carries the
                recipe title). */}
            <div className="flex items-center justify-between gap-2 border-b border-[rgba(224,112,42,0.1)] px-4 py-3">
              <h1 className="font-display text-16 font-semibold text-ink">Planner</h1>
              <span className="font-mono text-9 tabular-nums text-ink-muted">03:00 / 75:00</span>
            </div>
            <div ref={bodyRef} className="no-scrollbar flex-1 overflow-y-auto px-4 pb-4 pt-3">
              {body}
            </div>
            <div className="flex shrink-0 items-center justify-between border-t border-[rgba(224,112,42,0.1)] px-4 py-3 font-mono text-9 text-ink-muted">
              <span className="inline-flex items-center gap-1.5"><Volume2 className="h-3.5 w-3.5" />Voice narration on</span>
              <button
                type="button"
                onClick={() => bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
                className="transition-colors hover:text-verdigris"
              >
                View overview
              </button>
            </div>
          </motion.aside>
      </AnimatePresence>
    );
  }

  /* ------------------------------- mobile ------------------------------ */
  // The sheet renders in every phase — during intake it carries the empty
  // state so the Planner panel is always visible.

  return (
    <section
      aria-label={railLabel}
      className="planner-panel order-2 flex max-h-[35vh] w-full flex-col overflow-hidden rounded-[22px] clay-card lg:order-none"
    >
      <motion.button
        type="button"
        onClick={() => {
          const nextOpen = !infoOpen;
          setInfoOpen(nextOpen);
          if (nextOpen) setChatOpen(false);
        }}
        aria-expanded={sheetOpen}
        {...(sheetOpen ? { "aria-controls": "info-sheet-body" } : {})}
        {...pressProps}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 pb-1 pt-3 text-left transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="font-mono text-12 uppercase tracking-[0.16em] text-ink-muted">
          {railLabel}
        </span>
        {sheetOpen ? (
          <ChevronDown className="h-5 w-5 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronUp className="h-5 w-5 text-ink-muted" aria-hidden="true" />
        )}
      </motion.button>
      {sheetOpen && (
        <div
          id="info-sheet-body"
          className="no-scrollbar max-h-[calc(35vh-48px)] overflow-y-auto px-4 pb-4 pt-1"
        >
          {body}
        </div>
      )}
    </section>
  );
}
