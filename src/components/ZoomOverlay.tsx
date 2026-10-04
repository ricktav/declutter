import { lazy, Suspense, type ReactNode } from "react";

// The overlay (and Radix Dialog with it) loads on first use, so a bundle
// that only shows thumbnails - Flow's, via ItemRoomPreview - doesn't carry it.
const ZoomOverlayImpl = lazy(() => import("@/components/ZoomOverlayImpl"));

/**
 * Full-screen pan/zoom view for a photo or a drawing. Wheel and trackpad
 * pinch zoom around the cursor (0.5x-8x), drag pans, double-click toggles
 * 1x / 2x, two-finger touch pinch works through pointer events; Esc, the
 * close button or a click on the dark background closes it. Renders
 * nothing (and loads nothing) while closed.
 */
export function ZoomOverlay(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Extra controls shown at the left of the toolbar (e.g. a Pin button). */
  toolbarExtra?: ReactNode;
  children: ReactNode;
}) {
  if (!props.open) return null;
  return (
    <Suspense fallback={null}>
      <ZoomOverlayImpl {...props} />
    </Suspense>
  );
}
