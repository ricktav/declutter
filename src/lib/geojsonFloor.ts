import { parseGeojsonFloor } from "../../api/lib/geojsonFloor";

export type GeojsonWall = { points: [number, number][]; kind: "wall" | "door" | "window" };

/** A capture's `kind` is "scan" only when it came in through the Telegram
 * bot's extension-sniffing; the web inbox upload path tags everything
 * non-image as generic "file" regardless of extension - so also recognize
 * a geojson by its stored filename, or a thumbnail never renders for one
 * uploaded through the web form. */
export function isGeojsonFile(storageKey: string | null | undefined): boolean {
  return !!storageKey && /\.(geo)?json$/i.test(storageKey);
}

/**
 * Same parse as inbox.importGeojson (`api/lib/geojsonFloor.ts`): MappedIn
 * lon/lat projection, or homebase-scan/1 metres. Preview shows walls and
 * opening segments; room / object / photo features stay off the thumbnail.
 */
export function projectGeojsonFloor(geojson: {
  features: { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[];
  format?: unknown;
  properties?: Record<string, unknown>;
}): { walls: GeojsonWall[]; widthM: number; depthM: number } | null {
  const parsed = parseGeojsonFloor(geojson);
  if (!parsed) return null;
  return {
    walls: parsed.walls.map((w) => ({ points: w.points, kind: w.kind ?? "wall" })),
    widthM: parsed.widthM,
    depthM: parsed.depthM,
  };
}
