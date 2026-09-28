# GourMate — UI/UX Design Specification

| Field | Value |
| :--- | :--- |
| Status | Approved for V1 |
| Version | 1.0 |
| Doc type | UI/UX design |
| Upstream | `specs/gourmate.spec.md`, `docs/decisions/gourmate.architecture.md` |

---

## 1. Design Thesis

> **"The sous-chef on the pass."**

The 3D character **is** the status system. There are no spinners, progress bars, or "AI is thinking" text; the avatar's eyes and expression communicate every state — Idle, Listening, Submitting, Processing, Answering, and the completion **Done** celebration. This is the single signature element and the one aesthetic risk; everything around it stays quiet and disciplined.

Cooking recipes are a **true ordered sequence**, so a step rail with real order is meaningful information (not decorative numbering). The whole experience lives on **one continuous immersive canvas**: intake and cooking are the same space, with no screen change. The avatar **recedes** while the recipe leads and **expands** to converse.

**North star:** Apple-like restraint. Warm charred palette, one interactive accent, matte clay avatar, generous negative space.

## 2. Design Tokens

### 2.1 Color

**Dark — "night kitchen" (default emotional reference)**
| Token | Hex | Use |
| :--- | :--- | :--- |
| `--bg` | `#141110` | canvas |
| `--surface` | `#1E1A17` | panels, step card, sheets |
| `--surface-2` | `#272220` | raised elements |
| `--text` | `#F5EFE6` | primary text (bone) |
| `--text-muted` | `#A79E93` | secondary text |
| `--tallow` | `#F2B24C` | key light, timers, attention |
| `--verdigris` | `#6FA98B` | the one interactive accent |
| `--ember` | `#E4572E` | triage / burn only |
| `--steel` | `#9BA8B0` | utility, mic status |

**Light — "daylight kitchen"**
| Token | Hex | Use |
| :--- | :--- | :--- |
| `--bg` | `#F7F3EC` | canvas |
| `--surface` | `#FFFFFF` | panels, sheets |
| `--surface-2` | `#EFE9DF` | raised elements |
| `--text` | `#1B1714` | primary text |
| `--text-muted` | `#6B6259` | secondary text |
| `--tallow` | `#C8821A` | key light, timers |
| `--verdigris` | `#3E7A5E` | interactive accent |
| `--ember` | `#C63D1E` | triage / burn only |
| `--steel` | `#6B7377` | utility |

Both themes meet **WCAG AA** for text/background pairs.

### 2.2 Typography
| Role | Face | Usage |
| :--- | :--- | :--- |
| Display | **Bricolage Grotesque** | dish title, step title only |
| UI / body | **Geist** | labels, controls, captions |
| Numeric | **Geist Mono** | tabular timer digits |

Scale: `12 / 14 / 16 / 20 / 28 / 40 / 56`. Display weights 600; UI 400/500. Timers use `font-variant-numeric: tabular-nums` so digits never jitter.

