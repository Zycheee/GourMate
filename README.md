# GourMate (Kef)

GourMate is a hands-free voice cooking assistant for cooks whose hands are wet,
oily, or otherwise busy. It keeps the recipe state, reads steps aloud, runs
labeled kitchen timers, handles mid-cook emergencies, and suggests substitutions
— through an optional voice loop with barge-in. The procedural 3D
chef avatar **Kef** is the status display, so there are no spinners to
stare at while cooking.

The product is **Cook Mode**. Recipe intake (voice or typed/pasted text) is just
the on-ramp into a guided, eyes-up, hands-free cook.

## Kef sleep and voice controls

Kef starts asleep on every reload, keeping your recipe and timers. Tap Kef (or
activate it with the keyboard) to wake and enable the microphone. Typing wakes
Kef without enabling capture. After 60 seconds without speech or interaction,
counted after playback finishes, Kef sleeps again.

Voice wake is off by default. Enable it in Settings to listen for "Kef", "Hey
Kef", "Hello Kef", or "Okay Kef" while asleep. Pronounce Kef as **Keef**,
rhyming with leaf; transcripts may spell it Kef or Keef, including "OK Keef". Other speech stays out of the
conversation; a trailing request is processed after waking. A saved opt-in can
resume only with an already granted microphone permission. Manual mute stops
all capture immediately and submits speech recorded before the click once, after a bounded
200 ms worklet flush. Kef stays muted while answering. Unmute starts fresh; while
asleep it enables wake-only listening for this session and does not wake Kef. Reset,
disconnect, sleep and superseding input discard unfinished recordings.

New input interrupts old playback and cancels the superseded reply. Reply IDs
reject late audio, and decoder generations prevent stopped chunks restarting.
Settings includes Ava, Andrew, Emma and Brian alongside the existing voices;
the current Jenny default and saved selections remain available.

## Guided cooking

- If you do not know what to cook, GourMate asks up to four short questions about
  cravings, dietary needs, available ingredients and time. You can answer by
  voice, type freely, choose an option, or say “Suggest now.”
- Dish options open a preview with a photograph, description, estimated time,
  difficulty, ingredients, appeal and fit. “Choose this dish” selects it;
  opening or dismissing the preview does not.
- Normal replies include useful follow-up choices. Moving between cooking steps
  requires “Continue” or a spoken confirmation. “Skip this step” and “Skip to
  step N” bypass that check once. Finishing early warns about remaining steps.
- Interview answers last for the current session and clear on start-over.
  New users can choose “Use text instead” without granting microphone access.

Choices appear beneath the latest assistant message in the conversation. The
compact planner has ingredients, expandable steps, and a Start cooking button.
On desktop, opening the planner expands the workspace while keeping chat width.

Photos load directly from Wikimedia URLs. Gallery credits are recorded in
`frontend/public/food/ATTRIBUTIONS.md`; other dishes use the backend's
`POST /api/food-images/lookup` Commons search when their preview opens. Only the
dish name is sent. Lookup has a five-second timeout and bounded metadata cache;
missing, unrelated, unlicensed, or failed images show a placeholder. Photos are
not bundled or precached, so image display requires an internet connection.

## Architecture

```
┌──────────────────────────────┐
│      Browser (React PWA)     │
│  AudioWorklet → PCM 16 kHz   │
│  R3F avatar · timers · local │
│  cookbook (localStorage)     │
└──────────────┬───────────────┘
               │  WebSocket  /ws/session
               │  ▲ up:   binary Int16 PCM, 16 kHz mono
               │  ▼ down: JSON events + base64 MP3
┌──────────────▼───────────────┐
│   FastAPI backend (Uvicorn)  │
│   Python 3.11 · async        │
│                              │
│  Silero VAD                  │
│      ↓                       │
│  faster-whisper (small.en)   │
│      ↓                       │
│  Gemini 3.5 Flash Lite (tools)    │
│      ↓                       │
│  edge-tts (per sentence)     │
└──────────────┬───────────────┘
               │ HTTPS (key stays server-side)
               ▼
          Gemini API
```

Silero VAD runs on the continuous stream server-side and drives both
end-of-utterance detection and barge-in. The client owns the `Recipe` JSON; the
LLM interprets each free-form voice or typed request in the existing conversational
turn, using phase, recipe, recent history, preferences and pending confirmations.
Validated tool calls then execute deterministically against the client-owned recipe.
Planner buttons and action choices send typed `action_input` requests and need no
Gemini interpretation. Positive feedback approves a plan and asks readiness; an
explicit start begins step one. Repeated start requests acknowledge the active
step and never advance it.

