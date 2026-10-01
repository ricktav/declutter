// One-off: recompute walls for rooms that were cut before the wall-clipping
// fix (they used an all-or-nothing filter, dropping whole-floor walls that
// crossed the cut boundary instead of truncating them). Items/positions in
// these rooms are untouched by this bug and are left exactly as they are -
// only the `walls` column is recomputed, using the cut's original offset
// derived from a known item's true position (see conversation for how
// bx/by were reverse-engineered from the source GeoJSON).
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

function clipSegmentToBox([x0, y0], [x1, y1], xmin, xmax, ymin, ymax) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const checks = [[-dx, x0 - xmin], [dx, xmax - x0], [-dy, y0 - ymin], [dy, ymax - y0]];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  if (t0 >= t1) return null;
  return [[x0 + t0 * dx, y0 + t0 * dy], [x0 + t1 * dx, y0 + t1 * dy]];
}

function cutWallsFrom(sourceWalls, bx, by, bw, bd) {
  const out = [];
  for (const w of sourceWalls) {
    for (let i = 0; i < w.points.length - 1; i++) {
      const clipped = clipSegmentToBox(w.points[i], w.points[i + 1], bx, bx + bw, by, by + bd);
      if (!clipped) continue;
      out.push({ kind: w.kind, points: clipped.map(([x, y]) => [+(x - bx).toFixed(3), +(y - by).toFixed(3)]) });
    }
  }
  return out;
}

const db = getDb();
const source = await db.query.rooms.findFirst({ where: eq(schema.rooms.id, 3) }); // Begane grond
const sourceWalls = source.walls ?? [];

const FIXES = [
  { roomId: 4, name: "WC", bx: 0.855, by: 4.492, bw: 2.32, bd: 1.58 },
  { roomId: 5, name: "Woonkamer", bx: 5.514, by: 4.459, bw: 6.68, bd: 7.45 },
];

for (const f of FIXES) {
  const walls = cutWallsFrom(sourceWalls, f.bx, f.by, f.bw, f.bd);
  await db.update(schema.rooms).set({ walls }).where(eq(schema.rooms.id, f.roomId));
  console.log(`Updated ${f.name} (room ${f.roomId}): ${walls.length} wall segments`);
}
process.exit(0);
