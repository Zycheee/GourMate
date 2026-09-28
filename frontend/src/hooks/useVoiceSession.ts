/**
 * useVoiceSession — glue between the WebSocket session, the audio pipeline
 * and the zustand store (design §9 "State wiring").
 *
 * Every avatar `voiceState` in this hook maps to a real architecture §7 event:
 *   listening  ← vad speech_start (or state)
 *   submitting ← vad speech_end (or state)
 *   processing ← transcript final / state
 *   answering  ← assistant_audio / state
 *   triage     ← state
 *   error      ← typed error event
 *   idle       ← state idle / turn_end / TTS drain
 */

import { useCallback, useEffect, useRef } from "react";
import { useSession } from "../store/session";
import { SessionSocket } from "../lib/ws";
import { MicCapture, TtsPlayer, ensureAudioContext, getAudioContextState } from "../lib/audio";
import {
  createTimer,
  notifyTimerDone,
  recomputeTimers,
  requestNotificationPermission,
  saveTimers
} from "../lib/timers";
import { saveToCookbook } from "../lib/cookbook";
import { ERROR_COPY, COPY, timerDoneMessage, UI } from "../lib/copy";
import type { ServerMessage, ToolName, VoiceState } from "../types";

function executeTool(name: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  const s = useSession.getState();
  const recipe = s.recipe;

  switch (name) {
    case "advance_step": {
      const from =
        typeof args.from_step_index === "number" ? args.from_step_index : s.currentStepIndex;
      const next = recipe ? Math.min(from + 1, recipe.steps.length - 1) : from;
      if (recipe) s.setStepIndex(next);
      const step = recipe?.steps.find((st) => st.index === next) ?? null;
      return { ok: true, step_index: next, instruction: step?.instruction ?? "" };
    }
    case "repeat_step": {
      const idx = typeof args.step_index === "number" ? args.step_index : s.currentStepIndex;
      const step = recipe?.steps.find((st) => st.index === idx) ?? null;
      // Repeat re-reads; it never moves the cursor.
      return {
        ok: Boolean(step),
        step_index: s.currentStepIndex,
        repeated_index: idx,
        instruction: step?.instruction ?? ""
      };
    }
    case "go_to_step": {
      const idx = Number(args.step_index);
      if (recipe && Number.isFinite(idx) && idx >= 0 && idx < recipe.steps.length) {
        s.setStepIndex(idx);
      }
      const cur = useSession.getState().currentStepIndex;
      const step = recipe?.steps.find((st) => st.index === cur) ?? null;
      return { ok: true, step_index: cur, instruction: step?.instruction ?? "" };
    }
    case "create_kitchen_timer": {
      const label = String(args.label ?? "Timer");
      const duration = Number(args.duration_seconds);
      const related =
        typeof args.related_step_index === "number" ? args.related_step_index : null;
      if (!Number.isFinite(duration) || duration <= 0) {
        return { ok: false, error: "invalid duration_seconds" };
      }
      const timer = createTimer({ label, duration_seconds: duration, related_step_index: related });
      s.addTimer(timer);
      return {
        ok: true,
        id: timer.id,
        label: timer.label,
        duration_seconds: timer.duration_seconds,
        ends_at: timer.ends_at
      };
    }
    case "cancel_timer": {
      const cancelled = s.cancelTimerByLabel(String(args.label ?? ""));
      return cancelled
        ? { ok: true, id: cancelled.id, label: cancelled.label }
        : { ok: false, error: "no matching active timer" };
    }
    case "substitute_ingredient": {
      const needle = String(args.ingredient ?? "").trim().toLowerCase();
      const match = recipe?.ingredients.find(
        (i) =>
          i.name.toLowerCase().includes(needle) ||
          (needle.length > 0 && needle.includes(i.name.toLowerCase()))
      );
      if (!match) return { ok: false, error: "ingredient not found", advisory: true };
      return {
        ok: true,
        advisory: true,
        ingredient: match.display,
        substitutions: match.substitutions.map((sub) => ({
          substitute: sub.substitute,
          ratio: sub.ratio,
          note: sub.note
        }))
      };
    }
    default: {
      // Defensive: a tool call outside the §9.2 registry is rejected, not guessed at.
      return { ok: false, error: `unknown tool: ${String(name)}` };
    }
  }
}

function navTool(name: ToolName): boolean {
  return name === "advance_step" || name === "go_to_step" || name === "repeat_step";
}

export interface VoiceSessionApi {
  start: () => Promise<void>;
  stop: () => void;
  sendText: (text: string) => void;
  toggleMute: () => void;
  setVoice: (voice: string) => void;
  restartMic: () => Promise<void>;
  interrupt: () => void;
  disconnect: () => void;
}