### 2.3 Spacing, Radius, Elevation
- Spacing scale: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`.
- Radius: `sm 8 · md 14 · lg 24 · full`; avatar is organic, not governed by UI radius.
- Elevation: soft, warm-tinted shadows only in light mode; dark mode uses subtle light falloff instead of drop shadows.

### 2.4 Motion Tokens
| Token | Duration | Use |
| :--- | :--- | :--- |
| `micro` | 120 ms | press, toggle, mute |
| `feedback` | 180 ms | state flash, submit |
| `state` | 240 ms | voice-state transitions |
| `layout` | 320 ms | avatar recede/expand, sheets |
| `spring` | physical | avatar body motion |

Easing: `cubic-bezier(0.2, 0, 0, 1)` for UI; springs (no easing curve) for the avatar.

## 3. The Character (3D Spec)

- **Tech:** React Three Fiber + `@react-three/drei`, fully procedural geometry — no external asset pipeline.
- **Form (reference-matched):** a soft glossy **squircle** rendered as a single smooth **superellipsoid** (`buildSquircleGeometry`, L⁴ norm — no flat front face, no box seams) — the character *is* the blob — topped with a **puffy multi-lobe chef toque** (large band + 4–5 overlapping lobes, verdigris accent band) that is **seated into the crown** and worn with a permanent ~9° **jaunty sideways tilt**. Face = **two small dark pill eyes** (`^` arc when happy); **no mouth**; soft oval **blush** cheeks. No speech-bubble tail.
- **Material:** **glossy candy-clay** in a fixed **deep warm orange** (`#E0702A`, theme-independent) — low roughness (`0.26`), strong clearcoat (`0.9`), a small white **softbox highlight**. The **hat uses the same material profile** so it reads as one piece with the body. The eyes are a **dark glossy dielectric** (near-black `#191919`, high clearcoat) catching the same highlight (no emboss socket). Matches the reference mascots.
- **Lighting:** a **procedural studio environment** (drei `Environment` + `Lightformer` key/rim/ring — no HDRI download) plus a warm tallow key + cool stainless rim, **ACES filmic tone mapping**, and a soft contact shadow. The character floats on the app background (no panel).
- **Expression (crossfade, no morph targets):** each eye crossfades between a **dark pill** and a thick **`^` arc** (torus). The **happy sequence** is `pill closes (0.14 s) → ^ ^ holds (2.0 s) → eases back open (0.45 s)`, with asymmetric damping so it snaps shut and eases open. **Blink** squashes the eye group vertically (idle only); **shift up-left** when thinking; **blush** warms on answering/happy. The head and eyes **subtly follow the cursor** (damped yaw/pitch + eye shift).
- **Aliveness (secondary motion):** gentle **breathing** (scaleY), randomized idle micro-movement and blink timing, squash-and-stretch on state changes, and a springy **hat jiggle**. Under `prefers-reduced-motion` these pause (see below).
- **Expression triggers:** a **happy pulse** (`^` + small hop + hat bounce + blush) fires when the assistant starts replying, when a turn completes, and when a recipe arrives. A **recipe arrival** additionally plays a one-shot **"ta-da"**: bigger hop + expanding golden ring burst + hat bounce + a queued **double `^ ^`**.
- **Interactable:** hovering shows a pointer cursor and plays the happy `^ ^` **once per hover** — hover is detected on a single invisible hit-region and re-arms only after the pointer has genuinely left (hysteresis), so moving across the model or jittering in/out does not repeat it. **Clicking** triggers a **hop + 360° vertical spin** (Y-axis, ~0.8 s ease-out) + happy `^` eyes + hat bounce. Reduced motion keeps the happy-eyes flash but drops the motion.
- **Focus light:** the character's own light intensity tracks state (brighter when Answering, dimmer ambient when Listening).
- **Talk motion:** a gentle per-sentence nod is driven by the Web Audio `AnalyserNode` amplitude of the TTS audio (no mouth mesh).
- **Recede behavior:** during step reading the character scales down and slides to a lower corner (spring-driven); on dialogue it returns to center at full scale. `layout` token = 320 ms.
- **Performance tiers:** clamp DPR, drop the environment reflections, sparkles and contact shadow on low-power devices, cap triangle budget. Reduce ambient effects before dropping frame rate.

### 3.1 Procedural Build (reference)
```
body    = superellipsoid(0.98 × 0.94 × 0.64, L^4)       // one smooth glossy squircle
hat     = Cylinder(open band, verdigris accent) + 5× Sphere lobes (puffy toque),
          seated at y=0.40 (band sinks into the crown), permanent ~9° sideways tilt
eyes    = 2 × capsule (pill) crossfade ⇄ 2 × halved torus (^ arc)
          happy: close 0.14 s → hold 2.0 s → open 0.45 s (asymmetric damping)
blush   = 2 × flattened spheres (opacity warms on happy/answering)
face    = no mouth, no brows, no tail (expressions live in the eyes / tilt / blush)
hover   = single invisible hit-region; happy ^ ^ once per hover (re-arm hysteresis)
click   = hop + Y-axis 360° spin (~0.8 s ease-out) + happy ^ + hat bounce
pointer = damped head yaw/pitch + eye shift follows the cursor
```

## 4. State Animation System

The avatar is the status indicator. Nine states, all mapped to architecture WS events.

