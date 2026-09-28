# GourMate — Tech Stack & Decision Record

| Field | Value |
| :--- | :--- |
| Status | Approved for V1 |
| Version | 1.0 |
| Doc type | Architecture Decision Record (stack) |
| Upstream | `specs/gourmate.spec.md` |

Each entry follows: **Choice → Alternatives considered → Why the alternatives lost.**

---

## 1. Stack at a Glance

| Layer | Choice |
| :--- | :--- |
| Speech-to-text | `faster-whisper` (`small.en`) final + offline `sherpa-onnx` streaming zipformer partials, server-side CPU |
| Voice activity detection | `Silero VAD`, server-side, continuous |
| Brain | Gemini 3.5 Flash Lite via `google-genai` — recipe parse/generate **and** live conversation, function calling |
| Text-to-speech | `edge-tts`, sentence-streamed |
| Backend runtime | Python 3.11 |
| Backend framework | FastAPI + Uvicorn (async WS + REST) |
| Transport | WebSocket: 16 kHz mono Int16 PCM up; JSON events + MP3 down |
| Frontend | React + TypeScript + Vite |
| Styling | Tailwind CSS |
| PWA | `vite-plugin-pwa` |
| 3D avatar | React Three Fiber + `@react-three/drei` |
| Animation | `@react-spring/three` / `maath` damp + Web Audio `AnalyserNode` |
| Persistence | Browser `localStorage` |
| Rate limiting | `slowapi` (REST) + in-process counters (global cap) |
| Frontend hosting | Vercel |
| Backend hosting | Fly.io + persistent volume |

## 2. Decision Tables

### D-1 Speech-to-Text
| | |
| :--- | :--- |
| **Choice** | `faster-whisper` `small.en` (English-only), CPU inference, `beam_size=5` decoding + culinary `initial_prompt` |
| **Alternatives** | Browser Web Speech API; Whisper `base` / `tiny.en`; cloud STT (Deepgram/AssemblyAI) |
| **Why rejected** | Browser STT is inconsistent across engines and unavailable in Firefox; `base` mishears ingredient names and quantities often enough to break a hands-free cook; cloud STT breaks the zero-marginal-cost/privacy goal. `small.en` (English-only), 5-wide beam search, and a culinary `initial_prompt` trade some CPU latency for materially better recognition of ingredient, unit, and quantity vocabulary — accuracy matters more than the old finalization budget in a kitchen. |

### D-1b Live Partials (streaming) — **disabled by default**
| | |
| :--- | :--- |
| **Status** | **Off** (`STREAMING_STT_ENABLED=false`, `WHISPER_PARTIAL_ENABLED=false`). In practice the streaming partials were materially less accurate than the final `small.en` pass, so live user captions were removed from the UI and only the final transcript is shown. The code remains gated for re-enabling. |
| **Choice (if re-enabled)** | `sherpa-onnx` streaming zipformer (English, int8 ONNX) for live partial captions; `faster-whisper` `small.en` beam=5 remains the authoritative finalizer |
| **Alternatives** | Chunked re-decode of the growing Whisper clip with LocalAgreement-2 (kept as the fail-soft fallback); cloud streaming (Deepgram/AssemblyAI); a `tiny.en` partial model |
| **Why rejected** | Re-decoding the whole growing clip every 250 ms is CPU-heavy, and a weaker partial model produced live text that disagreed with the final transcript; cloud streaming breaks the zero-marginal-cost/privacy goal. A true streaming zipformer decodes incrementally, is Apache-2.0, CPU-only and ~72 MB int8, and fails soft to the chunked path if the wheel/model is unavailable. |

### D-2 Voice Activity Detection

| | |
| :--- | :--- |
| **Choice** | `Silero VAD`, run server-side on the continuous stream |
| **Alternatives** | Client-side `webrtcvad`; energy-threshold gating; no VAD (push-to-talk) |
| **Why rejected** | Client-side VAD adds a second protocol and drifts from Whisper's framing; energy thresholds fail in noisy kitchens; no-VAD contradicts the always-listening + barge-in requirement. Server-side Silero gives accurate end-of-utterance and enables barge-in detection. |

### D-3 Brain (LLM)
| | |
| :--- | :--- |
| **Choice** | Gemini 3.5 Flash Lite via `google-genai` |
| **Alternatives** | DeepSeek V4.1 Flash via Cline Pass; Groq Llama; Gemini 2.5 Pro / Flash-Lite |
| **Why rejected** | Cline Pass is a coding-agent gateway, not an app runtime API contract (no confirmed tool-calling/streaming SLA for production); Groq was a proposed split-brain design that added a second provider for no user benefit; `pro` is slower/costlier per voice turn; `flash-lite` risks weak culinary triage. Flash offers native function calling, streaming, and acceptable latency. |