export function useVoiceSession(): VoiceSessionApi {
  const socketRef = useRef<SessionSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const ttsRef = useRef<TtsPlayer | null>(null);
  const startedRef = useRef(false);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  /** True when the in-flight turn offered `choices` chips (see `turn_end`). */
  const choicesOfferedRef = useRef(false);
  /** Timestamp of the last server event — drives the stuck-state watchdog. */
  const lastActivityRef = useRef(Date.now());

  /* ---------------- server events → store / avatar ---------------- */

  const handleMessage = useCallback((msg: ServerMessage) => {
    const s = useSession.getState();
    lastActivityRef.current = Date.now();

    switch (msg.type) {
      case "ready": {
        s.setSessionId(msg.session_id);
        socketRef.current?.sendSync();
        break;
      }

      case "vad": {
        if (msg.state === "speech_start") {
          s.setUserSpeaking(true);
          // Barge-in (design §4): speaking over the assistant stops playback.
          if (s.voiceState === "answering" || ttsRef.current?.isBusy) {
            ttsRef.current?.stop();
            socketRef.current?.send({ type: "control", action: "barge_in" });
          }
          s.setVoiceState("listening");
        } else {
          s.setUserSpeaking(false);
          s.setVoiceState("submitting");
        }
        break;
      }

      case "transcript": {
        // Only the final transcript is shown; live partials were unreliable and
        // are not displayed (the backend no longer emits `final:false`).
        if (msg.final) {
          // The user answered by voice — offered chips are superseded.
          s.setChoices(null);
          s.setLiveCaption("");
          const said = msg.text.trim();
          if (said) {
            // Recognized line stays on the canvas until the assistant replies
            // (design §5.1 continuous canvas).
            s.setUserTranscript(said);
            s.addChat({ role: "user", text: said });
          }
          if (s.voiceState !== "triage") s.setVoiceState("processing");
        }
        break;
      }

      case "choices": {
        // Tappable multiple-choice options (§7 `choices` / `offer_choices`).
        s.setChoices(msg.options);
        choicesOfferedRef.current = true;
        break;
      }

      case "assistant_text": {
        const line = msg.text.trim();
        if (!line) break;
        // First chunk of a reply: the assistant is taking the floor.
        if (!s.liveCaption) s.setUserTranscript("");
        const caption = s.liveCaption ? `${s.liveCaption} ${line}` : line;
        s.setLiveCaption(caption);
        if (s.voiceState === "triage" || s.triage) {
          // Triage banner carries the corrective action (design §5.2).
          s.setTriage({ message: caption });
        }
        break;
      }

      case "assistant_audio": {
        ttsRef.current?.enqueue(msg.seq, msg.data);
        // Autoplay gate: audio queued while the shared context is suspended
        // would play silently — surface the enable-sound affordance instead.
        if (getAudioContextState() === "suspended") {
          s.setSoundPrompt(true);
        }
        if (s.voiceState !== "triage" && s.voiceState !== "error") {
          s.setVoiceState("answering");
        }
        break;
      }

      case "tool_call": {
        const result = executeTool(msg.name, msg.arguments ?? {});
        s.addChat({
          role: "tool",
          text: `tool:${msg.name}`,
          tool_call: {
            call_id: msg.call_id,
            name: msg.name,
            arguments: msg.arguments ?? {}
          }
        });
        socketRef.current?.send({ type: "tool_result", call_id: msg.call_id, result });
        if (navTool(msg.name) || msg.name === "create_kitchen_timer" || msg.name === "cancel_timer") {
          const st = useSession.getState();
          socketRef.current?.send({
            type: "recipe_state",
            phase: st.phase,
            recipe: st.recipe,
            current_step_index: st.currentStepIndex,
            timers: st.timers
          });
        }
        break;
      }

      case "state": {
        // Server-authoritative avatar state (architecture §7).
        s.setVoiceState(msg.voice_state);
        if (msg.voice_state === "triage") {
          s.setTriage({ message: s.liveCaption || s.triage?.message || UI.triageLabel });
        } else if (s.triage && msg.voice_state === "idle") {
          s.setTriage(null);
        }
        if (msg.voice_state !== "idle") s.setToast(null);
        break;
      }

      case "recipe": {
        s.setRecipe(msg.recipe);
        saveToCookbook(msg.recipe);
        s.setTriage(null);
        s.setUserTranscript("");
        requestNotificationPermission();
        break;
      }

      case "plan": {
        // Planning result (§7 `plan`): same bookkeeping as `recipe`, but the
        // phase becomes "planning" until the user confirms and cooking starts.
        s.setPlan(msg.recipe);
        saveToCookbook(msg.recipe);
        s.setTriage(null);
        s.setUserTranscript("");
        requestNotificationPermission();
        break;
      }

      case "reset": {
        // Server-driven cancel/discontinue (§7 `reset`). Stop any in-flight
        // assistant audio like the local stop paths (the echo gate flips with
        // `resetSession`'s idle voice state), then return to intake and drop
        // every kitchen timer (persisted, so a refresh cannot resurrect them).
        ttsRef.current?.stop();
        s.resetSession();
        s.setTimers([]);
        break;
      }

      case "done": {
        // Recipe complete (§7 `done`): keep the recipe and timers for the
        // completion card, mark the phase, and settle the voice like
        // `turn_end` does when nothing is still playing.
        s.setPhase("done");
        if (!s.userSpeaking && !ttsRef.current?.isBusy && s.voiceState !== "triage") {
          s.setVoiceState("idle");
        }
        break;
      }

      case "error": {
        const text = ERROR_COPY[msg.code] ?? msg.message;
        if (msg.code === "tts_failed") {
          // Text-only fallback: captions already carry the message (EH-5).
          break;
        }
        s.setVoiceState("error");
        if (text) {
          s.setToast({
            kind: "error",
            message: msg.code === "engine_loading" ? COPY.engineWarming : text
          });
        }
        if (msg.code === "out_of_scope" && s.liveCaption) {
          s.setLiveCaption(`${s.liveCaption} ${ERROR_COPY.out_of_scope}`);
        }
        window.setTimeout(() => {
          const cur = useSession.getState();
          if (cur.voiceState === "error") cur.setVoiceState("idle");
        }, 2600);
        break;
      }

      case "rate_limited": {
        s.setVoiceState("error");
        s.setToast({ kind: "rate_limit", message: COPY.rateLimited, retryAfter: msg.retry_after });
        window.setTimeout(() => {
          const cur = useSession.getState();
          if (cur.voiceState === "error") cur.setVoiceState("idle");
        }, 2600);
        break;
      }

      case "turn_end": {
        // Chips offered during this turn stay; anything older is stale.
        if (!choicesOfferedRef.current) s.setChoices(null);
        choicesOfferedRef.current = false;
        if (s.liveCaption.trim()) {
          s.addChat({ role: "assistant", text: s.liveCaption.trim() });
        }
        s.setUserTranscript("");
        if (!s.userSpeaking && !ttsRef.current?.isBusy && s.voiceState !== "triage") {
          s.setVoiceState("idle");
        }
        if (s.voiceState === "triage" && !ttsRef.current?.isBusy) {
          s.setTriage(null);
          s.setVoiceState("idle");
        }
        break;
      }
    }
  }, []);

  /* ---------------- lifecycle ---------------- */

  const start = useCallback(async () => {
    const s = useSession.getState();
    ensureAudioContext();
    requestNotificationPermission();

    if (!socketRef.current) {
      socketRef.current = new SessionSocket({
        onMessage: handleMessage,
        onStatus: (status) => useSession.getState().setConnection(status),
        // Every open (first connect + reconnects) re-applies the preferred
        // voice so the session always speaks with `settings.voice`.
        onOpen: () => {
          socketRef.current?.send({
            type: "control",
            action: "set_voice",
            voice: useSession.getState().settings.voice
          });
        },
        getStateForSync: () => useSession.getState().sessionSnapshot(null)
      });
    }
    socketRef.current.connect();

    if (!ttsRef.current) ttsRef.current = new TtsPlayer();

    if (!micRef.current) {
      micRef.current = new MicCapture({
        onPcm: (frame) => {
          const s = useSession.getState();
          // Echo gate: never stream our own TTS (played through speakers) back.
          if (s.muted || s.voiceState === "answering") return;
          socketRef.current?.sendPcm(frame);
        },
        onError: (err) => {
          const store = useSession.getState();
          // Missing/forbidden capture (insecure context, permission denied,
          // no device, device busy) is a mic problem; `workletUnsupported` is
          // reserved for a genuine capture failure after the fallback path.
          const insecure =
            typeof navigator === "undefined" ||
            !navigator.mediaDevices ||
            typeof navigator.mediaDevices.getUserMedia !== "function";
          const denied =
            insecure ||
            err.name === "mic_denied" ||
            err.name === "NotAllowedError" ||
            err.name === "NotFoundError" ||
            err.name === "NotReadableError" ||
            err.name === "SecurityError";
          store.setToast({
            kind: "error",
            message: denied ? COPY.micDenied : UI.workletUnsupported
          });
          store.setVoiceState("error");
          window.setTimeout(() => {
            const cur = useSession.getState();
            if (cur.voiceState === "error") cur.setVoiceState("idle");
          }, 2600);
        }
      });
    }
    await micRef.current.start(s.settings.micDeviceId);

    // Timers that fired while the tab was closed (architecture §14).
    const completed = s.hydrateTimers();
    for (const timer of completed) {
      const message = timerDoneMessage(timer.label);
      notifyTimerDone(timer, s.settings.timerSound);
      s.setLiveCaption(message);
      s.setToast({ kind: "info", message });
    }
    startedRef.current = true;
  }, [handleMessage]);

  const stop = useCallback(() => {
    micRef.current?.stop();
    ttsRef.current?.stop();
  }, []);

  /** Explicit barge-in: stop assistant audio and cancel the in-flight turn. */
  const interrupt = useCallback(() => {
    ttsRef.current?.stop();
    socketRef.current?.send({ type: "control", action: "barge_in" });
  }, []);

  const disconnect = useCallback(() => {
    micRef.current?.stop();
    ttsRef.current?.stop();
    socketRef.current?.close();
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    startedRef.current = false;
  }, []);

  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const s = useSession.getState();
    // A new user turn supersedes any offered chips (tapped or typed).
    s.setChoices(null);
    s.addChat({ role: "user", text: trimmed });
    s.setLiveCaption("");
    s.setVoiceState("processing");
    socketRef.current?.send({ type: "text_input", text: trimmed });
  }, []);

  const toggleMute = useCallback(() => {
    const s = useSession.getState();
    const next = !s.muted;
    s.setMuted(next);
    socketRef.current?.send({ type: "control", action: next ? "mute" : "unmute" });
  }, []);

  /** §7 `set_voice` control — no-op when the socket is not open. */
  const setVoice = useCallback((voice: string) => {
    socketRef.current?.send({ type: "control", action: "set_voice", voice });
  }, []);

  /** Re-open the capture device (settings change of `micDeviceId`). */
  const restartMic = useCallback(async () => {
    const s = useSession.getState();
    if (!micRef.current) return;
    await micRef.current.start(s.settings.micDeviceId);
  }, []);

  /* timer completion watchdog — 1 s tick, recomputed from ends_at */
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useSession.getState();
      const { timers, completed } = recomputeTimers(s.timers);
      if (completed.length === 0) return;
      saveTimers(timers);
      s.setTimers(timers);
      for (const timer of completed) {
        const message = timerDoneMessage(timer.label);
        notifyTimerDone(timer, s.settings.timerSound);
        s.setLiveCaption(message);
        s.setToast({ kind: "info", message });
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  /* stuck-state watchdog — if the server stops driving the voice state (a
     dropped turn, a reload mid-turn), the client would sit in a non-idle state
     forever and the echo gate (`onPcm`) would keep dropping mic frames. Reset
     to idle after a quiet spell so capture resumes. */
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useSession.getState();
      if (s.voiceState === "idle" || s.voiceState === "error") return;
      if (Date.now() - lastActivityRef.current > 20_000) {
        s.setVoiceState("idle");
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  /* wake lock during Cook Mode (design §7) */
  useEffect(() => {
    let cancelled = false;
    type WakeLockLike = {
      request?: (type: "screen") => Promise<{ release: () => Promise<void> }>;
    };
    const wakeLockApi = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;

    const request = async (): Promise<void> => {
      if (useSession.getState().phase !== "cooking") return;
      if (!wakeLockApi?.request) return;
      try {
        const sentinel = await wakeLockApi.request("screen");
        if (cancelled) {
          await sentinel.release();
          return;
        }
        wakeLockRef.current = sentinel;
      } catch {
        /* wake lock unavailable */
      }
    };
    void request();

    const onVisible = (): void => {
      if (document.visibilityState === "visible") void request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
    };
  }, []);

  /* reconnect watchdog: silence + status only; ws.ts handles backoff + sync */
  useEffect(() => {
    return () => {
      micRef.current?.stop();
      ttsRef.current?.stop();
      socketRef.current?.close();
    };
  }, []);

  return { start, stop, disconnect, sendText, toggleMute, setVoice, restartMic, interrupt };
}

/** Exposed for components that need the live voice state without re-rendering. */
export function currentVoiceState(): VoiceState {
  return useSession.getState().voiceState;
}
