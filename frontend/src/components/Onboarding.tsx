/**
 * Onboarding — 3 cards: mic permission → how to talk → start (design §5.2).
 * Shown once per device (localStorage); Escape is not bound — the flow is
 * linear and short.
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { Mic, MessageCircle, ChefHat } from "lucide-react";
import { pressProps, spring } from "../lib/motion";
import { COPY, UI } from "../lib/copy";

const CARDS = [
  {
    icon: Mic,
    title: UI.onboarding.micTitle,
    body: UI.onboarding.micBody,
    action: UI.onboarding.micAction
  },
  {
    icon: MessageCircle,
    title: UI.onboarding.talkTitle,
    body: UI.onboarding.talkBody,
    action: UI.onboarding.talkAction
  },
  {
    icon: ChefHat,
    title: UI.onboarding.startTitle,
    body: UI.onboarding.startBody,
    action: UI.onboarding.startAction
  }
] as const;

export default function Onboarding({
  onAllowMic,
  onStart
}: {
  onAllowMic: () => Promise<void>;
  onStart: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const card = CARDS[index];
  const Icon = card.icon;

  const advance = async (): Promise<void> => {
    if (index === 0) {
      try {
        await onAllowMic();
      } catch {
        setMicError(COPY.micDenied);
        return;
      }
    }
    if (index === CARDS.length - 1) {
      onStart();
      return;
    }
    setIndex((i) => i + 1);
    setMicError(null);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/88 px-6 backdrop-blur-md">
      <motion.section
        aria-label="Welcome"
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring}
        className="flex w-full max-w-md flex-col items-center rounded-lg bg-surface px-8 py-10 text-center shadow-warm-lg"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-tallow/15">
          <Icon className="h-7 w-7 text-tallow" aria-hidden="true" />
        </div>

        <h1 className="mt-6 font-display text-28 text-ink">{card.title}</h1>
        <p className="mt-3 max-w-sm text-16 leading-relaxed text-ink-muted">{card.body}</p>

        {micError && (
          <p role="alert" className="mt-4 text-14 text-ember">
            {micError}
          </p>
        )}

        <motion.button
          type="button"
          onClick={() => void advance()}
          {...pressProps}
          className="mt-8 min-h-[44px] w-full rounded-md bg-accent-strong px-8 py-3.5 text-16 font-medium text-white transition-colors duration-micro ease-ui hover:bg-accent-strong/90 active:bg-accent-strong/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {card.action}
        </motion.button>

        <div className="mt-6 flex items-center gap-2" aria-hidden="true">
          {CARDS.map((_, i) => (
            <span
              key={i}
              className={[
                "h-1.5 rounded-full transition-all duration-state ease-ui",
                i === index ? "w-6 bg-tallow" : "w-1.5 bg-steel/40"
              ].join(" ")}
            />
          ))}
        </div>
        <p className="mt-6 max-w-xs text-12 leading-relaxed text-ink-muted">
          {COPY.intakePrompt}
        </p>
      </motion.section>
    </div>
  );
}
