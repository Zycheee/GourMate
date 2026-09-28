# GourMate — Product Specification

| Field | Value |
| :--- | :--- |
| Status | Approved for V1 |
| Version | 1.0 |
| Doc type | Requirements (scope) |
| Product | GourMate (working name), assistant persona **Planner** |
| Platform | Responsive PWA (landscape-first) |

---

## 1. Problem

Home cooks work with wet, oily, or contaminated hands and cannot safely touch a screen or phone while cooking. Existing recipe apps assume continuous touch interaction and force the cook to wash hands, lose their place, and re-read steps. Meanwhile, kitchen emergencies (burning garlic, scorched pans, broken sauces) and missing ingredients happen mid-cook and require immediate, contextual guidance — not a recipe restart.

**GourMate** replaces the screen with a low-latency, always-listening voice assistant that keeps the recipe state, answers questions, runs timers, and handles kitchen crises hands-free.

## 2. Target Users

- **Primary:** Home cooks following a recipe with both hands occupied.
- **Secondary:** Casual cooks who improvise a dish and need timers and substitutions.
- **Explicitly not targeted in V1:** Professional kitchen line staff, meal planners, grocery shoppers, dietary-management users.

## 3. Product Focus

> **Cook Mode is the product.**

The app is optimized for one job: guiding a user through preparing a dish, by voice, with eyes and hands free. Recipe input is a conversational on-ramp into Cook Mode — not a browsing or discovery experience.

## 4. Scope

### 4.1 In Scope (V1)
1. Conversational recipe intake — voice (dish name **or** full dictation) **and** equal-weight text (type/paste).
2. Linear recipe navigation by voice ("what's next", "repeat", "go back").
3. Tool-calling timers ("set a pasta timer for 8 minutes") with persistence and notifications.
4. Real-time emergency culinary triage that preserves recipe context.
5. Instant ingredient substitutions with adjusted ratios.
6. Always-listening voice loop with barge-in.
7. Local cookbook (anonymous, `localStorage`).
8. A warm companion persona (**Planner**) and lightweight dish suggestions ("what should I cook?") that hand off into the existing cook-now / plan-it flow.

### 4.2 Out of Scope / Non-Goals (V1)
- Meal planning, a browsable or search-first discovery catalog, or saved recommendations. (Ad-hoc "what should I cook?" suggestions in §4.1 are in scope and always hand off to the existing recipe flow — see FR-12.)
- User accounts, authentication, cloud sync, or multi-device.
- Shopping lists, nutrition tracking, or dietary management.
- Wake-word detection.
- Native mobile, desktop, or smart-speaker apps.
- Persisting raw audio or transcripts server-side.
- Multi-user / concurrent shared sessions.

## 5. Functional Requirements

### FR-1 Conversational Intake
- **FR-1.1** The assistant greets and asks *"What are we cooking?"* in one continuous canvas.
- **FR-1.2** The user may (a) speak a dish name to generate a recipe, or (b) dictate a full recipe.
- **FR-1.3** A text field of equal prominence accepts typed or pasted recipe text.
- **FR-1.4** The assistant normalizes either path into a single structured `Recipe` object (see architecture doc).
- **FR-1.5** The assistant reads back the **plan** (dish title, ingredient list, and step count) before cooking begins.
- **FR-1.6** The assistant interviews with **at most two** brief questions (e.g. servings, dietary/allergies, what the user has on hand) and **always** presents the ingredients plus a plan; cooking begins **only after explicit user confirmation**, and the plan can be revised before cooking.
- **FR-1.7** After a dish is named, the assistant **always** asks how to proceed — *cook it straight away* or *plan it together* — offering both as speakable options and tappable chips. *Direct-cook* generates the recipe and announces the plan, ingredients, and estimated time before cooking begins (the "straight away" choice is the explicit confirmation); *plan together* runs the ≤ 2-question interview first (FR-1.6).
- **FR-1.8** The assistant **always** presents the ingredients and an **estimated time** before cooking and while cooking: the plan states the recipe's total time, each step readout states that step's duration, and the cooking HUD shows the total time plus the current step's ETA (architecture §6 time fields).

### FR-2 Linear Navigation
- **FR-2.1** The system tracks a single `current_step_index`.
- **FR-2.2** "What's next" advances one step; "repeat" replays the current step; "go back" decrements.
- **FR-2.3** Ingredient quantity questions ("how much butter was that") are answered from recipe context **without** changing the step index.
- **FR-2.4** At the final step, "next" **completes** the recipe (FR-11) instead of repeating the last step.

