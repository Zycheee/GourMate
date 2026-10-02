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

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ChefHat, ChevronLeft, ChevronRight, Maximize2, Minimize2, Power, Settings2, Volume2, X } from "lucide-react";
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
import { UI } from "./lib/copy";
import { useMediaQuery } from "./lib/useMediaQuery";
import { pressProps, spring } from "./lib/motion";
import { applyAccentTheme, resolveTheme } from "./lib/theme";
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
        <div className="relative mt-1 h-28 w-28 rounded-[34px] bg-[#E0702A] shadow-warm-lg">
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
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  const { start, sendText, toggleMute, setVoice, restartMic, disconnect, interrupt } = useVoiceSession();
  const audioUnlocked = useAudioUnlock();
  const focusMode = useSession((s) => s.focusMode);
  const setFocusMode = useSession((s) => s.setFocusMode);
  const setChatOpen = useSession((s) => s.setChatOpen);
  const setInfoOpen = useSession((s) => s.setInfoOpen);
  const voiceState = useSession((s) => s.voiceState);
  const chatOpen = useSession((s) => s.chatOpen);
  const infoOpen = useSession((s) => s.infoOpen);
  const chatWidth = useSession((s) => s.settings.chatWidth);
  const plannerWidth = useSession((s) => s.settings.plannerWidth);
  const chatSide = useSession((s) => s.settings.chatSide);
  const plannerSide = useSession((s) => s.settings.plannerSide);
  const sameSideOrder = useSession((s) => s.settings.sameSideOrder);
  useApplyTheme();
  useAccentTheme();
  useGlobalShortcuts(toggleMute, interrupt, sendText, settingsOpen || !onboarded);

  useLayoutEffect(() => {
    setChatOpen(isDesktop);
    setInfoOpen(isDesktop);
  }, [isDesktop, setChatOpen, setInfoOpen]);

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
    setChatOpen(isDesktop && !next);
    setInfoOpen(isDesktop && !next);
  }, [isDesktop, setFocusMode, setChatOpen, setInfoOpen]);

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
      <main className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end gap-4 px-3 pb-5 pt-20 sm:px-6">
        <div className="pointer-events-auto absolute left-4 right-4 top-5 z-20 flex items-center justify-between">
          <button
            type="button"
            aria-label={chatOpen ? "Close chat panel" : "Open chat panel"}
            title={chatOpen ? "Close chat panel" : "Open chat panel"}
            onClick={() => {
              const nextOpen = !chatOpen;
              setChatOpen(nextOpen);
              if (nextOpen && !isDesktop) setInfoOpen(false);
            }}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full clay-btn text-ink-muted"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <motion.div
            className="clay-btn inline-flex items-center gap-2 rounded-full px-4 py-2 text-10 font-semibold uppercase tracking-[0.12em] text-ink"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: 0.3 }}
          >
            <span className={`h-2 w-2 rounded-full ${voiceState === "listening" ? "bg-accent animate-pulse" : "bg-tallow"}`} />
            Assistant active
          </motion.div>
          <button
            type="button"
            aria-label={infoOpen ? "Close planner panel" : "Open planner panel"}
            title={infoOpen ? "Close planner panel" : "Open planner panel"}
            onClick={() => {
              const nextOpen = !infoOpen;
              setInfoOpen(nextOpen);
              if (nextOpen && !isDesktop) setChatOpen(false);
            }}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full clay-btn text-ink-muted"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Mic bar stays centered beneath the unchanged 3D mascot. */}
        <motion.div
          className="pointer-events-auto flex flex-col items-center gap-3"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring}
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

  const assistantStage = (
    <section className="gourmate-stage relative min-h-[300px] min-w-0 overflow-hidden rounded-[24px]" aria-label="Cooking assistant">
      {avatarLayer}
    </section>
  );
  const desktopChat = chatOpen ? <ChatPanel onSendText={sendText} /> : null;
  const desktopPlanner = infoOpen ? <InfoPanel onSendText={sendText} /> : null;

  const renderDesktopWorkspace = () => {
    if (desktopChat && desktopPlanner && chatSide === plannerSide) {
      const sideStack = (
        <div key={`panels-${chatSide}`} className="gourmate-panel-stack min-w-0 min-h-0">
          {sameSideOrder === "chat-first" ? <>{desktopChat}{desktopPlanner}</> : <>{desktopPlanner}{desktopChat}</>}
        </div>
      );
      return chatSide === "left" ? <>{sideStack}{assistantStage}</> : <>{assistantStage}{sideStack}</>;
    }

    if (desktopChat && desktopPlanner) {
      return chatSide === "left"
        ? <>{desktopChat}{assistantStage}{desktopPlanner}</>
        : <>{desktopPlanner}{assistantStage}{desktopChat}</>;
    }

    if (desktopChat) {
      return chatSide === "left" ? <>{desktopChat}{assistantStage}</> : <>{assistantStage}{desktopChat}</>;
    }

    if (desktopPlanner) {
      return plannerSide === "left" ? <>{desktopPlanner}{assistantStage}</> : <>{assistantStage}{desktopPlanner}</>;
    }

    return assistantStage;
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="gourmate-viewport relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-bg p-3 text-ink sm:p-4">
      <GlassBackdrop />
      <div className="gourmate-shell relative z-10 flex h-[96dvh] min-h-[min(560px,96dvh)] w-[97vw] max-w-[1680px] flex-col overflow-hidden rounded-[26px] border border-[color:var(--header-border)] bg-[color:var(--header-bg)] p-3 shadow-[0_24px_90px_rgba(18,47,34,0.15)] sm:p-4">
        <header className="gourmate-header relative z-40 flex h-[60px] shrink-0 items-center justify-between rounded-full border border-[color:var(--header-border)] bg-[color:var(--header-bg)] px-3 shadow-[var(--header-shadow)] sm:px-4">
          <motion.div
            className="flex min-w-0 items-center gap-2.5"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: 0.15 }}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#FFD275] to-[#E98235] text-[#27352A] shadow-[0_3px_10px_rgba(224,112,42,0.25)]">
              <ChefHat className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="shrink-0 font-display text-18 font-bold text-ink">{UI.appName}</span>
            <span aria-hidden="true" className="text-ink-muted">·</span>
            <span className="max-w-[45vw] truncate text-12 font-medium text-verdigris sm:max-w-[34ch]">
              {recipe?.title ?? "Healthy Beef Kaldereta"}
            </span>
          </motion.div>

          <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
        {phase === "cooking" && (
          <motion.button
            type="button"
            onClick={handleEndSession}
            aria-label={UI.endSession}
            title={UI.endSession}
            {...pressProps}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2/60 text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Power className="h-5 w-5" />
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
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2/60 text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {focusMode ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </motion.button>
        )}
        <motion.button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label={UI.settings}
          title={UI.settings}
          {...pressProps}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2/60 text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Settings2 className="h-5 w-5" />
        </motion.button>
          </div>
        </header>

      {/* Top-center column — triage first, then notifications (sound prompt +
          toasts) so both stay readable and never cover the floating controls. */}
      <div className="pointer-events-auto absolute left-1/2 top-[84px] z-30 flex w-[min(92vw,36rem)] -translate-x-1/2 flex-col gap-3">
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
              className="flex w-full items-center gap-3 rounded-md border border-white/10 bg-surface px-4 py-3 shadow-warm"
            >
              <Volume2 className="h-4 w-4 shrink-0 text-steel" aria-hidden="true" />
              <motion.button
                type="button"
                onClick={handleEnableSound}
                {...pressProps}
                className="min-h-[44px] flex-1 text-left text-14 font-medium text-ink transition-colors duration-micro ease-ui hover:text-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {UI.tapToEnableSound}
              </motion.button>
              <motion.button
                type="button"
                onClick={() => setSoundPrompt(false)}
                aria-label={UI.dismiss}
                {...pressProps}
                className="rounded-sm p-1.5 text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X className="h-4 w-4" />
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
        <ErrorToast onRetry={() => void start()} />
      </div>

      <div
        style={{
          "--chat-width": `${chatWidth * 1.0357}fr`,
          "--planner-width": `${plannerWidth}fr`,
          "--left-width": `${chatSide === "left" ? chatWidth * 1.0357 : plannerWidth}fr`,
          "--right-width": `${chatSide === "right" ? chatWidth * 1.0357 : plannerWidth}fr`,
          "--center-chat-width": `${chatWidth * 1.0357 * (71 / 29)}fr`,
          "--center-planner-width": `${plannerWidth * (72 / 28)}fr`,
          "--center-both-width": `${(chatWidth + plannerWidth) * (43 / 57)}fr`,
          "--same-side-width": `${chatWidth * 1.0357 + plannerWidth}fr`,
          "--same-side-center-width": `${(chatWidth * 1.0357 + plannerWidth) * (43 / 57)}fr`
        } as CSSProperties}
        className={[
          "gourmate-workspace relative z-10 grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto_auto] gap-3 pt-3 transition-[grid-template-columns] duration-300 ease-in-out lg:grid-rows-1",
          isDesktop && chatOpen && infoOpen && chatSide !== plannerSide
            ? "lg:grid-cols-[minmax(250px,var(--left-width))_minmax(340px,var(--center-both-width))_minmax(250px,var(--right-width))]"
            : isDesktop && chatOpen && infoOpen
              ? chatSide === "left"
                ? "lg:grid-cols-[minmax(460px,var(--same-side-width))_minmax(340px,var(--same-side-center-width))]"
                : "lg:grid-cols-[minmax(340px,var(--same-side-center-width))_minmax(460px,var(--same-side-width))]"
              : isDesktop && chatOpen
                ? chatSide === "left"
                  ? "lg:grid-cols-[minmax(260px,var(--chat-width))_minmax(340px,var(--center-chat-width))]"
                  : "lg:grid-cols-[minmax(340px,var(--center-chat-width))_minmax(260px,var(--chat-width))]"
                : isDesktop && infoOpen
                  ? plannerSide === "left"
                    ? "lg:grid-cols-[minmax(260px,var(--planner-width))_minmax(340px,var(--center-planner-width))]"
                    : "lg:grid-cols-[minmax(340px,var(--center-planner-width))_minmax(260px,var(--planner-width))]"
                  : isDesktop
                    ? "lg:grid-cols-1"
                    : ""
        ].join(" ")}
      >
        {isDesktop ? renderDesktopWorkspace() : (
          <>
            {assistantStage}
            <InfoPanel onSendText={sendText} />
            <ChatPanel onSendText={sendText} />
          </>
        )}
      </div>

      {/* Dialogs stay viewport-fixed overlays. */}
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {!onboarded && <Onboarding onAllowMic={handleAllowMic} onStart={handleStart} />}
      </div>
    </div>
    </MotionConfig>
  );
}
