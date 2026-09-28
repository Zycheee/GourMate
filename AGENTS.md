# AGENTS.md — GourMate (ChefSight)

Lean, load-bearing context for agents working in this repository. Keep it current;
do not store project context in chat.

## Project summary

GourMate is a hands-free voice cooking assistant. The browser captures 16 kHz
mono Int16 PCM through an `AudioWorklet` and streams it over `/ws/session`; the
FastAPI backend runs **Silero VAD → faster-whisper `small.en` (final) →
Gemini 3.5 Flash Lite (function calling) → edge-tts** and streams JSON events
plus base64 MP3 back. Live partial captions are disabled (only the accurate
final transcript is shown). A
procedural React Three Fiber avatar (**ChefSight**) is the status display, and
the cookbook, step index, and timers persist in `localStorage`.

- Product scope: `specs/gourmate.spec.md`
- Stack decisions: `docs/decisions/gourmate.techstack.md`
- Architecture: `docs/decisions/gourmate.architecture.md`
- UI/UX: `docs/decisions/gourmate.design.md`

## Architectural rule (do not break)

> **The structured `Recipe` JSON is the single source of truth on the client.
> The LLM never "holds" recipe state.**

- Each turn the client sends the current `Recipe` + `current_step_index` as
  context. Gemini emits **tool calls**; the client executes them deterministically
  and replies with `tool_result` (and optionally `recipe_state`).
- Pure navigation intents are answered server-side from `Recipe` with **no**
  Gemini round-trip (`backend/app/llm/tools.py:resolve_navigation`).
- Never move step ordering/navigation into the LLM, and never let the model
  author recipe state that the client does not own.

## Canonical contract

**Architecture §6–§9 is authoritative.**

- §6 data schemas · §7 WebSocket protocol · §8 REST endpoints · §9 Gemini/tools
- Never invent event names, fields, tool names, or error codes that are not in the
  architecture doc. If a change is needed, update the architecture doc **first**,
  then the Pydantic/Typescript mirrors.
- Backend mirror: `backend/app/schemas.py` (Pydantic v2).
- Frontend mirror: `frontend/src/types.ts` (TypeScript). Keep both in lockstep.
- Golden manifest: `contracts/ws-events.json` (event/tool/error/voice/VAD/control
  names, close codes, REST statuses). Enforced by `backend/tests/test_protocol.py`
  and `frontend/src/__tests__/types.contract.test.ts`; drift fails both suites.

## Repository structure

