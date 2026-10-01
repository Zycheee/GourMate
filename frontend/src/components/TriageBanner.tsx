/**
 * TriageBanner — ember-tinted, corrective action first, recipe context
 * preserved (design §5.2, FR-4). Ember red is reserved for real emergencies.
 * Slides in/out from the top under `AnimatePresence`.
 */

import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, X } from "lucide-react";
import { useSession } from "../store/session";
import { pressProps, spring } from "../lib/motion";
import { UI } from "../lib/copy";

export default function TriageBanner() {
  const triage = useSession((s) => s.triage);
  const setTriage = useSession((s) => s.setTriage);

  return (
    <AnimatePresence>
      {triage && (
        <motion.div
          key="triage"
          role="alert"
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.97 }}
          transition={spring}
          className="mx-auto flex w-full max-w-3xl items-start gap-3 rounded-[24px] border border-ember/45 bg-ember/12 px-4 py-3 text-ink clay "
        >
          <AlertTriangle className="mt-0.5 h-4.5 w-4.5 shrink-0 text-ember" aria-hidden="true" />
          <div className="flex-1">
            <p className="font-mono text-11 uppercase tracking-[0.18em] text-ember">{UI.triageLabel}</p>
            <p className="mt-0.5 text-13 sm:text-14 leading-relaxed text-ink">{triage.message}</p>
          </div>
          <motion.button
            type="button"
            onClick={() => setTriage(null)}
            aria-label={UI.dismiss}
            {...pressProps}
            className="flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-ember/20 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
          >
            <X className="h-3.5 w-3.5" />
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
