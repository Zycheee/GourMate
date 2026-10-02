/**
 * Audio conversion guards — the pure, deterministic half of the capture
 * pipeline (no Web Audio required). Locks the 16 kHz framing contract and the
 * 48 kHz rate branch: capture runs at the device default rate and
 * `downsampleTo16kInt16` decimates behind the 7.2 kHz low-pass, while
 * `float32ToInt16` short-circuits the equal-rate case. Also locks the dBFS
 * floor used by the Input level meter so it can never log10(0).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  MicCapture,
  MIN_INPUT_DBFS,
  downsampleTo16kInt16,
  float32ToInt16,
  getMicLevel,
  getMicPeak,
  levelToDbfs
} from "../audio";

const pcm = (s: number): number => float32ToInt16(new Float32Array([s]))[0];

describe("float32ToInt16", () => {
  it("maps full scale onto Int16 extremes and clips beyond", () => {
    expect(pcm(1)).toBe(0x7fff);
    expect(pcm(-1)).toBe(-0x8000);
    expect(pcm(2)).toBe(0x7fff);
    expect(pcm(-2)).toBe(-0x8000);
  });

  it("converts mid-scale samples without rate conversion", () => {
    const out = float32ToInt16(new Float32Array([0, 0.5, -0.5]));
    expect(out.length).toBe(3);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(pcm(0.5));
    expect(out[2]).toBe(pcm(-0.5));
  });
});

describe("downsampleTo16kInt16 — 48 kHz rate branch", () => {
  it("decimates 3:1 at 48 kHz (the default capture rate)", () => {
    const input = new Float32Array(480).fill(0.5);
    const out = downsampleTo16kInt16(input, 48000);
    expect(out.length).toBe(160);
    for (const s of out) expect(s).toBe(pcm(0.5));
  });

  it("box-averages within each decimation block", () => {
    // 6 samples @48 kHz → 2 outputs: block means 0 and 0.75.
    const out = downsampleTo16kInt16(
      new Float32Array([0, 0, 0, 0.75, 0.75, 0.75]),
      48000
    );
    expect(out.length).toBe(2);
    expect(out[0]).toBe(pcm(0));
    expect(out[1]).toBe(pcm(0.75));
  });

  it("short-circuits the equal-rate case through float32ToInt16", () => {
    const input = new Float32Array([0.25, -0.25]);
    expect(Array.from(downsampleTo16kInt16(input, 16000))).toEqual(
      Array.from(float32ToInt16(input))
    );
  });

  it("returns an empty buffer for empty input", () => {
    expect(downsampleTo16kInt16(new Float32Array(0), 48000).length).toBe(0);
  });
});

describe("levelToDbfs / Input level meter constants", () => {
  it("floors silence instead of taking log10(0)", () => {
    expect(levelToDbfs(0)).toBe(-120);
  });

  it("converts amplitude to 20*log10 dBFS", () => {
    expect(levelToDbfs(1)).toBeCloseTo(0, 5);
    expect(levelToDbfs(0.5)).toBeCloseTo(-6.02, 1);
    expect(levelToDbfs(0.0056)).toBeCloseTo(-45, 0);
  });

  it("mirrors the backend stt_min_rms_dbfs gate (≈ -45 dBFS)", () => {
    expect(MIN_INPUT_DBFS).toBe(-45);
  });

  it("starts both mic levels at 0 before capture", () => {
    expect(getMicLevel()).toBe(0);
    expect(getMicPeak()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* MicCapture concurrency guard                                        */
/* ------------------------------------------------------------------ */

class FakeNode {
  connect(target: unknown): unknown {
    return target;
  }
  disconnect(): void {
    /* no-op */
  }
}

function fakeStream(): { getTracks: () => unknown[]; getAudioTracks: () => unknown[]; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  const track = { stop };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 48000, channelCount: 1 }) }],
    stop
  };
}

