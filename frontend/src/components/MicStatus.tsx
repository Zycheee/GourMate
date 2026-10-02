/**
 * MicStatus — the one persistent control of the cooking surface (design §6):
 * mic status + mute. Space toggles mute globally (handled in App).
 */

import { Mic, MicOff, Wifi, WifiOff } from "lucide-react";
import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { getMicLevel } from "../lib/audio";
import { pressProps } from "../lib/motion";
import { UI } from "../lib/copy";
import { useEffect, useState } from "react";

function useLiveMicLevel(): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      setLevel(getMicLevel());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return level;
}

export default function MicStatus({ onToggleMute }: { onToggleMute: () => void }) {
  const muted = useSession((s) => s.muted);
  const wakeListening = useSession((s) => s.wakeListening);
  const connection = useSession((s) => s.connection);
  const voiceState = useSession((s) => s.voiceState);
  const level = useLiveMicLevel();

  const offline = connection === "reconnecting" || connection === "closed" || connection === "idle";
  const label = offline
    ? UI.reconnecting
    : wakeListening
      ? "Wake listening"
      : muted
      ? UI.micMuted
      : voiceState === "processing"
        ? UI.thinking
        : voiceState === "listening"
          ? UI.micLive
          : UI.listening.replace("…", "");

  const dotColor = offline
    ? "bg-steel"
    : muted
      ? "bg-steel/60"
      : voiceState === "listening"
        ? "bg-accent"
        : voiceState === "error"
          ? "bg-ember"
          : "bg-tallow";

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8.5 sm:h-9 items-center gap-2 rounded-full clay px-3.5 clay-soft">
        <span className="relative flex h-2.5 w-2.5 items-center justify-center" aria-hidden="true">
          {!muted && !offline && level > 0.02 && (
            <span
              className="absolute inline-flex h-full w-full rounded-full bg-accent/50"
              style={{ transform: `scale(${1 + level * 2.2})`, opacity: 0.25 + level * 0.5 }}
            />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${dotColor}`} />
        </span>
        <span className="text-12 sm:text-13 font-medium text-ink">{label}</span>
        {offline ? (
          <WifiOff className="h-3 w-3 text-steel" aria-hidden="true" />
        ) : (
          <Wifi className="h-3 w-3 text-steel" aria-hidden="true" />
        )}
      </div>

      <motion.button
        type="button"
        onClick={onToggleMute}
        aria-pressed={muted && !wakeListening}
        aria-label={wakeListening ? "Stop wake listening" : muted ? UI.unmute : UI.mute}
        title={wakeListening ? "Stop wake listening" : muted ? UI.unmute : UI.mute}
        {...pressProps}
        className={[
          "flex h-8.5 w-8.5 sm:h-9 sm:w-9 items-center justify-center rounded-full clay-control transition-colors duration-micro ease-ui clay-soft",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          muted
            ? "bg-steel/25 text-ink hover:bg-steel/35"
            : "bg-surface dark:bg-surface-2 text-ink hover:bg-surface"
        ].join(" ")}
      >
        {muted && !wakeListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </motion.button>
    </div>
  );
}
