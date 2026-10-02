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
import { ReplyGate } from "../lib/replyGate";
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
import type { ConversationAction, ServerMessage, ToolName, VoiceState } from "../types";

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
  sendAction: (action: ConversationAction, displayText?: string) => void;
  toggleMute: () => void;
  setVoice: (voice: string) => void;
  restartMic: () => Promise<void>;
  interrupt: () => void;
  disconnect: () => void;
  wake: (enableMic?: boolean) => void;
  setVoiceWake: (enabled: boolean) => void;
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
  const replyGate = useRef(new ReplyGate());
  const utteranceRef = useRef<string | null>(null);
  const submittedUtterances = useRef(new Set<string>());
  const completedUtterances = useRef(new Set<string>());
  const cancelledUtterances = useRef(new Set<string>());
  const wakeTranscriptPending = useRef(false);
  const desiredActivity = useRef<{ sleeping: boolean; wakeListening: boolean; muted: boolean } | null>(null);
  const captureGeneration = useRef(0);
  const sessionVoiceWake = useRef(false);
  const invalidateCapture = () => {
    captureGeneration.current += 1;
    wakeTranscriptPending.current = false;
    for (const id of submittedUtterances.current) cancelledUtterances.current.add(id);
    if (utteranceRef.current) cancelledUtterances.current.add(utteranceRef.current);
    while (cancelledUtterances.current.size > 64) cancelledUtterances.current.delete(cancelledUtterances.current.values().next().value!);
    submittedUtterances.current.clear(); utteranceRef.current = null;
  };
  const freshCapture = () => {
    micRef.current?.stop();
    const current = useSession.getState();
    if (!current.muted || current.wakeListening) void micRef.current?.start(current.settings.micDeviceId);
  };
  const flushingRef = useRef(false);
  const micTransition = useRef<Promise<void>>(Promise.resolve());

  /* ---------------- server events → store / avatar ---------------- */

  const handleMessage = useCallback((msg: ServerMessage) => {
    const s = useSession.getState();
    lastActivityRef.current = Date.now();
    if ("turn_id" in msg) {
      const decision = replyGate.current.accept(msg.turn_id, ["assistant_text", "assistant_audio", "choices"].includes(msg.type) || (msg.type === "state" && msg.voice_state === "processing"));
      if (decision === "ignore") return;
      if (decision === "start") {
        ttsRef.current?.stop();
        s.setLiveCaption(""); s.setChoices(null);
        choicesOfferedRef.current = false;
      }
    }

    switch (msg.type) {
      case "activity": {
        if (s.sleeping && !msg.sleeping) wakeTranscriptPending.current = true;
        const desired = desiredActivity.current;
        if (desired && desired.sleeping && !msg.sleeping) {
          // A wake phrase can finish during the flush deadline. Honour the
          // server wake, while preserving the user's pending hardware mute.
          desired.sleeping = false; desired.wakeListening = false;
          s.setActivity(false, false, desired.muted);
        }
        if (desired && (desired.sleeping !== msg.sleeping || desired.wakeListening !== msg.wake_listening || desired.muted !== msg.muted)) break;
        desiredActivity.current = null;
        s.setActivity(msg.sleeping, msg.wake_listening, msg.muted);
        if (msg.sleeping && !msg.wake_listening) micRef.current?.stop();
        break;
      }
      case "ready": {
        s.setSessionId(msg.session_id);
        socketRef.current?.sendSync();
        break;
      }

      case "vad": {
        if (msg.utterance_id) utteranceRef.current = msg.utterance_id;
        if (s.sleeping || s.muted) break;
        if (msg.state === "speech_start") {
          s.touchActivity();
          s.setUserSpeaking(true);
          // Barge-in (design §4): speaking over the assistant stops playback.
          if (s.voiceState === "answering" || ttsRef.current?.isBusy) {
            ttsRef.current?.stop();
            replyGate.current.cancel();
            // Server VAD already cancels the old reply. A second barge_in here
            // would also cancel the user's newly started capture.
          }
          s.setVoiceState("listening");
        } else {
          s.setUserSpeaking(false);
          s.setVoiceState("submitting");
        }
        break;
      }

      case "transcript": {
        const submitted = !!msg.utterance_id && submittedUtterances.current.has(msg.utterance_id);
        if ((s.sleeping || s.muted) && !submitted) break;
        if (msg.utterance_id && (completedUtterances.current.has(msg.utterance_id) || cancelledUtterances.current.has(msg.utterance_id))) break;
        if (msg.utterance_id && !submitted && utteranceRef.current !== msg.utterance_id && !wakeTranscriptPending.current) break;
        if (msg.final) wakeTranscriptPending.current = false;
        if (msg.final && msg.utterance_id) {
          submittedUtterances.current.delete(msg.utterance_id);
          completedUtterances.current.add(msg.utterance_id);
          if (completedUtterances.current.size > 64) completedUtterances.current.delete(completedUtterances.current.values().next().value!);
          if (utteranceRef.current === msg.utterance_id) utteranceRef.current = null;
        }
        if (msg.final) s.setChoices(null);
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
        // If the server signals idle while the local TTS player is still playing
        // or has audio chunks queued, keep answering until playback finishes (handled by onEnded).
        if (msg.voice_state === "idle" && ttsRef.current?.isBusy) {
          break;
        }
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
        invalidateCapture();
        ttsRef.current?.stop();
        s.resetSession();
        freshCapture();
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
        wakeTranscriptPending.current = false;
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
    // A saved opt-in may resume only an already granted permission; never prompt on reload.
    if (!startedRef.current && s.sleeping && s.settings.voiceWake && navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (permission.state === "granted" && useSession.getState().sleeping) s.setActivity(true, true, true);
      } catch { /* Browsers without microphone permission queries stay asleep. */ }
    }

    if (!socketRef.current) {
      socketRef.current = new SessionSocket({
        onMessage: handleMessage,
        onStatus: (status) => {
          const current = useSession.getState();
          current.setConnection(status);
          if (status !== "open") {
            invalidateCapture(); desiredActivity.current = null;
            micRef.current?.stop();
            current.setChoices(null); current.setUserSpeaking(false);
            ttsRef.current?.stop(); replyGate.current.cancel();
          }
        },
        // Every open (first connect + reconnects) re-applies the preferred
        // voice so the session always speaks with `settings.voice`.
        onOpen: () => {
          const current = useSession.getState();
          if (startedRef.current && (!current.muted || current.wakeListening)) void micRef.current?.start(current.settings.micDeviceId);
          socketRef.current?.send(current.sleeping
            ? { type: "control", action: "sleep", wake_listening: current.wakeListening }
            : { type: "control", action: "wake", enable_mic: !current.muted });
          if (!current.sleeping && current.muted) socketRef.current?.send({ type: "control", action: "mute" });
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

    if (!ttsRef.current) {
      ttsRef.current = new TtsPlayer({
        onEnded: () => {
          const cur = useSession.getState();
          cur.touchActivity();
          if (!cur.userSpeaking && (cur.voiceState === "answering" || cur.voiceState === "triage")) {
            if (cur.triage) cur.setTriage(null);
            cur.setVoiceState("idle");
          }
        }
      });
    }

    if (!micRef.current) {
      micRef.current = new MicCapture({
        onPcm: (frame) => {
          const s = useSession.getState();
          // getUserMedia acoustic echo cancellation allows near-end barge-in.
          if (s.muted && !s.wakeListening && !flushingRef.current) return;
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
          desiredActivity.current = null;
          store.setActivity(store.sleeping, false, true);
          socketRef.current?.send({ type: "control", action: "mute" });
          window.setTimeout(() => {
            const cur = useSession.getState();
            if (cur.voiceState === "error") cur.setVoiceState("idle");
          }, 2600);
        }
      });
    }
    const activity = useSession.getState();
    if (!activity.muted || activity.wakeListening) await micRef.current.start(activity.settings.micDeviceId);

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
    invalidateCapture();
    micRef.current?.stop();
    ttsRef.current?.stop();
  }, []);

  /** Explicit barge-in: stop assistant audio and cancel the in-flight turn. */
  const interrupt = useCallback(() => {
    invalidateCapture();
    ttsRef.current?.stop();
    replyGate.current.cancel();
    socketRef.current?.send({ type: "control", action: "barge_in" });
  }, []);

  const disconnect = useCallback(() => {
    invalidateCapture(); desiredActivity.current = null;
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
    ttsRef.current?.stop(); replyGate.current.cancel();
    invalidateCapture(); desiredActivity.current = null;
    socketRef.current?.send({ type: "control", action: "barge_in" });
    s.setActivity(false, false);
    freshCapture();
    socketRef.current?.send({ type: "control", action: "wake", enable_mic: false });
    // A new user turn supersedes any offered chips (tapped or typed).
    s.setChoices(null);
    s.addChat({ role: "user", text: trimmed });
    s.setLiveCaption("");
    s.setVoiceState("processing");
    socketRef.current?.send({ type: "text_input", text: trimmed });
  }, []);

  const sendAction = useCallback((action: ConversationAction, displayText?: string) => {
    const s = useSession.getState();
    ttsRef.current?.stop(); replyGate.current.cancel();
    invalidateCapture(); desiredActivity.current = null;
    s.setActivity(false, false);
    freshCapture();
    s.setChoices(null); s.setLiveCaption(""); s.setVoiceState("processing");
    s.addChat({ role: "user", text: displayText ?? action.value ?? action.name.replace(/_/g, " ") });
    socketRef.current?.send({ type: "action_input", action });
  }, []);

  const toggleMute = useCallback(() => {
    const s = useSession.getState();
    const muting = s.wakeListening || !s.muted;
    s.setUserSpeaking(false); s.setUserTranscript("");
    if (muting) {
      sessionVoiceWake.current = false;
      const generation = captureGeneration.current;
      desiredActivity.current = { sleeping: s.sleeping, wakeListening: false, muted: true };
      const currentId = utteranceRef.current;
      const identity = currentId && !submittedUtterances.current.has(currentId) && !completedUtterances.current.has(currentId) ? currentId : crypto.randomUUID();
      submittedUtterances.current.add(identity);
      if (submittedUtterances.current.size > 64) submittedUtterances.current.delete(submittedUtterances.current.values().next().value!);
      flushingRef.current = true;
      // stopAndFlush stops hardware tracks synchronously before its first await.
      const flush = micRef.current?.stopAndFlush() ?? Promise.resolve();
      s.setActivity(s.sleeping, false, true);
      micTransition.current = micTransition.current.catch(() => undefined).then(async () => {
        try { await flush; } finally { flushingRef.current = false; }
        socketRef.current?.send({ type: "control", action: "mute", pending_audio: generation === captureGeneration.current ? "submit" : "discard", utterance_id: identity });
      });
    } else {
      if (s.sleeping) sessionVoiceWake.current = true;
      desiredActivity.current = { sleeping: s.sleeping, wakeListening: s.sleeping, muted: s.sleeping };
      s.setActivity(s.sleeping, s.sleeping, s.sleeping);
      micTransition.current = micTransition.current.catch(() => undefined).then(async () => {
        socketRef.current?.send({ type: "control", action: "unmute" });
        const current = useSession.getState();
        if (!current.muted || current.wakeListening) { ensureAudioContext(); await start(); }
      });
    }
  }, [start]);

  const wake = useCallback((enableMic = true) => {
    const s = useSession.getState();
    desiredActivity.current = null;
    s.setActivity(false, false, enableMic ? false : s.muted);
    ensureAudioContext();
    socketRef.current?.send({ type: "control", action: "wake", enable_mic: enableMic });
    void start().catch(() => undefined);
  }, [start]);

  const setVoiceWake = useCallback((enabled: boolean) => {
    const s = useSession.getState();
    s.setSettings({ voiceWake: enabled });
    if (!s.sleeping) return;
    s.setActivity(true, enabled, true);
    socketRef.current?.send({ type: "control", action: "sleep", wake_listening: enabled });
    if (enabled) { ensureAudioContext(); void start().catch(() => undefined); }
    else micRef.current?.stop();
  }, [start]);

  /** §7 `set_voice` control — no-op when the socket is not open. */
  const setVoice = useCallback((voice: string) => {
    socketRef.current?.send({ type: "control", action: "set_voice", voice });
  }, []);

  /** Re-open the capture device (settings change of `micDeviceId`). */
  const restartMic = useCallback(async () => {
    const s = useSession.getState();
    if (!micRef.current) return;
    if (s.muted && !s.wakeListening) return;
    await micRef.current.start(s.settings.micDeviceId);
  }, []);

  useEffect(() => {
    const touch = () => { const s = useSession.getState(); if (!s.sleeping) s.touchActivity(); };
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    const interval = window.setInterval(() => {
      const s = useSession.getState();
      if (s.sleeping) return;
      if (s.userSpeaking || ttsRef.current?.isBusy || !["idle", "error"].includes(s.voiceState)) {
        s.touchActivity(); return;
      }
      if (Date.now() - s.lastInteractionAt < 60_000) return;
      invalidateCapture(); desiredActivity.current = null;
      replyGate.current.cancel(); ttsRef.current?.stop();
      const wakeListening = (s.settings.voiceWake || sessionVoiceWake.current) && !s.muted;
      s.setActivity(true, wakeListening, true);
      s.setUserSpeaking(false);
      socketRef.current?.send({ type: "control", action: "sleep", wake_listening: wakeListening });
      if (!wakeListening) micRef.current?.stop();
    }, 1000);
    return () => { window.clearInterval(interval); window.removeEventListener("pointerdown", touch); window.removeEventListener("keydown", touch); };
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

  return { start, stop, disconnect, sendText, sendAction, toggleMute, setVoice, restartMic, interrupt, wake, setVoiceWake };
}

/** Exposed for components that need the live voice state without re-rendering. */
export function currentVoiceState(): VoiceState {
  return useSession.getState().voiceState;
}
