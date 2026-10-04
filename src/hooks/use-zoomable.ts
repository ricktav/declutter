import { useCallback, useState } from "react";

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
