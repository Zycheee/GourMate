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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/95 px-6 ">
      <motion.section
        aria-label="Welcome"
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring}
        className="flex w-full max-w-md flex-col items-center rounded-[24px] border border-black/5 dark:border-white/10 bg-surface px-6 py-8 text-center clay-strong sm:px-8 sm:py-9"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-[24px] bg-earth-yellow/30 dark:bg-earth-yellow/15 clay-soft">
          <Icon className="h-6 w-6 text-castleton-green dark:text-earth-yellow" aria-hidden="true" />
        </div>

        <h1 className="mt-5 font-display text-20 sm:text-28 font-semibold tracking-tight text-ink">{card.title}</h1>
        <p className="mt-2.5 max-w-sm text-13 sm:text-14 leading-relaxed text-ink-muted">{card.body}</p>

        {micError && (
          <p role="alert" className="mt-3.5 text-12 text-ember">
            {micError}
          </p>
        )}

        <motion.button
          type="button"
          onClick={() => void advance()}
          {...pressProps}
          className="mt-6 h-10 w-full rounded-xl clay-primary px-6 text-13 sm:text-14 font-medium text-dark-serpent  transition-colors duration-micro ease-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {card.action}
        </motion.button>

        <div className="mt-5 flex items-center gap-1.5" aria-hidden="true">
          {CARDS.map((_, i) => (
            <span
              key={i}
              className={[
                "h-1.5 rounded-full transition-all duration-state ease-ui",
                i === index ? "w-5 bg-tallow" : "w-1.5 bg-steel/30"
              ].join(" ")}
            />
          ))}
        </div>
        <p className="mt-5 max-w-xs text-11 sm:text-12 leading-relaxed text-ink-muted">
          {COPY.intakePrompt}
        </p>
      </motion.section>
    </div>
  );
}
