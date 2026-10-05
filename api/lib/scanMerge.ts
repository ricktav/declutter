import { FURNITURE_KIND_MAP } from "./geojsonFloor";

/** An active Thing in the rescanned room. `scanKind` is its `scan_kind`
 * attribute (null for hand-placed Things and for Things a scan created
 * before that key existed). */
export type ScanCandidate = {
  id: number;
  name: string;
  scanKind: string | null;
  pos: { xM: number; yM: number; wM: number; dM: number } | null;
};

/** One furniture polygon of the new scan: its bounding box in metres, in the
 * room frame, plus the exporter's kind and the display label for that kind. */
export type ScanPoly = {
  kind: string;
  label: string;
  xM: number;
  yM: number;
  wM: number;
  dM: number;
  /** rotation about the footprint centre (a RoomPlan object); absent for GeoJSON polygons */
  rotDeg?: number;
  /** measured height (a RoomPlan object); absent = the kind's estimate */
  hM?: number;
};

/** A Thing counts as the same Thing when its footprint centre moved at most
 * this far (or half its diagonal, for big things like a sofa or table). */
export const MATCH_TOLERANCE_M = 0.75;

type Box = { xM: number; yM: number; wM: number; dM: number };

const centre = (b: Box): [number, number] => [b.xM + b.wM / 2, b.yM + b.dM / 2];
const diagonal = (b: Box): number => Math.hypot(b.wM, b.dM);
/** "Chair 2" -> "chair": the name a scan import gave it, without the counter. */
const baseName = (name: string): string => name.trim().replace(/\s+\d+$/, "").toLowerCase();

const SCAN_LABELS = new Set(Object.values(FURNITURE_KIND_MAP).map((m) => m.label.toLowerCase()));

/**
 * Decide which existing Thing each polygon of a rescan is.
 *
 * A Thing is eligible for a polygon when its `scan_kind` equals the polygon's
 * kind, or - for Things created by a scan before `scan_kind` existed - when it
 * has no `scan_kind` and its name without a trailing counter equals the
 * polygon's label. The pair must also be close: centre distance at most
 * max(MATCH_TOLERANCE_M, half the larger diagonal). All eligible pairs are
 * taken greedily, nearest first, so each Thing and each polygon is used once;
 * augmenting paths then pair any Thing greedy left out when that is possible.
 *
 * Missing = a Thing with a position that came from a scan (a `scan_kind`, or
 * a legacy scan name) and that no polygon matched. Hand-placed Things never go
 * missing: a scan does not know about them.
 */
export function matchScanItems(
  existing: ScanCandidate[],
  polys: ScanPoly[],
): {
  matched: Array<{ itemId: number; poly: ScanPoly; movedM: number }>;
  unmatchedPolys: ScanPoly[];
  missingItemIds: number[];
} {
  const placed = existing.filter((c): c is ScanCandidate & { pos: Box } => c.pos != null);
  const pairs: Array<{ ci: number; pi: number; d: number }> = [];
  placed.forEach((c, ci) => {
    const cName = baseName(c.name);
    const [cx, cy] = centre(c.pos);
    polys.forEach((p, pi) => {
      const sameKind = c.scanKind != null ? c.scanKind === p.kind : cName === p.label.trim().toLowerCase();
      if (!sameKind) return;
      const [px, py] = centre(p);
      const d = Math.hypot(px - cx, py - cy);
      const limit = Math.max(MATCH_TOLERANCE_M, 0.5 * Math.max(diagonal(c.pos), diagonal(p)));
      if (d <= limit) pairs.push({ ci, pi, d });
    });
  });
  // nearest first (to the millimetre, ties broken by input order so the
  // result is deterministic)
  for (const pr of pairs) pr.d = +pr.d.toFixed(3);
  pairs.sort((a, b) => a.d - b.d || a.ci - b.ci || a.pi - b.pi);

  const polyOf = new Map<number, number>(); // candidate index -> poly index
  const candOf = new Map<number, number>(); // poly index -> candidate index
  for (const { ci, pi } of pairs) {
    if (polyOf.has(ci) || candOf.has(pi)) continue;
    polyOf.set(ci, pi);
    candOf.set(pi, ci);
  }

  // Greedy alone can strand a Thing: two chairs that both moved 0.3 m to the
  // right, where the right chair's old spot is nearest to the left chair's
  // new one. Repair with augmenting paths (each step re-pairs within the
  // tolerance), so a Thing is only "missing" when no full assignment exists.
  const edges = new Map<number, Array<{ pi: number; d: number }>>();
  for (const { ci, pi, d } of pairs) {
    if (!edges.has(ci)) edges.set(ci, []);
    edges.get(ci)!.push({ pi, d });
  }
  const augment = (ci: number, seen: Set<number>): boolean => {
    for (const { pi } of edges.get(ci) ?? []) {
      if (seen.has(pi)) continue;
      seen.add(pi);
      const other = candOf.get(pi);
      if (other == null || augment(other, seen)) {
        polyOf.set(ci, pi);
        candOf.set(pi, ci);
        return true;
      }
    }
    return false;
  };
  for (const ci of edges.keys()) if (!polyOf.has(ci)) augment(ci, new Set());

  const dist = new Map(pairs.map((p) => [`${p.ci}:${p.pi}`, p.d]));
  const matched = [...polyOf.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ci, pi]) => ({ itemId: placed[ci].id, poly: polys[pi], movedM: dist.get(`${ci}:${pi}`)! }));
  const usedC = new Set(polyOf.keys());
  const usedP = new Set(candOf.keys());

  const unmatchedPolys = polys.filter((_, pi) => !usedP.has(pi));
  const missingItemIds = placed
    .filter((c, ci) => !usedC.has(ci) && (c.scanKind != null || SCAN_LABELS.has(baseName(c.name))))
    .map((c) => c.id);
  return { matched, unmatchedPolys, missingItemIds };
}
