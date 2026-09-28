/**
 * Session WebSocket client — architecture §7.
 *
 * Endpoint: `VITE_WS_URL + /ws/session`
 * Client → server: Int16 PCM binary frames + JSON control messages.
 * Server → client: typed JSON events (see types.ts).
 * Reconnect: exponential backoff, then a `sync` message with full SessionState.
 */

import type { ClientMessage, ConnectionStatus, ServerMessage, SessionState } from "../types";

const WS_PATH = "/ws/session";

export interface SessionSocketHandlers {
  onMessage: (msg: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Called after the socket opens and `start` is sent. */
  onOpen?: () => void;
  /** SessionState mirror used for `sync` on every connect/reconnect. */
  getStateForSync: () => SessionState;
}

function socketUrl(): string {
  const base = (import.meta.env.VITE_WS_URL ?? "ws://localhost:8080").replace(/\/+$/, "");
  return `${base}${WS_PATH}`;
}

/**
 * REST base derived from the WS endpoint: `ws`→`http` / `wss`→`https`, with
 * any trailing `/ws/session` stripped (e.g. `ws://host:8080` → `http://host:8080`).
 */
export function httpBaseUrl(): string {
  const base = (import.meta.env.VITE_WS_URL ?? "ws://localhost:8080")
    .replace(/\/+$/, "")
    .replace(/\/ws\/session$/, "");
  return base.replace(/^ws/, "http");
}

export class SessionSocket {
  private ws: WebSocket | null = null;
  private handlers: SessionSocketHandlers;
  private attempts = 0;
  private deliberatelyClosed = false;
  private reconnectTimer: number | null = null;

  constructor(handlers: SessionSocketHandlers) {
    this.handlers = handlers;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.deliberatelyClosed = false;
    this.handlers.onStatus(this.attempts === 0 ? "connecting" : "reconnecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    // Every handler is identity-guarded: a *stale* socket (e.g. one closed by a
    // reload / StrictMode teardown just before a re-`connect()`) must never act
    // on the current session. Without this, the old socket's late `onclose`
    // would null `this.ws` while a newer socket is live — silently dropping all
    // PCM/control frames ("mic hears you, nothing is sent").
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.handlers.onStatus("open");
      // §7: `{type:"start"}` begins the session.
      this.send({ type: "start" });
      this.handlers.onOpen?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        // Server sends JSON only; binary is ignored defensively (audio_corrupt parity).
        return;
      }
      if (typeof event.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
        return;
      }
      this.handlers.onMessage(msg);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return; // a newer socket already owns the session
      this.ws = null;
      if (this.deliberatelyClosed) {
        this.handlers.onStatus("closed");
        return;
      }
      // Control close codes: 1013 too many connections — back off harder.
      if (event.code === 1013) {
        this.attempts = Math.max(this.attempts, 4);
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // `onclose` always follows; reconnect is scheduled there.
    };
  }

  /** Send full SessionState on connect/reconnect (§7 `sync`). */
  sendSync(): void {
    this.send({ type: "sync", state: this.handlers.getStateForSync() });
  }

  send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      // Frame dropped; next turn re-syncs.
    }
  }

  /** Binary: Int16 PCM, 16 kHz mono, 20–40 ms frames. */
  sendPcm(frame: Int16Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      // Copy into an exact-size typed array so the wire frame is only the frame.
      this.ws.send(new Int16Array(frame));
    } catch {
      // Drop frame (audio_corrupt parity).
    }
  }

  close(): void {
    this.deliberatelyClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, "client shutdown");
    this.ws = null;
    this.handlers.onStatus("closed");
  }

  private scheduleReconnect(): void {
    if (this.deliberatelyClosed) return;
    this.handlers.onStatus("reconnecting");
    const backoff = Math.min(1000 * 2 ** this.attempts, 15_000);
    const jitter = Math.random() * 400;
    this.attempts += 1;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, backoff + jitter);
  }
}
