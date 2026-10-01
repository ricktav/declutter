import { useEffect, useRef, useState } from "react";

const KEY_PREFIX = "declutter.aiTiming.";

function getTypical(action: string): number | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + action);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function recordDuration(action: string, ms: number) {
  try {
    const prev = getTypical(action);
    // exponential moving average - adapts over time instead of getting
    // stuck on the very first (often slowest, cold-start) call
    const next = prev == null ? ms : prev * 0.7 + ms * 0.3;
    localStorage.setItem(KEY_PREFIX + action, String(Math.round(next)));
  } catch {
    // private browsing / storage disabled - just won't remember next time
  }
}

/**
 * Ticking elapsed time plus a remembered typical duration for one kind of AI
 * call, so a slow request (claude -p dev mode can take 10-15s) shows an
 * honest "how long is this usually" instead of a bare spinner. Records its
 * own duration when `active` goes false, adapting over time rather than
 * needing the caller to report anything.
 */
export function useAiProgress(active: boolean, action: string) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [typicalMs, setTypicalMs] = useState<number | null>(() => getTypical(action));
  const startRef = useRef<number | null>(null);
  const wasActive = useRef(false);

  useEffect(() => {
    if (active) {
      if (!wasActive.current) startRef.current = Date.now();
      wasActive.current = true;
      const id = setInterval(() => {
        setElapsedMs(Date.now() - (startRef.current ?? Date.now()));
      }, 100);
      return () => clearInterval(id);
    }
    if (wasActive.current && startRef.current != null) {
      recordDuration(action, Date.now() - startRef.current);
      setTypicalMs(getTypical(action));
    }
    wasActive.current = false;
    startRef.current = null;
    setElapsedMs(0);
  }, [active, action]);

  const pct = typicalMs ? Math.min(100, (elapsedMs / typicalMs) * 100) : null;
  return { elapsedMs, typicalMs, pct };
}
