# GourMate — System Architecture

| Field | Value |
| :--- | :--- |
| Status | Approved for V1 |
| Version | 1.0 |
| Doc type | Architecture & data design |
| Upstream | `specs/gourmate.spec.md`, `docs/decisions/gourmate.techstack.md` |

---

## 1. Architectural Principle

> **The structured `Recipe` JSON is the single source of truth on the client. The LLM never "holds" recipe state.**

Each turn, the client sends the current recipe + step index to the server as context. Gemini emits **tool calls**; the client executes them deterministically. This prevents the LLM from drifting out of sequence — the #1 failure mode in conversational recipe assistants — and satisfies the Value-Source Audit: every rendered value traces to `Recipe`, timer state, the transcript, or explicit tool results.

## 2. System Context

```
Browser (React PWA)                          FastAPI Backend (Fly.io)
┌──────────────────────────┐  WS: PCM 16k   ┌───────────────────────────────┐
│ Mic → AudioWorklet        │──────────────>│ Ring buffer                    │
│                           │               │   → Silero VAD (end/barge-in)  │
│ Speaker ← MP3 frames      │<──────────────│   → faster-whisper (small.en)  │
│                           │               │   → Gemini 3.5 Flash Lite           │
│ UI · Timers · Recipe state│<─text/tools───│       (tools + streaming)      │
└───────────┬──────────────┘               │   → edge-tts (per sentence)     │
            │ localStorage                  └───────────────┬───────────────┘
            │ (cookbook, step idx, timers)                  │ HTTPS (server-side key)
            └───────────────────────────────────────────────┘
                                                    Gemini API
```

## 3. Backend Components

| Module | Responsibility |
| :--- | :--- |
| `ws.session` | One WebSocket per client; owns `SessionState`, lifecycle, rate limits |
| `audio.buffer` | Ring buffer of Int16 PCM; feeds VAD + STT |
| `vad.silero` | Speech start/end detection; drives barge-in |
| `stt.whisper` | Lazy-loaded faster-whisper `small.en`. The **final** pass (greedy decoding + culinary `initial_prompt`) transcribes the silence-trimmed utterance. The optional **partial** pass (greedy, LocalAgreement-2) is **disabled by default** — the live partials were unreliable and the UI shows no live user text. |
| `stt.streaming` | Optional offline sherpa-onnx streaming zipformer for live partials (int8 ONNX, weights cached under `HF_HOME`). **Disabled by default** (`STREAMING_STT_ENABLED=false`); kept as a gated knob. |
| `llm.gemini` | `google-genai` client; conversation turns, recipe parse/generate, tools |
| `llm.prompts` | System prompt, out-of-scope guard, tool declarations |
| `tts.edge` | edge-tts synthesis; sentence chunking; per-session voice override |
| `recipe.service` | Parse/generate → normalized `Recipe`; validation |
| `tool.registry` | Tool schemas + server-side validation of tool calls |
| `ratelimit` | REST token bucket + per-session + global daily counter |
| `errors` | Typed error taxonomy → WS/REST payloads |

**Concurrency:** one async task set per WebSocket (receive loop, VAD/STT loop, LLM pipeline). Model loading is process-global and lazy, guarded by a readiness flag surfaced at `/api/health`.

**TTS voice (per-session override):** synthesis defaults to `TTS_VOICE` (`en-US-AriaNeural`). A session may override its own edge-tts voice by sending `{type:"control", action:"set_voice", voice:"<id>"}` (§7); the server validates the id against a backend allow-list and applies it to subsequent utterance synthesis, falling back to `TTS_VOICE` on an unknown id. The override is session-scoped and never persisted server-side; the Settings picker previews a real sample through `POST /api/tts/preview` (§8).

**STT accuracy/latency tradeoff (techstack D-1):** the server runs English-only `small.en` with **greedy decoding** (`beam_size=1`) at `temperature=0.0` and a culinary `initial_prompt` (ingredients, units and numbers), plus a shortened silence hold (`VAD_MIN_SILENCE_S=0.6`, `UTTERANCE_CONTINUATION_S=0.4`). Dropping the wider beam search and tightening the silence window deliberately trades a little transcription accuracy for a faster end-of-speech → transcript path — the dominant term in first-audio latency; the model stays English-only `small.en`. **Live partial captions are disabled by default** (`WHISPER_PARTIAL_ENABLED=false`, `STREAMING_STT_ENABLED=false`): the streaming zipformer partials were materially less accurate than the final pass, so the UI shows no live user text — only the final `transcript{final:true}` and the assistant caption. The partial paths remain gated for re-enabling later (chunked `small.en` + LocalAgreement-2, or the sherpa-onnx streaming zipformer). Tunable via `WHISPER_MODEL`, `WHISPER_BEAM_SIZE`, `WHISPER_PARTIAL_MODEL`, `PARTIAL_INTERVAL_S`, `STREAMING_STT_*`, `VAD_MIN_SILENCE_S` and `UTTERANCE_CONTINUATION_S`; `compute_type=int8` keeps it CPU-friendly.