The wire contract is machine-checked: the golden manifest
[`contracts/ws-events.json`](contracts/ws-events.json) is mirrored by the Pydantic
models in [`backend/app/schemas.py`](backend/app/schemas.py) and the TypeScript
types in [`frontend/src/types.ts`](frontend/src/types.ts).

## Tech stack

| Layer | Choice |
| :--- | :--- |
| Speech-to-text | `faster-whisper` (`small.en`) final pass, server-side CPU (live partials disabled) |
| Voice activity detection | `Silero VAD`, server-side, continuous |
| Brain | Gemini 3.5 Flash Lite via `google-genai` — parse/generate **and** conversation, function calling |
| Text-to-speech | `edge-tts`, sentence-streamed |
| Backend runtime | Python 3.11 |
| Backend framework | FastAPI + Uvicorn (async WS + REST) |
| Transport | WebSocket: 16 kHz mono Int16 PCM up; JSON events + MP3 down |
| Frontend | React + TypeScript + Vite |
| Styling | Tailwind CSS |
| PWA | `vite-plugin-pwa` |
| 3D avatar | React Three Fiber + `@react-three/drei` |
| Animation | `@react-spring/three` / `maath` + Web Audio `AnalyserNode` |
| Persistence | Browser `localStorage` |
| Rate limiting | `slowapi` (REST) + in-process counters |
| Frontend hosting | Vercel |
| Backend hosting | Railway (Dockerfile) + persistent volume |

## Prerequisites

- **Python 3.11**
- **Node.js 20**
- A **Gemini API key** (server-side only; never shipped to the browser)
- A modern Chromium-based browser (the mic path uses `AudioWorklet`)

## Backend — setup and run

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate           # Windows
source .venv/bin/activate        # macOS / Linux
pip install -r requirements.txt
copy .env.example .env           # Windows
cp .env.example .env             # macOS / Linux
# then edit .env and set GEMINI_API_KEY=<your key>
# Dev server with reload that ignores data/ (Windows):
.venv\Scripts\python.exe run.py
# or directly:
uvicorn app.main:app --reload --port 8080
```

- First startup lazily downloads the Whisper and Silero weights into `HF_HOME`
  (default `/data/hf`). Until they finish, `/api/health` reports
  `models_loaded: false` and audio turns emit `engine_loading`; the text path
  still works.
- Readiness/models/Gemini status: `GET http://localhost:8080/api/health`
- **Watch transcription in the terminal.** The backend logs each finalized line,
  tagged with a short session id (live partial text is disabled):
  ```
  INFO app.pipeline [a1b2c3d4] speech end; finalizing utterance
  INFO app.pipeline [a1b2c3d4] utterance assembled: audio=2.10s wall=2.40s
  INFO app.pipeline [a1b2c3d4] final: chop the onion finely
  ```
- REST: `POST /api/recipes/generate`, `POST /api/recipes/parse`.
- WebSocket: `ws://localhost:8080/ws/session`.

> **Port:** locally the backend and `frontend/.env.example` both use port **8080**,
> so the pair matches out of the box. In production the container binds to
> `$PORT` (falling back to `8080`), as injected by the host.

## Frontend — setup and run

```bash
cd frontend
npm install
copy .env.example .env           # Windows
cp .env.example .env             # macOS / Linux
# set VITE_WS_URL=ws://localhost:8080  (no trailing slash; scheme required)
npm run dev
```

Vite serves at `http://localhost:5173`, which is in the backend's default
`ALLOWED_ORIGINS`. The client connects to `<VITE_WS_URL>/ws/session`.

## Testing and verification

The QA suites are committed and run offline (no model weights or API key needed).

| Area | Command | Covers |
| :--- | :--- | :--- |
| Backend tests | `cd backend && pip install -r requirements-dev.txt && pytest -q` | Offline pytest checks: token bucket / session / daily limits, PCM ring buffer, silence trim + speech gate, utterance continuation, LocalAgreement streaming, sherpa-onnx partial engine, typed error taxonomy, recipe validation, tools + navigation, exact §7 serializers |
| Frontend tests | `cd frontend && npm test` | Vitest + jsdom: contract guard, store, timers, cookbook, copy |
| Frontend types | `cd frontend && npm run typecheck` | `tsc --noEmit` over the WS contract |
| Frontend build | `cd frontend && npm run build` | Type-check + production PWA bundle |
| Live health | `curl http://localhost:8080/api/health` | `{ status, models_loaded, gemini_ok }` (requires a running server) |
| Live REST | `curl -X POST http://localhost:8080/api/recipes/generate -H "Content-Type: application/json" -d "{\"dish\":\"chicken adobo\"}"` | A validated `Recipe` JSON (requires a working `GEMINI_API_KEY`) |

