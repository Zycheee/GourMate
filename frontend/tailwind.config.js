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
        "12": ["12px", { lineHeight: "16px" }],
        "14": ["14px", { lineHeight: "20px" }],
        "16": ["16px", { lineHeight: "24px" }],
        "20": ["20px", { lineHeight: "28px" }],
        "28": ["28px", { lineHeight: "34px" }],
        "40": ["40px", { lineHeight: "44px" }],
        "56": ["56px", { lineHeight: "60px" }]
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