## 4. Voice Turn — Sequence

```
User speaks
  │
  ▼
[1] AudioWorklet captures Float32 @48k → downsamples to Int16 @16k mono
  │   → WS binary frames
  ▼
[2] Server appends to ring buffer; Silero VAD
  │   emits vad:speech_start  → client: Listening
  │   if assistant is speaking → barge-in: client stops playback, server clears TTS queue
  │   (live partial captions disabled by default; no transcript{final:false})
  ▼
[3] VAD emits vad:speech_end (after VAD_MIN_SILENCE_S=0.6 s silence; +0.4 s continuation window)
  │   server: Submitting? (client shows Submitting on speech_end)
  ▼
[4] faster-whisper transcribes the silence-trimmed utterance → transcript{final:true}
  │   client: Processing
  ▼
[5] Build LLM turn:
  │   system prompt + recipe context (step idx, ingredients) + recent turns
  │   + tool declarations + user transcript
  ▼
[6] Gemini 3.5 Flash Lite (streaming)
  │   ├─ text deltas → sentence buffer → edge-tts → assistant_audio frames → Answering
  │   └─ functionCall → tool_call event → client executes → tool_result → loop back to [6]
  ▼
[7] turn_end → client returns to Idle unless speaking
   │
   ▼
[8] Dish named — the assistant ALWAYS asks how to proceed: cook it straight
   │   away, or plan it together (offered as tappable chips, and speakable).
   │   Two branches:
   │
   ├─ DIRECT-COOK ─ create_plan with no interview → server generates the
   │                structured Recipe → plan event {type:"plan", recipe};
   │                assistant announces plan + ingredients + ETA
   │                (total_time_seconds). The "straight away" choice IS the
   │                explicit confirmation → go straight to [12].
   │
   └─ PLAN TOGETHER
        ▼
[9] Planning interview — assistant asks up to 2 brief questions about what
   │   ingredients the user has on hand; recipe context carried each turn
   ▼
[10] Gemini calls create_plan {servings?, constraints?} → server generates the
   │   structured Recipe → plan event {type:"plan", recipe}
   │   client: Planning HUD, plan card (ingredients + ordered steps);
   │   announced with ingredients + ETA (total_time_seconds)
   ▼
[11] Explicit confirmation — voice ("let's cook"/"go"/"proceed") resolved
   │   deterministically (no Gemini round-trip), or the "Let's cook" button.
   │   A revision regenerates the plan (back to [9]).
   ▼
[12] recipe event → phase:"cooking". Navigation readout begins at [1]; each
   │   step readout states that step's duration (its ETA); the cooking HUD
   │   shows total_time_seconds + the current step's ETA
   ▼
[13] Cancel (during planning) / discontinue (during cooking) — voice or button
       → server emits {type:"reset"}; client clears recipe, current_step_index
         and timers and returns to Intake. The recipe stays in the local
         cookbook.
[14] Recipe complete — the user reaches or passes the final step. The server
     emits {type:"done"}; the client phase → "done"; the avatar celebrates
     (jump/spin, happy eyes, hat bounce, confetti/sparkle burst) and the
     progress ring completes; the assistant congratulates and offers
     "what's next" (→ dish suggestions, §9.1). The final step is not replayed.
```

**Intake is model-decided:** the assistant no longer treats "any short utterance" as a dish name. Each intake turn is judged by the model: when the user names a real dish it calls `begin_dish { dish }` (§9.2), and the server then asks the cook-now vs plan-it choice; otherwise the assistant asks a brief clarifying question, or — for "what should I cook?" — suggests a few dishes (§9.1). Step [8] therefore assumes a dish has already been recognised via `begin_dish`.

