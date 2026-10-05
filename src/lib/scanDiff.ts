import type { ItemPos, RoomScanChange } from "@db/schema";

/** One Thing change of a scan, with the Thing's current name and status (rooms.scanDiff). */
export type ScanDiffChange = RoomScanChange & { name: string; status: string };

/** The centre of a footprint, "x, y" in metres. */
export const footprintCentre = (p: ItemPos) =>
  `${(Math.max(0, p.xM) + p.wM / 2).toFixed(2)}, ${(Math.max(0, p.yM) + p.dM / 2).toFixed(2)}`;

const distance = (a: ItemPos, b: ItemPos) =>
  Math.hypot(a.xM + a.wM / 2 - (b.xM + b.wM / 2), a.yM + a.dM / 2 - (b.yM + b.dM / 2));

/** One-line label for a moved Thing, used on the plan's arrow. */
export function moveLabel(c: ScanDiffChange) {
  if (!c.posBefore || !c.posAfter) return c.name;
  return `${c.name}: ${footprintCentre(c.posBefore)} → ${footprintCentre(c.posAfter)} m (${distance(c.posBefore, c.posAfter).toFixed(2)} m)`;
}