```
GourMate/
├─ specs/
│  └─ gourmate.spec.md              # requirements / scope / acceptance criteria
├─ docs/decisions/
│  ├─ gourmate.techstack.md         # stack choices, decision tables, env defaults
│  ├─ gourmate.architecture.md      # contract: schemas, WS, REST, tools, errors
│  └─ gourmate.design.md            # UI/UX, avatar states, tokens, copy
├─ docs/archive/
│  └─ GourMate.concept.md           # original concept; provenance only, not spec
├─ backend/
│  ├─ requirements.txt
│  ├─ requirements-dev.txt           # pytest, pytest-asyncio, httpx
│  ├─ pytest.ini                     # asyncio_mode=auto, testpaths=tests
│  ├─ Dockerfile                     # CPU-only; context = repo root; EXPOSE 8080
│  ├─ .dockerignore                  # root-context exclusions (secrets, tests)
│  ├─ .env.example                  # every backend env var (no secrets)
│  ├─ tests/                        # pytest suite + golden-contract guard
│  │  ├─ conftest.py                # loads contracts/ws-events.json, recipe factory
│  │  ├─ test_protocol.py           # §7 serializers ↔ golden manifest
│  │  └─ test_{schemas,errors,tools,ratelimit,buffer,ws,recipe_service}.py
│  └─ app/
│     ├─ config.py                  # pydantic-settings (env)
│     ├─ main.py                    # FastAPI app, REST, WS, error handlers
│     ├─ schemas.py                 # Pydantic v2 contract models (architecture §6–§8)
│     ├─ errors.py                  # typed ErrorCode taxonomy + AppError (§11)
│     ├─ ratelimit.py               # REST token bucket, session caps, Gemini daily cap (§10)
│     ├─ pipeline.py                # voice-turn orchestration + Services/Readiness (§4)
│     ├─ audio/                     # buffer.py, vad.py (Silero), stt.py (faster-whisper),
│     │                             # segment.py (silence trim), streaming.py (LocalAgreement-2),
│     │                             # streaming_engine.py (optional sherpa-onnx streaming partials)
│     ├─ llm/                       # prompts.py, tools.py, gemini.py
│     ├─ tts/edge.py                # sentence chunking + edge-tts
│     ├─ recipe/service.py          # generate/parse/intake → validated Recipe
│     └─ ws/                        # protocol.py (serializers), session.py (registry + receive loop)
├─ frontend/
│  ├─ package.json
│  ├─ vitest.config.ts              # jsdom; exposes repo root for the golden import
│  ├─ vercel.json                   # Vite build, dist output, SPA rewrites
│  ├─ .env.example                  # VITE_WS_URL (default ws://localhost:8080)
│  └─ src/
│     ├─ types.ts                   # TS mirrors of architecture §6–§7
│     ├─ App.tsx, main.tsx
│     ├─ test/setup.ts              # vitest setup (jest-dom, localStorage reset)
│     ├─ store/session.ts           # zustand store (localStorage persistence)
│     ├─ hooks/useVoiceSession.ts   # WS ⇄ audio ⇄ store glue, tool execution
│     ├─ lib/                       # ws.ts, audio.ts, timers.ts, cookbook.ts, copy.ts
│     ├─ lib/__tests__/, store/__tests__/, src/__tests__/  # vitest suites
│     └─ components/                # Avatar3D, StepCard, TimerRings, sheets, etc.
├─ contracts/
│  └─ ws-events.json                # golden cross-cutting wire-contract manifest
├─ .github/workflows/ci.yml         # backend pytest + frontend build
├─ fly.toml                         # Fly.io app, /data volume, port 8080
├─ .gitignore
├─ AGENTS.md
└─ README.md
```

## Commands

### Backend (run from `backend/`, virtualenv active)

| Purpose | Command |
| :--- | :--- |
| Install | `pip install -r requirements.txt` |
| Install (dev/test) | `pip install -r requirements-dev.txt` |
| Run | `uvicorn app.main:app --reload --port 8080` (or `python run.py`, which excludes `data/` from the reloader) |
| Health | `curl http://localhost:8080/api/health` |
| Test | `pytest -q` (245 tests; offline — no weights or API key needed) |
| Test (one file) | `pytest -q tests/test_protocol.py` |
| Lint / format | **Not configured** — no `ruff`/`flake8`/`mypy`/`black` config |
| Build | **Not applicable** — plain Python service, no packaging step |

### Frontend (run from `frontend/`)

| Purpose | Command |
| :--- | :--- |
| Install | `npm install` |
| Run (dev) | `npm run dev` → `http://localhost:5173` |
| Build | `npm run build` (`tsc && vite build`) |
| Type check | `npm run typecheck` (`tsc --noEmit`) |
| Preview build | `npm run preview` |
| Test | `npm test` (`vitest run`; jsdom) |
| Test (watch) | `npm run test:watch` (`vitest`) |
| Lint | **Not configured** — no ESLint config |

### CI — `.github/workflows/ci.yml`

Runs on `push` and `pull_request`; both jobs set their own `working-directory`.

| Job | Steps |
| :--- | :--- |
| Backend (Python 3.11) | install `requirements.txt` (+ `requirements-dev.txt` when present) → `python -m compileall app` → `python -m pytest -q` (skipped if pytest is absent) |
| Frontend (Node 20) | `npm ci` when `package-lock.json` exists, else `npm install` → `npm run build` → `npm test` when a `test` script exists |

Both jobs degrade gracefully while optional tooling is missing, so the local
commands above stay in step with CI.

## Environment variables

