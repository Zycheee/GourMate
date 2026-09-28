import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Dedicated Vitest config (kept separate from vite.config.ts so the PWA plugin
 * is not loaded during unit tests). jsdom gives us localStorage + DOM.
 *
 * `server.fs.allow` exposes the repo root so the frontend contract test can
 * import `contracts/ws-events.json` as raw source (single golden manifest shared
 * with the backend suite).
 */
const frontendRoot = process.cwd();
const repoRoot = resolve(frontendRoot, "..");

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [frontendRoot, repoRoot]
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
    restoreMocks: true,
    clearMocks: true
  }
});