### FR-3 Timers (Tool Calling)
- **FR-3.1** Temporal instructions map to a `create_kitchen_timer` tool call with `label` + `duration_seconds`.
- **FR-3.2** Multiple concurrent timers are supported and labeled.
- **FR-3.3** Timers persist across page refresh (`localStorage`).
- **FR-3.4** On completion, the timer fires a browser notification and a chime.
- **FR-3.5** Timers can be cancelled by voice.

### FR-4 Emergency Triage
- **FR-4.1** Crises (burning, smoking, curdling, scorching) receive an immediate corrective action **before** any other response.
- **FR-4.2** Triage does **not** reset or lose recipe context.

### FR-5 Substitutions
- **FR-5.1** Missing ingredients return an alternative with an adjusted ratio.
- **FR-5.2** Substitutions are advisory and do not mutate the recipe unless the user confirms.

### FR-6 Voice Interaction
- **FR-6.1** The microphone streams continuously while in Cook Mode (always-listening).
- **FR-6.2** The backend detects utterance end via VAD and finalizes the transcript.
- **FR-6.3** The user can barge in and interrupt the assistant while it is speaking.
- **FR-6.4** A persistent mic status and a mute control are the only visible controls.
- **FR-6.5** The assistant voice is user-selectable from a curated allow-list; the choice **persists** across refresh (localStorage) and applies to subsequent assistant speech in the session (architecture §7 `set_voice`, §8).
- **FR-6.6** The voice picker offers a **Preview voice** action that plays a real backend-synthesized sample (`POST /api/tts/preview`), not a canned client-side clip.

### FR-7 Persistence
- **FR-7.1** Generated/parsed recipes are saved to a local cookbook.
- **FR-7.2** Step progress and timers survive refresh.
- **FR-7.3** No server-side storage of recipes or audio.

### FR-8 Cancel & Discontinue
- **FR-8.1** The user can **cancel** during planning or **discontinue** during cooking, by voice or a visible button.
- **FR-8.2** Both reset the session to **intake**: the recipe leaves the active session, the phase returns to `intake`, the step index clears, and all timers are cleared.
- **FR-8.3** The recipe is **not** deleted in the reset; it remains in the local cookbook (FR-7.1).
- **FR-8.4** The server signals the reset with a `{type:"reset"}` WebSocket event (architecture §7).

### FR-9 Companion Persona & Tone
- **FR-9.1** The assistant persona is **Planner**, a warm cooking companion — encouraging, a little playful, and mindful of earlier context — not a robotic command interface. The product brand remains **GourMate**.
- **FR-9.2** Replies stay short and plain-text for TTS (2–3 sentences) and the existing out-of-scope (cooking-only) and corrective-action-first triage rules are preserved (architecture §9.1).
- **FR-9.3** Planner remembers and references recent session context naturally, and never scolds the user.

### FR-10 Spoken-Line Captions
- **FR-10.1** Every spoken assistant line is also emitted as an `assistant_text` caption, so the chat and the transcript sheet always mirror the voice.
- **FR-10.2** This includes the deterministic server lines that were previously speech-only: the plan readback, step readouts, the cook-now / plan-it choice, cancel/discontinue, and the completion congratulation.
- **FR-10.3** The caption text matches the spoken utterance; the two never diverge.

### FR-11 Recipe Completion & Celebration
- **FR-11.1** Reaching or passing the final step ends the recipe: `SessionPhase` gains a terminal `"done"` and the server emits `{type:"done"}` (architecture §6–§7).
- **FR-11.2** On completion the assistant congratulates the user and the avatar **celebrates** (jump/spin, happy eyes, hat bounce, confetti/sparkle burst, progress ring completes).
- **FR-11.3** "What's next" after completion offers a new dish (FR-12) rather than repeating the last step.
- **FR-11.4** Completion does not delete or mutate the recipe; the finished recipe stays in the local cookbook (FR-7.1).
- **FR-11.5** A done cue at or after the final step ("I'm done", "finished", "that's it") or the "Done cooking" button does **not** end the recipe immediately: the assistant **confirms first** via tappable `choices` ("Yes, I'm done" / "Not yet"). Only "Yes" completes (FR-11.1–11.2); "Not yet" leaves the recipe running, and the final step is never replayed.

### FR-12 Dish Suggestions
- **FR-12.1** When the user asks what to cook or eat ("what should I cook?"), the assistant suggests about **five** dishes — popular/trending and mindful of ingredients the user has on hand.
- **FR-12.2** The assistant asks the user to choose, then runs the existing cook-now vs plan-it choice (FR-1.7) and proceeds only after confirmation (FR-1.6).
- **FR-12.3** Suggestions are additive conversation: they do not mutate the active recipe or the step index.
- **FR-12.4** The suggestions are rendered as **tappable multiple-choice chips** (also speakable) via a server `choices` event; tapping a chip sends that dish as the user's next utterance and continues the existing flow (FR-12.2).

## 6. Rate Limiting Requirements

