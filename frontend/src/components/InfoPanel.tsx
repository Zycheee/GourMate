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

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import IngredientsPanel from "./IngredientsPanel";
import PlanCard from "./PlanCard";
import StepCard from "./StepCard";
import StepRail from "./StepRail";
import TimerRings from "./TimerRings";
import { useSession } from "../store/session";
import { useMediaQuery } from "../lib/useMediaQuery";
import { pressProps } from "../lib/motion";
import { UI } from "../lib/copy";

export default function InfoPanel({ onSendText }: { onSendText: (text: string) => void }) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const phase = useSession((s) => s.phase);
  const recipe = useSession((s) => s.recipe);
  /* Shared panel state (the avatar glides around open cards). */
  const infoOpen = useSession((s) => s.infoOpen);
  const setInfoOpen = useSession((s) => s.setInfoOpen);

  /** Mobile: sheet handle ↔ expanded sheet. */
  const [sheetOpen, setSheetOpen] = useState(false);

  const prevOpenRef = useRef(infoOpen);

  /* Desktop minimize swaps column ↔ pill through AnimatePresence (`mode="wait"`),
     so the successor control mounts after the exit — focus follows it via a
     callback ref once the toggle's intent lands on it. */
  const focusIntent = useRef<"expand" | "minimize" | null>(null);
  const bindExpand = useCallback((el: HTMLButtonElement | null) => {
    if (el && focusIntent.current === "expand") {
      focusIntent.current = null;
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }
  }, []);
  const bindMinimize = useCallback((el: HTMLButtonElement | null) => {
    if (el && focusIntent.current === "minimize") {
      focusIntent.current = null;
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }
  }, []);

  /* Minimize/expand records where focus should land after the swap. */
  useEffect(() => {
    const was = prevOpenRef.current;
    prevOpenRef.current = infoOpen;
    if (was === infoOpen) return;
    focusIntent.current = infoOpen ? "minimize" : "expand";
  }, [infoOpen]);

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
              className="inline-flex h-8 sm:h-8.5 items-center rounded-lg bg-accent-strong px-3.5 py-1 text-12 sm:text-13 font-medium text-white transition-colors duration-micro ease-ui hover:bg-accent-strong/90 active:bg-accent-strong/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
            >
              {UI.plan.doneCooking}
            </motion.button>
          )}
          <motion.button
            type="button"
            onClick={() => onSendText(cancelText)}
            {...pressProps}
            className="inline-flex h-8 sm:h-8.5 items-center rounded-lg border border-black/10 dark:border-white/10 bg-surface/80 dark:bg-surface-2/80 px-3.5 py-1 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
          >
            {cancelLabel}
          </motion.button>
        </div>
      )}
      {/* Completion card — the recipe is done; "Cook something else" sends the
          discontinue line and the server's `reset` returns to intake. */}
      {phase === "done" && (
        <div className="w-full rounded-2xl glass px-5 py-4 shadow-warm transition-colors duration-layout ease-ui sm:px-6 sm:py-5">
          <h2 className="font-display text-20 sm:text-28 font-semibold leading-tight text-ink">
            {UI.done.title}
          </h2>
          <p className="mt-1.5 text-13 sm:text-14 leading-relaxed text-ink-muted">{UI.done.body}</p>
          <motion.button
            type="button"
            onClick={() => onSendText(UI.plan.stopCookingText)}
            {...pressProps}
            className="mt-3.5 h-9 sm:h-10 w-full rounded-xl bg-accent-strong px-4 text-13 sm:text-14 font-medium text-white shadow-sm transition-colors duration-micro ease-ui hover:bg-accent-strong/90 active:bg-accent-strong/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
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
      {!recipe && <p className="text-13 sm:text-14 leading-relaxed text-ink-muted">{UI.plan.empty}</p>}
    </div>
  );

  /**
   * Round minimize handle — centered on the panel's inner edge, half on / half
   * off the card. `x`/`y` live in motion (not translate classes) so hover/tap
   * scaling cannot clobber the centering.
   */
  const edgeHandle =
    "absolute top-1/2 z-10 flex h-8 w-8 sm:h-8.5 sm:w-8.5 items-center justify-center rounded-full glass text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm";

  /* ------------------------------ desktop ------------------------------ */

  if (isDesktop) {
    return (
      <AnimatePresence initial={false} mode="wait">
        {!infoOpen ? (
          /* Round expand handle floating where the card was (near the right
             edge) — icon-only, the free canvas stays full width. */
          <motion.aside
            key="info-pill"
            id="info-panel"
            aria-label={railLabel}
            className="absolute right-4 top-1/2 z-20"
            initial={{ opacity: 0, x: 80, scale: 0.85, y: "-50%" }}
            animate={{ opacity: 1, x: 0, scale: 1, y: "-50%" }}
            exit={{ opacity: 0, x: 80, scale: 0.85, y: "-50%" }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
          >
            <motion.button
              type="button"
              ref={bindExpand}
              onClick={() => setInfoOpen(true)}
              aria-expanded={false}
              aria-controls="info-panel"
              aria-label={UI.panel.expand}
              title={UI.panel.expand}
              {...pressProps}
              className="flex h-9 sm:h-9.5 items-center gap-2 rounded-full glass border border-black/5 dark:border-white/10 px-3.5 sm:px-4 text-13 sm:text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
            >
              <ChevronLeft className="h-4 w-4 shrink-0" />
              {railLabel}
            </motion.button>
          </motion.aside>
        ) : (
          <motion.aside
            key="info-panel"
            id="info-panel"
            aria-label={panelName}
            className="absolute right-4 top-20 bottom-4 z-20 flex w-[360px] xl:w-[400px] flex-col rounded-2xl glass"
            initial={{ opacity: 0, x: 440 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 440 }}
            transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.85 }}
          >
            {/* Round minimize handle on the inner (left) edge — half on, half
                off the card. */}
            <motion.button
              type="button"
              ref={bindMinimize}
              onClick={() => setInfoOpen(false)}
              aria-expanded={true}
              aria-controls="info-panel"
              aria-label={UI.panel.collapse}
              title={UI.panel.collapse}
              {...pressProps}
              style={{ x: "-50%", y: "-50%" }}
              className={`${edgeHandle} left-0`}
            >
              <ChevronRight className="h-4 w-4" />
            </motion.button>
            {/* Header row — the Planner label (the brand echo carries the
                recipe title). */}
            <div className="flex items-center border-b border-black/5 dark:border-white/10 px-5 py-2.5">
              <h1 className="font-display text-16 sm:text-18 font-semibold tracking-tight text-ink">{panelName}</h1>
            </div>
            <div className="no-scrollbar flex-1 overflow-y-auto pb-4 pl-6 pr-5 pt-3.5">
              {body}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    );
  }

  /* ------------------------------- mobile ------------------------------ */
  // The sheet renders in every phase — during intake it carries the empty
  // state so the Planner panel is always visible.

  return (
    <section
      aria-label={railLabel}
      className="flex w-full flex-col rounded-t-2xl glass"
    >
      <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-ink-muted/25" aria-hidden="true" />
      <motion.button
        type="button"
        onClick={() => setSheetOpen((v) => !v)}
        aria-expanded={sheetOpen}
        {...(sheetOpen ? { "aria-controls": "info-sheet-body" } : {})}
        {...pressProps}
        className="flex h-9 w-full items-center justify-between gap-3 px-4 pb-1 pt-1 text-left transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="font-mono text-11 uppercase tracking-[0.16em] text-ink-muted">
          {railLabel}
        </span>
        {sheetOpen ? (
          <ChevronDown className="h-4 w-4 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronUp className="h-4 w-4 text-ink-muted" aria-hidden="true" />
        )}
      </motion.button>
      {sheetOpen && (
        <div
          id="info-sheet-body"
          className="no-scrollbar max-h-[35vh] overflow-y-auto px-4 pb-4 pt-1"
        >
          {body}
        </div>
      )}
    </section>
  );
}
