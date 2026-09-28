/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // `<alpha-value>` format so `bg-bg/70` style modifiers work with CSS vars.
        bg: "rgb(var(--bg-rgb) / <alpha-value>)",
        surface: "rgb(var(--surface-rgb) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2-rgb) / <alpha-value>)",
        ink: "rgb(var(--ink-rgb) / <alpha-value>)",
        "ink-muted": "rgb(var(--ink-muted-rgb) / <alpha-value>)",
        tallow: "rgb(var(--tallow-rgb) / <alpha-value>)",
        verdigris: "rgb(var(--verdigris-rgb) / <alpha-value>)",
        accent: "rgb(var(--accent-rgb) / <alpha-value>)",
        "accent-soft": "rgb(var(--accent-soft-rgb) / <alpha-value>)",
        "accent-strong": "rgb(var(--accent-strong-rgb) / <alpha-value>)",
        ember: "rgb(var(--ember-rgb) / <alpha-value>)",
        steel: "rgb(var(--steel-rgb) / <alpha-value>)",
        "timer-1": "rgb(var(--timer-1-rgb) / <alpha-value>)",
        "timer-2": "rgb(var(--timer-2-rgb) / <alpha-value>)",
        "timer-3": "rgb(var(--timer-3-rgb) / <alpha-value>)",
        "timer-4": "rgb(var(--timer-4-rgb) / <alpha-value>)",
        "timer-5": "rgb(var(--timer-5-rgb) / <alpha-value>)"
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', "Georgia", "serif"],
        sans: ["Geist", "Inter", "system-ui", "sans-serif"],
        mono: ['"Geist Mono"', "ui-monospace", "monospace"]
      },
      fontSize: {
        "10": ["0.625rem", { lineHeight: "1.3", letterSpacing: "0.06em" }],
        "11": ["0.6875rem", { lineHeight: "1.35", letterSpacing: "0.06em" }],
        "12": ["clamp(0.6875rem, 0.65rem + 0.15vw, 0.75rem)", { lineHeight: "1.35" }],
        "13": ["clamp(0.75rem, 0.72rem + 0.15vw, 0.8125rem)", { lineHeight: "1.4" }],
        "14": ["clamp(0.78125rem, 0.74rem + 0.2vw, 0.875rem)", { lineHeight: "1.4" }],
        "16": ["clamp(0.84375rem, 0.8rem + 0.25vw, 0.9375rem)", { lineHeight: "1.5" }],
        "18": ["clamp(0.9375rem, 0.88rem + 0.3vw, 1.0625rem)", { lineHeight: "1.4" }],
        "20": ["clamp(1.03125rem, 0.96rem + 0.4vw, 1.1875rem)", { lineHeight: "1.3", letterSpacing: "-0.015em" }],
        "28": ["clamp(1.2rem, 1.08rem + 0.65vw, 1.5rem)", { lineHeight: "1.2", letterSpacing: "-0.02em" }],
        "40": ["clamp(1.45rem, 1.25rem + 1vw, 2rem)", { lineHeight: "1.15", letterSpacing: "-0.025em" }],
        "56": ["clamp(1.75rem, 1.45rem + 1.5vw, 2.5rem)", { lineHeight: "1.1", letterSpacing: "-0.03em" }]
      },
      borderRadius: {
        sm: "8px",
        md: "14px",
        lg: "24px"
      },
      transitionDuration: {
        micro: "120ms",
        feedback: "180ms",
        state: "240ms",
        layout: "320ms"
      },
      transitionTimingFunction: {
        ui: "cubic-bezier(0.2, 0, 0, 1)"
      },
      boxShadow: {
        warm: "0 8px 32px -12px rgb(80 50 20 / 0.28)",
        "warm-lg": "0 24px 64px -24px rgb(80 50 20 / 0.35)"
      }
    }
  },
  plugins: []
};
