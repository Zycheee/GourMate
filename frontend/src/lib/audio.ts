/**
 * Audio pipeline — design §3 "Mouth sync", architecture §4.
 *
 * Capture: getUserMedia(echoCancellation) → low-pass (7.2 kHz) → AudioWorklet
 * batches Float32 → main thread frames 16 kHz mono Int16 PCM (32 ms). The
 * capture AudioContext runs at the device's default rate: forcing
 * `sampleRate: 16000` once produced silence / low-level audio on some stacks
 * (Whisper hallucinated on it). `downsampleTo16kInt16` decimates to 16 kHz
 * behind the low-pass anti-alias guard; `float32ToInt16` covers the
 * equal-rate case (e.g. a 16 kHz device default).
 *
 * Playback: assistant MP3 sentence chunks are decoded and played through an
 * AnalyserNode; its amplitude drives the avatar mouth.
 */

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 512; // 32 ms @ 16 kHz

/* ------------------------------------------------------------------ */
/* Shared analysis levels (read per-frame by the 3D avatar)           */
/* ------------------------------------------------------------------ */

const levelState = {
  mouth: 0,
  mouthSmoothed: 0,
  mic: 0,
  micSmoothed: 0,
  micPeak: 0
};

/** 0..1 amplitude of the assistant TTS output — drives mouth open. */
export function getMouthLevel(): number {
  return levelState.mouthSmoothed;
}

/** 0..1 amplitude of the live microphone. */
export function getMicLevel(): number {
  return levelState.micSmoothed;
}

/**
 * 0..1 peak-hold of the live microphone with a slow decay, so a brief word
 * stays visible on the input-level meter instead of flashing by in one frame.
 * Decays per rAF pump in `MicCapture.pumpLevels`.
 */
export function getMicPeak(): number {
  return levelState.micPeak;
}

/**
 * 20*log10(level) with a -120 dBFS floor for silence (never log10(0)).
 * Shared with the Speech check meter so the "too quiet" hint reads in the
 * same units the backend gates on (`stt_min_rms_dbfs`, ≈ -45 dBFS).
 */
export function levelToDbfs(level: number): number {
  return level > 0 ? 20 * Math.log10(level) : -120;
}

/**
 * Backend input gate (config.py `stt_min_rms_dbfs` default) — the Speech
 * check meter flags anything below this as "too quiet — check your mic".
 */
export const MIN_INPUT_DBFS = -45;

function rmsToUnit(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
}

/**
 * Extract speech volume and syllable dynamics for avatar lip-sync.
 * Blends RMS (phoneme core) and peak transient (consonant attack) with gain
 * so spoken words produce clear, lively 0.2..1.0 levels while speech pauses drop to 0.
 */
function speechLevelToUnit(buf: Uint8Array): number {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs((buf[i] - 128) / 128);
    sum += v * v;
    if (v > peak) peak = v;
  }
  const rms = Math.sqrt(sum / buf.length);
  const combined = rms * 0.7 + peak * 0.3;
  return Math.min(1, Math.max(0, combined * 4.8));
}

/* ------------------------------------------------------------------ */
/* Shared AudioContext (resumed on user gesture)                       */
/* ------------------------------------------------------------------ */

let sharedCtx: AudioContext | null = null;

/** True once the shared context has been resumed inside a user gesture. */
let audioUnlocked = false;

export function ensureAudioContext(): AudioContext {
  if (!sharedCtx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new Ctor({ latencyHint: "interactive" });
  }
  if (sharedCtx.state === "suspended") {
    void sharedCtx.resume();
  }
  return sharedCtx;
}

/** Current shared-context state, or null before the context exists. */
export function getAudioContextState(): AudioContextState | null {
  return sharedCtx?.state ?? null;
}

/** Resumed state after the first user gesture (autoplay policy gate). */
export function isAudioUnlocked(): boolean {
  return audioUnlocked;
}

/**
 * Resume the shared context from a user gesture and record the result.
 * Without a gesture the context stays suspended and TTS plays silently.
 */
export async function resumeAudioContext(): Promise<boolean> {
  const ctx = ensureAudioContext();
  try {
    if (ctx.state !== "running") await ctx.resume();
  } catch {
    /* resume refused — stays locked */
  }
  // Autoplay policy gates every context independently — wake capture too.
  if (captureCtx && captureCtx.state === "suspended") {
    try {
      await captureCtx.resume();
    } catch {
      /* capture stays suspended until a gesture */
    }
  }
  audioUnlocked = ctx.state === "running";
  return audioUnlocked;
}

