import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog";

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Elements inside the stage that keep their own pointer/wheel handling
 * (buttons, links, form fields, and anything marked `data-zoom-ignore`,
 * e.g. the three.js view with its own orbit controls). */
const IGNORE_SELECTOR = "button, a, input, select, textarea, label, [data-zoom-ignore]";
const isIgnored = (target: EventTarget | null) =>
  target instanceof Element && target.closest(IGNORE_SELECTOR) != null;

type View = { s: number; x: number; y: number };
const IDENTITY: View = { s: 1, x: 0, y: 0 };

/** Zoom `v` to scale `next` while keeping the stage point (px, py) still. */
function zoomAt(v: View, next: number, px: number, py: number): View {
  const s = clamp(next, MIN_SCALE, MAX_SCALE);
  const k = s / v.s;
  return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/**
 * Full-screen pan/zoom view for a photo or a drawing. Wheel and trackpad
 * pinch zoom around the cursor (0.5x-8x), drag pans, double-click toggles
 * 1x / 2x, two-finger touch pinch works through pointer events, and Esc or
 * the close button closes it. `children` are laid out centred in the
 * viewport at 1x; the stage scales them with a CSS transform.
 */
export default function ZoomOverlayImpl({
  open,
  onClose,
  title,
  toolbarExtra,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Extra controls shown at the left of the toolbar (e.g. a Pin button). */
  toolbarExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-black/85" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[1100] flex flex-col outline-none"
          // React events bubble through portals: keep a double-click in here
          // from reaching the element that opened the overlay
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <DialogPrimitive.Title className="sr-only">{title ?? "Zoom view"}</DialogPrimitive.Title>
          {/* mounted only while open, so every opening starts at 1x */}
          <ZoomStage title={title} toolbarExtra={toolbarExtra} onClose={onClose}>
            {children}
          </ZoomStage>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

function ZoomStage({
  title,
  toolbarExtra,
  onClose,
  children,
}: {
  title?: string;
  toolbarExtra?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const [view, setView] = useState<View>(IDENTITY);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  // the second click of the double-click that opened the overlay lands on
  // the stage - don't let it count as a zoom toggle
  const openedAtRef = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; mx: number; my: number } | null>(null);
  // set once a press has moved far enough to count as a drag, so the
  // click that ends it doesn't close the overlay
  const dragged = useRef(false);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  // pointer capture retargets the click to the stage, so remember where the
  // press actually started
  const downTarget = useRef<EventTarget | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    openedAtRef.current = Date.now();
  }, []);

  const local = useCallback(
    (clientX: number, clientY: number) => {
      const r = stage?.getBoundingClientRect();
      return r ? { x: clientX - r.left, y: clientY - r.top } : { x: clientX, y: clientY };
    },
    [stage],
  );

  // wheel + Safari gesture events need non-passive listeners to preventDefault
  useEffect(() => {
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (isIgnored(e.target)) return;
      e.preventDefault();
      // trackpad pinch arrives as ctrl+wheel with small deltas
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const k = e.ctrlKey ? 0.01 : 0.0015;
      const factor = Math.exp(-e.deltaY * unit * k);
      const p = local(e.clientX, e.clientY);
      setView((v) => zoomAt(v, v.s * factor, p.x, p.y));
    };
    // Safari (macOS) reports trackpad pinch as gesture* events, not ctrl+wheel
    let lastScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      const factor = ge.scale / (lastScale || 1);
      lastScale = ge.scale;
      const p = local(ge.clientX, ge.clientY);
      setView((v) => zoomAt(v, v.s * factor, p.x, p.y));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGestureStart);
    stage.addEventListener("gesturechange", onGestureChange);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", onGestureStart);
      stage.removeEventListener("gesturechange", onGestureChange);
    };
  }, [stage, local]);

  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (isIgnored(e.target) || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e.clientX, e.clientY));
    if (pointers.current.size === 1) {
      dragged.current = false;
      downAt.current = { x: e.clientX, y: e.clientY };
      downTarget.current = e.target;
    } else {
      dragged.current = true;
    }
    gesture.current = pointers.current.size === 2 ? pinchState() : null;
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    if (downAt.current && Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) > 4) {
      dragged.current = true;
    }
    if (pointers.current.size === 1) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    } else if (pointers.current.size === 2 && gesture.current) {
      const g = pinchState();
      const last = gesture.current;
      gesture.current = g;
      setView((v) => {
        const zoomed = zoomAt(v, v.s * (g.dist / (last.dist || 1)), g.mx, g.my);
        return { ...zoomed, x: zoomed.x + g.mx - last.mx, y: zoomed.y + g.my - last.my };
      });
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    gesture.current = pointers.current.size === 2 ? pinchState() : null;
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (isIgnored(e.target) || Date.now() - openedAtRef.current < 500) return;
    const p = local(e.clientX, e.clientY);
    setView((v) => (Math.abs(v.s - 1) < 0.01 ? zoomAt(v, 2, p.x, p.y) : IDENTITY));
  };

  // a click on the dark background (not on the photo or drawing) closes,
  // like the old lightbox's backdrop did
  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (dragged.current) return;
    const t = downTarget.current;
    downTarget.current = null;
    if (t === e.currentTarget || t === layerRef.current) onClose();
  };

  const zoomBy = (factor: number) => {
    const r = stage?.getBoundingClientRect();
    setView((v) => zoomAt(v, v.s * factor, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2));
  };

  const btn = "h-8 w-8 flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/15";

  return (
    <>
      <div className="flex items-center gap-1 px-3 py-2 shrink-0">
        {toolbarExtra}
        {title && <div className="text-[13px] text-white/80 truncate ml-1">{title}</div>}
        <div className="ml-auto flex items-center gap-1 rounded-lg bg-black/40 p-0.5">
          <button type="button" className={btn} title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.5)}>
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="font-data text-[11px] text-white/70 w-10 text-center tabular-nums">
            {Math.round(view.s * 100)}%
          </span>
          <button type="button" className={btn} title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.5)}>
            <ZoomIn className="h-4 w-4" />
          </button>
          <button type="button" className={btn} title="Fit" aria-label="Fit to screen" onClick={() => setView(IDENTITY)}>
            <Maximize className="h-4 w-4" />
          </button>
          <DialogPrimitive.Close className={btn} title="Close (Esc)" aria-label="Close">
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </div>
      </div>
      <div
        ref={setStage}
        className="relative flex-1 min-h-0 overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onClick={onBackdropClick}
        onDragStart={(e) => e.preventDefault()}
      >
        <div
          ref={layerRef}
          className="absolute inset-0 flex items-center justify-center p-4"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: "0 0" }}
        >
          {children}
        </div>
      </div>
    </>
  );
}
