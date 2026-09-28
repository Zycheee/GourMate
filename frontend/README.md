# GourMate — Frontend

Hands-free voice cooking assistant (persona **ChefSight**). React + TypeScript + Vite + Tailwind CSS PWA, with a procedural R3F avatar that is the status system.

See the root [`README.md`](../README.md) for full-stack setup.

## Run

```bash
npm install
cp .env.example .env       # set VITE_WS_URL to the FastAPI host
npm run dev
```

## Build

```bash
npm run build     # tsc + vite build
npm run preview
npm run typecheck
```

## Notes

- `VITE_WS_URL` is the backend origin (default `ws://localhost:8080`); the client connects to `<VITE_WS_URL>/ws/session`.
- Mic streaming uses `AudioWorklet` (`public/worklets/capture-processor.js`) → 16 kHz mono Int16 PCM over the WebSocket.
- Recipe, step index, timers, transcript and settings persist in `localStorage` and are resynced to the server with a `sync` message on every connect.