| State | Trigger | Avatar motion | Eyes / expression | Light | HUD |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Idle** | no speech or TTS | slow bob (4 s loop) + breathing, occasional blink | pill eyes straight, blink every 3–6 s | warm 40% | step text, rail |
| **Listening** | `vad:speech_start` | leans in ~6°, head tilt (curious), faster bob (2.4 s); **nod-along** to the user's voice peaks (mic level) | pills perk up + **widen with mic level** | key up, ambience dims | **expanding mic-driven ripples behind the head**, "Listening" |
| **Submitting** | `vad:speech_end` | nod down ~8° (180 ms), pulse travels up into hat | brief blink | flash | waveform collapses |
| **Processing** | awaiting Whisper + Gemini | **stir orbit** (slow circular lean/turntable ~1.2 s), **heartbeat** double-pulse squash, hat pom wobble | eyes up-left (thinking) + **orbiting golden sparks** + **`···` ellipsis** | pulsing warm | "Thinking…" subtle label |
| **Answering** | `assistant_audio` streaming | **talk-bob** + **side-to-side rock** from TTS amplitude, hat springs per phrase, blush warms | gently `^` (pleased) | key +15% | assistant captions |
| **Planning** | `plan` event, awaiting confirmation | lean back + gentle "presenting" sweep toward the plan card, hat perky | eyes up-left (curious), easing to `^` while presenting | warm key, steady | plan card, **Let's cook** action, collapsible ingredients |
| **Triage** | burn/emergency detected | quick shake ±3° @60 ms | wide pills | ember rim light | red banner, context preserved |
| **Error** | typed `error` event | droop ~8°, desaturate | squint + "!" | grey | inline message |
| **Done / Celebration** | final step reached or passed (`{type:"done"}`) | big hop + **360° spin** (~0.8 s) + hat bounce, springy squash-and-stretch | happy `^ ^` (long hold), warm blush | key up, tallow glow | **progress ring completes**, confetti/sparkle burst, "what's next" + suggestion chips |

**Happy pulse:** eyes crossfade into a `^` (thick arc) with a small hop + hat bounce + blush. Fires when the assistant starts replying, when a turn completes (`→ idle`), and when a recipe arrives (which also plays the one-shot "ta-da" burst + double `^ ^`).

**Completion celebration:** at `{type:"done"}` the avatar runs the **biggest** celebration — hop + 360° spin + hat bounce + happy `^ ^` + blush — synchronized with the progress ring completing and a confetti/sparkle burst (design §3 sparkles, respecting performance tiers). It is distinct from the recipe-arrival "ta-da": the recipe arrival celebrates the *start*, completion celebrates the *finish*.

**Completion is confirmed first:** a done cue at or after the final step ("I'm done", "finished", "that's it") or the "Done cooking" button does **not** jump straight to this celebration — the assistant opens the same tappable `choices` ("Yes, I'm done" / "Not yet"). Only "Yes" emits `{type:"done"}` and runs the celebration above; "Not yet" returns to the current step. The final step is never replayed.

**Interactable:** hover shows a pointer cursor and plays the happy `^ ^` **once per hover**; clicking the character plays a hop + **360° vertical spin** + happy `^` eyes + hat bounce. The head and eyes subtly follow the cursor.

**Barge-in:** on `vad:speech_start` while Answering → stop TTS playback, transition Answering → Listening (`state` token).

**Reduced motion (recommendation):** user chose 3D-only (no 2D avatar). Under `prefers-reduced-motion`, pause **ambient** loops (idle bob, breathing, orbit motif, sparkles), the click hop + spin, and pointer tracking, but keep discrete state transitions and the happy-eye morph expression. Recorded here as a recommendation, not a requirement change.

## 5. Screens & Flows

### 5.1 One Continuous Canvas
There is **no screen change** between intake and cooking. The avatar, lighting, and layout persist; only the surrounding HUD changes.

**Intake state**
```
┌──────────────────────────────────────────────┐
│  GourMate                              ⚙     │
│                                              │
│                ╭─────────╮                   │
│                │  ◠   ◠  │   avatar (center)  │
│                │   ╰─╯   │                   │
│                ╰────┬────╯                   │
│                  chef hat                    │
│                                              │
│      "What are we cooking?"                  │  ← live caption of assistant
│  ┌────────────────────────┐  ┌───────────┐   │
│  │ type or paste a recipe… │  │ Start     │   │  ← equal-weight text path
│  └────────────────────────┘  └───────────┘   │
│                ◉ Listening…                  │
└──────────────────────────────────────────────┘
```
- Voice accepts a **dish name** (generate) or **full dictation** (parse), and the text field is **equal weight**.