**Drift guard:** [`contracts/ws-events.json`](contracts/ws-events.json) is the
golden cross-cutting manifest — server→client and client→server event names,
tool names, error codes, voice/VAD states, control actions, close codes, and REST
statuses. Both [`backend/tests/test_protocol.py`](backend/tests/test_protocol.py)
and
[`frontend/src/__tests__/types.contract.test.ts`](frontend/src/__tests__/types.contract.test.ts)
load it and fail on drift, so the Pydantic models (`backend/app/schemas.py`) and
the TypeScript mirrors (`frontend/src/types.ts`) cannot diverge silently.

The frontend test harness is `frontend/vitest.config.ts` (jsdom) with setup in
`frontend/src/test/setup.ts`. CI runs both suites on every push/PR via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) (backend
`python -m compileall app` + `pytest -q`; frontend `npm ci`/`npm install` +
`npm run build`, plus `npm test` when the script exists).

## Deployment

The configs are committed:

- **Backend → Railway**: [`railway.json`](railway.json) selects the Dockerfile
  builder ([`backend/Dockerfile`](backend/Dockerfile) — CPU-only, `HF_HOME=/data/hf`,
  non-root, binds to `$PORT` with a `8080` fallback). Mount a Railway volume at
  `/data` so the whisper + silero weights are cached across deploys, and set
  `GEMINI_API_KEY` (secret) plus `ALLOWED_ORIGINS` to the deployed Vercel origin.
  The health check is `GET /api/health`.
- **Frontend → Vercel**: [`frontend/vercel.json`](frontend/vercel.json) — Vite
  framework, `npm run build`, output `dist`, SPA rewrites, immutable asset caching.
- **CI**: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the backend
  (`compileall` + `pytest`) and frontend (`npm run build`) jobs on push/PR.
- Set `ALLOWED_ORIGINS` to the deployed Vercel origin so CORS and the WS origin
  check pass.

## Roadmap

"Status" reflects what is present in the repo; the QA suites cover the contract
offline, not a deployed verification run.

| Phase | Deliverable | Exit criteria | Status |
| :--- | :--- | :--- | :--- |
| 0 | Skeleton: FastAPI WS, React canvas, R3F avatar | Avatar renders; WS round-trips | Code present |
| 1 | Voice loop: AudioWorklet PCM, Silero VAD, faster-whisper | Transcript appears after speech | Code present (needs weights) |
| 2 | Brain: Gemini turns + tool calls, edge-tts, barge-in | Spoken answers; barge-in works | Code present (needs API key) |
| 3 | Recipe pipeline: parse + generate → `Recipe` | Both intake paths produce valid JSON | Code present |
| 4 | Timers + notifications + cookbook | Timer survives refresh; alerts fire | Code present |
| 5 | Rate limits + error taxonomy + polish | RL/EH acceptance tests pass | Code present; pytest + vitest suites committed |
| 6 | Deploy: Railway volume, Vercel | Public URL, acceptable cold start | Configs present: Dockerfile, `railway.json`, `vercel.json`, CI workflow |

## Repository layout

```
GourMate/
├─ backend/
│  ├─ app/               # FastAPI: audio, VAD/STT, Gemini, TTS, ws, recipe
│  ├─ tests/             # pytest suite + golden-contract guard
│  ├─ requirements.txt
│  ├─ requirements-dev.txt
│  ├─ pytest.ini
│  ├─ Dockerfile         # CPU-only image; build context is the repo root
│  └─ .dockerignore
├─ frontend/
│  ├─ src/               # React PWA: R3F avatar, audio, zustand store, components
│  ├─ src/**/__tests__/  # vitest suites (incl. types.contract.test.ts)
│  ├─ vitest.config.ts
│  ├─ vercel.json        # Vercel build + SPA rewrites
│  └─ package.json
├─ contracts/
│  └─ ws-events.json     # golden cross-cutting wire-contract manifest
├─ .github/workflows/ci.yml   # backend pytest + frontend build
├─ railway.json          # Railway build/deploy config (Dockerfile builder)
├─ .dockerignore         # root-context build exclusions
├─ .gitignore
└─ README.md
```
