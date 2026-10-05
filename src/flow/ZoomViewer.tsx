import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { trpc } from "@/providers/trpc";

const MAX = 6;

/**
 * Full-screen Photo: pinch (two fingers) between 1x and 6x, double-tap toggles
 * 1x / 3x, drag to pan. The picture sits in a box that is really resized (not
 * CSS-scaled), so `children` positioned in percent - the AI's frames - scale
 * and pan with it while borders and badges keep their pixel size.
 */
export function ZoomViewer({
  storageKey,
  onClose,
  children,
}: {
  storageKey: string;
  onClose: () => void;
  children: (ratio: number) => ReactNode;
}) {
  const url = trpc.attachments.url.useQuery({ key: storageKey });
  const [ratio, setRatio] = useState(4 / 3);
  const [scale, setScale] = useState(1);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const scroller = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const lastTap = useRef(0);

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const fitW = Math.min(vp.w, vp.h * ratio);
  const w = fitW * scale;
  const h = (fitW / ratio) * scale;

  // zoom around a point of the viewport, keeping the picture under it still
  const zoomTo = (next: number, cx: number, cy: number) => {
    const el = scroller.current;
    const s = Math.min(MAX, Math.max(1, next));
    if (el) {
      const k = s / scale;
      const left = (el.scrollLeft + cx) * k - cx;
      const top = (el.scrollTop + cy) * k - cy;
      requestAnimationFrame(() => el.scrollTo(left, top));
    }
    setScale(s);
  };

  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black" role="dialog" aria-label="Photo">
      <div
        ref={scroller}
        className="absolute inset-0 overflow-auto"
        style={{ touchAction: "pan-x pan-y" }}
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) pinch.current = { dist: dist(), scale };
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2 && pinch.current && pinch.current.dist > 0) {
            zoomTo((pinch.current.scale * dist()) / pinch.current.dist, vp.w / 2, vp.h / 2);
          }
        }}
        onPointerUp={(e) => {
          const wasOne = pointers.current.size === 1;
          pointers.current.delete(e.pointerId);
          pinch.current = null;
          if (!wasOne) return;
          const now = Date.now();
          if (now - lastTap.current < 300) zoomTo(scale > 1.01 ? 1 : 3, e.clientX, e.clientY);
          lastTap.current = now;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          pinch.current = null;
        }}
      >
        <div className="relative" style={{ width: w, height: h, margin: `${Math.max(0, (vp.h - h) / 2)}px ${Math.max(0, (vp.w - w) / 2)}px` }}>
          {url.data?.url && (
            <img
              src={url.data.url}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full select-none"
              onLoad={(e) => {
                const { naturalWidth: nw, naturalHeight: nh } = e.currentTarget;
                if (nw > 0 && nh > 0) setRatio(nw / nh);
              }}
            />
          )}
          {children(ratio)}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close the Photo"
        className="absolute right-3 top-[calc(0.75rem+env(safe-area-inset-top))] grid h-10 w-10 place-items-center rounded-full bg-white/90 text-black"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}