**Planning state**
```
┌──────────────────────────────────────────────┐
│  Chicken Adobo                              │
│                                              │
│                ╭─────────╮                   │
│                │  ◠   ◠  │   eyes up-left     │  ← curious, presenting plan
│                │   ╰─╯   │                   │
│                ╰────┬────╯                   │
│                  chef hat                    │
│  ┌──────────────────────────────────────────┐│
│  │ PLAN · Serves 4            6 ingredients ││  ← plan card
│  │ • 2 lb chicken thighs  • 1/2 cup soy     ││
│  │ • 1/3 cup vinegar      • 6 cloves garlic ││
│  │ 1. Marinate the chicken…                  ││  ← ordered steps
│  │ 2. Sear skin-side down…    ┌───────────┐ ││
│  │                            │ Let's cook│ ││  ← explicit confirm
│  │                            └───────────┘ ││
│  └──────────────────────────────────────────┘│
│  "Here's the plan — change anything, or say go." │
└──────────────────────────────────────────────┘
```
- The assistant interviews (≤ 2 brief questions), then **always** presents the plan; cooking does **not** begin until the user confirms by voice or taps **Let's cook**. A revision regenerates the plan (architecture §6–§9).

**Cancel / discontinue**
- In **Planning**, the user can **cancel** by voice ("cancel", "never mind", "start over") or the plan card's cancel affordance; in **Cooking**, they can **discontinue** ("stop cooking", "stop", "I'm done") or via the HUD. Both are the same reset.
- Both **reset to Intake**: the recipe leaves the active session, the phase returns to `intake`, `current_step_index` clears to `0`, and all timers are cleared. The recipe is **not** deleted — it remains in the local cookbook (architecture §5 State Ownership).
- Over the wire the server emits `{type:"reset"}` (architecture §7); the client returns to the Intake state above with an empty canvas and the "What are we cooking?" prompt.

**Cooking state**
```
┌──────────────────────────────────────────────┐
│  Seared Salmon & Asparagus          ⚙   ⏻    │
│  ──●───●───●───○───○───○    Step 3 of 6      │  ← read-only rail (real order)
│                                              │
│                                        ╭───╮ │
│       ◯ pasta 08:00                    │ ◠◠ │ │  ← avatar receded
│       ◯ rest 02:30                     │ ╰─╯ │ │
│                                        ╰───╯ │
│  ┌──────────────────────────────────────────┐│
│  │ Sear salmon skin-side down 4 min, don't  ││  ← step card (hero)
│  │ move it.                                 ││
│  └──────────────────────────────────────────┘│
│  "Go ahead, lay it in skin-side down…"       │  ← captions
│                ◉ Listening…                  │
└──────────────────────────────────────────────┘
```

**Completion state**
```
┌──────────────────────────────────────────────┐
│  Seared Salmon & Asparagus                   │
│  ──●───●───●───●───●───●   Complete           │  ← progress ring / rail full
│               ✦     ✦     ✦                  │  ← confetti / sparkle burst
│                    ╭───────╮                  │
│                    │  ^   ^  │  avatar cheering │  ← celebratory spin
│                    ╰────┬────╯                  │
│  "That's a wrap — you nailed it."            │  ← caption (also spoken)
│  Suggest something new?   [ dish ] [ dish ]   │  ← suggestion chips
└──────────────────────────────────────────────┘
```
- Reaching or passing the final step sets the phase to `done` and emits `{type:"done"}`. The assistant congratulates and offers a new dish; the finished recipe stays in the cookbook.