/* ------------------------------------------------------------------ */
/* Capture AudioContext (device default rate — separate from the shared TTS one) */
/* ------------------------------------------------------------------ */

let captureCtx: AudioContext | null = null;

/**
 * Dedicated capture context at the device's default sample rate with
 * interactive latency. Forcing `sampleRate: 16000` proved risky (silence /
 * low-level audio on some stacks → Whisper hallucinations), so we capture at
 * the default rate and convert in software: a 7.2 kHz low-pass guards the
 * box downsample in `MicCapture.enqueue`, and `float32ToInt16` handles the
 * equal-rate case when the default already is 16 kHz.
 */
function createCaptureContext(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor({ latencyHint: "interactive" });
  captureCtx = ctx;
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Float32 → Int16 mono @ 16 kHz                                       */
/* ------------------------------------------------------------------ */

/** Direct Float32 [-1..1] → Int16 conversion (no rate conversion). */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Box-downsample Float32 (any rate) → Int16 mono @ 16 kHz. This is the
 * normal path for default-rate capture contexts (e.g. 48 kHz → 16 kHz);
 * `float32ToInt16` short-circuits the equal-rate case (16 kHz device
 * default). The capture graph low-passes at 7.2 kHz first so the box
 * decimation cannot fold aliasing into the Whisper band.
 */
export function downsampleTo16kInt16(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === TARGET_RATE) {
    return float32ToInt16(input);
  }
  const ratio = inputRate / TARGET_RATE;
  const newLength = Math.floor(input.length / ratio);
  const out = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let acc = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      acc += input[j];
      n++;
    }
    const s = Math.max(-1, Math.min(1, n > 0 ? acc / n : 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Microphone capture via AudioWorklet                                 */
/* ------------------------------------------------------------------ */

export interface MicCaptureHandlers {
  /** 32 ms Int16 @ 16 kHz frames, ready for the WebSocket. */
  onPcm: (frame: Int16Array) => void;
  onStatus?: (status: "live" | "stopped") => void;
  onError?: (error: Error) => void;
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf = new Uint8Array(256);
  private pending: Float32Array[] = [];
  private pendingLength = 0;
  private handlers: MicCaptureHandlers;
  private flushResolve: (() => void) | null = null;
  private flushing: Promise<void> | null = null;
  private raf = 0;
  /**
   * Generation counter: every `start()`/`stop()` bumps it. An `await` inside
   * `start()` that resumes after a newer call took over bails out and releases
   * its own resources, so two concurrent starts can never leave two capture
   * graphs feeding the same frame buffer (doubled, choppy audio).
   */
  private startToken = 0;

  constructor(handlers: MicCaptureHandlers) {
    this.handlers = handlers;
  }

  async start(deviceId?: string | null): Promise<void> {
    // Invalidate any in-flight start and tear down the current graph first.
    const token = ++this.startToken;
    this.teardown();

    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {})
      }
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Surface the real cause — permission, missing device, insecure context…
      // eslint-disable-next-line no-console
      console.warn("[gourmate] mic capture failed", err);
      // `DOMException.name` is read-only, so build a plain Error carrying the
      // mapped name instead of assigning to it (which throws in strict mode).
      const cause = err instanceof Error ? err : new Error("mic_denied");
      const error = new Error(cause.message || "mic_denied");
      error.name = cause.name === "NotAllowedError" ? "mic_denied" : cause.name;
      this.handlers.onError?.(error);
      return;
    }
    if (token !== this.startToken) {
      // A newer start/stop superseded us while the device was opening.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    let ctx: AudioContext | null = null;
    try {
      // Own capture context at the device default rate; the shared context
      // stays reserved for TTS playback. A 7.2 kHz low-pass between the mic
      // and the processor keeps aliasing out of the box downsample to 16 kHz.
      ctx = createCaptureContext();
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);

      // Capture processor: the AudioWorklet path is primary. When worklets are
      // unavailable (`audioWorklet` missing or module/node creation throws) a
      // ScriptProcessorNode forwards raw frames into the very same `enqueue`
      // path — the 16 kHz Int16 downsample is untouched, so STT input and the
      // rest of the pipeline are identical either way.
      let processor: AudioNode;
      let workletNode: AudioWorkletNode | null = null;
      let scriptNode: ScriptProcessorNode | null = null;
      try {
        if (!ctx.audioWorklet) throw new Error("AudioWorklet is not supported");
        const workletUrl = `${import.meta.env.BASE_URL ?? "/"}worklets/capture-processor.js`;
        await ctx.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(ctx, "capture-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit"
        });
        node.port.onmessage = (event: MessageEvent) => {
          if (event.data?.type === "flushed") { this.flushResolve?.(); return; }
          if (event.data instanceof Float32Array) this.enqueue(event.data);
        };
        workletNode = node;
        processor = node;
      } catch (err) {
        // Fallback capture — same downstream frames, no worklet required.
        // eslint-disable-next-line no-console
        console.warn(
          "[gourmate] mic capture: AudioWorklet unavailable, using ScriptProcessor fallback",
          err
        );
        const sp = ctx.createScriptProcessor(2048, 1, 1);
        sp.onaudioprocess = (event: AudioProcessingEvent) => {
          this.enqueue(new Float32Array(event.inputBuffer.getChannelData(0)));
        };
        scriptNode = sp;
        processor = sp;
      }

      if (token !== this.startToken) {
        // A newer start/stop superseded us while the processor was opening.
        workletNode?.port.close();
        workletNode?.disconnect();
        scriptNode?.disconnect();
        if (captureCtx === ctx) captureCtx = null;
        void ctx.close().catch(() => undefined);
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      // Commit point: only the newest start wires up the live graph and assigns
      // the shared fields, so a superseded start can never clobber them.
      this.stream = stream;
      this.ctx = ctx;
      this.worklet = workletNode;
      this.processor = scriptNode;
      this.source = ctx.createMediaStreamSource(stream);
      // Anti-alias guard before the software decimation to 16 kHz
      // (BiquadFilterNode: lowpass @ ≈7.2 kHz, Q ≈ 0.7).
      this.highpass = ctx.createBiquadFilter();
      this.highpass.type = "highpass";
      this.highpass.frequency.value = 100;
      this.highpass.Q.value = 0.7;
      this.lowpass = ctx.createBiquadFilter();
      this.lowpass.type = "lowpass";
      this.lowpass.frequency.value = 7200;
      this.lowpass.Q.value = 0.7;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyserBuf = new Uint8Array(this.analyser.frequencyBinCount);

      // source -> highpass -> lowpass -> (worklet | scriptProcessor)
      // (analyser stays on the raw source).
      this.source.connect(this.highpass);
      this.highpass.connect(this.lowpass);
      this.lowpass.connect(processor);
      // Keep the graph alive without monitoring the mic through speakers.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      processor.connect(mute).connect(ctx.destination);
      this.source.connect(this.analyser);

      this.logTrackSettings();
      this.raf = requestAnimationFrame(this.pumpLevels);
      this.handlers.onStatus?.("live");
    } catch (err) {
      // Surface the real cause before releasing the failed attempt.
      // eslint-disable-next-line no-console
      console.warn("[gourmate] mic capture failed", err);
      // Release anything this (now-failed) attempt created.
      if (ctx) {
        if (captureCtx === ctx) captureCtx = null;
        void ctx.close().catch(() => undefined);
      }
      stream.getTracks().forEach((t) => t.stop());
      if (this.stream === stream) this.stream = null;
      if (this.ctx === ctx) this.ctx = null;
      this.worklet = null;
      this.processor = null;
      this.handlers.onError?.(err instanceof Error ? err : new Error("mic capture failed"));
    }
  }

  /** Diagnostic: surface the negotiated capture format in the browser console. */
  private logTrackSettings(): void {
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return;
    const s = track.getSettings();
    // eslint-disable-next-line no-console
    console.info(
      "[gourmate] mic capture:",
      JSON.stringify({
        deviceId: s.deviceId,
        sampleRate: s.sampleRate,
        channelCount: s.channelCount,
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseSuppression,
        autoGainControl: s.autoGainControl,
        ctxRate: this.ctx?.sampleRate
      })
    );
  }

  private pumpLevels = (): void => {
    // Safety net for the reload path (no user gesture yet): keep trying to
    // wake the capture context so frames reach the worklet.
    const ctx = this.ctx;
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    if (this.analyser) {
      this.analyser.getByteTimeDomainData(this.analyserBuf);
      levelState.mic = rmsToUnit(this.analyserBuf);
      levelState.micSmoothed += (levelState.mic - levelState.micSmoothed) * 0.25;
      // Peak-hold: instant attack, slow decay so a brief word stays visible
      // on the input-level meter (~0.6 s to half at 60 fps).
      levelState.micPeak = Math.max(levelState.mic, levelState.micPeak * 0.98);
    }
    this.raf = requestAnimationFrame(this.pumpLevels);
  };

  private enqueue(chunk: Float32Array): void {
    this.pending.push(chunk);
    this.pendingLength += chunk.length;
    // Accumulate enough input for a few 32 ms frames before converting.
    if (this.pendingLength < FRAME_SAMPLES * 2) return;

    const merged = new Float32Array(this.pendingLength);
    let offset = 0;
    for (const part of this.pending) {
      merged.set(part, offset);
      offset += part.length;
    }

    const rate = this.ctx?.sampleRate ?? TARGET_RATE;
    // 16 kHz device default → direct Int16 conversion (no decimation).
    // Any other rate (typically 48 kHz) → box downsample behind the 7.2 kHz
    // low-pass. Framing stays 512 samples / 32 ms either way.
    const pcm =
      rate === TARGET_RATE ? float32ToInt16(merged) : downsampleTo16kInt16(merged, rate);
    const usable = Math.floor(pcm.length / FRAME_SAMPLES) * FRAME_SAMPLES;
    for (let i = 0; i < usable; i += FRAME_SAMPLES) {
      // slice(): each frame owns an exact-size buffer for the WS send.
      this.handlers.onPcm(pcm.slice(i, i + FRAME_SAMPLES));
    }

    // Carry the unconsumed float tail into the next batch.
    const consumedFloat = Math.min(merged.length, Math.floor(usable * (rate / TARGET_RATE)));
    const rest = merged.subarray(consumedFloat);
    if (rest.length > 0) {
      const carry = new Float32Array(rest);
      this.pending = [carry];
      this.pendingLength = carry.length;
    } else {
      this.pending = [];
      this.pendingLength = 0;
    }
  }

  /** Release the live capture graph without touching `startToken`. */
  private teardown(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.worklet?.port.close();
    this.worklet?.disconnect();
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    this.lowpass?.disconnect();
    this.highpass?.disconnect();
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    // The capture context is ours — close it so the device fully releases.
    // (The shared TTS context stays alive for playback.)
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      if (captureCtx === ctx) captureCtx = null;
      void ctx.close().catch(() => undefined);
    }
    this.worklet = null;
    this.processor = null;
    this.lowpass = null;
    this.highpass = null;
    this.source = null;
    this.analyser = null;
    this.stream = null;
    this.pending = [];
    this.pendingLength = 0;
    levelState.mic = 0;
    levelState.micSmoothed = 0;
    levelState.micPeak = 0;
  }

  /** Stop device capture first; flush only samples already recorded (§7). */
  stopAndFlush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.startToken += 1;
    const token = this.startToken;
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.processor) this.processor.onaudioprocess = null;
    const worklet = this.worklet;
    this.flushing = (async () => {
      if (worklet) {
        await new Promise<void>(resolve => {
          const timeout = window.setTimeout(resolve, 200);
          this.flushResolve = () => { window.clearTimeout(timeout); resolve(); };
          try { worklet.port.postMessage({ type: "flush" }); } catch { this.flushResolve(); }
        });
      }
      if (token !== this.startToken) return;
      if (this.pendingLength) {
        const merged = new Float32Array(this.pendingLength);
        let offset = 0;
        for (const chunk of this.pending) { merged.set(chunk, offset); offset += chunk.length; }
        const rate = this.ctx?.sampleRate ?? TARGET_RATE;
        const pcm = rate === TARGET_RATE ? float32ToInt16(merged) : downsampleTo16kInt16(merged, rate);
        for (let i = 0; i < pcm.length; i += FRAME_SAMPLES) this.handlers.onPcm(pcm.slice(i, i + FRAME_SAMPLES));
      }
      this.teardown();
      this.handlers.onStatus?.("stopped");
    })().finally(() => { this.flushResolve = null; this.flushing = null; });
    return this.flushing;
  }

  stop(): void {
    // Bump the token so any in-flight start() aborts and cleans up after itself.
    this.startToken += 1;
    this.flushResolve?.();
    this.teardown();
    this.handlers.onStatus?.("stopped");
  }
}