| ID | Requirement |
| :--- | :--- |
| RL-1 | REST recipe endpoints (`/parse`, `/generate`) use a per-IP token bucket with **burst capacity 5** and a sustained refill of **10 tokens/min (~1 token per 6 s)**. With the bucket full, the first 5 rapid requests succeed and the **6th** (no tokens refilled) is denied; sustained traffic above the refill rate is denied. Denials return `429` with `Retry-After`. |
| RL-2 | Per-session utterance rate: minimum **1.5 s** between finalized turns. |
| RL-3 | Per-session audio caps: max **30 s** per utterance; **60 s** buffer cap before forced flush/discard. |
| RL-4 | Global daily ceiling of **500 Gemini calls/day** to bound cost/quota. |
| RL-5 | *(Recommended)* Per-IP WebSocket cap: **1 active socket**, reconnect throttling, close code `1013` on excess. Tracked as a recommended item; see Open Items. |

All limits are **environment-configurable** and return `429` + `Retry-After` (REST) or a `rate_limited` WS event (session).

## 7. Error Handling Requirements

| ID | Category | Requirement |
| :--- | :--- | :--- |
| EH-1 | Out-of-scope | The assistant politely declines non-cooking requests and redirects, **without** losing recipe context. |
| EH-2 | Recipe input | Unreadable, unsupported, oversized, or unparseable recipes produce a clear retry/rephrase prompt. |
| EH-3 | Bad audio | No-speech, too-long audio, corrupted PCM, and mic-permission loss are handled gracefully. |
| EH-4 | LLM | Gemini timeout, `429`, or safety block triggers a spoken fallback + backoff retry. |
| EH-5 | TTS | edge-tts failure degrades to text-only; transcript still shown. |
| EH-6 | Infrastructure | WS drop / machine restart reconnects with backoff and resyncs state from `localStorage`. |

Every error maps to a typed WS `error`/`rate_limited` event or a REST status code, and to a designed UI state (see design doc §8).

## 8. Non-Functional Requirements

| ID | Requirement | Target |
| :--- | :--- | :--- |
| NFR-1 | End-of-speech → first TTS audio | ≤ 2.5 s p50, ≤ 4 s p95 on reference hardware |
| NFR-2 | STT finalization (5 s utterance, `small.en` + greedy decoding) | ≤ 800 ms (legacy `base` target; may regress — see note) |
| NFR-3 | Recipe parse/generate | ≤ 8 s |
| NFR-4 | Privacy | Gemini key server-side only; no raw audio or recipe text persisted server-side |
| NFR-5 | Cost | FOSS components; paid only for hosting; Gemini daily cap enforced |
| NFR-6 | Accessibility | WCAG 2.1 AA, live captions of every spoken line (incl. deterministic readouts), `aria-live` voice-state announcements |
| NFR-7 | Motion | Ambient motion respects `prefers-reduced-motion` |
| NFR-8 | Devices | Modern Chromium-based browsers; graceful message on unsupported AudioWorklet |
| NFR-9 | Reliability | Automatic WS reconnect + state resync |

> **NFR-2 note:** STT uses `small.en` with **greedy decoding (`beam_size=1`)** and
> a culinary `initial_prompt`, plus a shortened `VAD_MIN_SILENCE_S=0.6` and
> `UTTERANCE_CONTINUATION_S=0.4`. Dropping the wider beam search and tightening
> the silence hold trades a little recognition accuracy for a faster
> end-of-speech → transcript path (the dominant term in first-audio latency);
> the model stays English-only `small.en`. The ≤ 800 ms target was characterized
> on the `base`/greedy configuration and must be re-benchmarked on the reference
> hardware. The requirement stands — it is not dropped, only pending
> re-measurement.

## 9. User Stories & Acceptance Criteria

### US-1 Generate and start cooking
*As a home cook, I want to say a dish and start cooking.*
- **AC-1.1** Saying "chicken adobo" yields a structured recipe within 8 s.
- **AC-1.2** The assistant reads the title and step count.
- **AC-1.3** The recipe is saved to the local cookbook.
- **AC-1.4** The assistant presents the ingredients and plan, and cooking starts only after the user confirms — by voice ("let's cook"/"go"/"proceed") or the "Let's cook" button.
- **AC-1.5** After naming a dish, the assistant asks "cook it straight away" or "plan it together" (offered as tappable chips); direct-cook announces the plan, ingredients, and ETA before cooking, and plan-together asks up to two questions first.
- **AC-1.6** Cancelling during planning or discontinuing during cooking returns to intake with the recipe cleared from the session and all timers cleared, while the recipe remains in the local cookbook.