### Backend — `backend/app/config.py` (defaults; names are case-insensitive)

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | `""` | **Required for LLM features.** Secret, server-side only. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | |
| `GEMINI_TIMEOUT_S` | `30.0` | |
| `WHISPER_MODEL` | `small.en` | faster-whisper size (English-only), final pass. |
| `WHISPER_BEAM_SIZE` | `5` | Final-pass decoding beam width (accuracy default). |
| `WHISPER_PARTIAL_MODEL` | `small.en` | Model for the (disabled) live partial pass. |
| `PARTIAL_INTERVAL_S` | `0.25` | Live partial re-decode cadence (when enabled). |
| `WHISPER_PARTIAL_ENABLED` | `false` | Chunked Whisper live partials — **disabled** (inaccurate; UI shows no live text). |
| `STREAMING_STT_ENABLED` | `false` | Offline sherpa-onnx streaming partials — **disabled**. |
| `STREAMING_STT_REPO` | `csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26` | Streaming model repo (if re-enabled). |
| `STREAMING_STT_NUM_THREADS` | `1` | sherpa-onnx decode threads. |
| `TRANSCRIPTION_ONLY` | `false` | `false` = full assistant (Gemini + tools + TTS); `true` = transcribe only. |
| `VAD_MIN_SILENCE_S` | `1.0` | Silence hold before end-of-utterance (was a hard-coded ~3 s). |
| `UTTERANCE_CONTINUATION_S` | `0.8` | Post-pause window that merges resumed speech into one utterance. |
| `WHISPER_INITIAL_PROMPT` | culinary term list | Biases STT vocabulary toward ingredients/units. |
| `HF_HOME` | `/data/hf` | Model weights cache (Fly volume). |
| `REST_RATE_LIMIT` | `10` | Requests/min/IP for `/api/recipes/*`. |
| `REST_RATE_BURST` | `5` | Token-bucket burst. |
| `SESSION_MIN_TURN_GAP_S` | `1.5` | Min gap between finalized turns. |
| `MAX_UTTERANCE_S` | `30.0` | Per-utterance audio cap. |
| `MAX_BUFFER_S` | `60.0` | Ring-buffer retention cap. |
| `GEMINI_DAILY_CAP` | `500` | Global daily Gemini call ceiling. |
| `WS_MAX_CONNECTIONS_PER_IP` | `1` | Enforced by `ConnectionRegistry` as a **newest-wins takeover**: a same-IP reconnect closes the prior socket (`1000`) and takes its slot. |
| `WS_MAX_FRAME_BYTES` | `8192` | Max bytes per binary audio frame. |
| `MAX_RECIPE_TEXT_CHARS` | `20000` | Input cap for pasted/dictated recipes. |
| `NAV_MAX_CHARS` | `80` | Max utterance treated as pure navigation. |
| `CHAT_HISTORY_WINDOW` | `12` | Recent turns mirrored server-side. |
| `HEALTH_RATE_LIMIT` | `60` | **Not listed in `.env.example`.** |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,https://gourmate.vercel.app` | Comma-separated CORS/WS allowlist. |
| `AUDIO_SAMPLE_RATE` | `16000` | |
| `TTS_VOICE` | `en-US-AriaNeural` | edge-tts voice id (see open items). |
| `TTS_RATE` | `+0%` | |
| `TTS_VOLUME` | `+0%` | |
| `LOG_LEVEL` | `INFO` | |

### Frontend — `frontend/.env.example` + code

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `VITE_WS_URL` | `ws://localhost:8080` | Backend origin, scheme required, no trailing slash. Client appends `/ws/session`. Code fallback is also `ws://localhost:8080` (`frontend/src/lib/ws.ts`). |
| `BASE_URL` | Vite built-in | Used to resolve the AudioWorklet path; not user-set. |

## Conventions

- **Contract:** architecture §6–§9 is canonical. No invented events/fields/tools/codes.
- **Golden manifest:** `contracts/ws-events.json` is the drift guard. Both
  `backend/tests/test_protocol.py` and `frontend/src/__tests__/types.contract.test.ts`
  load it; update it alongside the architecture doc and both type mirrors.
