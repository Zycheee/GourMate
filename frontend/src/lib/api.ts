/**
 * api.ts — REST helpers (architecture §8).
 *
 * `previewVoice` renders a short sample with the chosen edge-tts voice via
 * `POST /api/tts/preview` and plays the returned `audio/mpeg` through a blob
 * URL. Callers handle failure (e.g. fall back to `speechSynthesis`).
 */

import { httpBaseUrl } from "./ws";

/** Play a spoken sample of `voice` through the backend TTS engine. */
export async function previewVoice(voice: string): Promise<void> {
  const res = await fetch(`${httpBaseUrl()}/api/tts/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice })
  });
  if (!res.ok) throw new Error(`tts preview failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("tts preview audio failed"));
      audio.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