### US-2 Navigate hands-free
*As a cook with wet hands, I want to move through steps by voice.*
- **AC-2.1** "What's next" advances exactly one step and reads it.
- **AC-2.2** "Repeat" re-reads the current step and does not advance.
- **AC-2.3** Step progress survives a page refresh.

### US-3 Timers
*As a cook, I want to set a timer by voice.*
- **AC-3.1** "Set a pasta timer for 8 minutes" creates a labeled 08:00 timer.
- **AC-3.2** The timer survives refresh and alerts with chime + notification on completion.

### US-4 Triage
*As a cook, I want help when something goes wrong.*
- **AC-4.1** "My garlic is browning too fast" returns an immediate corrective action.
- **AC-4.2** The current step index is unchanged after triage.

### US-5 Substitution
*As a cook missing an ingredient, I want a substitute.*
- **AC-5.1** "I don't have heavy cream" returns a substitute with adjusted ratio.

### US-6 Rate limiting
- **AC-6.1** With the bucket full, the first 5 rapid REST recipe requests succeed and the **6th** (with no tokens refilled) returns `429` with `Retry-After`; the bucket refills at 10/min (~1 token per 6 s).
- **AC-6.2** Exceeding the Gemini daily cap places the session in a clear degraded state.

### US-7 Out-of-scope handling
- **AC-7.1** "What's the weather?" is declined in-one-breath and redirected to cooking.
- **AC-7.2** Recipe context is preserved across the refusal.

### US-8 Finish a recipe
*As a cook, I want to know when I'm done and be celebrated for it.*
- **AC-8.1** Reaching or passing the final step ends the recipe, sets the session phase to `done`, and emits `{type:"done"}`.
- **AC-8.2** The assistant congratulates the user and the avatar plays the celebration (jump/spin, happy eyes, hat bounce, sparkle burst, completed progress ring).
- **AC-8.3** Saying "what's next" afterward offers a new dish rather than replaying the last step.
- **AC-8.4** The finished recipe remains in the local cookbook.

### US-9 Get a dish suggestion
*As a cook unsure what to make, I want a few ideas.*
- **AC-9.1** "What should I cook?" returns about five suggestions, popular/trending and mindful of ingredients on hand.
- **AC-9.2** After the user picks one, the assistant offers the cook-now vs plan-it choice and proceeds only after confirmation.

### US-10 Choose by tap, not talk
*As a cook with messy hands, I want to pick an option without speaking.*
- **AC-10.1** "What should I cook?" returns about five dish suggestions rendered as **tappable chips** (and spoken).
- **AC-10.2** Tapping a chip selects that dish and proceeds through the existing cook-now / plan-it flow.
- **AC-10.3** The completion confirmation also appears as chips ("Yes, I'm done" / "Not yet"); only "Yes" triggers the celebration, and the final step is not replayed.

## 10. Build Roadmap

| Phase | Deliverable | Exit criteria |
| :--- | :--- | :--- |
| 0 | Skeleton: FastAPI WS echo, React canvas, R3F avatar | Avatar renders; WS round-trips |
| 1 | Voice loop: AudioWorklet PCM, Silero VAD, faster-whisper | Transcript appears after speech |
| 2 | Brain: Gemini turns + tool calls, edge-tts, barge-in | Spoken answers; barge-in works |
| 3 | Recipe pipeline: parse + generate → `Recipe` | Both intake paths produce valid JSON |
| 4 | Timers + notifications + cookbook | Timer survives refresh; alerts fire |
| 5 | Rate limits + error taxonomy + polish | RL/EH acceptance tests pass |
| 6 | Deploy: Fly.io volume, Vercel, docs | Public URL, cold start < acceptable |

## 11. Risks

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| Echo / self-audio triggers barge-in | Assistant interrupts itself | `echoCancellation: true`, mic gating during TTS, energy threshold |
| CPU latency (Whisper + Silero) on shared tier | Slow first turn | Persistent model volume, warm machine, `small.en` + greedy decoding and shortened VAD silence for lower end-of-speech latency (re-benchmark NFR-2), sentence-streamed TTS |
| No wake word | False triggers | Energy VAD thresholds; mute control; wake word deferred to V2 |
| Gemini free-tier limits | Failed turns | Daily cap, backoff, graceful degraded state |
| edge-tts has no SLA (unofficial MS endpoint) | TTS outages | Text-only fallback; abstract TTS behind an interface |
| 3D GPU floor | Poor perf on low-end | Device tiers, DPR clamp, disable heavy effects |
| Fly.io is not free | Cost overrun | Single small machine; documented cost note |

## 12. Open Items

1. **Repo layout** — assumed single repo with `frontend/` + `backend/`; confirm.
2. **Per-IP WebSocket cap (RL-5)** — recommended but not yet confirmed.
3. **Reference hardware** for NFR latency targets — to be pinned in `AGENTS.md`.