### 5.2 Overlays
| Overlay | Presentation |
| :--- | :--- |
| Timer expanded | Tap a ring → full-screen ring, label, remaining time, cancel |
| Plan view | Full plan card: ingredients list + ordered steps, with a **Let's cook** action and an edit affordance (a revision regenerates the plan) |
| Ingredients panel | Collapsible panel listing ingredients, available from the plan and during cooking; toggled from the HUD |
| Transcript sheet | Slide-up sheet: full session transcript, copyable |
| Triage banner | Ember-tinted banner with the corrective action; recipe context intact |
| Completion | Progress ring completes, celebratory avatar, a "nice work" headline, and "what's next" suggestion chips |
| Dish suggestions | When the user asks "what should I cook?", about five dish **chips** appear as tappable options (also speakable) from a server `choices` event; choosing one runs the existing cook-now / plan-it choice |
| Completion confirm | Reaching the last step (or the "Done cooking" button) opens the same **choice chips** ("Yes, I'm done" / "Not yet"); only "Yes" runs the completion celebration |
| Choice chips | The shared `choices` presentation: a single-select row of pill chips, ≥ 44 px tall, focus-ringed and keyboard-selectable; tapping sends the chip label as the user's next utterance. Used for dish suggestions, the cook-now / plan-it choice, and the completion confirmation |
| Notifications | **Top-center** toasts (timer done, recoverable errors, confirmations); each **auto-dismisses after ~4 s** and never blocks the mic controls |
| Planner panel | Titled **“Planner”**; **auto-opens when a plan is presented or cooking starts**; its minimize is a **circular handle centered on the panel edge** (overlapping it) that collapses/expands the panel |
| Error / rate-limit toast | Inline, calm; retry affordance where recoverable |
| Settings sheet | Minimal (see §5.4) |
| Onboarding | 3 cards: mic permission → how to talk → start |

### 5.3 Timers
- **Orbiting rings** around the avatar, each a distinct tallow-family hue; label + `MM:SS` in Geist Mono.
- When the avatar recedes, rings dock into a tidy vertical stack near it (no overlap with the step card).
- Completion: chime (`feedback`) + browser notification + ring pulses to verdigris.

### 5.4 Settings (minimal)
Voice pick · mic device · timer sound on/off · theme (auto/light/dark) · clear cookbook.

The **voice pick** lists the backend allow-list; selecting one changes the assistant's **actual** edge-tts voice for the session (emits `{type:"control", action:"set_voice", voice:"<id>"}`) and is persisted locally across refresh. **Preview voice** plays a **real** backend-synthesized sample (`POST /api/tts/preview`), so what the user hears is exactly what the assistant will say (architecture §7–§8).

## 6. Interaction Model

- **Always-listening** is the default; the user speaks naturally and the backend VAD ends the utterance.
- **Visible controls are only:** a persistent mic-status indicator and a mute control.
- **Barge-in:** speaking while the assistant talks interrupts it immediately.
- **Recipe navigation is voice-only** ("next", "back", "repeat"); the step rail is a **read-only** progress indicator.
- **Text input** exists during intake only, of equal weight to voice.
- **Tap targets** ≥ 44×44 px; every interactive element has a visible focus ring.

### 6.1 Conversation UX

The assistant is **Planner**, a warm cooking **companion** — not a chatbot and not a robotic command line. (The persona is **Planner**; the app brand remains **GourMate**.) The user is cooking with messy hands, so every spoken turn is optimized for listening, never reading.

