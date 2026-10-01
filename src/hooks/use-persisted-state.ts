import { useState } from "react";

const PREFIX = "declutter.ui.";

/** Like useState, but the value survives navigation/reload via localStorage -
 * for per-screen UI preferences (view mode, sort, toggles) that should stick
 * instead of resetting every time you come back to a screen. */
export function usePersistedState<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  const set = (value: T | ((prev: T) => T)) => {
    setState((prev) => {
      const next = typeof value === "function" ? (value as (prev: T) => T)(prev) : value;
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(next));
      } catch {
        // storage unavailable (private mode, quota) - state still works in-memory
      }
      return next;
    });
  };

  return [state, set] as const;
}