**Every spoken line is captioned:** any line the assistant speaks is also emitted as an `assistant_text` event (§7), so the chat and the transcript sheet always mirror the voice. This explicitly includes the deterministic server lines that were previously speech-only — the plan readback, step readouts, the cook-now/plan-it choice, and cancel/discontinue — alongside the congratulation at completion. Text streamed from Gemini is captioned the same way.

**Deterministic navigation shortcut:** for pure navigation intents, the server does **not** spend a second Gemini round-trip. It computes the step readout from `Recipe` and streams it via edge-tts directly, then emits a `tool_call` (or state event) so the client updates `current_step_index`. Gemini is reserved for freeform conversation, triage, and substitutions.

**Structured choices:** when the assistant offers a discrete set — about five dish suggestions (§9.1), the step [8] cook-now vs plan-it choice, or the completion confirmation below — the server emits `{type:"choices", options:[{id,label}]}` (§7) and **speaks the same options**. The client renders them as **tappable multiple-choice chips**. Tapping a chip sends the chosen label as the user's next utterance, which then follows the normal turn path. This is the client-rendered form of the server-executed `offer_choices` tool (§9.2).

**Completion on a done cue:** at or after the final step, a done cue ("I'm done", "finished", "that's it") or the "Done cooking" button does **not** end the recipe immediately — the assistant first **confirms** via `choices` ("Yes, I'm done" / "Not yet"). Only on "Yes" does the server emit `{type:"done"}`, set the phase to `done`, congratulate, and celebrate (step [14]); "Not yet" leaves the recipe running. The final step is never replayed.

## 5. State Ownership

| State | Owner | Mirrored server-side | Persisted |
| :--- | :--- | :--- | :--- |
| `Recipe` | Client | Yes (per session, in memory) | `localStorage` cookbook |
| `current_step_index` | Client | Yes | `localStorage` |
| `KitchenTimer[]` | Client | No (server stateless for timers) | `localStorage` |
| `ChatTurn[]` | Client (recent window) | Yes (recent window) | `localStorage` (optional, transcript) |
| `voice_state` | Derived from server events | Server authoritative | No |
| Audio buffers | Server (in memory only) | — | **Never persisted** |

**Reconnect:** client sends a `sync` message with full `SessionState`; server rebuilds context. No server session survives a restart (by design; anonymous).

## 6. Data Schemas

```ts
type RecipeSource = "generated" | "user_text";

interface Recipe {
  id: string;                 // uuid
  title: string;
  servings: number | null;
  prep_time_seconds: number | null;
  cook_time_seconds: number | null;
  total_time_seconds: number | null;
  ingredients: Ingredient[];
  steps: Step[];              // ordered
  source: RecipeSource;
  created_at: string;         // ISO 8601
}

interface Ingredient {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  display: string;            // "2 tbsp butter"
  notes: string | null;
  substitutions: Substitution[];
}

interface Substitution {
  substitute: string;
  ratio: string | null;       // "3/4 cup milk : 1 tbsp butter"
  note: string | null;
}

interface Step {
  index: number;              // 0-based, contiguous
  instruction: string;
  duration_seconds: number | null;
  ingredient_refs: string[];  // Ingredient.id[]
  tip: string | null;
}

interface KitchenTimer {
  id: string;
  label: string;
  duration_seconds: number;
  started_at: number;         // epoch ms
  ends_at: number;            // epoch ms
  status: "active" | "paused" | "done" | "cancelled";
  related_step_index: number | null;
}

interface ChatTurn {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  tool_call?: { call_id: string; name: string; arguments: Record<string, unknown> };
  ts: number;
}

interface SessionState {
  session_id: string;
  phase: "intake" | "planning" | "cooking" | "done";
  recipe: Recipe | null;
  current_step_index: number;
  timers: KitchenTimer[];
}
```

**Planning phase:** between intake and cooking the assistant interviews the user and builds the plan; the structured `Recipe` remains the single source of truth and the LLM never holds recipe state (§1).

**Completion phase:** `SessionPhase` gains a terminal `"done"` value. When the user reaches or passes the final step the recipe ends: the server emits `{type:"done"}` (§7), the client shows the completion state and the avatar celebrates, and the assistant congratulates and offers a new dish via "what's next" (dish suggestions, §9.1). `"done"` is a session phase only — `current_step_index` is not advanced past the last step, and the finished recipe stays in the local cookbook. Reset (cancel/discontinue, §4 step [13]) clears it.

