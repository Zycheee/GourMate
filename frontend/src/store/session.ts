/**
 * Session store — architecture §5 "State ownership" mirrored client-side.
 *
 * Persisted (localStorage): phase, recipe, current_step_index, timers,
 * transcript, mute, settings, onboarding. Ephemeral: voice_state (server
 * authoritative), connection, live captions, the recognized user line,
 * toasts, sound prompt.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ChoiceOption,
  ChatTurn,
  ConnectionStatus,
  KitchenTimer,
  Recipe,
  SessionPhase,
  SessionState,
  Settings,
  Toast,
  VoiceState
} from "../types";
import { loadTimers, recomputeTimers, saveTimers } from "../lib/timers";

const DEFAULT_SETTINGS: Settings = {
  voice: "en-US-JennyNeural",
  micDeviceId: null,
  voiceWake: false,
  timerSound: true,
  theme: "auto"
};

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** Recent turns mirrored into `SessionState.turns` on `sync` (architecture §5). */
export const SYNC_TURN_WINDOW = 20;

export interface SessionStore {
  /* ---- persisted ---- */
  phase: SessionPhase;
  recipe: Recipe | null;
  currentStepIndex: number;
  timers: KitchenTimer[];
  transcript: ChatTurn[];
  muted: boolean;
  settings: Settings;
  onboarded: boolean;

  /* ---- ephemeral ---- */
  voiceState: VoiceState;
  connection: ConnectionStatus;
  sessionId: string | null;
  liveCaption: string;
  /** Final recognized user line on the canvas (design §5.1) — never persisted. */
  userTranscript: string;
  userSpeaking: boolean;
  triage: { message: string } | null;
  toast: Toast | null;
  /** Autoplay guard: assistant audio arrived while the AudioContext was suspended. */
  soundPrompt: boolean;
  /** Completed-timer pulse ids (design §5.3 — ring pulses verdigris). */
  pulsedTimerIds: string[];
  /** Floating chat card open (desktop) — ephemeral UI state, never persisted. */
  chatOpen: boolean;
  /** Floating info card open (desktop) — ephemeral UI state, never persisted. */
  infoOpen: boolean;
  /** Immersive cook mode (cards hidden, step card enlarged) — ephemeral. */
  focusMode: boolean;
  /** Offered multiple-choice chips (`choices` event) — ephemeral, never persisted. */
  choices: ChoiceOption[] | null;
  sleeping: boolean;
  wakeListening: boolean;
  lastInteractionAt: number;

  /* ---- actions ---- */
  setPhase: (phase: SessionPhase) => void;
  setRecipe: (recipe: Recipe | null) => void;
  /** Planning result (`plan` event) — recipe ready, awaiting confirmation. */
  setPlan: (recipe: Recipe) => void;
  setStepIndex: (index: number) => void;
  setTimers: (timers: KitchenTimer[]) => void;
  addTimer: (timer: KitchenTimer) => void;
  updateTimer: (id: string, patch: Partial<KitchenTimer>) => void;
  cancelTimerByLabel: (label: string) => KitchenTimer | null;
  clearPulse: (id: string) => void;
  addChat: (turn: Omit<ChatTurn, "id" | "ts"> & Partial<Pick<ChatTurn, "id" | "ts">>) => void;
  setVoiceState: (state: VoiceState) => void;
  setConnection: (status: ConnectionStatus) => void;
  setSessionId: (id: string | null) => void;
  setLiveCaption: (text: string) => void;
  setUserTranscript: (text: string) => void;
  setUserSpeaking: (speaking: boolean) => void;
  setTriage: (triage: { message: string } | null) => void;
  setToast: (toast: Toast | null) => void;
  setSoundPrompt: (visible: boolean) => void;
  setChatOpen: (open: boolean) => void;
  setInfoOpen: (open: boolean) => void;
  setFocusMode: (on: boolean) => void;
  setChoices: (choices: ChoiceOption[] | null) => void;
  setMuted: (muted: boolean) => void;
  setActivity: (sleeping: boolean, wakeListening: boolean, muted?: boolean) => void;
  touchActivity: () => void;
  setSettings: (patch: Partial<Settings>) => void;
  setOnboarded: (onboarded: boolean) => void;
  /** Full SessionState snapshot for `sync` / `recipe_state` messages. */
  sessionSnapshot: (sessionId: string | null) => SessionState;
  /** Reconcile persisted timers with `ends_at` after load/refresh. */
  hydrateTimers: () => KitchenTimer[];
  resetSession: () => void;
}

