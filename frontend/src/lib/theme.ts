/**
 * theme.ts — model-derived accent palette (single source of truth).
 *
 * `MODEL_COLOR` is the avatar body orange (design §3). Every accent token in
 * the UI is derived from it through HSL so the chrome always matches the
 * character: `accent` (the model color itself), `accent-soft` (lighter tint),
 * `accent-strong` (darker shade), each with a `r g b` triple for CSS vars.
 * Also owns concrete theme resolution (`resolveTheme` / `useResolvedTheme`)
 * so the 3D canvas can paint the right surface color without reading the DOM.
 */

import { useEffect, useState } from "react";
import { useSession } from "../store/session";
import type { ThemePreference } from "../types";

export const MODEL_COLOR = "#E0702A";

/** Concrete color scheme after `auto` resolution. */
export type ResolvedTheme = "light" | "dark";

/** Surface colors per resolved theme (keep in sync with `--bg` in index.css). */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#f7f3ec",
  dark: "#141110"
};

/** Resolve a theme preference to a concrete scheme (`auto` follows the OS). */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

/**
 * Live resolved theme: respects `settings.theme` and re-resolves when the
 * preference or the OS scheme changes. Derived from the same inputs as
 * `data-theme` — never from a DOM read — so the canvas cannot lag a toggle.
 */
export function useResolvedTheme(): ResolvedTheme {
  const pref = useSession((s) => s.settings.theme);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(pref));
  useEffect(() => {
    const apply = (): void => setResolved(resolveTheme(pref));
    apply();
    if (pref !== "auto" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
  return resolved;
}

export interface AccentPalette {
  /** Base model color (hex). */
  accent: string;
  /** `"r g b"` triple for `rgb(var(--accent-rgb) / a)`. */
  accentRgb: string;
  /** Lighter tint (hex) — hovers, subtle fills. */
  accentSoft: string;
  accentSoftRgb: string;
  /** Darker shade (hex) — filled buttons (AA on white text). */
  accentStrong: string;
  accentStrongRgb: string;
}

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number): string =>
    Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

function triple(t: [number, number, number]): string {
  return t.map((v) => Math.round(v)).join(" ");
}

/** Derive accent / accent-soft / accent-strong from a base hex color. */
export function deriveAccentPalette(base: string = MODEL_COLOR): AccentPalette {
  const [r, g, b] = parseHex(base);
  const [h, s, l] = rgbToHsl(r, g, b);
  const soft = hslToRgb(h, Math.min(100, s * 0.82), Math.min(92, l + 20));
  const strong = hslToRgb(h, Math.min(100, s * 1.05), Math.max(10, l - 14));
  return {
    accent: toHex(r, g, b),
    accentRgb: triple([r, g, b]),
    accentSoft: toHex(soft[0], soft[1], soft[2]),
    accentSoftRgb: triple(soft),
    accentStrong: toHex(strong[0], strong[1], strong[2]),
    accentStrongRgb: triple(strong)
  };
}

/**
 * Publish the derived palette as CSS custom properties so Tailwind's
 * `accent*` colors and the raw `var(--accent*)` hooks pick it up.
 */
export function applyAccentTheme(
  root: HTMLElement = document.documentElement
): AccentPalette {
  const p = deriveAccentPalette();
  root.style.setProperty("--accent", p.accent);
  root.style.setProperty("--accent-rgb", p.accentRgb);
  root.style.setProperty("--accent-soft", p.accentSoft);
  root.style.setProperty("--accent-soft-rgb", p.accentSoftRgb);
  root.style.setProperty("--accent-strong", p.accentStrong);
  root.style.setProperty("--accent-strong-rgb", p.accentStrongRgb);
  return p;
}