/* ------------------------------------------------------------------ */
/* TTS playback (assistant_audio sentence chunks)                      */
/* ------------------------------------------------------------------ */

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface TtsPlayerHandlers {
  onEnded?: () => void;
}

export class TtsPlayer {
  private generation = 0;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private queue: { seq: number; bytes: Uint8Array }[] = [];
  private playing = false;
  private current: AudioBufferSourceNode | null = null;
  private raf = 0;
  private handlers?: TtsPlayerHandlers;

  constructor(handlers?: TtsPlayerHandlers) {
    this.handlers = handlers;
  }

  private ensureGraph(): AudioContext {
    const ctx = ensureAudioContext();
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.gain = ctx.createGain();
      this.gain.gain.value = 1;
      this.analyser.connect(this.gain).connect(ctx.destination);
    }
    return ctx;
  }

  /** Enqueue one base64 MP3 sentence chunk (`assistant_audio`). */
  enqueue(seq: number, dataBase64: string): void {
    try {
      const bytes = base64ToBytes(dataBase64);
      this.queue.push({ seq, bytes });
      void this.pump();
    } catch {
      // audio_corrupt — drop the chunk, captions still carry the text.
    }
  }

  get isBusy(): boolean {
    return this.playing || this.queue.length > 0;
  }

  /** Barge-in / turn reset: stop playback immediately and clear the queue. */
  stop(): void {
    this.generation++;
    this.queue = [];
    if (this.current) {
      try {
        this.current.onended = null;
        this.current.stop();
      } catch {
        /* already stopped */
      }
      this.current = null;
    }
    this.playing = false;
    levelState.mouth = 0;
    levelState.mouthSmoothed = 0;
    this.stopLevelPump();
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    const next = this.queue.shift();
    if (!next) {
      levelState.mouth = 0;
      levelState.mouthSmoothed = 0;
      this.stopLevelPump();
      this.handlers?.onEnded?.();
      return;
    }
    const ctx = this.ensureGraph();
    const analyser = this.analyser;
    const generation = this.generation;
    this.playing = true;
    this.startLevelPump();
    try {
      const copy = next.bytes.slice().buffer as ArrayBuffer;
      const audioBuffer = await ctx.decodeAudioData(copy);
      if (generation !== this.generation) return;
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      if (analyser) src.connect(analyser);
      this.current = src;
      src.onended = () => {
        if (generation !== this.generation) return;
        this.current = null;
        this.playing = false;
        void this.pump();
      };
      src.start();
    } catch {
      if (generation !== this.generation) return;
      // tts_failed / audio_corrupt — degrade to text-only continuation.
      this.playing = false;
      this.current = null;
      levelState.mouth = 0;
      levelState.mouthSmoothed = 0;
      void this.pump();
    }
  }

  private startLevelPump(): void {
    if (this.raf) return;
    const tick = (): void => {
      const analyser = this.analyser;
      if (analyser && this.playing) {
        analyser.getByteTimeDomainData(this.levelBuf);
        const target = speechLevelToUnit(this.levelBuf);
        levelState.mouth = target;
        // Asymmetric attack/release envelope:
        // Snappy attack so mouth opens instantly with spoken phonemes, natural release during pauses
        if (target > levelState.mouthSmoothed) {
          levelState.mouthSmoothed += (target - levelState.mouthSmoothed) * 0.75;
        } else {
          levelState.mouthSmoothed += (target - levelState.mouthSmoothed) * 0.28;
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLevelPump(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** fftSize 256 time-domain buffer. */
  private levelBuf = new Uint8Array(256);
}

/* ------------------------------------------------------------------ */
/* Timer chime (lib/timers.ts + SettingsSheet "Timer sound")           */
/* ------------------------------------------------------------------ */

export function playChime(): void {
  try {
    const ctx = ensureAudioContext();
    const now = ctx.currentTime;
    const partials = [
      { f: 880, g: 0.22, t: 0 },
      { f: 1320, g: 0.14, t: 0.12 },
      { f: 1760, g: 0.08, t: 0.24 }
    ];
    for (const p of partials) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = p.f;
      gain.gain.setValueAtTime(0, now + p.t);
      gain.gain.linearRampToValueAtTime(p.g, now + p.t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + p.t + 1.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + p.t);
      osc.stop(now + p.t + 1.2);
    }
  } catch {
    // Audio unavailable — the Notification still fires.
  }
}
