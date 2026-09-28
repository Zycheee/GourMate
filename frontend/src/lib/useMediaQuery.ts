/**
 * useMediaQuery — subscribe to a CSS media query (SSR-safe).
 * Returns `false` whenever `window` is unavailable; otherwise the live match
 * state, kept in sync through `change` events with proper cleanup. The initial
 * value is read lazily from `matchMedia` on the client so layout does not flash
 * through the SSR default before the first paint.
 */

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => {
      setMatches(event.matches);
    };
    // Re-sync: the query string may have changed since the initial render.
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
