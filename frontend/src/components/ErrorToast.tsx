/**
 * ErrorToast — inline, calm error / rate-limit surface (design §5.2, §8).
 * Errors are direction: what happened + what to do. Slides in/out from the
 * top under `AnimatePresence`.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check, X } from "lucide-react";
import { useSession } from "../store/session";
import { pressProps, spring } from "../lib/motion";
import { UI } from "../lib/copy";

export default function ErrorToast({ onRetry }: { onRetry?: () => void }) {
  const toast = useSession((s) => s.toast);
  const setToast = useSession((s) => s.setToast);
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (toast?.kind === "rate_limit" && typeof toast.retryAfter === "number") {
      setCountdown(Math.ceil(toast.retryAfter));
    } else {
      setCountdown(null);
    }
  }, [toast]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) return;
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown]);

  /* Auto-dismiss every toast after 4s; a rate_limit stays until its wait is
     over (countdown reaches 0) when that takes longer, so the message stays
     usable. The timer restarts whenever the toast changes and clears with it. */
  useEffect(() => {
    if (!toast) return;
    const delay =
      toast.kind === "rate_limit" && typeof toast.retryAfter === "number"
        ? Math.max(4000, Math.ceil(toast.retryAfter) * 1000)
        : 4000;
    const id = window.setTimeout(() => setToast(null), delay);
    return () => window.clearTimeout(id);
  }, [toast, setToast]);

  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          key="toast"
          role={toast.kind === "error" ? "alert" : "status"}
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.97 }}
          transition={spring}
          className="mx-auto flex w-full max-w-xl items-start gap-3 rounded-md glass px-5 py-4 shadow-warm"
        >
          {toast.kind === "info" ? (
            <Check className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
          ) : (
            <AlertCircle
              className={`mt-0.5 h-5 w-5 shrink-0 ${toast.kind === "rate_limit" ? "text-tallow" : "text-steel"}`}
              aria-hidden="true"
            />
          )}
          <div className="flex-1">
            <p className="text-16 text-ink">{toast.message}</p>
            {countdown !== null && countdown > 0 && (
              <p className="mt-1 font-mono text-12 text-ink-muted tabular-nums">
                {countdown}s
              </p>
            )}
            {toast.kind === "rate_limit" && countdown === 0 && onRetry && (
              <motion.button
                type="button"
                onClick={onRetry}
                {...pressProps}
                className="mt-2 rounded-sm text-14 font-medium text-accent-strong underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:text-accent"
              >
                {UI.retry}
              </motion.button>
            )}
          </div>
          <motion.button
            type="button"
            onClick={() => setToast(null)}
            aria-label={UI.dismiss}
            {...pressProps}
            className="rounded-sm p-1.5 text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-4 w-4" />
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
