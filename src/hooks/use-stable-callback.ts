import { useCallback, useLayoutEffect, useRef } from "react";

/** A callback with a fixed identity that always calls the latest `fn`.
 * For handlers passed to memoised children (RoomPlan2D) whose bodies read
 * fresh state: the child must not re-render just because the closure did. */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
