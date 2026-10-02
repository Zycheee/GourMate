import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useSession } from "../../store/session";
import { useVoiceSession } from "../useVoiceSession";

const mocks = vi.hoisted(() => ({ socket: null as any, mic: null as any, tts: null as any }));
vi.mock("../../lib/ws", () => ({ SessionSocket: class {
  handlers: any; send = vi.fn(); sendPcm = vi.fn(); sendSync = vi.fn(); close = vi.fn();
  constructor(handlers: any) { this.handlers = handlers; mocks.socket = this; }
  open = false; connect() { if (!this.open) { this.open = true; this.handlers.onOpen(); } }
} }));
vi.mock("../../lib/audio", () => ({
  ensureAudioContext: vi.fn(), getAudioContextState: () => "running",
  MicCapture: class { handlers: any; start = vi.fn(async () => {}); stop = vi.fn(); stopAndFlush = vi.fn(async () => { this.stop(); }); constructor(h: any) { this.handlers = h; mocks.mic = this; } },
  TtsPlayer: class { isBusy = false; enqueue = vi.fn(() => { this.isBusy = true; }); stop = vi.fn(() => { this.isBusy = false; }); constructor() { mocks.tts = this; } }
}));
const initial = useSession.getState();
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); useSession.setState({ ...initial, lastInteractionAt: Date.now() }, true);
  mocks.socket = mocks.mic = mocks.tts = null;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const deliver = (event: any) => act(() => mocks.socket.handlers.onMessage(event));

