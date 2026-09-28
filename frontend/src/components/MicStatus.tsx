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
  const connection = useSession((s) => s.connection);
  const voiceState = useSession((s) => s.voiceState);
  const level = useLiveMicLevel();

  const offline = connection === "reconnecting" || connection === "closed" || connection === "idle";
  const label = offline
    ? UI.reconnecting
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
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2.5 rounded-full glass px-4 py-2.5">
        <span className="relative flex h-3 w-3 items-center justify-center" aria-hidden="true">
          {!muted && !offline && level > 0.02 && (
            <span
              className="absolute inline-flex h-full w-full rounded-full bg-accent/50"
              style={{ transform: `scale(${1 + level * 2.2})`, opacity: 0.25 + level * 0.5 }}
            />
          )}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dotColor}`} />
        </span>
        <span className="text-14 font-medium text-ink">{label}</span>
        {offline ? (
          <WifiOff className="h-3.5 w-3.5 text-steel" aria-hidden="true" />
        ) : (
          <Wifi className="h-3.5 w-3.5 text-steel" aria-hidden="true" />
        )}
      </div>

      <motion.button
        type="button"
        onClick={onToggleMute}
        aria-pressed={muted}
        aria-label={muted ? UI.unmute : UI.mute}
        title={muted ? UI.unmute : UI.mute}
        {...pressProps}
        className={[
          "flex h-12 w-12 items-center justify-center rounded-full transition-colors duration-micro ease-ui",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          muted
            ? "bg-steel/25 text-ink hover:bg-steel/35"
            : "bg-surface/85 text-ink hover:bg-surface-2/90"
        ].join(" ")}
      >
        {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </motion.button>
    </div>
  );
}
