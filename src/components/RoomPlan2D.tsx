import { useRef } from "react";
import type { ItemPos, RoomGeometry } from "@db/schema";

export type PlanItem = {
  id: number;
  name: string;
  pos: ItemPos | null;
};

type Opening = RoomGeometry["openings"][number];
type DragKind = "move" | "rotate" | "resize";
type DragState = { kind: DragKind; id: number; startLoc: { x: number; y: number }; startPos: ItemPos };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const round2 = (v: number) => +v.toFixed(2);

/** Whatever contains this footprint's center and is bigger than it (a desk,
 * a table) is its stacking host - ported from lidarventory's findHost(). */
function findHost(id: number, pos: ItemPos, items: PlanItem[]): (PlanItem & { pos: ItemPos }) | null {
  const cx = pos.xM + pos.wM / 2, cy = pos.yM + pos.dM / 2;
  const area = pos.wM * pos.dM;
  for (const h of items) {
    if (h.id === id || !h.pos) continue;
    const hp = h.pos;
    if (cx < hp.xM || cx > hp.xM + hp.wM || cy < hp.yM || cy > hp.yM + hp.dM) continue;
    if (hp.wM * hp.dM <= area) continue;
    return h as PlanItem & { pos: ItemPos };
  }
  return null;
}

/** Sets/clears pos.baseM to the host's top height, or back to the floor. */
function applyStacking(id: number, pos: ItemPos, items: PlanItem[]): ItemPos {
  const host = findHost(id, pos, items);
  if (!host) {
    const { baseM: _drop, ...rest } = pos;
    return rest;
  }
  return { ...pos, baseM: round2((host.pos.baseM ?? 0) + (host.pos.hM ?? 0.8)) };
}

/**
 * 2D floor plan, to scale in meters - read-only render plus drag/rotate/
 * resize on placed items. Ported from lidarventory's render2D() (meter→
 * pixel grid via SVG CTM, edge-based opening placement, 15°-snap rotate,
 * unrotated-frame resize - same simplification the original uses: the
 * rotate/resize handles sit at the item's *unrotated* bounding box, so a
 * rotated item's resize is approximate, matching the source behavior).
 *
 * Drag math stays imperative for the hot path (direct attribute writes on
 * pointermove, matching the original) and only commits to the caller via
 * onPosChange on pointerup - re-rendering the whole SVG on every pointer
 * move would be the "drag-in-React tax" the rewrite estimate warned about.
 */