describe("Kef activity and capture", () => {
  it("cancels a reply during processing before its first audio arrives", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    deliver({ type: "state", voice_state: "processing", turn_id: "pending" });
    act(() => result.current.sendText("A newer request"));
    deliver({ type: "assistant_audio", turn_id: "pending", seq: 0, data: "AA==", mime: "audio/mpeg" });
    expect(mocks.tts.enqueue).not.toHaveBeenCalled();
  });
  it.each(["granted", "denied", "prompt"])("restores saved voice wake only for %s permission", async (permission) => {
    vi.stubGlobal("navigator", { permissions: { query: vi.fn(async () => ({ state: permission })) } });
    useSession.getState().setSettings({ voiceWake: true });
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    expect(useSession.getState().sleeping).toBe(true);
    expect(useSession.getState().wakeListening).toBe(permission === "granted");
    expect(mocks.mic.start).toHaveBeenCalledTimes(permission === "granted" ? 1 : 0);
  });
  it("reconnect restores the current microphone mode", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start()); act(() => result.current.wake());
    mocks.socket.send.mockClear(); act(() => mocks.socket.handlers.onOpen());
    expect(mocks.socket.send).toHaveBeenCalledWith({ type: "control", action: "wake", enable_mic: true });
    act(() => result.current.toggleMute()); mocks.socket.send.mockClear();
    act(() => mocks.socket.handlers.onOpen());
    expect(mocks.socket.send).toHaveBeenCalledWith({ type: "control", action: "mute" });
  });
  it("does not sleep during active speech", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start()); act(() => result.current.wake());
    deliver({ type: "vad", state: "speech_start" });
    act(() => vi.advanceTimersByTime(90_000));
    expect(useSession.getState().sleeping).toBe(false);
  });
  it("connects asleep without capture and wakes with a single activation", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    expect(useSession.getState().sleeping).toBe(true);
    expect(mocks.mic.start).not.toHaveBeenCalled();
    act(() => result.current.wake());
    expect(useSession.getState().sleeping).toBe(false);
    expect(mocks.mic.start).toHaveBeenCalledOnce();
  });
  it("typed input wakes without enabling capture and stops the previous reply", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    deliver({ type: "assistant_audio", turn_id: "old", seq: 0, data: "AA==", mime: "audio/mpeg" });
    act(() => result.current.sendText("Cook eggs"));
    expect(useSession.getState().sleeping).toBe(false);
    expect(useSession.getState().muted).toBe(true);
    expect(mocks.tts.isBusy).toBe(false);
    deliver({ type: "assistant_audio", turn_id: "old", seq: 1, data: "AA==", mime: "audio/mpeg" });
    expect(mocks.tts.enqueue).toHaveBeenCalledOnce();
    expect(mocks.mic.start).not.toHaveBeenCalled();
  });
  it("mute stops wake capture and ignores an unfinished transcript", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    act(() => result.current.setVoiceWake(true));
    expect(useSession.getState().wakeListening).toBe(true);
    act(() => result.current.toggleMute());
    expect(useSession.getState().wakeListening).toBe(false);
    expect(mocks.mic.stop).toHaveBeenCalled();
    deliver({ type: "transcript", final: true, text: "unfinished words" });
    expect(useSession.getState().transcript).toEqual([]);
    act(() => result.current.toggleMute());
    expect(useSession.getState().sleeping).toBe(true);
    expect(useSession.getState().muted).toBe(true);
    expect(useSession.getState().wakeListening).toBe(true);
  });
  it("counts inactivity after playback and retains optional wake listening", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    act(() => { result.current.wake(); result.current.setVoiceWake(true); });
    mocks.tts.isBusy = true;
    act(() => vi.advanceTimersByTime(65_000));
    expect(useSession.getState().sleeping).toBe(false);
    mocks.tts.isBusy = false;
    act(() => { useSession.getState().setVoiceState("idle"); vi.advanceTimersByTime(59_000); });
    expect(useSession.getState().sleeping).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(useSession.getState().sleeping).toBe(true);
    expect(useSession.getState().wakeListening).toBe(true);
  });
  it("keeps chunks of one reply playing and interrupts on near-end speech", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start()); act(() => result.current.wake());
    deliver({ type: "assistant_audio", turn_id: "reply", seq: 0, data: "AA==" });
    const stops = mocks.tts.stop.mock.calls.length;
    deliver({ type: "assistant_audio", turn_id: "reply", seq: 1, data: "AA==" });
    expect(mocks.tts.stop).toHaveBeenCalledTimes(stops);
    deliver({ type: "vad", state: "speech_start" });
    expect(mocks.tts.isBusy).toBe(false);
    expect(useSession.getState().userSpeaking).toBe(true);
  });
  it("denied capture leaves voice wake disabled", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start()); act(() => result.current.setVoiceWake(true));
    act(() => mocks.mic.handlers.onError(new DOMException("Denied", "NotAllowedError")));
    expect(useSession.getState().wakeListening).toBe(false);
    expect(useSession.getState().muted).toBe(true);
  });
  it("manual mute flushes audio before submitting and accepts the final transcript once", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    act(() => result.current.wake());
    deliver({ type: "vad", state: "speech_start", utterance_id: "recording" });
    let release!: () => void;
    mocks.mic.stopAndFlush.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    mocks.socket.send.mockClear();
    act(() => result.current.toggleMute());
    expect(useSession.getState().muted).toBe(true);
    expect(mocks.socket.send).not.toHaveBeenCalledWith(expect.objectContaining({ action: "mute" }));
    act(() => mocks.mic.handlers.onPcm(new Int16Array([123])));
    expect(mocks.socket.sendPcm).toHaveBeenCalledWith(new Int16Array([123]));
    await act(async () => { release(); });
    expect(mocks.socket.send).toHaveBeenCalledWith({ type: "control", action: "mute", pending_audio: "submit", utterance_id: "recording" });
    deliver({ type: "transcript", final: true, utterance_id: "recording", text: "I have eggs" });
    deliver({ type: "transcript", final: true, utterance_id: "recording", text: "I have eggs" });
    deliver({ type: "transcript", final: true, utterance_id: "late", text: "stale words" });
    expect(useSession.getState().transcript.map(t => t.text)).toEqual(["I have eggs"]);
    expect(useSession.getState().muted).toBe(true);
  });
  it("sleeping unmute enables wake only without changing the saved preference", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    await act(async () => result.current.toggleMute());
    expect(useSession.getState().sleeping).toBe(true);
    expect(useSession.getState().wakeListening).toBe(true);
    expect(useSession.getState().muted).toBe(true);
    expect(useSession.getState().settings.voiceWake).toBe(false);
    expect(mocks.socket.send).toHaveBeenCalledWith({ type: "control", action: "unmute" });
    expect(mocks.socket.send).not.toHaveBeenCalledWith(expect.objectContaining({ action: "wake" }));
    deliver({ type: "transcript", final: true, utterance_id: "unrelated", text: "television speech" });
    expect(useSession.getState().transcript).toEqual([]);
  });
  it("rapid mute/unmute ignores the old mute acknowledgement and starts fresh capture", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start()); act(() => result.current.wake());
    const initialStarts = mocks.mic.start.mock.calls.length;
    let release!: () => void;
    mocks.mic.stopAndFlush.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    act(() => result.current.toggleMute());
    act(() => result.current.toggleMute());
    deliver({ type: "activity", sleeping: false, wake_listening: false, muted: true });
    expect(useSession.getState().muted).toBe(false);
    await act(async () => { release(); });
    expect(mocks.mic.start.mock.calls.length).toBe(initialStarts + 1);
    deliver({ type: "activity", sleeping: false, wake_listening: false, muted: false });
    expect(useSession.getState().muted).toBe(false);
    const controls = mocks.socket.send.mock.calls.map((c: any[]) => c[0]).filter((c: any) => c.action === "mute" || c.action === "unmute");
    expect(controls.map((c: any) => c.action)).toEqual(["mute", "unmute"]);
  });
  it("superseding typed input rejects delayed submitted speech even after unmute", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start()); act(() => result.current.wake());
    deliver({ type: "vad", state: "speech_start", utterance_id: "old" });
    await act(async () => result.current.toggleMute());
    act(() => result.current.sendText("New request"));
    await act(async () => result.current.toggleMute());
    deliver({ type: "transcript", final: true, utterance_id: "old", text: "old words" });
    expect(useSession.getState().transcript.map(t => t.text)).toEqual(["New request"]);
  });
  it("inline actions send a typed event without synthesizing a command string", async () => {
    const { result } = renderHook(useVoiceSession);
    await act(() => result.current.start());
    act(() => result.current.sendAction({ name: "start_cooking" }, "Start cooking"));
    expect(mocks.socket.send).toHaveBeenCalledWith({ type: "action_input", action: { name: "start_cooking" } });
    expect(mocks.socket.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "text_input" }));
    expect(useSession.getState().sleeping).toBe(false);
    expect(useSession.getState().muted).toBe(true);
  });

});
