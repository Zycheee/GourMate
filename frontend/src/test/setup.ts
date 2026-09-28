import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom does not always expose crypto.randomUUID; the store/timer code uses it.
try {
  if (
    typeof globalThis.crypto === "undefined" ||
    typeof globalThis.crypto.randomUUID !== "function"
  ) {
    Object.defineProperty(globalThis, "crypto", {
      value: {
        randomUUID: () =>
          `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
      },
      configurable: true,
      writable: true
    });
  }
} catch {
  // If the global is locked down, individual tests polyfill as needed.
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
