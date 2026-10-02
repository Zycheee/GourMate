/** GourMate — one workspace for the chef, conversation, and cooking plan. */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion, type MotionStyle } from "framer-motion";
import { BookOpen, ChevronDown, ChevronUp, ChefHat, MessageCircle, Maximize2, Minimize2, Power, Settings2, Volume2, X } from "lucide-react";
import ChatPanel from "./components/ChatPanel";
import Confetti from "./components/Confetti";
import ErrorToast from "./components/ErrorToast";
import InfoPanel from "./components/InfoPanel";
import MicStatus from "./components/MicStatus";
import Onboarding from "./components/Onboarding";
import SettingsSheet from "./components/SettingsSheet";
import TriageBanner from "./components/TriageBanner";
import { useVoiceSession } from "./hooks/useVoiceSession";
import { useChefLayout, useClosingSurface, usePanelProgress } from "./hooks/useChefLayout";
import { useSession } from "./store/session";
import { useMediaQuery } from "./lib/useMediaQuery";
import { UI } from "./lib/copy";
import { pressProps, spring } from "./lib/motion";
import { applyAccentTheme, MODEL_COLOR, resolveTheme } from "./lib/theme";
import { isAudioUnlocked, resumeAudioContext } from "./lib/audio";
import type { ConversationAction } from "./types";

// The 3D avatar (three + @react-three + @react-spring) is the heaviest part of
// the bundle. Load it on demand so the entry chunk ships without it; the app
// boots immediately behind AvatarFallback and swaps in the canvas when ready.
const Avatar3D = lazy(() => import("./components/Avatar3D"));

/**
 * Lightweight, on-brand stand-in for the 3D canvas while the avatar chunk
 * loads. Mirrors Avatar3D's glossy squircle + pill eyes + small chef toque
 * (design §3); `absolute inset-0` preserves the contained chef stage.
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
        <div className="relative mt-1 h-28 w-28 rounded-[34px] shadow-warm-lg" style={{ backgroundColor: MODEL_COLOR }}>
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
 * Publish the independent interface brand palette (`lib/theme.ts`) as CSS custom
 * properties on mount so the `accent*` Tailwind colors and `var(--accent*)`
 * hooks resolve from one source of truth (the interface brand colors).
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
 * N / R send the cook voice lines; Esc exits the focused cooking view. All of
 * them yield while focus is in a field or on a control, and Esc yields to the
 * Settings/Onboarding dialogs (they keep their own Escape handling).
 */
