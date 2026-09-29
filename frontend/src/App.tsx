/**
 * GourMate — three panes over one continuous canvas (design §5.1).
 * Desktop (≥1024px): [ chat | 3D avatar | info ] — the chat column (left,
 * minimizable) and the info column (right: plan / steps / ingredients,
 * minimizable) frame the always-centered avatar. Mobile: the avatar is
 * full-bleed with a single fixed bottom stack [ info sheet | chat drawer ].
 * Plan/step panels never sit over the avatar. Floating top-right controls
 * (settings, back-to-intake) replace the old full-width header; errors and
 * the sound prompt float top-right beneath them.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ChefHat, Maximize2, Minimize2, Power, Settings2, Volume2, X } from "lucide-react";
import ChatPanel from "./components/ChatPanel";
import Confetti from "./components/Confetti";
import ErrorToast from "./components/ErrorToast";
import GlassBackdrop from "./components/GlassBackdrop";
import InfoPanel from "./components/InfoPanel";
import MicStatus from "./components/MicStatus";
import Onboarding from "./components/Onboarding";
import SettingsSheet from "./components/SettingsSheet";
import StepProgressRing from "./components/StepProgressRing";
import TriageBanner from "./components/TriageBanner";
import { useVoiceSession } from "./hooks/useVoiceSession";
import { useSession } from "./store/session";
import { useMediaQuery } from "./lib/useMediaQuery";
import { UI } from "./lib/copy";
import { pressProps, spring, modelSpring } from "./lib/motion";
import { applyAccentTheme, resolveTheme } from "./lib/theme";
import { useAvatarOffsetPx } from "./lib/avatarOffset";
import { isAudioUnlocked, resumeAudioContext } from "./lib/audio";

// The 3D avatar (three + @react-three + @react-spring) is the heaviest part of
// the bundle. Load it on demand so the entry chunk ships without it; the app
// boots immediately behind AvatarFallback and swaps in the canvas when ready.
const Avatar3D = lazy(() => import("./components/Avatar3D"));

/**
 * Lightweight, on-brand stand-in for the 3D canvas while the avatar chunk
 * loads. Mirrors Avatar3D's glossy squircle + pill eyes + small chef toque
 * (design §3); `absolute inset-0` preserves the continuous-canvas layout (§5.1).
 */
function AvatarFallback() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center"
      aria-hidden="true"
      data-testid="avatar-fallback"
    >
      <div className="relative">
        {/* chef toque — squashed cap + band */}
        <div className="mx-auto h-6 w-20 rounded-full bg-[#F7F3EC] shadow-warm" />
        <div className="mx-auto -mt-2 h-4 w-14 rounded-sm bg-[#F7F3EC]" />
        {/* squircle body */}
        <div className="relative mt-1 h-28 w-28 rounded-[34px] bg-[rgb(var(--tallow-rgb))] shadow-warm-lg">
          {/* pill eyes */}
          <span className="absolute left-[34px] top-10 h-5 w-3 rounded-full bg-[#241F1B]" />
          <span className="absolute right-[34px] top-10 h-5 w-3 rounded-full bg-[#241F1B]" />
          {/* blush */}
          <span className="absolute bottom-6 left-4 h-3 w-6 rounded-full bg-[#E0906F]/45" />
          <span className="absolute bottom-6 right-4 h-3 w-6 rounded-full bg-[#E0906F]/45" />
        </div>
      </div>
    </div>
  );
}

/**
 * Publish the model-derived accent palette (`lib/theme.ts`) as CSS custom
 * properties on mount so the `accent*` Tailwind colors and `var(--accent*)`
 * hooks resolve from one source of truth (the avatar body color).
 */
function useAccentTheme(): void {
  useEffect(() => {
    applyAccentTheme();
  }, []);
}

