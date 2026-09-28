import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Split heavy vendor groups so the entry chunk stays small. The `three`
        // group is only reachable through the lazy-loaded Avatar3D chunk, so it
        // is fetched on demand rather than on initial load. Keep this in sync
        // with vite-plugin-pwa's `globPatterns`, which precaches every emitted
        // `*.js` asset (including these chunks) when the service worker installs.
        manualChunks(id: string): string | undefined {
          const mod = id.replace(/\\/g, "/");
          // Vite's dynamic-import preload helper is shared by the entry and the
          // lazy Avatar3D chunk. Pin it to the eagerly-loaded framework chunk;
          // otherwise Rollup files it under `three`, which turns that whole
          // chunk into a static import of the entry and loads three eagerly.
          if (mod.includes("preload-helper")) return "react";
          if (!mod.includes("node_modules")) return undefined;
          if (
            mod.includes("/three/") ||
            mod.includes("/three-") ||
            mod.includes("/@react-three/") ||
            mod.includes("/@react-spring/")
          ) {
            return "three";
          }
          if (
            mod.includes("/react/") ||
            mod.includes("/react-dom/") ||
            mod.includes("/scheduler/") ||
            // zustand is shared by the entry store and by @react-three/fiber.
            // Pinning it here keeps it out of the `three` chunk, otherwise the
            // entry statically imports `three` and eagerly preloads all of it.
            mod.includes("/zustand/")
          ) {
            return "react";
          }
          return undefined;
        }
      }
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "worklets/capture-processor.js"],
      manifest: {
        name: "GourMate",
        short_name: "GourMate",
        description: "The sous-chef on the pass — a hands-free voice cooking assistant.",
        theme_color: "#141110",
        background_color: "#141110",
        display: "standalone",
        orientation: "any",
        start_url: ".",
        icons: [
          {
            src: "favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        navigateFallback: "index.html"
      }
    })
  ]
});
