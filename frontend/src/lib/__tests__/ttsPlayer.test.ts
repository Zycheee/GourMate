import { afterEach, beforeEach, expect, it, vi } from "vitest";

let decodes: Array<(value: any) => void>;
let sources: any[];
beforeEach(() => {
  vi.resetModules(); decodes = []; sources = [];
  const node = () => ({ connect: vi.fn().mockReturnThis(), gain: { value: 1 }, getByteTimeDomainData: vi.fn() });
  vi.stubGlobal("AudioContext", class {
    state = "running"; destination = {}; resume = vi.fn(async () => {});
    createAnalyser = node; createGain = node;
    decodeAudioData() { return new Promise(resolve => decodes.push(resolve)); }
    createBufferSource() { const source = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; sources.push(source); return source; }
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

it("cannot restart stopped audio when an old decode completes", async () => {
  const { TtsPlayer } = await import("../audio");
  const player = new TtsPlayer();
  player.enqueue(0, "AA=="); player.stop(); player.enqueue(1, "AA==");
  decodes[0]({}); await Promise.resolve();
  expect(sources).toHaveLength(0);
  decodes[1]({}); await Promise.resolve();
  expect(sources).toHaveLength(1); expect(sources[0].start).toHaveBeenCalledOnce();
  player.stop();
});

it("plays consecutive sentence chunks without stopping the current source", async () => {
  const { TtsPlayer } = await import("../audio");
  const player = new TtsPlayer();
  player.enqueue(0, "AA=="); player.enqueue(1, "AA==");
  decodes[0]({}); await Promise.resolve();
  expect(decodes).toHaveLength(1);
  expect(sources[0].stop).not.toHaveBeenCalled();
  sources[0].onended(); decodes[1]({}); await Promise.resolve();
  expect(sources).toHaveLength(2); player.stop();
});