**Time fields as ETA:** `Recipe.prep_time_seconds`, `cook_time_seconds`, and `total_time_seconds` are the authoritative source for every spoken and on-screen estimate. The plan readout states `total_time_seconds`; each `Step.duration_seconds` is surfaced as that step's ETA during cooking; the cooking HUD shows `total_time_seconds` alongside the current step's ETA. When a field is `null` the assistant omits the number rather than inventing one (Value-Source Audit).

**Recipe validation (server):** enforce contiguous step indices, non-empty `instruction`, `duration_seconds ≥ 0`, and that every `ingredient_refs` id exists. Invalid Gemini output → `recipe_invalid` error (EH-2).

## 7. WebSocket Protocol

**Endpoint:** `wss://<host>/ws/session`

### Client → Server
| Frame | Payload |
| :--- | :--- |
| Binary | Int16 PCM, 16 kHz mono, 20–40 ms frames |
| `{type:"start"}` | Begin session |
| `{type:"sync", state}` | Full `SessionState` on connect/reconnect |
| `{type:"control", action:"mute"\|"unmute"\|"barge_in"\|"set_voice", voice?}` | Mic control / interrupt; `set_voice` carries `voice` (the session's edge-tts voice id, validated against an allow-list) |
| `{type:"text_input", text}` | Equal-weight text intake path |
| `{type:"tool_result", call_id, result}` | Result of executed tool |
| `{type:"recipe_state", ...}` | State updates after navigation |

### Server → Client
| Event | Payload |
| :--- | :--- |
| `{type:"ready", session_id}` | Session established |
| `{type:"vad", state:"speech_start"\|"speech_end"}` | Drives Listening/Submitting |
| `{type:"transcript", text, final}` | Partial/final user speech |
| `{type:"choices", options:[{id,label}]}` | Tappable multiple-choice options (about five dish suggestions, or the completion confirmation); the assistant speaks the same options. Tapping a chip sends the chosen label as the user's next utterance |
| `{type:"assistant_text", text}` | Assistant utterance (captions) |
| `{type:"assistant_audio", seq, mime:"audio/mpeg", data:base64}` | Sentence audio chunk |
| `{type:"tool_call", call_id, name, arguments}` | Client must execute |
| `{type:"state", voice_state:"idle"\|"listening"\|"submitting"\|"processing"\|"answering"\|"triage"}` | Avatar state |
| `{type:"plan", recipe}` | Planning result (ingredients + steps), awaiting confirmation |
| `{type:"recipe", recipe}` | Intake result; reused to signal the transition into cooking |
| `{type:"done"}` | Recipe complete (final step reached or passed). Client shows the completion state; the avatar celebrates; the progress ring completes |
| `{type:"reset"}` | Session reset to intake — cancel (planning) or discontinue (cooking). Client clears `recipe`, `current_step_index` and timers, returns to Intake; the recipe is retained in the local cookbook |
| `{type:"error", code, message, recoverable}` | Typed error |
| `{type:"rate_limited", scope, retry_after}` | Limit hit |
| `{type:"turn_end", turn_id}` | Turn complete |

**Control close codes:** `1013` (process-global connection ceiling), `1011` (internal), `1000` (normal). `1008` is used, additively, for a disallowed `Origin` (policy violation).

**Reconnect semantics — same-IP newest-wins takeover:** a new socket from an IP that already has an active session takes over rather than being rejected. The prior session is closed with `1000` and its per-IP slot is reused; the new session proceeds normally and emits `ready`. This prevents a browser reload (new socket opening before the old one's slot is released) from colliding with its own stale connection. `1013` is therefore reserved for the **process-global** ceiling (`WS_MAX_TOTAL_CONNECTIONS`) and genuine distinct-IP over-limit, never for a same-IP reload.

## 8. REST Endpoints

| Method | Path | Body | Response | Limits |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/recipes/generate` | `{ dish, servings?, constraints? }` | `Recipe` | 10/min/IP |
| `POST` | `/api/recipes/parse` | `{ text }` | `Recipe` | 10/min/IP |
| `POST` | `/api/tts/preview` | `{ voice }` | `audio/mpeg` | 10/min/IP (shares the recipe per-IP bucket family) |
| `GET` | `/api/health` | — | `{ status, models_loaded, gemini_ok }` | 60/min/IP |

Errors: `400` invalid input, `422` schema, `429` rate limit (+`Retry-After`), `502` upstream Gemini, `503` models loading.

## 9. Gemini Integration

### 9.1 System Prompt (Planner)
```
You are Planner, the user's warm cooking companion. The user is cooking with messy
hands, so keep them company while they cook — encouraging, a little playful, and
mindful of what you've already discussed. Never sound robotic.

RULES:
1. Speak concisely, 2-3 sentences max. The user is listening, not reading.
2. Output clean conversational plain text. Never emit markdown, asterisks, or bullets.
3. Be warm and human: encourage, celebrate small wins, and reference context you
   remember from earlier turns. Never scold or go clinical.
4. For timers, step changes, or substitutions, use the provided tools.
5. If a cooking disaster is mentioned (burning, smoking, curdling), give the immediate
   corrective action FIRST, before anything else. Never reset the recipe.
6. Only help with cooking. For anything else, decline briefly and redirect to the dish.
7. When the user asks what to cook or eat, suggest about five dishes (popular/trending,
   leaning on ingredients they have), ask them to choose, then offer the cook-now vs
   plan-it choice before proceeding.
8. When the recipe is complete, congratulate the user warmly and offer a new dish.
```

> **Planning prompt:** a dedicated planning system prompt drives the pre-cook interview — it asks at most two brief clarifying questions (servings, dietary/allergies, on-hand ingredients), then calls `create_plan`; it must always present the plan and await explicit confirmation before cooking begins.

> **Suggestions & completion:** for a "what should I cook?" ask with no active dish, Planner suggests about five popular/trending dishes mindful of on-hand ingredients, asks the user to pick, then runs the same cook-now vs plan-it choice (§4 step [8]). The suggestions are returned via the `offer_choices` tool (§9.2) and rendered as tappable chips. Once the recipe is complete (§4 step [14]) the assistant congratulates and offers a new dish instead of repeating the final step; a done cue at/after the last step is confirmed first via `choices` before `{type:"done"}` (§4).

### 9.2 Tool Declarations
| Tool | Arguments | Executed by |
| :--- | :--- | :--- |
| `advance_step` | `{ from_step_index:int }` | Client |
| `repeat_step` | `{ step_index:int }` | Client |
| `go_to_step` | `{ step_index:int }` | Client |
| `create_kitchen_timer` | `{ label:str, duration_seconds:int, related_step_index?:int }` | Client |
| `cancel_timer` | `{ label:str }` | Client |
| `substitute_ingredient` | `{ ingredient:str, reason?:str }` | Client (advisory) |
| `create_plan` | `{servings?:int, constraints?:str}` | Server |
| `begin_dish` | `{ dish: string }` | Server |
| `offer_choices` | `{ options:string[] }` | Server (emits `{type:"choices"}`, §7) |

> **`begin_dish` (server-executed):** the model calls it when the user names a real, recognisable dish. The server then asks the cook-now vs plan-it choice via `choices` (§4 step [8], §7) — **without echoing the user's own words back** — and arms the deterministic answer routing so the user's choice (chip or voice) is resolved without a second Gemini round-trip.

### 9.3 Tool Loop
1. Server sends conversation + declarations to Gemini.
2. Gemini returns `functionCall` → server validates args via `tool.registry` → emits `tool_call`.
3. Client executes, updates state, returns `tool_result` (+ optional `recipe_state`).
4. Server appends tool result and re-invokes Gemini **only if** a spoken continuation is needed; navigation readouts bypass this (see §4).

**Model:** the backend calls `GEMINI_MODEL`, default `gemini-3.5-flash-lite`. A missing
API key, a retired model, or an unknown/unsupported model id must surface as
`llm_config` (never as a transient `llm_timeout`).

**Upstream error mapping** (`app/llm/gemini.py:_map_exception`): HTTP
`400`/`401`/`403`/`404`, and upstream messages containing `not found`,
`no longer available`, `api key`, `permission_denied`, `unauthenticated`, or
`unsupported model` → `llm_config`; `429` → `llm_rate`; `5xx`/timeout →
`llm_timeout`; safety/blocklist → `llm_blocked`. The raw upstream error
(`type(exc).__name__` + `str(exc)`, truncated) is logged at `WARNING` before
mapping so the true cause is never hidden.

## 10. Rate Limiting

| Layer | Default | Storage | Response |
| :--- | :--- | :--- | :--- |
| REST `/recipes/*` | burst capacity 5, sustained refill 10/min (~1 per 6 s) | In-process token bucket (`backend/app/ratelimit.py`; `slowapi` used for `/api/health`) | `429` + `Retry-After` |
| Per-session turns | min 1.5 s gap | `SessionState` timestamps | `rate_limited`, turn dropped |
| Per-session audio | 30 s utterance, 60 s buffer | Ring buffer | Forced flush/discard |
| Global Gemini | 500/day | In-process counter (Redis if scaled) | `429`/degraded state |
| Per-IP WS | 1 active socket | Connection registry; same-IP reconnect is a newest-wins takeover | Prior socket closed `1000`; new session proceeds |
| Global WS | `WS_MAX_TOTAL_CONNECTIONS` (200) | Connection registry (hard ceiling across all IPs) | New socket closed `1013` |

**Burst semantics (RL-1):** the REST bucket starts full with **capacity 5** and
refills at **10 tokens/min (~1 token every 6 s)**. With no refill elapsed, the
first 5 rapid requests succeed and the **6th** is denied; sustained traffic above
the refill rate is also denied. Denials return `429` with `Retry-After` (rounded
up, minimum 1 s).

## 11. Error Taxonomy & Handling

| Code | Category | Trigger | Client behavior |
| :--- | :--- | :--- | :--- |
| `out_of_scope` | Semantic | Non-cooking request | Assistant declines + redirects (context preserved) |
| `recipe_invalid` | Input | Unparseable/oversized/unsupported | Show retry/rephrase prompt |
| `audio_too_long` | Audio | Utterance > cap | Notify, resume listening |
| `no_speech` | Audio | VAD timeout | Silent, return to Idle |
| `audio_corrupt` | Audio | Malformed PCM | Drop frame, continue |
| `mic_denied` | Client | Permission lost | Onboarding/permission guidance |
| `llm_timeout` / `llm_rate` | LLM | Gemini timeout/429 | Spoken fallback + backoff retry |
| `llm_blocked` | LLM | Safety block | Rephrase request |
| `llm_config` | LLM | Missing/invalid API key OR retired/unknown/unsupported model | Show configuration error and log the raw upstream error |
| `tts_failed` | TTS | edge-tts error | Text-only fallback |
| `rate_limited` | Limit | Any limit | Backoff UI, `retry_after` |
| `engine_loading` | Infra | Models still loading | "Warming up…" once |
| `ws_dropped` | Infra | Disconnect | Reconnect + `sync` state |

Every code maps to a designed UI state (design doc §8) and a spoken message where appropriate.

## 12. Security & Privacy

- Gemini API key lives **only** server-side (`fly secrets`); never sent to the browser.
- TLS everywhere (`wss://`, `https://`); `ALLOWED_ORIGINS` CORS/WS origin check.
- Input caps (text size, frame size, utterance length) before processing.
- No raw audio, transcripts, or recipes persisted server-side; audio buffers are in-memory and freed per turn.
- No accounts, no PII; `localStorage` data is user-controlled and clearable.

## 13. Deployment Topology

```
Vercel ── static PWA ──┐
                       │ wss / https (ALLOWED_ORIGINS)
Fly.io ────────────────┘
  app: gourmate-api
  machine: shared-cpu-2x, 2 GB RAM (min)
  volume: /data  (HF_HOME=/data/hf)  ← caches whisper + silero weights
  env:   GEMINI_API_KEY (secret), WHISPER_MODEL=small.en, caps...
  health: /api/health (readiness)
```

**Cold start:** persistent volume avoids re-downloading weights; model load (~hundreds of ms to a few seconds) is surfaced as `engine_loading`. One warm machine recommended to keep first-turn latency acceptable.

## 14. Failure & Recovery

| Failure | Detection | Recovery |
| :--- | :--- | :--- |
| WS drop | `onclose` | Exponential backoff reconnect + `sync` |
| Backend restart | Reconnect fails | New session, state rebuilt from `localStorage` |
| Gemini outage | `llm_timeout`/`502` | Spoken fallback, queued retry |
| TTS outage | `tts_failed` | Text-only continuation |
| STT unavailable | `/health` | Text input path remains usable |
| Timer fires while tab closed | On resume | Recompute from `ends_at`; alert if elapsed |

## 15. Open Items

1. Reference hardware for NFR latency targets.
2. Redis migration trigger (only if the backend is horizontally scaled).