function useApplyTheme(): void {
  const theme = useSession((s) => s.settings.theme);
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.setAttribute("data-theme", resolveTheme(theme));
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

/**
 * Global keyboard shortcuts (design §6): Space toggles mute / interrupts;
 * N / R send the cook voice lines; Esc collapses the floating cards. All of
 * them yield while focus is in a field or on a control, and Esc yields to the
 * Settings/Onboarding dialogs (they keep their own Escape handling).
 */
function useGlobalShortcuts(
  toggleMute: () => void,
  interrupt: () => void,
  sendText: (text: string) => void,
  dialogsOpen: boolean
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      const onControl = target?.closest("button, a, [role='button'], [role='radio'], [role='switch']");
      if (typing || onControl) return;

      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        if (useSession.getState().voiceState === "answering") {
          interrupt();
          return;
        }
        toggleMute();
        return;
      }

      if (e.key === "Escape") {
        if (dialogsOpen) return;
        const s = useSession.getState();
        s.setChatOpen(false);
        s.setInfoOpen(false);
        return;
      }

      // Text shortcuts are cook-mode only and never hijack browser chords.
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (useSession.getState().phase !== "cooking") return;
      if (e.key === "n" || e.key === "N") {
        sendText(UI.quick.nextText);
      } else if (e.key === "r" || e.key === "R") {
        sendText(UI.quick.repeatText);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMute, interrupt, sendText, dialogsOpen]);
}

/**
 * Autoplay gate: browsers keep the shared AudioContext suspended until a
 * user gesture. After a reload `start()` runs without one, so assistant TTS
 * would be silent — resume on the first interaction and track the state.
 */
function useAudioUnlock(): boolean {
  const [unlocked, setUnlocked] = useState(() => isAudioUnlocked());

  useEffect(() => {
    if (isAudioUnlocked()) {
      setUnlocked(true);
      return;
    }
    const unlock = (): void => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
      void resumeAudioContext().then((ok) => {
        setUnlocked(ok);
        if (ok) useSession.getState().setSoundPrompt(false);
      });
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchstart", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
  }, []);

  return unlocked;
}

