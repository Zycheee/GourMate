/**
 * Confetti — a short accent-tinted burst when a recipe completes
 * (phase "done"). Pure decoration: absolutely positioned, pointer-transparent,
 * non-looping CSS keyframes that fade out on their own; skipped entirely under
 * `prefers-reduced-motion` (see `.confetti-piece` in index.css).
 */

import { useState, type CSSProperties } from "react";

const COLORS = [
  "rgb(var(--accent-rgb))",      // Saffron accent
  "rgb(var(--accent-soft-rgb))", // Soft saffron
  "rgb(var(--tallow-rgb))",      // Earth yellow
  "#046241",                     // Castleton Green
  "#E1A95F",                     // Earth Yellow
  "#F5EEDB",                     // Paper
  "#FFFFFF"                      // White
];

const PIECE_COUNT = 28;

function makePieces(): CSSProperties[] {
  return Array.from({ length: PIECE_COUNT }, (_, i) => {
    const angle = (i / PIECE_COUNT) * Math.PI * 2 + Math.random() * 0.55;
    const dist = 90 + Math.random() * 170;
    return {
      "--confetti-x": `${Math.round(Math.cos(angle) * dist)}px`,
      "--confetti-y": `${Math.round(Math.sin(angle) * dist * 0.85 + 48)}px`,
      "--confetti-rot": `${Math.round((Math.random() * 2 - 1) * 540)}deg`,
      "--confetti-dur": `${(1.4 + Math.random() * 1.1).toFixed(2)}s`,
      "--confetti-delay": `${(Math.random() * 0.35).toFixed(2)}s`,
      width: `${Math.round(6 + Math.random() * 6)}px`,
      height: `${Math.round(8 + Math.random() * 8)}px`,
      borderRadius: Math.random() > 0.5 ? "9999px" : "2px",
      background: COLORS[i % COLORS.length]
    } as CSSProperties;
  });
}

export default function Confetti() {
  const [pieces] = useState(makePieces);

  return (
    <div
      aria-hidden="true"
      data-testid="confetti"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {pieces.map((style, i) => (
        <span key={i} className="confetti-piece" style={style} />
      ))}
    </div>
  );
}
