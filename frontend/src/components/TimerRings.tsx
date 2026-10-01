/**
 * TimerRings — kitchen timers as a vertical chip stack (design §5.3), shown
 * inside the InfoPanel body above the step card (both planning and cooking).
 * Each chip: colour ring + label + remaining MM:SS; tap → full-screen
 * expanded view with label, tabular MM:SS, +1m / +5m / Cancel. Digits are
 * Geist Mono with tabular figures. Completion pulses verdigris (the chime and
 * browser notification fire in the voice-session watchdog — untouched).
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { formatMMSS, remainingMs } from "../lib/timers";
import { fadeRise, pressProps } from "../lib/motion";
import { UI } from "../lib/copy";
import type { KitchenTimer } from "../types";

const HUE_VARS = ["--timer-1", "--timer-2", "--timer-3", "--timer-4", "--timer-5"];

/** Chip ring diameter (colour ring beside the label). */
const RING_SIZE = 44;
/** Expanded dialog ring diameter. */
const EXPANDED_RING_SIZE = 220;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Colour progress ring for one timer chip. */
function Ring({
  timer,
  now,
  hueIndex,
  size
}: {
  timer: KitchenTimer;
  now: number;
  hueIndex: number;
  size: number;
}) {
  const pulsed = useSession((s) => s.pulsedTimerIds.includes(timer.id));
  const remaining = remainingMs(timer, now);
  const progress = timer.duration_seconds > 0 ? 1 - remaining / (timer.duration_seconds * 1000) : 0;
  const stroke = `var(${HUE_VARS[hueIndex % HUE_VARS.length]})`;
  const done = timer.status === "done" || pulsed;
  const r = size / 2 - 4;

  return (
    <span className="relative block h-11 w-11 shrink-0" aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--ink-muted-rgb) / 0.25)" strokeWidth={4} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={done ? "var(--verdigris)" : stroke}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={2 * Math.PI * r}
          strokeDashoffset={2 * Math.PI * r * (1 - Math.min(1, Math.max(0, progress)))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke] duration-feedback ease-ui"
        />
      </svg>
    </span>
  );
}

function ExpandedTimer({
  timer,
  now,
  hueIndex,
  onClose
}: {
  timer: KitchenTimer;
  now: number;
  hueIndex: number;
  onClose: () => void;
}) {
  const updateTimer = useSession((s) => s.updateTimer);
  const remaining = remainingMs(timer, now);
  const progress = timer.duration_seconds > 0 ? 1 - remaining / (timer.duration_seconds * 1000) : 0;
  const size = EXPANDED_RING_SIZE;
  const r = size / 2 - 14;
  const stroke = `var(${HUE_VARS[hueIndex % HUE_VARS.length]})`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${timer.label} timer`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 px-6 "
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-sm flex-col items-center rounded-[24px] border border-black/5 dark:border-white/10 clay-strong p-6 text-center clay-strong"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--ink-muted-rgb) / 0.25)" strokeWidth={16} />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={stroke}
              strokeWidth={16}
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * r}
              strokeDashoffset={2 * Math.PI * r * (1 - Math.min(1, Math.max(0, progress)))}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
          <p className="absolute inset-0 flex items-center justify-center font-mono text-28 sm:text-40 font-semibold text-ink tabular-nums">
            {formatMMSS(remaining / 1000)}
          </p>
        </div>

        <p className="mt-3.5 font-display text-18 sm:text-20 font-semibold tracking-tight text-ink">{timer.label}</p>

        <div className="mt-6 flex w-full flex-col gap-2.5">
          <div className="flex gap-2.5">
            <motion.button
              type="button"
              onClick={() => updateTimer(timer.id, { ends_at: timer.ends_at + 60_000 })}
              {...pressProps}
              className="h-9 sm:h-9.5 flex-1 rounded-xl clay-primary px-4 text-13 font-medium text-dark-serpent  transition-colors duration-micro ease-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {UI.timerAddOne}
            </motion.button>
            <motion.button
              type="button"
              onClick={() => updateTimer(timer.id, { ends_at: timer.ends_at + 300_000 })}
              {...pressProps}
              className="h-9 sm:h-9.5 flex-1 rounded-xl clay-primary px-4 text-13 font-medium text-dark-serpent  transition-colors duration-micro ease-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {UI.timerAddFive}
            </motion.button>
          </div>
          <motion.button
            type="button"
            onClick={() => {
              updateTimer(timer.id, { status: "cancelled" });
              onClose();
            }}
            {...pressProps}
            className="h-9 sm:h-9.5 rounded-xl border border-ember/40 bg-ember/5 px-4 text-13 font-medium text-ember clay-soft transition-colors duration-micro ease-ui hover:bg-ember/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
          >
            {UI.timerExpandedCancel}
          </motion.button>
        </div>
      </div>
    </div>
  );
}

export default function TimerRings() {
  const timers = useSession((s) => s.timers);
  const pulsedTimerIds = useSession((s) => s.pulsedTimerIds);
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);

  // Active timers + recently finished ones still pulsing verdigris (design §5.3).
  const active = timers.filter(
    (t) => t.status === "active" || (t.status === "done" && pulsedTimerIds.includes(t.id))
  );
  const openTimer = active.find((t) => t.id === openId) ?? null;

  return (
    <>
      {active.length > 0 && (
        <section aria-label={UI.timersLabel} className="w-full">
          <ul className="flex flex-col gap-1">
            {active.map((timer, i) => {
              const remaining = remainingMs(timer, now);
              const done = timer.status === "done" || pulsedTimerIds.includes(timer.id);
              return (
                <motion.li
                  key={timer.id}
                  variants={fadeRise}
                  initial="hidden"
                  animate="show"
                >
                  <motion.button
                    type="button"
                    onClick={() => setOpenId(timer.id)}
                    aria-label={`${timer.label}, ${formatMMSS(remaining / 1000)} remaining`}
                    {...pressProps}
                    className={[
                      "clay-control flex min-h-12 w-full items-center gap-2.5 rounded-xl px-2.5 py-1 text-left transition-colors duration-micro ease-ui hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      done ? "timer-pulse" : ""
                    ].join(" ")}
                  >
                    <Ring timer={timer} now={now} hueIndex={i} size={RING_SIZE} />
                    <span className="flex-1 truncate text-12 sm:text-13 font-medium text-ink">{timer.label}</span>
                    <span
                      className={[
                        "font-mono text-12 sm:text-13 tabular-nums",
                        done ? "text-verdigris" : "text-ink-muted"
                      ].join(" ")}
                    >
                      {formatMMSS(remaining / 1000)}
                    </span>
                  </motion.button>
                </motion.li>
              );
            })}
          </ul>
        </section>
      )}

      {openTimer && (
        <ExpandedTimer
          timer={openTimer}
          now={now}
          hueIndex={active.findIndex((t) => t.id === openTimer.id)}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}