class FakeAudioContext {
  state = "running";
  sampleRate = 48000;
  destination = {};
  closed = false;
  audioWorklet = { addModule: () => Promise.resolve() };
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  createMediaStreamSource(): FakeNode {
    return new FakeNode();
  }
  createBiquadFilter(): FakeNode {
    const node = new FakeNode() as FakeNode & { type: string; frequency: { value: number }; Q: { value: number } };
    node.type = "";
    node.frequency = { value: 0 };
    node.Q = { value: 0 };
    return node;
  }
  createAnalyser(): FakeNode {
    const node = new FakeNode() as FakeNode & { fftSize: number; frequencyBinCount: number; getByteTimeDomainData: () => void };
    node.fftSize = 256;
    node.frequencyBinCount = 128;
    node.getByteTimeDomainData = () => undefined;
    return node;
  }
  createGain(): FakeNode {
    const node = new FakeNode() as FakeNode & { gain: { value: number } };
    node.gain = { value: 1 };
    return node;
  }
}

class FakeWorkletNode {
  static latest: FakeWorkletNode;
  constructor() { FakeWorkletNode.latest = this; }
  port = { onmessage: null as ((event: MessageEvent) => void) | null, close: () => undefined, postMessage: vi.fn() };
  connect(target: unknown): unknown {
    return target;
  }
  disconnect(): void {
    /* no-op */
  }
}

describe("MicCapture.start concurrency", () => {
  const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
  const originalWorklet = (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;

  beforeEach(() => {
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = FakeWorkletNode;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => fakeStream()) }
    });
  });

  afterEach(() => {
    (globalThis as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = originalWorklet;
  });


  it("mute stops tracks immediately and flushes the worklet tail before resolving", async () => {
    const stream = fakeStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream as unknown as MediaStream);
    const frames: Int16Array[] = [];
    const capture = new MicCapture({ onPcm: frame => frames.push(frame) });
    await capture.start(null);
    const node = FakeWorkletNode.latest;
    node.port.onmessage!({ data: new Float32Array(900).fill(0.5) } as MessageEvent);
    const flushing = capture.stopAndFlush();
    expect(stream.stop).toHaveBeenCalled();
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    node.port.onmessage!({ data: new Float32Array(180).fill(0.5) } as MessageEvent);
    node.port.onmessage!({ data: { type: "flushed" } } as MessageEvent);
    await flushing;
    expect(frames.reduce((n, f) => n + f.length, 0)).toBe(360);
    expect(frames[0][0]).toBe(pcm(0.5));
    capture.stop();
  });

  it("flush has a 200 ms deadline and keeps samples already received", async () => {
    vi.useFakeTimers();
    try {
      const frames: Int16Array[] = [];
      const capture = new MicCapture({ onPcm: frame => frames.push(frame) });
      await capture.start(null);
      FakeWorkletNode.latest.port.onmessage!({ data: new Float32Array(900).fill(0.5) } as MessageEvent);
      const flushing = capture.stopAndFlush();
      let resolved = false;
      void flushing.then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(199);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await flushing;
      expect(frames[0]).toHaveLength(300);
      capture.stop();
    } finally { vi.useRealTimers(); }
  });

  it("discard cancels an unfinished flush and fresh capture has no old tail", async () => {
    const frames: Int16Array[] = [];
    const capture = new MicCapture({ onPcm: frame => frames.push(frame) });
    await capture.start(null);
    FakeWorkletNode.latest.port.onmessage!({ data: new Float32Array(900).fill(0.5) } as MessageEvent);
    const flushing = capture.stopAndFlush();
    capture.stop();
    await flushing;
    expect(frames).toEqual([]);
    await capture.start(null);
    const next = capture.stopAndFlush();
    FakeWorkletNode.latest.port.onmessage!({ data: { type: "flushed" } } as MessageEvent);
    await next;
    expect(frames).toEqual([]);
  });

  it("aborts a superseded start so only one capture graph can go live", async () => {
    const streams: ReturnType<typeof fakeStream>[] = [];
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const s = fakeStream();
      streams.push(s);
      return s;
    });

    const capture = new MicCapture({ onPcm: () => undefined });
    const first = capture.start(null);
    const second = capture.start(null);
    await Promise.all([first, second]);

    // The first (superseded) stream's track must be released; exactly one lives.
    const stopped = streams.filter((s) => s.stop.mock.calls.length > 0);
    expect(streams).toHaveLength(2);
    expect(stopped).toHaveLength(1);

    capture.stop();
  });
});
