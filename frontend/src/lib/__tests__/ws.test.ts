/**
 * SessionSocket lifecycle guard (architecture §7).
 *
 * Regression: a reload / StrictMode teardown closes a socket and immediately
 * reconnects. The *old* socket's late `onclose` must not null the current
 * socket reference, or every subsequent send (PCM + control) is silently
 * dropped — the "mic hears you, nothing is sent" bug.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSocket } from "../ws";

class MockWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWS[] = [];

  url: string;
  readyState = MockWS.CONNECTING;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWS.CLOSED;
  }

  /** Test helper: transition to OPEN and fire `onopen`. */
  open(): void {
    this.readyState = MockWS.OPEN;
    this.onopen?.();
  }
}

function makeSocket(): SessionSocket {
  return new SessionSocket({
    onMessage: vi.fn(),
    onStatus: vi.fn(),
    getStateForSync: () => ({
      session_id: "",
      phase: "intake",
      recipe: null,
      current_step_index: 0,
      timers: []
    })
  });
}

beforeEach(() => {
  MockWS.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWS;
});

describe("SessionSocket stale-socket guard", () => {
  it("a stale onclose must not clobber the current socket", () => {
    const socket = makeSocket();

    socket.connect();
    const first = MockWS.instances[0];
    expect(first).toBeDefined();
    first.open();

    // Reload / StrictMode: close, then immediately reconnect.
    socket.close();
    socket.connect();
    const second = MockWS.instances[1];
    expect(second).toBeDefined();
    second.open();

    // The old socket's late close event arrives after the reconnect.
    first.onclose?.({ code: 1000 });

    // The live socket must still receive sends (not be nulled out). The stale
    // socket got only its own `start` — never the later control frame.
    const frame = { type: "control" as const, action: "mute" as const };
    socket.send(frame);
    expect(second.sent).toContain(JSON.stringify(frame));
    expect(first.sent).not.toContain(JSON.stringify(frame));
  });

  it("onopen sends start only for the current socket", () => {
    const socket = makeSocket();
    socket.connect();
    const first = MockWS.instances[0];
    socket.close();
    socket.connect();
    const second = MockWS.instances[1];

    // A late onopen from the superseded socket is ignored.
    first.open();
    expect(first.sent).toHaveLength(0);

    second.open();
    expect(second.sent).toContain(JSON.stringify({ type: "start" }));
  });
});
