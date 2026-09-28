/**
 * Kitchen timers — localStorage-persisted, recomputed from `ends_at` so a
 * refresh never loses a timer (FR-3.3, architecture §5 / §14).
 *
 * Completion: Web Audio chime + Notification API + verdigris ring pulse
 * (design §5.3). No pause tool exists in the §9.2 registry, so V1 timers run
 * or cancel; `paused` remains a valid schema status.
 */

import type { KitchenTimer } from "../types";
import { playChime } from "./audio";
import { timerDoneMessage } from "./copy";

const KEY = "gourmate-timers-v1";

export function loadTimers(): KitchenTimer[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is KitchenTimer => Boolean(t) && typeof (t as KitchenTimer).id === "string");
  } catch {
    return [];
  }
}

export function saveTimers(timers: KitchenTimer[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(timers));
  } catch {
    /* ignore quota errors */
  }
}

export function clearTimers(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Recompute from `ends_at`: anything active whose deadline passed becomes
 * `done` and is returned for alerting (timers that fired while the tab was
 * closed — architecture §14).
 */
export function recomputeTimers(
  timers: KitchenTimer[],
  now: number = Date.now()
): { timers: KitchenTimer[]; completed: KitchenTimer[] } {
  const completed: KitchenTimer[] = [];
  const next = timers.map((t) => {
    if (t.status === "active" && t.ends_at <= now) {
      completed.push({ ...t, status: "done" });
      return { ...t, status: "done" as const };
    }
    return t;
  });
  return { timers: next, completed };
}

export function remainingMs(timer: KitchenTimer, now: number = Date.now()): number {
  if (timer.status === "cancelled") return 0;
  if (timer.status === "done") return 0;
  return Math.max(0, timer.ends_at - now);
}

export function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function createTimer(input: {
  label: string;
  duration_seconds: number;
  related_step_index?: number | null;
  now?: number;
}): KitchenTimer {
  const now = input.now ?? Date.now();
  const duration = Math.max(1, Math.round(input.duration_seconds));
  return {
    id: crypto.randomUUID(),
    label: input.label.trim() || "Timer",
    duration_seconds: duration,
    started_at: now,
    ends_at: now + duration * 1000,
    status: "active",
    related_step_index: input.related_step_index ?? null
  };
}

export function requestNotificationPermission(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

export function notifyTimerDone(timer: KitchenTimer, soundEnabled: boolean): void {
  const message = timerDoneMessage(timer.label);
  if (soundEnabled) playChime();
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification("GourMate", { body: message, tag: `gourmate-timer-${timer.id}` });
    } catch {
      /* notification blocked */
    }
  }
}