export default function App() {
  const phase = useSession((s) => s.phase);
  const recipe = useSession((s) => s.recipe);
  const onboarded = useSession((s) => s.onboarded);
  const setOnboarded = useSession((s) => s.setOnboarded);
  const micDeviceId = useSession((s) => s.settings.micDeviceId);
  const voice = useSession((s) => s.settings.voice);
  const soundPrompt = useSession((s) => s.soundPrompt);
  const setSoundPrompt = useSession((s) => s.setSoundPrompt);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const { start, sendText, toggleMute, setVoice, restartMic, disconnect, interrupt } = useVoiceSession();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const audioUnlocked = useAudioUnlock();
  const offsetX = useAvatarOffsetPx();
  const focusMode = useSession((s) => s.focusMode);
  const setFocusMode = useSession((s) => s.setFocusMode);
  const setChatOpen = useSession((s) => s.setChatOpen);
  const setInfoOpen = useSession((s) => s.setInfoOpen);
  useApplyTheme();
  useAccentTheme();
  useGlobalShortcuts(toggleMute, interrupt, sendText, settingsOpen || !onboarded);

  // Prevent horizontal scroll jumps when offscreen elements mount/focus
  useEffect(() => {
    const lockHorizontalScroll = (): void => {
      if (window.scrollX !== 0) window.scrollTo(0, window.scrollY);
      if (document.documentElement.scrollLeft !== 0) document.documentElement.scrollLeft = 0;
      if (document.body.scrollLeft !== 0) document.body.scrollLeft = 0;
    };
    window.addEventListener("scroll", lockHorizontalScroll, { passive: true });
    return () => window.removeEventListener("scroll", lockHorizontalScroll);
  }, []);

  // Session boots after onboarding (mic gesture already granted).
  useEffect(() => {
    if (onboarded) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded]);

  // Mic device switch re-opens capture — but only on an actual change,
  // never on the initial mount (the onboarded effect already opens the mic). Two
  // overlapping starts would create two capture graphs feeding one frame buffer.
  const prevMicRef = useRef<{ deviceId: string | null } | null>(null);
  useEffect(() => {
    if (!onboarded) return;
    const prev = prevMicRef.current;
    prevMicRef.current = { deviceId: micDeviceId };
    if (prev === null) return;
    if (prev.deviceId === micDeviceId) return;
    void restartMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micDeviceId, onboarded]);

  // Keep the assistant voice in sync with the picker (§7 `set_voice`); the
  // initial value is also applied whenever the socket (re)opens.
  useEffect(() => {
    setVoice(voice);
  }, [voice, setVoice]);

  const handleAllowMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  }, []);

  const handleStart = useCallback(() => {
    setOnboarded(true);
    void start();
  }, [setOnboarded, start]);

  const handleEndSession = useCallback(() => {
    // Conversational cancel (§7 `reset`): send the discontinue line and let the
    // server's `reset` event bring the app back to intake, so the farewell
    // turn still lands. Phase-aware so the same control can serve planning.
    sendText(phase === "planning" ? UI.plan.cancelPlanText : UI.plan.stopCookingText);
  }, [phase, sendText]);

  /** Explicit gesture for the "Tap to enable sound" affordance. */
  const handleEnableSound = useCallback(() => {
    void resumeAudioContext().then((ok) => {
      if (ok) setSoundPrompt(false);
    });
  }, [setSoundPrompt]);

  /** Immersive cook mode: hide both cards (restored when focus is released). */
  const toggleFocus = useCallback(() => {
    const next = !useSession.getState().focusMode;
    setFocusMode(next);
    setChatOpen(!next);
    setInfoOpen(!next);
  }, [setFocusMode, setChatOpen, setInfoOpen]);

  // Full teardown only on unmount (PWA keeps the page alive).
  useEffect(() => {
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* The 3D avatar is the full-screen, dead-center canvas layer (design §1).
     Suspense keeps the layout intact while the three chunk streams in. The
     model glides (inside Avatar3D) to stay clear of the floating panel cards. */
  const avatarLayer = (
    <div className="absolute inset-0 z-10">
      <Suspense fallback={<AvatarFallback />}>
        <Avatar3D />
      </Suspense>

      {/* Only the mic status stays over the canvas: plan/step panels live in
          the floating info card and notifications float top-right, so nothing
          covers the avatar. */}
      <main className="pointer-events-none absolute inset-0 flex flex-col justify-end items-center gap-5 px-4 pb-48 pt-4 sm:px-8 lg:pb-8">
        {/* Mic bar glides with the model so it always sits under it. */}
        <motion.div
          className="pointer-events-auto flex flex-col items-center gap-3"
          initial={{ x: offsetX }}
          animate={{ x: offsetX }}
          transition={modelSpring}
        >
          <MicStatus onToggleMute={toggleMute} />
        </motion.div>
      </main>

      {/* Orbiting timer rings moved into the InfoPanel (steps panel). */}

      {/* Cook-mode step progress — subtle ring + label around the model. */}
      <StepProgressRing />

      {/* Recipe-complete celebration burst (plays once on mounting). */}
      {phase === "done" && <Confetti />}
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
    <div
      ref={(el) => {
        if (el && el.scrollLeft !== 0) el.scrollLeft = 0;
      }}
      onScroll={(e) => {
        if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0;
      }}
      className="relative h-[100dvh] w-full overflow-hidden overflow-x-hidden bg-bg text-ink"
    >
      {/* Modern kitchen photo background with jet black blur and clear visibility */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-black">
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat scale-105 filter blur-[5px] opacity-85 dark:opacity-75 transition-all duration-700"
          style={{ backgroundImage: "url('/MODEN5-KITCHEN.jpg')" }}
        />
        {/* Subtle jet black tint to keep background clearly visible */}
        <div className="absolute inset-0 bg-black/25 dark:bg-black/40 backdrop-blur-[0.5px]" />
      </div>

      {/* Frosted accent orbs — behind the full-bleed canvas. */}
      <GlassBackdrop />

      {/* Full-screen 3D canvas layer — the model glides around open cards. */}
      {avatarLayer}

      {/* Frosted glass header matching Chat section and Planner Section */}
      <header className="pointer-events-auto absolute left-4 right-4 top-4 z-40 flex h-12 sm:h-14 items-center justify-between px-4 sm:px-5 rounded-2xl glass shadow-warm">
        {/* Leftmost: logo and name */}
        <div className="flex items-center gap-2.5 min-w-0">
          <ChefHat className="h-5 w-5 sm:h-6 sm:w-6 text-accent shrink-0" aria-hidden="true" />
          <span className="shrink-0 font-display text-18 sm:text-20 font-semibold tracking-tight text-ink">
            {UI.appName}
          </span>
          {recipe && (
            <>
              <span aria-hidden="true" className="text-ink-muted/50 hidden sm:inline">
                ·
              </span>
              <span className="hidden sm:inline max-w-[20ch] md:max-w-[32ch] truncate text-13 sm:text-14 font-medium text-ink-muted">
                {recipe.title}
              </span>
            </>
          )}
        </div>

        {/* Right: Controls & settings button */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {phase === "cooking" && (
            <motion.button
              type="button"
              onClick={handleEndSession}
              aria-label={UI.endSession}
              title={UI.endSession}
              {...pressProps}
              className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Power className="h-4 w-4" />
            </motion.button>
          )}
          {phase === "cooking" && (
            <motion.button
              type="button"
              onClick={toggleFocus}
              aria-pressed={focusMode}
              aria-label={focusMode ? UI.exitFocusMode : UI.focusMode}
              title={focusMode ? UI.exitFocusMode : UI.focusMode}
              {...pressProps}
              className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {focusMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </motion.button>
          )}
          <motion.button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label={UI.settings}
            title={UI.settings}
            {...pressProps}
            className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Settings2 className="h-4 w-4" />
          </motion.button>
        </div>
      </header>

      {/* Top-center column — triage first, then notifications (sound prompt +
          toasts) so both stay readable and never cover the floating controls. */}
      <div className="pointer-events-auto absolute left-1/2 top-20 z-30 flex w-[min(92vw,36rem)] -translate-x-1/2 flex-col gap-3">
        <TriageBanner />

        {/* Autoplay guard: queued assistant audio with a suspended context */}
        <AnimatePresence>
          {soundPrompt && !audioUnlocked && (
            <motion.div
              key="sound-prompt"
              role="status"
              initial={{ opacity: 0, y: -12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.97 }}
              transition={spring}
              className="flex w-full items-center gap-2.5 rounded-2xl glass px-4 py-2.5 shadow-warm"
            >
              <Volume2 className="h-4 w-4 shrink-0 text-steel" aria-hidden="true" />
              <motion.button
                type="button"
                onClick={handleEnableSound}
                {...pressProps}
                className="h-8 flex-1 text-left text-12 sm:text-13 font-medium text-ink transition-colors duration-micro ease-ui hover:text-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {UI.tapToEnableSound}
              </motion.button>
              <motion.button
                type="button"
                onClick={() => setSoundPrompt(false)}
                aria-label={UI.dismiss}
                {...pressProps}
                className="flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X className="h-3.5 w-3.5" />
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
        <ErrorToast onRetry={() => void start()} />
      </div>

      {/* Floating panel cards (desktop) / bottom stack (mobile). */}
      {isDesktop ? (
        <>
          <ChatPanel onSendText={sendText} />
          <InfoPanel onSendText={sendText} />
        </>
      ) : (
        /* Mobile: full-bleed canvas + one bottom stack
           [ info sheet | chat drawer ] anchored to the viewport. */
        <div className="fixed inset-x-0 bottom-0 z-30 flex flex-col">
          <InfoPanel onSendText={sendText} />
          <ChatPanel onSendText={sendText} />
        </div>
      )}

      {/* Dialogs stay viewport-fixed overlays. */}
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {!onboarded && <Onboarding onAllowMic={handleAllowMic} onStart={handleStart} />}
    </div>
    </MotionConfig>
  );
}