### D-4 Text-to-Speech
| | |
| :--- | :--- |
| **Choice** | `edge-tts`, synthesized per sentence |
| **Alternatives** | Browser `SpeechSynthesis`; ElevenLabs; Coqui/Piper self-hosted |
| **Why rejected** | Browser TTS voice quality/availability is inconsistent; ElevenLabs breaks the free goal; Piper adds another model to host. `edge-tts` is high-quality and free; risk (no SLA) is mitigated by a TTS interface + text fallback. |

### D-5 Audio Transport
| | |
| :--- | :--- |
| **Choice** | WebSocket streaming 16 kHz mono Int16 PCM |
| **Alternatives** | Chunked `MediaRecorder` uploads; WebRTC |
| **Why rejected** | MediaRecorder chunks are encoded and awkward for continuous VAD; WebRTC adds SFU/ops complexity. Raw PCM over WS is the lowest-friction match for server-side Silero + faster-whisper. |

### D-6 Backend Framework
| | |
| :--- | :--- |
| **Choice** | FastAPI + Uvicorn |
| **Alternatives** | Flask + Socket.IO; Litestar/Starlette; Django |
| **Why rejected** | Flask's async/WS story is weaker; Litestar has a smaller ecosystem for ML/audio tooling; Django is heavyweight for a single-purpose service. FastAPI gives native async WS, Pydantic schemas, and easy ML integration. |

### D-7 Frontend Build
| | |
| :--- | :--- |
| **Choice** | React + TypeScript + Vite (SPA) + Tailwind |
| **Alternatives** | Next.js; plain JS; CSS-in-JS |
| **Why rejected** | Next.js SSR provides no value for a client-heavy, authenticated-free real-time app and complicates the separate Python backend; plain JS loses type safety on the WS protocol; Tailwind matches the concept and speeds token-driven theming. |

### D-8 3D Avatar
| | |
| :--- | :--- |
| **Choice** | React Three Fiber + drei, procedural geometry |
| **Alternatives** | GLTF/Spline-authored asset; CSS/SVG only; Babylon.js |
| **Why rejected** | Authored assets add a pipeline and licensing/versioning burden for a simple form; SVG cannot deliver the clay/lighting premium feel; Babylon is heavier with no React integration benefit. Procedural R3F keeps the avatar code-native and themeable. |

### D-9 Persistence
| | |
| :--- | :--- |
| **Choice** | Browser `localStorage` |
| **Alternatives** | IndexedDB; server SQLite/Postgres; no persistence |
| **Why rejected** | IndexedDB is overkill for small cookbook/state; server storage breaks the anonymous/privacy model and adds DB scope; no-persistence violates FR-7. |

### D-10 Rate Limiting
| | |
| :--- | :--- |
| **Choice** | Custom in-process token bucket (`RestTokenBucket`, `backend/app/ratelimit.py`) for `/api/recipes/*`, plus in-process per-session limits and a global Gemini daily counter. `slowapi` wraps only `/api/health`. |
| **Alternatives** | `slowapi` for every endpoint; reverse-proxy limits only (Fly); Redis-backed limiter; no limits |
| **Why rejected** | The recipe limiter needs the burst-capacity + sustained-refill token bucket defined by spec RL-1, and the session/Gemini layers hold state a generic request limiter does not model; `slowapi` is retained for the simple `/api/health` limit. Proxy-only can't see per-session utterance limits or Gemini cost; Redis is unwarranted for a single machine. In-process counters are correct at V1 scale (documented migration path to Redis if horizontally scaled). |

### D-11 Hosting
| | |
| :--- | :--- |
| **Choice** | Vercel (FE) + Fly.io machine with volume (BE) |
| **Alternatives** | Render free tier; Hugging Face Spaces; single VPS; local/LAN |
| **Why rejected** | Render free tier risks OOM/cold starts loading two models; HF Spaces cold-starts and memory limits hurt the first turn; a VPS is more ops than needed; local/LAN cannot be shown to users. Fly's persistent volume caches model weights and avoids re-download. |

## 3. Value-Source Audit

Every value rendered or spoken must trace to an authoritative source. No placeholder or inferred data is permitted.

| Output Field / Computation | Data Source / Upstream | Fallback / Failure State |
| :--- | :--- | :--- |
| Dish title | `Recipe.title` (Gemini parse/generate) | Intake error prompt (EH-2) |
| Step text read aloud | `Recipe.steps[current_step_index].instruction` | Error state, offer repeat |
| "Step N of M" | `current_step_index` + `Recipe.steps.length` | Hidden until recipe loaded |
| Ingredient quantity answers | `Ingredient.quantity` / `.unit` / `.display` | "I don't have that quantity" |
| Substitution advice | Gemini response grounded on `Ingredient` | Decline + ask again |
| Timer label & duration | `create_kitchen_timer` tool arguments | Reject malformed call |
| Timer countdown | `KitchenTimer.ends_at` − now (client clock) | Refresh resync from `localStorage` |
| Timer completion alert | `KitchenTimer.status === done` transition | Missed while tab closed → alert on resume |
| Transcript / captions | faster-whisper output (user) / Gemini text (assistant) | Text-only fallback (EH-5) |
| Voice state (avatar) | Server `vad` + `assistant_audio`/`turn_end` events | Default to Idle on disconnect |
| Error messages | Typed `error.code` → copy map (design §8) | Generic "I hit a snag" |
| Rate-limit state | `rate_limited` event / REST `429` | Backoff display |