export const useSession = create<SessionStore>()(
  persist(
    (set, get) => ({
      phase: "intake",
      recipe: null,
      currentStepIndex: 0,
      timers: [],
      transcript: [],
      muted: true,
      settings: DEFAULT_SETTINGS,
      onboarded: false,

      voiceState: "idle",
      connection: "idle",
      sessionId: null,
      liveCaption: "",
      userTranscript: "",
      userSpeaking: false,
      triage: null,
      toast: null,
      soundPrompt: false,
      pulsedTimerIds: [],
      chatOpen: false,
      infoOpen: false,
      focusMode: false,
      choices: null,
      sleeping: true,
      wakeListening: false,
      lastInteractionAt: Date.now(),

      setPhase: (phase) => set({ phase }),

      setRecipe: (recipe) =>
        set({
          recipe,
          currentStepIndex: 0,
          phase: recipe ? "cooking" : "intake"
        }),

      setPlan: (recipe) => set({ recipe, currentStepIndex: 0, phase: "planning" }),

      setStepIndex: (index) => {
        const recipe = get().recipe;
        if (!recipe) return;
        const max = Math.max(0, recipe.steps.length - 1);
        set({ currentStepIndex: Math.min(Math.max(0, index), max) });
      },

      setTimers: (timers) => {
        saveTimers(timers);
        set({ timers });
      },

      addTimer: (timer) => {
        const timers = [...get().timers, timer];
        saveTimers(timers);
        set({ timers });
      },

      updateTimer: (id, patch) => {
        const timers = get().timers.map((t) => (t.id === id ? { ...t, ...patch } : t));
        saveTimers(timers);
        set({ timers });
      },

      cancelTimerByLabel: (label) => {
        const needle = label.trim().toLowerCase();
        const target = get().timers.find(
          (t) => (t.status === "active" || t.status === "paused") && t.label.trim().toLowerCase() === needle
        );
        if (!target) return null;
        const timers = get().timers.map((t) =>
          t.id === target.id ? { ...t, status: "cancelled" as const } : t
        );
        saveTimers(timers);
        set({ timers });
        return target;
      },

      clearPulse: (id) => set({ pulsedTimerIds: get().pulsedTimerIds.filter((p) => p !== id) }),

      addChat: (turn) => {
        const entry: ChatTurn = {
          id: turn.id ?? uid(),
          ts: turn.ts ?? Date.now(),
          role: turn.role,
          text: turn.text,
          ...(turn.tool_call ? { tool_call: turn.tool_call } : {})
        };
        const transcript = [...get().transcript, entry].slice(-200);
        set({ transcript });
      },

      setVoiceState: (voiceState) => set({ voiceState }),
      setConnection: (connection) => set({ connection }),
      setSessionId: (sessionId) => set({ sessionId }),
      setLiveCaption: (liveCaption) => set({ liveCaption }),
      setUserTranscript: (userTranscript) => set({ userTranscript }),
      setUserSpeaking: (userSpeaking) => set({ userSpeaking }),

      setTriage: (triage) => set({ triage }),
      setToast: (toast) => set({ toast }),
      setSoundPrompt: (soundPrompt) => set({ soundPrompt }),
      setChatOpen: (chatOpen) => set({ chatOpen }),
      setInfoOpen: (infoOpen) => set({ infoOpen }),
      setFocusMode: (focusMode) => set({ focusMode }),
      setChoices: (choices) => set({ choices }),
      setMuted: (muted) => set({ muted }),
      setActivity: (sleeping, wakeListening, muted) => set({ sleeping, wakeListening, ...(muted === undefined ? {} : { muted }), lastInteractionAt: Date.now() }),
      touchActivity: () => set({ lastInteractionAt: Date.now() }),

      setSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),
      setOnboarded: (onboarded) => set({ onboarded }),

      sessionSnapshot: (sessionId) => {
        const s = get();
        return {
          session_id: sessionId ?? s.sessionId ?? "",
          phase: s.phase,
          recipe: s.recipe,
          current_step_index: s.currentStepIndex,
          timers: s.timers,
          // Chat-window restore: the recent transcript travels on `sync` so the
          // server can rebuild conversation context after a reconnect.
          turns: s.transcript.slice(-SYNC_TURN_WINDOW)
        };
      },

      hydrateTimers: () => {
        // Local timers are authoritative on the client; rebuild from `ends_at`.
        const loaded = get().timers.length > 0 ? get().timers : loadTimers();
        const { timers, completed } = recomputeTimers(loaded);
        saveTimers(timers);
        set({ timers, pulsedTimerIds: completed.map((t) => t.id) });
        return completed;
      },

      resetSession: () =>
        set({
          phase: "intake",
          recipe: null,
          currentStepIndex: 0,
          transcript: [],
          liveCaption: "",
          userTranscript: "",
          triage: null,
          toast: null,
          soundPrompt: false,
          choices: null,
          voiceState: "idle"
        })
    }),
    {
      name: "gourmate-session-v1",
      partialize: (s) => ({
        phase: s.phase,
        recipe: s.recipe,
        currentStepIndex: s.currentStepIndex,
        timers: s.timers,
        transcript: s.transcript,
        muted: s.muted,
        settings: s.settings,
        onboarded: s.onboarded
      }),
      merge: (persistedState, currentState): SessionStore => {
        const p = (persistedState ?? {}) as Partial<SessionStore>;
        return {
          phase: p.phase ?? currentState.phase,
          recipe: p.recipe !== undefined ? p.recipe : currentState.recipe,
          currentStepIndex: p.currentStepIndex ?? currentState.currentStepIndex,
          timers: p.timers ?? currentState.timers,
          transcript: p.transcript ?? currentState.transcript,
          muted: true,
          sleeping: true,
          wakeListening: false,
          lastInteractionAt: Date.now(),
          settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
          onboarded: p.onboarded ?? currentState.onboarded,

          voiceState: currentState.voiceState,
          connection: currentState.connection,
          sessionId: currentState.sessionId,
          liveCaption: currentState.liveCaption,
          userTranscript: currentState.userTranscript,
          userSpeaking: currentState.userSpeaking,
          triage: currentState.triage,
          toast: currentState.toast,
          soundPrompt: currentState.soundPrompt,
          pulsedTimerIds: currentState.pulsedTimerIds,
          chatOpen: currentState.chatOpen,
          infoOpen: currentState.infoOpen,
          focusMode: currentState.focusMode,
          choices: currentState.choices,

          setPhase: currentState.setPhase,
          setRecipe: currentState.setRecipe,
          setPlan: currentState.setPlan,
          setStepIndex: currentState.setStepIndex,
          setTimers: currentState.setTimers,
          addTimer: currentState.addTimer,
          updateTimer: currentState.updateTimer,
          cancelTimerByLabel: currentState.cancelTimerByLabel,
          clearPulse: currentState.clearPulse,
          addChat: currentState.addChat,
          setVoiceState: currentState.setVoiceState,
          setConnection: currentState.setConnection,
          setSessionId: currentState.setSessionId,
          setLiveCaption: currentState.setLiveCaption,
          setUserTranscript: currentState.setUserTranscript,
          setUserSpeaking: currentState.setUserSpeaking,
          setTriage: currentState.setTriage,
          setToast: currentState.setToast,
          setSoundPrompt: currentState.setSoundPrompt,
          setChatOpen: currentState.setChatOpen,
          setInfoOpen: currentState.setInfoOpen,
          setFocusMode: currentState.setFocusMode,
          setChoices: currentState.setChoices,
          setMuted: currentState.setMuted,
          setActivity: currentState.setActivity,
          touchActivity: currentState.touchActivity,
          setSettings: currentState.setSettings,
          setOnboarded: currentState.setOnboarded,
          sessionSnapshot: currentState.sessionSnapshot,
          hydrateTimers: currentState.hydrateTimers,
          resetSession: currentState.resetSession
        };
      }
    }
  )
);
