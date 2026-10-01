import type { ItemPos, RoomGeometry } from "@db/schema";

export type PlanItem = {
  id: number;
  name: string;
  pos: ItemPos | null;
};

type Opening = RoomGeometry["openings"][number];

/**
 * Read-only 2D floor plan, to scale in meters. Ported from lidarventory's
 * render2D() (meter→pixel grid, edge-based opening placement, rotated item
 * rects) but expressed declaratively since nothing here is dragged yet -
 * drag/rotate/resize lands in the next phase, likely as an imperative
 * pointer layer over this same SVG rather than a re-render-per-frame.
 */
export function RoomPlan2D({
  widthM,
  depthM,
  walls,
  openings,
  items,
}: {
  widthM: number;
  depthM: number;
  walls: RoomGeometry["walls"] | null;
  openings: RoomGeometry["openings"] | null;
  items: PlanItem[];
}) {
  const S = 70; // px per meter
  const PAD = 36;
  const svgW = widthM * S + PAD * 2;
  const svgH = depthM * S + PAD * 2;
  const px = (xM: number) => PAD + xM * S;
  const py = (yM: number) => PAD + yM * S;

  const xTicks = Array.from({ length: Math.floor(widthM) + 1 }, (_, i) => i);
  const yTicks = Array.from({ length: Math.floor(depthM) + 1 }, (_, i) => i);
  const placed = items.filter((it): it is PlanItem & { pos: ItemPos } => it.pos != null);

  const openingLine = (o: Opening) => {
    const a = o.offsetM, b = o.offsetM + o.widthM;
    if (o.edge === "bottom") return { x1: px(a), y1: py(depthM), x2: px(b), y2: py(depthM) };
    if (o.edge === "top") return { x1: px(a), y1: py(0), x2: px(b), y2: py(0) };
    if (o.edge === "left") return { x1: px(0), y1: py(a), x2: px(0), y2: py(b) };
    return { x1: px(widthM), y1: py(a), x2: px(widthM), y2: py(b) };
  };

  return (
    <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-auto bg-white rounded-lg border border-border">
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
        return (
          <g key={it.id} transform={`rotate(${-p.rotDeg} ${x + w / 2} ${y + d / 2})`}>
            <rect x={x} y={y} width={w} height={d} rx={4} className="fill-primary/15 stroke-primary" strokeWidth={1.5} />
            <text x={x + w / 2} y={y + d / 2 + 4} textAnchor="middle" className="text-[10px] fill-foreground">
              {it.name}
              {p.baseM ? " ↑" : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
