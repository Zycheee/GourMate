# GourMate (ChefSight) Backend

Async FastAPI backend for the hands-free voice cooking assistant. It owns the
always-listening voice loop: PCM in, Silero VAD, faster-whisper STT, Gemini 2.5
Flash turns with tool calls, and sentence-streamed edge-tts MP3 out.

Contract source of truth: `docs/decisions/gourmate.architecture.md` sections 5–11.
Secrets and models are server-side only. No raw audio, transcript or recipe is
ever persisted server-side.

See the root [`README.md`](../README.md) for full-stack setup and
[`docs/decisions/`](../docs/decisions/) for the architecture, tech-stack and design records.

## Module map

```
backend/
├─ requirements.txt
├─ .env.example                 # every env var (no real secrets)
└─ app/
   ├─ config.py                 # Pydantic Settings (env)
   ├─ schemas.py                # Recipe/Session + WS + REST models (§6–§8)
   ├─ errors.py                 # typed error taxonomy + AppError (§11)
   ├─ ratelimit.py              # REST token bucket, session caps, daily Gemini cap (§10)
   ├─ pipeline.py               # voice-turn orchestration + Services/Readiness (§4)
   ├─ main.py                   # FastAPI app, REST, WS, error handlers
   ├─ audio/
   │  ├─ buffer.py              # PCM16 16k mono ring + utterance capture
   │  ├─ vad.py                 # Silero VAD singleton + barge-in
   │  └─ stt.py                 # faster-whisper singleton, async transcribe
   ├─ llm/
   │  ├─ prompts.py             # ChefSight prompt (verbatim) + tool declarations (§9)
   │  ├─ tools.py               # tool registry/validation + deterministic navigation (§4)
   │  └─ gemini.py              # async google-genai client (stream + structured output)
   ├─ tts/
   │  └─ edge.py                # sentence chunking + edge-tts MP3 synthesis
   ├─ recipe/
   │  └─ service.py             # generate/parse/intake -> validated Recipe
   └─ ws/
      ├─ protocol.py            # server -> client event serializers (§7)
      └─ session.py            # connection registry + receive loop + dispatch
```

## Run

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate            # Windows (source .venv/bin/activate on *nix)
pip install -r requirements.txt
copy .env.example .env             # then set GEMINI_API_KEY
uvicorn app.main:app --host 0.0.0.0 --port 8080 --ws websockets
```

- REST: `POST /api/recipes/generate`, `POST /api/recipes/parse`, `GET /api/health`.
- WebSocket: `/ws/session` (Int16 PCM 16 kHz mono up; JSON events + base64 MP3 down).
- First run downloads Whisper/Silero weights into `HF_HOME`; readiness is exposed
  at `/api/health` as `models_loaded` and `gemini_ok`.

## Conventions

- Full type hints, stdlib `logging`, Pydantic v2 models.
- Every failure path raises `AppError` with an `ErrorCode` from §11.
- Models load lazily in a startup warmup task; a turn before readiness emits
  `engine_loading` once per session.
- Timer state is client-owned; the server is stateless for timers.

## Resolved ambiguities

1. **`text_input` mode (dish vs dictated recipe):** §7 sends a single `text`
   payload with no mode flag. `recipe/service.py:classify_intake` heuristically
   chooses `generated` (short phrase) vs `user_text` (≥20 words / newline /
   measurement markers). No extra Gemini call.
2. **`recipe_state` client event payload:** §7 writes `{type:"recipe_state", ...}`.
   The model carries optional `recipe`, `current_step_index`, `phase`, `timers`.
   No `recipe_state` event is emitted server→client (not in the §7 server list);
   deterministic navigation updates the client via the `tool_call`.
3. **`SessionState.turns`:** §5 mirrors `ChatTurn` server-side, but §6's
   `SessionState` omits it. An optional `turns: ChatTurn[] = []` was added so
   reconnect `sync` can restore the recent window.
4. **Malformed tool calls:** §11 has no tool-specific code. `tools.validate_tool_call`
   raises `recipe_invalid` (the "unparseable input" category).
5. **Generic internal error:** §11 has no generic code; unexpected REST errors
   map to `ws_dropped` (HTTP 500).
6. **Origin rejection close code:** §7 lists 1013/1011/1000; a disallowed WS
   `Origin` is closed with the standard `1008` (policy violation).
7. **Extra env vars:** `MAX_BUFFER_S` (RL-3 60 s cap), `WS_MAX_FRAME_BYTES`,
   `MAX_RECIPE_TEXT_CHARS`, `NAV_MAX_CHARS`, `CHAT_HISTORY_WINDOW`,
   `HEALTH_RATE_LIMIT`, `TTS_VOICE/RATE/VOLUME`, `GEMINI_TIMEOUT_S`, `LOG_LEVEL`
   are required by the implementation but not listed in techstack §5.
8. **`assistant_audio.seq`** is monotonic per session (not reset per turn).
9. **REST error body:** `{code, message, recoverable, retry_after?}`, mirroring
   the WS `error` event fields; `Retry-After` is set on `429`.

## Known limitations (not implementable without network/weights)

- Recipe generation/parsing and conversation require a valid `GEMINI_API_KEY`
  and network access; without it the app reports `gemini_ok: false` and typed
  `llm_timeout`/`degraded` responses.
- Silero VAD and faster-whisper require downloading model weights (`HF_HOME`)
  and PyTorch; until loaded, `/api/health` reports `models_loaded: false` and
  audio turns emit `engine_loading`. The text path remains usable.
- Out-of-scope requests during **intake** are constrained by the system prompt
  but the structured-output schema forces a recipe shape; there is no separate
  out-of-scope classifier for intake V1.