- **Tone:** warm, encouraging, a little playful, and hands-free. Planner sounds like a companion beside the stove — it remembers what was said earlier, celebrates small wins, and never scolds or goes clinical. Plain verbs, sentence case, no filler and no apologies (see §8). One job per message; never robotic.
- **Companion continuity:** Planner references recent session context naturally (e.g. an earlier substitution or a timer), so the conversation feels remembered rather than reset.
- **Turn shape:** each reply is **2–3 short sentences** of clean plain text. Speak the plan, the ingredients, and the estimated time; never dump markdown, asterisks, bullets, or numbered lists into speech — ordered steps live in the HUD, not in the voice.
- **Every spoken line is captioned:** any deterministic server line that is spoken — the plan readback, step readouts, the cook-now / plan-it choice, cancel/discontinue, and the completion congratulation — appears as an `assistant_text` caption too, so the chat and the transcript sheet always mirror the voice (FR-10).
- **Always present ingredients + ETA:** before cooking begins — and again when reading out a step during cooking — the assistant states the **ingredients** and an **estimated time**. Plans state the recipe's total time; each step readout states that step's duration; while cooking the UI shows the total time plus the current step's ETA (architecture §6 time fields).
- **Choices are tapped, not spelled out:** when the assistant offers options (e.g. "cook it straight away" vs "plan it together", about five "what should I cook?" dish suggestions, or the completion confirmation "Yes, I'm done" / "Not yet"), they appear as **tappable chips** as well as being speakable, so the user can choose without talking. They arrive via a server `choices` event; tapping a chip sends its label as the user's next utterance.
- **Explicit confirmation to start:** cooking never begins on the assistant's initiative — after the plan and ingredients are presented, the user must confirm by voice ("let's cook"/"go"/"proceed") or tap **Let's cook** (FR-1.6, §5.1).
- **Explicit cancel / discontinue:** the user can always back out — cancel during planning or discontinue during cooking — by voice or button; both reset to Intake (§5.1).
- **Celebrate completion:** reaching or passing the final step ends the recipe — the avatar celebrates, Planner congratulates, and "what's next" offers a new dish instead of replaying the last step (§5.1 Completion state, architecture §6–§7).

## 7. Accessibility

| Requirement | Implementation |
| :--- | :--- |
| WCAG 2.1 AA contrast | Verified token pairs in both themes |
| Voice state for non-visual users | `aria-live="polite"` announcements: "Listening", "Thinking", "Answering", and completion ("Nice work") |
| Captions | Live captions of **every** spoken line, including deterministic readouts and the completion congratulation (`assistant_text`); transcript sheet |
| Reduced motion | Pause ambient avatar loops under `prefers-reduced-motion` (recommendation) |
| Keyboard | Full focus order; Escape closes sheets; space toggles mute |
| Screen staying awake | Wake Lock API during Cook Mode |
| Color independence | Triage uses text + icon, not color alone; timers carry labels |
| Distance legibility | Step title ≥ 28 px; timer digits high-contrast mono |

## 8. Copy & Error Voice

Errors are direction, not mood. They say what happened and what to do; they never apologize or go vague.

| State | Message |
| :--- | :--- |
| Intake prompt | "What are we cooking?" |
| Out-of-scope refusal | "I'm just here for the cooking. Want me to get back to the sear?" |
| Unsupported recipe input | "I couldn't read that one. Paste it again, or tell me the dish." |
| Bad audio | "I didn't catch that — say it once more." |
| Mic denied | "I need mic access to cook hands-free. Turn it on in your browser settings." |
| Rate limited | "Give me a few seconds before the next one." |
| LLM unavailable | "My brain's not responding right now. Give me a moment and say that again." |
| Engine warming | "One sec — I'm just waking up." |
| Timer done | "Pasta's ready." |
| Completion | "That's a wrap — you nailed it. Want something new, or shall I suggest a dish?" |
| Dish suggestions | "Here are a few I think you'll love — which one sounds good?" |

Tone: conversational, plain verbs, sentence case, one job per message.

## 9. Implementation Notes

- **Avatar:** R3F `useFrame` + damped springs (`@react-spring/three` or `maath`); mouth from an `AnalyserNode` bound to the TTS audio element.
- **State wiring:** the nine avatar states subscribe to a single `voiceState` store fed by WS events (`vad`, `assistant_audio`, `turn_end`, `error`, `done`).
- **Recede/animate:** animate transforms, never layout; keep the canvas full-bleed behind the HUD.
- **Theme:** CSS custom properties per token table; `prefers-color-scheme` drives auto mode.
- **Device tiers:** detect WebGL capabilities + `navigator.hardwareConcurrency`; downgrade shadows/particles/DPR accordingly.
- **Perf budget:** target 60 fps; the step card and captions are DOM (not 3D) for crisp typography.
- **Portrait fallback:** landscape is primary, but in portrait the avatar moves to the top third, step card and timers stack below.

## 10. Open Items

1. Reference device tiers for the 3D performance budget.
2. Whether ambient-loop pausing under reduced motion is promoted from recommendation to requirement.
3. Exact tallow-family palette steps for distinguishing multiple concurrent timer rings (needs a 5-hue set with AA contrast).
