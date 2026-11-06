import { useRef } from "react";

/** Pointer travel (px) below which a press on a frame counts as a click, not a drag. */
export const DRAG_CLICK_PX = 5;

/** One draggable/resizable detection box on the original snap. */
export function Box({
  box,
  color,
  onChange,
  onSelect,
  selected,
  label,
  description,
  showInlineLabel,
}: {
  box: { xPct: number; yPct: number; wPct: number; hPct: number };
  color: string;
  onChange: (b: { xPct: number; yPct: number; wPct: number; hPct: number }) => void;
  onSelect?: () => void;
  selected?: boolean;
  label?: string;
  description?: string | null;
  showInlineLabel?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  type Corner = "tl" | "tr" | "bl" | "br";
  // a corner drag moves that corner only; the opposite corner stays where it is
  const drag = useRef<{ mode: "move" | Corner; startX: number; startY: number; orig: typeof box } | null>(null);
  const moved = useRef(false);

  const onPointerDown = (e: React.PointerEvent, mode: "move" | Corner) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    moved.current = false;
    drag.current = { mode, startX: e.clientX, startY: e.clientY, orig: { ...box } };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const rect = ref.current?.parentElement?.getBoundingClientRect();
    if (!d || !rect) return;
    if (Math.abs(e.clientX - d.startX) > DRAG_CLICK_PX || Math.abs(e.clientY - d.startY) > DRAG_CLICK_PX) {
      moved.current = true;
    }
    const dx = ((e.clientX - d.startX) / rect.width) * 100;
    const dy = ((e.clientY - d.startY) / rect.height) * 100;
    if (d.mode === "move") {
      onChange({
        ...d.orig,
        xPct: Math.min(100, Math.max(0, d.orig.xPct + dx)),
        yPct: Math.min(100, Math.max(0, d.orig.yPct + dy)),
      });
      return;
    }
    const o = d.orig;
    let left = o.xPct - o.wPct / 2;
    let right = o.xPct + o.wPct / 2;
    let top = o.yPct - o.hPct / 2;
    let bottom = o.yPct + o.hPct / 2;
    const clamp = (v: number) => Math.min(100, Math.max(0, v));
    if (d.mode === "tl" || d.mode === "bl") left = clamp(Math.min(left + dx, right - 4));
    if (d.mode === "tr" || d.mode === "br") right = clamp(Math.max(right + dx, left + 4));
    if (d.mode === "tl" || d.mode === "tr") top = clamp(Math.min(top + dy, bottom - 4));
    if (d.mode === "bl" || d.mode === "br") bottom = clamp(Math.max(bottom + dy, top + 4));
    onChange({ xPct: (left + right) / 2, yPct: (top + bottom) / 2, wPct: right - left, hPct: bottom - top });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const mode = drag.current?.mode;
    const wasDrag = moved.current;
    drag.current = null;
    moved.current = false;
    if (!wasDrag && onSelect && e.button !== 2 && mode === "move") onSelect();
  };

  const handleClass: Record<Corner, string> = {
    tl: "-top-1.5 -left-1.5 cursor-nwse-resize",
    tr: "-top-1.5 -right-1.5 cursor-nesw-resize",
    bl: "-bottom-1.5 -left-1.5 cursor-nesw-resize",
    br: "-bottom-1.5 -right-1.5 cursor-nwse-resize",
  };

  const tip = [label, description].filter((t): t is string => !!t && t.trim().length > 0);

  return (
    <div
      ref={ref}
      data-zoom-ignore
      className="absolute border-2 touch-none group"
      style={{
        left: `${box.xPct - box.wPct / 2}%`,
        top: `${box.yPct - box.hPct / 2}%`,
        width: `${box.wPct}%`,
        height: `${box.hPct}%`,
        borderColor: color,
        background: `${color}14`,
        cursor: "move",
        zIndex: selected ? 20 : 10,
      }}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {tip.length > 0 && (
        <div
          className={`pointer-events-none absolute left-0 z-20 max-w-[14rem] rounded-md bg-black/85 px-2 py-1 text-[11px] leading-snug text-white ${
            showInlineLabel
              ? "bottom-full mb-1"
              : "bottom-full mb-1 hidden group-hover:block"
          }`}
        >
          {label && <div className="font-semibold">{label}</div>}
          {description && <div className="text-white/80">{description}</div>}
        </div>
      )}
      {(["tl", "tr", "bl", "br"] as const).map((corner) => (
        <div
          key={corner}
          className={`absolute h-3.5 w-3.5 rounded-sm border-2 bg-white ${handleClass[corner]}`}
          style={{ borderColor: color }}
          onPointerDown={(e) => onPointerDown(e, corner)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      ))}
    </div>
  );
}
