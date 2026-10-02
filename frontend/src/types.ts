/**
 * GourMate — canonical client types.
 *
 * Mirrors the golden manifest `contracts/ws-events.json` plus the Pydantic
 * models in `backend/app/schemas.py` exactly. No invented event names or fields.
 */

/* ------------------------------------------------------------------ */
/* §6 — Data schemas                                                  */
/* ------------------------------------------------------------------ */

export type RecipeSource = "generated" | "user_text";

export interface Substitution {
  substitute: string;
  ratio: string | null;
  note: string | null;
}

export interface Ingredient {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  display: string;
  notes: string | null;
  substitutions: Substitution[];
}

export interface Step {
  index: number;
  instruction: string;
  duration_seconds: number | null;
  ingredient_refs: string[];
  tip: string | null;
}

export interface Recipe {
  id: string;
  title: string;
  servings: number | null;
  prep_time_seconds: number | null;
  cook_time_seconds: number | null;
  total_time_seconds: number | null;
  ingredients: Ingredient[];
  steps: Step[];
  source: RecipeSource;
  created_at: string;
}

export type TimerStatus = "active" | "paused" | "done" | "cancelled";

export interface KitchenTimer {
  id: string;
  label: string;
  duration_seconds: number;
  started_at: number;
  ends_at: number;
  status: TimerStatus;
  related_step_index: number | null;
}

export interface ToolCall {
  call_id: string;
  name: ToolName;
  arguments: Record<string, unknown>;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  tool_call?: ToolCall;
  ts: number;
}

/** Session lifecycle (architecture §6) — planning sits between intake and cooking. */
export type SessionPhase = "intake" | "planning" | "cooking" | "done";

export interface SessionState {
  session_id: string;
  phase: SessionPhase;
  recipe: Recipe | null;
  current_step_index: number;
  timers: KitchenTimer[];
  /** Recent chat window (architecture §5) so the server can restore context. */
  turns?: ChatTurn[];
}

/* ------------------------------------------------------------------ */
/* §7 — WebSocket protocol                                            */
/* ------------------------------------------------------------------ */

/** §9.2 tool registry — executed client-side (plus the server-side tools). */
export type ToolName =
  | "advance_step"
  | "repeat_step"
  | "go_to_step"
  | "create_kitchen_timer"
  | "cancel_timer"
  | "substitute_ingredient"
  | "begin_dish"
  | "create_plan"
  | "offer_choices";

/** §11 error taxonomy. */
export type ErrorCode =
  | "out_of_scope"
  | "recipe_invalid"
  | "audio_too_long"
  | "no_speech"
  | "audio_corrupt"
  | "mic_denied"
  | "llm_timeout"
  | "llm_rate"
  | "llm_blocked"
  | "llm_config"
  | "tts_failed"
  | "rate_limited"
  | "engine_loading"
  | "ws_dropped";

/** Server-authoritative avatar states (§7 `state` event). */
export type ServerVoiceState =
  | "idle"
  | "listening"
  | "submitting"
  | "processing"
  | "answering"
  | "triage";

/** Full avatar state system (design §4) — `error` derives from the typed `error` event. */
export type VoiceState = ServerVoiceState | "error";

/* --------------------------- client → server ---------------------- */

export type ClientMessage =
  | { type: "start" }
  | { type: "sync"; state: SessionState }
  | {
      type: "control";
      action: "mute" | "unmute" | "barge_in" | "set_voice";
      /** edge-tts voice id — required for `set_voice`. */
      voice?: string;
    }
  | { type: "text_input"; text: string }
  | { type: "tool_result"; call_id: string; result: Record<string, unknown> }
  | {
      type: "recipe_state";
      phase: SessionState["phase"];
      recipe: Recipe | null;
      current_step_index: number;
      timers: KitchenTimer[];
    };

/* --------------------------- server → client ---------------------- */

export type ServerMessage =
  | { type: "ready"; session_id: string }
  | { type: "vad"; state: "speech_start" | "speech_end" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "choices"; options: { id: string; label: string }[] }
  | { type: "assistant_text"; text: string }
  | { type: "assistant_audio"; seq: number; mime: "audio/mpeg"; data: string }
  | { type: "tool_call"; call_id: string; name: ToolName; arguments: Record<string, unknown> }
  | { type: "state"; voice_state: ServerVoiceState }
  | { type: "recipe"; recipe: Recipe }
  | { type: "reset" }
  | { type: "plan"; recipe: Recipe }
  | { type: "done" }
  | { type: "error"; code: ErrorCode; message: string; recoverable: boolean }
  | { type: "rate_limited"; scope: string; retry_after: number }
  | { type: "turn_end"; turn_id: string };

/**
 * §7 `plan` event (backend `PlanEvent`) — planning result awaiting
 * confirmation. Derived from `ServerMessage` so the shapes cannot drift; the
 * union member stays an inline literal because `types.contract.test.ts` only
 * accepts type-literal members when it reads the discriminator values.
 */
export type PlanEvent = Extract<ServerMessage, { type: "plan" }>;

/* ------------------------------------------------------------------ */
/* Client-side UI state                                               */
/* ------------------------------------------------------------------ */

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export type ThemePreference = "auto" | "light" | "dark";
export type PanelSide = "left" | "right";

export interface Settings {
  /** Preferred edge-tts voice id (see design §5.4 "Voice pick"). */
  voice: string;
  micDeviceId: string | null;
  timerSound: boolean;
  theme: ThemePreference;
  chatWidth: number;
  plannerWidth: number;
  chatSide: PanelSide;
  plannerSide: PanelSide;
  sameSideOrder: "chat-first" | "planner-first";
}

export type ToastKind = "error" | "rate_limit" | "info";

export interface Toast {
  kind: ToastKind;
  message: string;
  retryAfter?: number;
}
