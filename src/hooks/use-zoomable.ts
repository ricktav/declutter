import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

/** Open/close state for a ZoomOverlay plus the props that make any element
 * open it on double-click: `<img {...zoom.props} />` and
 * `<ZoomOverlay open={zoom.open} onClose={zoom.close}>…</ZoomOverlay>`. */
export function useZoomable() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const show = useCallback(() => setOpen(true), []);
  return {
    open,
    show,
    close,
    props: { onDoubleClick: show, title: "Double-click to enlarge" },
  };
}

/** Split single and double clicks on an element whose single click already
 * does something (navigate, start a mutation): the single action waits out
 * the double-click window, a double click cancels it and runs `onDouble`.
 * Modified clicks (ctrl/cmd/shift/middle) pass straight through. */
export function useClickOrDoubleClick(onSingle: () => void, onDouble: () => void, delay = 250) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return {
    onClick: (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      if (e.detail > 1) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        onSingle();
      }, delay);
    },
    onDoubleClick: (e: MouseEvent) => {
      e.preventDefault();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      onDouble();
    },
  };
}