export function RoomPlan2D({
  widthM,
  depthM,
  walls,
  openings,
  items,
  editable = false,
  selectedId = null,
  onSelect,
  onPosChange,
}: {
  widthM: number;
  depthM: number;
  walls: RoomGeometry["walls"] | null;
  openings: RoomGeometry["openings"] | null;
  items: PlanItem[];
  editable?: boolean;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  onPosChange?: (id: number, pos: ItemPos) => void;
}) {
  const S = 70; // px per meter
  const PAD = 36;
  const svgW = widthM * S + PAD * 2;
  const svgH = depthM * S + PAD * 2;
  const px = (xM: number) => PAD + xM * S;
  const py = (yM: number) => PAD + yM * S;

  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const xTicks = Array.from({ length: Math.floor(widthM) + 1 }, (_, i) => i);
  const yTicks = Array.from({ length: Math.floor(depthM) + 1 }, (_, i) => i);
  const placed = items.filter((it): it is PlanItem & { pos: ItemPos } => it.pos != null);
  const selected = placed.find((it) => it.id === selectedId);

  const openingLine = (o: Opening) => {
    const a = o.offsetM, b = o.offsetM + o.widthM;
    if (o.edge === "bottom") return { x1: px(a), y1: py(depthM), x2: px(b), y2: py(depthM) };
    if (o.edge === "top") return { x1: px(a), y1: py(0), x2: px(b), y2: py(0) };
    if (o.edge === "left") return { x1: px(0), y1: py(a), x2: px(0), y2: py(b) };
    return { x1: px(widthM), y1: py(a), x2: px(widthM), y2: py(b) };
  };

  const toLocal = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM()!.inverse());
  };

  const placeItemGroup = (id: number, p: ItemPos) => {
    const svg = svgRef.current;
    const g = svg?.querySelector<SVGGElement>(`g[data-item-id="${id}"]`);
    if (!g) return;
    const x = px(Math.max(0, p.xM)), y = py(Math.max(0, p.yM)), w = p.wM * S, d = p.dM * S;
    g.setAttribute("transform", `rotate(${-p.rotDeg} ${x + w / 2} ${y + d / 2})`);
    g.querySelector("rect")?.setAttribute("x", String(x));
    g.querySelector("rect")?.setAttribute("y", String(y));
    g.querySelector("rect")?.setAttribute("width", String(w));
    g.querySelector("rect")?.setAttribute("height", String(d));
    g.querySelector("text")?.setAttribute("x", String(x + w / 2));
    g.querySelector("text")?.setAttribute("y", String(y + d / 2 + 4));
  };

  const startDrag = (kind: DragKind, id: number, e: React.PointerEvent) => {
    if (!editable) return;
    const it = placed.find((p) => p.id === id);
    if (!it) return;
    onSelect?.(id);
    dragRef.current = { kind, id, startLoc: toLocal(e.clientX, e.clientY), startPos: { ...it.pos } };
    (e.target as Element).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };

  const onDragMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const loc = toLocal(e.clientX, e.clientY);
    const next = { ...drag.startPos };

    if (drag.kind === "move") {
      const dx = (loc.x - drag.startLoc.x) / S, dy = (loc.y - drag.startLoc.y) / S;
      next.xM = round2(clamp(drag.startPos.xM + dx, 0, widthM - drag.startPos.wM));
      next.yM = round2(clamp(drag.startPos.yM + dy, 0, depthM - drag.startPos.dM));
    } else if (drag.kind === "resize") {
      next.wM = Math.max(0.1, round2((loc.x - PAD) / S - Math.max(0, drag.startPos.xM)));
      next.dM = Math.max(0.1, round2((loc.y - PAD) / S - Math.max(0, drag.startPos.yM)));
    } else {
      const cx = px(Math.max(0, drag.startPos.xM) + drag.startPos.wM / 2);
      const cy = py(Math.max(0, drag.startPos.yM) + drag.startPos.dM / 2);
      const a = (Math.atan2(loc.y - cy, loc.x - cx) * 180) / Math.PI;
      const rot = (((-(a + 90)) % 360) + 360) % 360;
      next.rotDeg = e.shiftKey ? +rot.toFixed(1) : Math.round(rot / 15) * 15 % 360;
    }

    (drag as DragState & { pending?: ItemPos }).pending = next;
    placeItemGroup(drag.id, next);
  };

  const onDragEnd = () => {
    const drag = dragRef.current as (DragState & { pending?: ItemPos }) | null;
    dragRef.current = null;
    if (!drag?.pending) return;
    const pos = drag.kind === "move" ? applyStacking(drag.id, drag.pending, placed) : drag.pending;
    onPosChange?.(drag.id, pos);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${svgW} ${svgH}`}
      className="w-full h-auto bg-white rounded-lg border border-border touch-none"
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
    >
      {xTicks.map((x) => (
        <text key={`x${x}`} x={px(x)} y={PAD - 10} textAnchor="middle" className="fill-muted-foreground text-[9px]">
          {x}m
        </text>
      ))}
      {yTicks.map((y) => (
        <text key={`y${y}`} x={PAD - 8} y={py(y) + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">
          {y}m
        </text>
      ))}

      <rect x={PAD} y={PAD} width={widthM * S} height={depthM * S} className="fill-muted/20 stroke-border" strokeWidth={1} />

      {(walls ?? []).map((wall, i) => (
        <polyline
          key={i}
          points={wall.points.map(([x, y]) => `${px(x)},${py(y)}`).join(" ")}
          className="stroke-foreground/60"
          strokeWidth={3}
          fill="none"
        />
      ))}

      {(openings ?? []).map((o, i) => {
        const { x1, y1, x2, y2 } = openingLine(o);
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-background" strokeWidth={4} />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#d9a13b" strokeWidth={2} strokeDasharray="6 4" />
            <text
              x={(x1 + x2) / 2}
              y={Math.max(y1, y2) + (o.edge === "bottom" ? 14 : -6)}
              textAnchor="middle"
              fill="#d9a13b"
              className="text-[9px]"
            >
              opening · {o.widthM} m{o.connectsTo != null ? ` → room #${o.connectsTo}` : ""}
            </text>
          </g>
        );
      })}

      {placed.map((it) => {
        const p = it.pos;
        const x = px(Math.max(0, p.xM)), y = py(Math.max(0, p.yM)), w = p.wM * S, d = p.dM * S;
        const isSel = it.id === selectedId;
        return (
          <g
            key={it.id}
            data-item-id={it.id}
            transform={`rotate(${-p.rotDeg} ${x + w / 2} ${y + d / 2})`}
            onPointerDown={(e) => (editable ? startDrag("move", it.id, e) : onSelect?.(it.id))}
            className={editable ? "cursor-move" : "cursor-pointer"}
          >
            <rect
              x={x}
              y={y}
              width={w}
              height={d}
              rx={4}
              className={isSel ? "fill-primary/25 stroke-primary" : "fill-primary/15 stroke-primary/70"}
              strokeWidth={isSel ? 2 : 1.5}
            />
            <text x={x + w / 2} y={y + d / 2 + 4} textAnchor="middle" className="text-[10px] fill-foreground">
              {it.name}
              {p.baseM ? " ↑" : ""}
            </text>
          </g>
        );
      })}

      {editable && selected && (
        <>
          {(() => {
            const p = selected.pos;
            const x = px(Math.max(0, p.xM)), y = py(Math.max(0, p.yM)), w = p.wM * S, d = p.dM * S;
            return (
              <>
                <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y - 16} stroke="#4da3ff" strokeWidth={1} />
                <circle
                  cx={x + w / 2}
                  cy={y - 16}
                  r={7}
                  className="fill-white stroke-[#4da3ff] cursor-grab"
                  strokeWidth={2}
                  onPointerDown={(e) => startDrag("rotate", selected.id, e)}
                />
                <rect
                  x={x + w - 6}
                  y={y + d - 6}
                  width={12}
                  height={12}
                  className="fill-white stroke-[#4da3ff] cursor-se-resize"
                  strokeWidth={2}
                  onPointerDown={(e) => startDrag("resize", selected.id, e)}
                />
              </>
            );
          })()}
        </>
      )}
    </svg>
  );
}