## 4. Dependencies (proposed)

**Backend**
```
fastapi
uvicorn[standard]
websockets
google-genai
faster-whisper
silero-vad
edge-tts
numpy
slowapi               # only for /api/health; /api/recipes/* uses app/ratelimit.py
pydantic-settings
python-dotenv
```

**Frontend**
```
react, react-dom
typescript, vite
tailwindcss
vite-plugin-pwa
three, @react-three/fiber, @react-three/drei
@react-spring/three
```

## 5. Configuration (environment)

| Variable | Purpose | Default |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Server-side brain key | *(required, secret)* |
| `GEMINI_MODEL` | Model id | `gemini-3.5-flash-lite` |
| `WHISPER_MODEL` | faster-whisper size (English-only) | `small.en` |
| `WHISPER_BEAM_SIZE` | decoding beam width (final pass) | `5` |
| `WHISPER_PARTIAL_MODEL` | model for the (disabled) live partial pass | `small.en` |
| `PARTIAL_INTERVAL_S` | live partial re-decode cadence | `0.25` |
| `WHISPER_PARTIAL_ENABLED` | chunked Whisper live partials | `false` |
| `STREAMING_STT_ENABLED` | true offline streaming partials (sherpa-onnx) | `false` |
| `TRANSCRIPTION_ONLY` | transcribe only (skip Gemini + TTS); `false` = full assistant | `false` |
| `STREAMING_STT_REPO` | streaming model repo (weights cached under `HF_HOME`) | `csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26` |
| `STREAMING_STT_NUM_THREADS` | sherpa-onnx decode threads | `1` |
| `WHISPER_INITIAL_PROMPT` | culinary vocabulary bias prompt | `Kitchen voice commands and recipe instructions. Units and measurements: tablespoon, teaspoon, cup, ounce, gram, milliliter, degrees Fahrenheit, Celsius, pound. Actions: chop, mince, dice, slice, whisk, stir, simmer, boil, saute, sear, roast, bake, broil, reduce, season. Ingredients: garlic, onion, butter, olive oil, salt, pepper, chicken, beef, salmon, pasta, rice, sauce.` |
| `VAD_MIN_SILENCE_S` | silence hold before end-of-utterance | `1.0` |
| `UTTERANCE_CONTINUATION_S` | post-pause window merging resumed speech into one utterance | `0.8` |
| `HF_HOME` | Model cache (Fly volume) | `/data/hf` |
| `REST_RATE_LIMIT` | REST req/min/IP | `10` |
| `REST_RATE_BURST` | Token bucket burst | `5` |
| `SESSION_MIN_TURN_GAP_S` | Min gap between turns | `1.5` |
| `MAX_UTTERANCE_S` | Max utterance audio | `30` |
| `GEMINI_DAILY_CAP` | Global daily calls | `500` |
| `WS_MAX_CONNECTIONS_PER_IP` | Per-IP cap (same-IP reconnect = newest-wins takeover) | `1` |
| `WS_MAX_TOTAL_CONNECTIONS` | Global WS ceiling (hard, closes `1013`) | `200` |
| `ALLOWED_ORIGINS` | CORS/WS allowlist | `http://localhost:5173,http://127.0.0.1:5173,https://gourmate.vercel.app` |

## 6. Repository Layout

```
GourMate/
├─ specs/
│  └─ gourmate.spec.md
├─ docs/
│  └─ decisions/
│     ├─ gourmate.techstack.md
│     ├─ gourmate.architecture.md
│     └─ gourmate.design.md
├─ backend/
│  ├─ app/                # FastAPI, ws, pipeline, llm, tts, vad
│  ├─ tests/              # pytest suite + golden-contract guard
│  ├─ requirements.txt
│  ├─ requirements-dev.txt
│  ├─ pytest.ini
│  ├─ Dockerfile          # root-context build; HF_HOME=/data/hf
│  └─ .dockerignore
├─ frontend/
│  ├─ src/                # React, R3F avatar, audio, state
│  ├─ package.json
│  └─ vercel.json
├─ contracts/
│  └─ ws-events.json      # golden wire-contract manifest
├─ .github/workflows/ci.yml
├─ fly.toml               # Fly.io app, /data volume, port 8080
├─ AGENTS.md
└─ README.md
```

## 7. Removed Components (for the record)

| Removed | Reason |
| :--- | :--- |
| Browser Web Speech API | Replaced by server-side faster-whisper + edge-tts |
| Groq | Single-brain simplification |
| DeepSeek V4.1 Flash / Cline Pass | Not an app-runtime API contract; Gemini chosen |
| 2D avatar fallback | User decision; reduced-motion path documented as recommendation |
