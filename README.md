# GourMate (ChefSight)

GourMate is a hands-free voice cooking assistant for cooks whose hands are wet,
oily, or otherwise busy. It keeps the recipe state, reads steps aloud, runs
labeled kitchen timers, handles mid-cook emergencies, and suggests substitutions
— all through an always-listening voice loop with barge-in. The procedural 3D
chef avatar **ChefSight** is the status display, so there are no spinners to
stare at while cooking.

The product is **Cook Mode**. Recipe intake (voice or typed/pasted text) is just
the on-ramp into a guided, eyes-up, hands-free cook.

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
LLM emits tool calls that the client executes. Pure navigation turns are
answered from `Recipe` without spending a Gemini round-trip.

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
| Backend tests | `cd backend && pip install -r requirements-dev.txt && pytest -q` | 245 pytest tests: token bucket / session / daily limits, PCM ring buffer, silence trim + speech gate, utterance continuation, LocalAgreement streaming, sherpa-onnx partial engine, typed error taxonomy, recipe validation, tools + navigation, exact §7 serializers |
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
