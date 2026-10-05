import type { ItemPos, RoomGeometry } from "@db/schema";

export type WallSide = "left" | "right" | "top" | "bottom";
export type WallKind = "wall" | "door" | "window";
export interface SnapResult {
  pos: ItemPos;
  movedM: number;
  side: WallSide;
  kind: WallKind;
}

/** A Thing snaps only to a wall line this close (metres) to its footprint's nearest edge. */
export const SNAP_MAX_M = 0.5;
/** Scanned walls are straightened; anything further off an axis is diagonal and skipped. */
const AXIS_TOL_DEG = 2;
/** Along the wall, the segment must reach at least this close to the footprint to count. */
const SPAN_TOL_M = 0.01;

interface Line {
  axis: "x" | "y"; // "x": a vertical wall at x = at; "y": a horizontal wall at y = at
  at: number;
  from: number; // the segment's span along the wall
  to: number;
  kind: WallKind;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The Thing's footprint as an axis-aligned box. pos.xM/yM is the top-left
 * corner of the unrotated wM x dM rectangle; it turns by rotDeg about its
 * centre (RoomPlan2D draws rotate(-rotDeg) in its y-down frame), so the
 * bounding box half-extents only need |cos| and |sin|.
 */
function footprint(pos: ItemPos) {
  const t = (pos.rotDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  const cx = pos.xM + pos.wM / 2, cy = pos.yM + pos.dM / 2;
  const hx = (c * pos.wM + s * pos.dM) / 2, hy = (s * pos.wM + c * pos.dM) / 2;
  return { cx, cy, hx, hy };
}

function linesOf(walls: RoomGeometry["walls"] | null | undefined): Line[] {
  const out: Line[] = [];
  const tol = Math.tan((AXIS_TOL_DEG * Math.PI) / 180);
  for (const w of walls ?? []) {
    const kind: WallKind = w.kind ?? "wall";
    const pts = w.points ?? [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      if (dx === 0 && dy === 0) continue;
      if (dy <= tol * dx) out.push({ axis: "y", at: (y0 + y1) / 2, from: Math.min(x0, x1), to: Math.max(x0, x1), kind });
      else if (dx <= tol * dy) out.push({ axis: "x", at: (x0 + x1) / 2, from: Math.min(y0, y1), to: Math.max(y0, y1), kind });
      // diagonal: skipped
    }
  }
  return out;
}

/**
 * The nearest wall line within SNAP_MAX_M, as the signed gap to close
 * (positive = move +x/+y). On a tie the first segment in wall order wins.
 * The room side of each line is the side the room's interior point is on,
 * never the Thing's own centre: a Thing mostly through the wall is pulled
 * back in, not pushed out.
 */
function nearest(fp: ReturnType<typeof footprint>, lines: Line[], inside: { x: number; y: number }) {
  let best: { shift: number; axis: "x" | "y"; side: WallSide; kind: WallKind } | null = null;
  for (const l of lines) {
    const [c, h, lo, hi] = l.axis === "x" ? [fp.cx, fp.hx, fp.cy - fp.hy, fp.cy + fp.hy] : [fp.cy, fp.hy, fp.cx - fp.hx, fp.cx + fp.hx];
    if (l.to < lo - SPAN_TOL_M || l.from > hi + SPAN_TOL_M) continue; // the wall does not reach the Thing
    // gap > 0: open space between edge and wall; gap < 0: the edge is through the wall.
    // An interior point on the line itself (a partition) says nothing: use the Thing's centre.
    const ref = l.axis === "x" ? inside.x : inside.y;
    const roomAfter = Math.abs(ref - l.at) > 1e-6 ? ref > l.at : c >= l.at;
    let gap: number, shift: number, side: WallSide;
    if (roomAfter) {
      gap = c - h - l.at;
      shift = -gap;
      side = l.axis === "x" ? "left" : "top";
    } else {
      gap = l.at - (c + h);
      shift = gap;
      side = l.axis === "x" ? "right" : "bottom";
    }
    if (Math.abs(gap) > SNAP_MAX_M) continue;
    if (!best || Math.abs(shift) < Math.abs(best.shift) - 1e-9) best = { shift, axis: l.axis, side, kind: l.kind };
  }
  return best;
}

/**
 * Moves a Thing so its footprint's nearest edge sits flush against the
 * nearest axis-aligned wall within 0.5 m (pulling it back when a scan put it
 * partly through the wall). Doors and windows count as their wall's line.
 * Only a room without straight wall segments falls back to its outer box.
 * Only xM/yM change. null = no wall within 0.5 m.
 */
export function snapPosToWalls(
  pos: ItemPos,
  walls: RoomGeometry["walls"] | null | undefined,
  widthM: number | null | undefined,
  depthM: number | null | undefined,
): SnapResult | null {
  const fp = footprint(pos);
  const lines = linesOf(walls);
  const hasBox = widthM != null && depthM != null && widthM > 0 && depthM > 0;
  let best: ReturnType<typeof nearest> = null;
  if (lines.length) {
    // the room's interior: the centre of its walls' bounding box (else of its outer box)
    const pts = (walls ?? []).flatMap((w) => w.points ?? []);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const inside = pts.length
      ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
      : { x: (widthM ?? 0) / 2, y: (depthM ?? 0) / 2 };
    best = nearest(fp, lines, inside);
  } else if (hasBox) {
    const box: Line[] = [
      { axis: "x", at: 0, from: 0, to: depthM, kind: "wall" },
      { axis: "x", at: widthM, from: 0, to: depthM, kind: "wall" },
      { axis: "y", at: 0, from: 0, to: widthM, kind: "wall" },
      { axis: "y", at: depthM, from: 0, to: widthM, kind: "wall" },
    ];
    best = nearest(fp, box, { x: widthM / 2, y: depthM / 2 });
  }
  if (!best) return null;
  const next: ItemPos = { ...pos };
  if (best.axis === "x") next.xM = r3(pos.xM + best.shift);
  else next.yM = r3(pos.yM + best.shift);
  return { pos: next, movedM: r2(Math.abs(best.shift)), side: best.side, kind: best.kind };
}