- **Tests:** offline suites — `pytest -q` (backend, after
  `pip install -r requirements-dev.txt`) and `npm test` (frontend, vitest+jsdom).
  Both run in CI via `.github/workflows/ci.yml`.
- **Secrets:** `GEMINI_API_KEY` lives only server-side; never expose it to the browser.
- **Privacy:** no raw audio, transcripts, or recipes persisted server-side; audio
  buffers are in-memory and freed per turn.
- **Types:** Pydantic v2 in `backend/app/schemas.py` mirrors TypeScript in
  `frontend/src/types.ts`. Change both together.
- **Errors:** every failure path raises `AppError` with an `ErrorCode`
  (`backend/app/errors.py`). REST body: `{code, message, recoverable, retry_after?}`;
  WS event: `{type:"error", code, message, recoverable}`. `429` sets `Retry-After`.
- **State ownership:** client owns `Recipe`, `current_step_index`, and timers; the
  server is stateless for timers. `voice_state` is server-authoritative.
- **Rate limits:** env-configurable; REST → `429` + `Retry-After`, session →
  `rate_limited` event.
- **Models:** lazy process-global loading; readiness surfaced at `/api/health`.
- **Comments:** source comments cite architecture section numbers — preserve that.
- **Reuse:** extend existing modules rather than duplicating logic.

## Known open items

1. **Voice selection still has no wire path.** `Settings.voice` (frontend default
   `en-US-JennyNeural`) is stored and picked in `SettingsSheet`, but no client
   event carries it; the backend always uses `TTS_VOICE` (default
   `en-US-AriaNeural`). The picker is currently cosmetic and the two defaults
   disagree. Resolve by adding a `set_voice` client event and updating
   architecture §7, or by fixing the voice server-side.
2. **~~Per-IP WebSocket cap.~~ Resolved.** `ConnectionRegistry` now enforces
   `WS_MAX_CONNECTIONS_PER_IP` as a **newest-wins same-IP takeover** (prior
   socket closed `1000`), so a reload cannot collide with its own stale socket.
   `1013` is reserved for the **global** `WS_MAX_TOTAL_CONNECTIONS` ceiling.
   See architecture §7/§10.
3. **Reference hardware** for NFR-1–NFR-3 latency targets is not pinned.
4. **3D device tiers** (design §9/§10) — DPR/shadow/particle downgrade thresholds
   are not finalized.
5. **Error copy is defined in two places.** The backend spoken map
   (`SPOKEN_MESSAGES` / `DEFAULT_MESSAGES` in `backend/app/errors.py`) and the
   frontend `ERROR_COPY` (`frontend/src/lib/copy.ts`) both encode design §8.
   Single-source them through `contracts/ws-events.json` (e.g. a `copy` section)
   so they cannot drift.
6. **`recipe_state` payload asymmetry.** The frontend `ClientMessage` variant
   (`frontend/src/types.ts`) sends `phase`, `recipe`, `current_step_index`, and
   `timers` as required, while the backend `RecipeStateEvent`
   (`backend/app/schemas.py`) makes every field optional. Pin one shape and add it
   to the golden manifest.
7. **`HEALTH_RATE_LIMIT`** is implemented with a default of `60` but absent from
   `.env.example` and techstack §5.
8. **Origin rejection** closes with `1008` (policy violation), which is not in the
   architecture §7 control-code list. Recorded in `backend/README.md`
   "Resolved ambiguities".
9. **Live partial captions are disabled.** Both partial paths are off
   (`WHISPER_PARTIAL_ENABLED=false`, `STREAMING_STT_ENABLED=false`): the
   streaming zipformer partials were materially less accurate than the final
   `small.en` pass, so the UI shows no live user text — only the final
   `transcript{final:true}` and the assistant caption. The gated code
   (`audio/streaming.py`, `audio/streaming_engine.py`, the pipeline partial
   paths) remains for re-enabling; if `STREAMING_STT_ENABLED` is turned on it
   downloads the int8 zipformer (~72 MB) into `HF_HOME` at first boot. The
   on-device WER/latency budget for the partial path is not pinned (item 3).