function useGlobalShortcuts(
  toggleMute: () => void,
  interrupt: () => void,
  sendAction: (action: ConversationAction, displayText?: string) => void,
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
        s.setFocusMode(false);
        return;
      }

      // Text shortcuts are cook-mode only and never hijack browser chords.
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (useSession.getState().phase !== "cooking") return;
      if (e.key === "n" || e.key === "N") {
        sendAction({ name: "advance_step" }, UI.quick.nextText);
      } else if (e.key === "r" || e.key === "R") {
        sendAction({ name: "repeat_step" }, UI.quick.repeatText);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMute, interrupt, sendAction, dialogsOpen]);
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
  const voiceState = useSession((s) => s.voiceState);
  const sleeping = useSession((s) => s.sleeping);
  const onboarded = useSession((s) => s.onboarded);
  const setOnboarded = useSession((s) => s.setOnboarded);
  const micDeviceId = useSession((s) => s.settings.micDeviceId);
  const voice = useSession((s) => s.settings.voice);
  const soundPrompt = useSession((s) => s.soundPrompt);
  const setSoundPrompt = useSession((s) => s.setSoundPrompt);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const { start, sendText, sendAction, toggleMute, setVoice, restartMic, disconnect, interrupt, wake, setVoiceWake } = useVoiceSession();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [workspaceTab, setWorkspaceTab] = useState<"chat" | "recipe">("chat");
  const [chatDraft, setChatDraft] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [recipeOpen, setRecipeOpen] = useState(false);
  // Conversation owns the shared desktop group and mobile drawer visibility.
  const drawerOpen = chatOpen;
  const setDrawerOpen = setChatOpen;
  const reducedMotion = useReducedMotion();
  const { progress, presentationRef, portraitRef } = useChefLayout(chatOpen, reducedMotion);
  const recipeProgress = usePanelProgress(recipeOpen, reducedMotion);
  const choices = useSession((s) => s.choices);
  useEffect(() => {
    // Confirmations must remain visible even when the cooking tab is active.
    if (choices?.some(choice => ["continue", "stay", "yes", "not_yet"].includes(choice.id))) {
      setChatOpen(true); setWorkspaceTab("chat");
    }
  }, [choices]);
  const panelsPresent = useClosingSurface(chatOpen, progress);
  const recipePresent = useClosingSurface(recipeOpen, recipeProgress);
  const previousPhase = useRef(phase);
  useEffect(() => {
    if (previousPhase.current !== phase) {
      setWorkspaceTab(phase === "intake" ? "chat" : "recipe");
      if (phase !== "intake") { setRecipeOpen(true); }
      else { setRecipeOpen(false); setChatOpen(true); setDrawerOpen(true); }
    }
    previousPhase.current = phase;
  }, [phase]);
  const previousRecipe = useRef(recipe);
  useEffect(() => {
    if (recipe && recipe !== previousRecipe.current) {
      setRecipeOpen(true); setWorkspaceTab("recipe");
    }
    previousRecipe.current = recipe;
  }, [recipe]);
  const audioUnlocked = useAudioUnlock();
  const focusMode = useSession((s) => s.focusMode);
  const setFocusMode = useSession((s) => s.setFocusMode);
  useEffect(() => {
    if (phase !== "cooking") setFocusMode(false);
  }, [phase, setFocusMode]);
  useApplyTheme();
  useAccentTheme();
  useGlobalShortcuts(toggleMute, interrupt, sendAction, settingsOpen || !onboarded);

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
    sendAction({ name: "reset" }, phase === "planning" ? UI.plan.cancelPlanText : UI.plan.stopCookingText);
  }, [phase, sendText]);

  /** Explicit gesture for the "Tap to enable sound" affordance. */
  const handleEnableSound = useCallback(() => {
    void resumeAudioContext().then((ok) => {
      if (ok) setSoundPrompt(false);
    });
  }, [setSoundPrompt]);

  /** Focused cooking simplifies supporting panels while keeping the chef visible. */
  const toggleFocus = useCallback(() => {
    const next = !useSession.getState().focusMode;
    setFocusMode(next);
    if (next) { setWorkspaceTab("recipe"); setRecipeOpen(true); setDrawerOpen(true); }
  }, [setFocusMode]);

  // Full teardown only on unmount (PWA keeps the page alive).
  useEffect(() => {
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const desktopPanelsVisible = chatOpen;
  const avatarExpanded = isDesktop ? !desktopPanelsVisible : !drawerOpen;
  const avatarLayer = (
    <div className="chef-stage">
      <div className="chef-stage-caption">
        <span className="stage-eyebrow">Kef, your kitchen companion</span>
        <span className="stage-state">{sleeping ? "Asleep · Tap Kef to wake" : UI.ariaVoiceState[voiceState]}</span>
      </div>
      <div className="chef-presentation" ref={presentationRef}>
      <div className="chef-portrait" ref={portraitRef}>
        <Suspense fallback={<AvatarFallback />}><Avatar3D /></Suspense>
        {sleeping && <button type="button" className="kef-wake-target" aria-label="Wake Kef" onClick={() => wake()} />}
      </div>
      </div>
      {phase === "done" && <Confetti />}
      <div className="chef-voice"><MicStatus onToggleMute={toggleMute} /></div>
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
      className="kitchen-app relative h-[100dvh] w-full overflow-hidden bg-bg text-ink"
    >
      {/* Quiet brand canvas behind the unchanged 3D avatar. */}
      <div aria-hidden="true" className="clay-canvas pointer-events-none absolute inset-0 z-0" />

      {/* Raised clay header matching Chat section and Planner Section */}
      <header className="workspace-header">
        {/* Leftmost: logo and name */}
        <div className="flex items-center gap-2.5 min-w-0">
          <ChefHat className="h-5 w-5 sm:h-6 sm:w-6 text-castleton-green dark:text-earth-yellow shrink-0" aria-hidden="true" />
          <span className="shrink-0 font-display text-18 sm:text-20 font-semibold tracking-tight brand-wordmark">
            {UI.appName}
          </span>
          <span className="brand-subtitle">A little guidance. A great meal.</span>
        </div>

        {/* Right: Controls & settings button */}
        <div className="flex items-center gap-2">
          <span className="session-badge">{phase === "intake" ? "Let’s plan" : phase === "planning" ? "Recipe ready" : phase === "cooking" ? "Cooking together" : "Meal complete"}</span>
          {phase === "cooking" && (
            <motion.button
              type="button"
              onClick={handleEndSession}
              aria-label={UI.endSession}
              title={UI.endSession}
              {...pressProps}
              className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full clay-control text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
              className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full clay-control text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
            className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full clay-control text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Settings2 className="h-4 w-4" />
          </motion.button>
        </div>
      </header>

      {/* Notifications occupy their own row so the chef's measured space stays clear. */}
      <div className="workspace-notices">
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
              className="flex w-full items-center gap-2.5 rounded-[24px] clay px-4 py-2.5 clay-soft"
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
                className="flex h-7 w-7 items-center justify-center rounded-full clay-control text-ink-muted transition-colors duration-micro ease-ui hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X className="h-3.5 w-3.5" />
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
        <ErrorToast onRetry={() => void start()} />
      </div>

      <motion.main className="avatar-workspace" data-focus={focusMode} data-expanded={avatarExpanded}
        style={{ "--panel-progress": progress, "--recipe-progress": recipeProgress } as MotionStyle}>
        {avatarLayer}
        {isDesktop ? <>
          <nav className="folder-rail" aria-label="Workspace panels">
            {!chatOpen && <button type="button" className="folder-tab" aria-label="Conversation" aria-expanded={false} aria-controls="content-group"
              onClick={() => setChatOpen(!chatOpen)}>
              <span className="folder-face clay-control"><MessageCircle size={16} aria-hidden="true" /><span>Conversation</span></span>
            </button>}
          </nav>
          <div className="content-track">
          <div id="content-group" className="content-group clay-strong" data-recipe-open={recipeOpen} data-open={chatOpen}
            hidden={!panelsPresent} aria-hidden={!chatOpen} ref={el => { if (el) el.inert = !chatOpen; }}>
          {!recipeOpen && <button type="button" className="recipe-folder clay-control" aria-label="Recipe" aria-expanded={false} aria-controls="recipe-workspace" onClick={() => setRecipeOpen(true)}>
            <BookOpen size={16} aria-hidden="true" /><span>Recipe</span>
          </button>}
          <div className="content-panels" data-chat-open={chatOpen} data-recipe-open={recipeOpen}>
            <div id="chat-workspace" className="panel-body chat-side">
              <ChatPanel onSendAction={sendAction} draft={chatDraft} onDraftChange={setChatDraft} active={chatOpen} onSendText={sendText} onShowRecipe={() => setRecipeOpen(true)}
                onMinimize={() => { setChatOpen(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('button[aria-label="Conversation"]')?.focus()); }} />
            </div>
            <div id="recipe-workspace" className="panel-body recipe-side" hidden={!recipePresent} aria-hidden={!recipeOpen} ref={el => { if (el) el.inert = !recipeOpen; }}>
              <InfoPanel onSendAction={sendAction} onSendText={sendText} onMinimize={() => { setRecipeOpen(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('button[aria-label="Recipe"]')?.focus()); }} />
            </div>
          </div>
          </div>
          </div>
        </> : <div className="mobile-drawer clay-strong" data-open={drawerOpen}>
          <div className="drawer-bar">
            <div role="tablist" aria-label="Kitchen workspace" className="workspace-tabs">
              {(["chat", "recipe"] as const).filter((tab) => drawerOpen || tab === "chat").map((tab, index) => <button key={tab} id={`${tab}-tab`} role="tab"
                aria-selected={!drawerOpen || workspaceTab === tab} aria-controls={`${tab}-workspace`} tabIndex={!drawerOpen || workspaceTab === tab ? 0 : -1}
                onClick={() => { if (drawerOpen) setWorkspaceTab(tab); setDrawerOpen(true); if (tab === "chat" && drawerOpen) setFocusMode(false); }}
                onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  if (!drawerOpen) return;
                  event.preventDefault(); const next = index === 0 ? "recipe" : "chat"; setWorkspaceTab(next); setDrawerOpen(true);
                  if (next === "chat") setFocusMode(false); document.getElementById(`${next}-tab`)?.focus();
                } }}>
                {tab === "chat" ? <MessageCircle size={16} /> : <BookOpen size={16} />}
                {tab === "chat" ? "Conversation" : phase === "cooking" ? "Cooking" : "Recipe"}
              </button>)}
            </div>
            <button type="button" className="drawer-toggle clay-control" aria-label={drawerOpen ? "Collapse panel" : "Expand panel"}
              aria-expanded={drawerOpen} aria-controls="drawer-content" onClick={() => setDrawerOpen(!drawerOpen)}>
              {drawerOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
            </button>
          </div>
          <div id="drawer-content" className="drawer-content" hidden={!drawerOpen}>
            <div id="chat-workspace" role="tabpanel" aria-labelledby="chat-tab" className="panel-body" hidden={workspaceTab !== "chat"}>
              <ChatPanel onSendAction={sendAction} draft={chatDraft} onDraftChange={setChatDraft} active={drawerOpen && workspaceTab === "chat"} onSendText={sendText} onShowRecipe={() => setWorkspaceTab("recipe")} />
            </div>
            <div id="recipe-workspace" role="tabpanel" aria-labelledby="recipe-tab" className="panel-body" hidden={workspaceTab !== "recipe"}>
              <InfoPanel onSendAction={sendAction} onSendText={sendText} />
            </div>
          </div>
        </div>}
      </motion.main>

      {/* Dialogs stay viewport-fixed overlays. */}
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} onVoiceWakeChange={setVoiceWake} />

      {!onboarded && <Onboarding onAllowMic={handleAllowMic} onStart={handleStart} onUseText={() => {
        useSession.getState().setMuted(true);
        handleStart();
      }} />}
    </div>
    </MotionConfig>
  );
}
