import type { RoomGeometry } from "@db/schema";

type GeojsonFeature = {
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
};
type Geojson = { features: GeojsonFeature[] };

export type FurniturePoly = { kind: string; ring: [number, number][] };

/**
 * Project a MappedIn-style GeoJSON floor export's lon/lat-shaped local
 * coordinates into meters - an equirectangular approximation around the
 * floor's own bounding-box corner (good enough at this scale; precision
 * doesn't matter since the "geo" values were never real GPS). Ported from
 * scripts/import-geojson-floor.mjs so the Inbox preview (src/lib/geojsonFloor.ts)
 * and the actual import land on the same shape.
 */
export function parseGeojsonFloor(geojson: Geojson): {
  walls: RoomGeometry["walls"];
  furniturePolys: FurniturePoly[];
  widthM: number;
  depthM: number;
} | null {
  const allCoords: [number, number][] = [];
  for (const f of geojson.features) {
    if (f.geometry.type === "LineString") allCoords.push(...(f.geometry.coordinates as [number, number][]));
    if (f.geometry.type === "Polygon")
      for (const ring of f.geometry.coordinates as [number, number][][]) allCoords.push(...ring);
  }
  if (allCoords.length === 0) return null;

  const lon0 = Math.min(...allCoords.map((c) => c[0]));
  // North (higher latitude) must land at smaller Y (top of a top-down plan) -
  // project against the MAX latitude, or the floor renders mirrored.
  const latMax = Math.max(...allCoords.map((c) => c[1]));
  const metersPerLat = 111320;
  const metersPerLon = 111320 * Math.cos((latMax * Math.PI) / 180);
  const project = ([lon, lat]: [number, number]): [number, number] => [
    +((lon - lon0) * metersPerLon).toFixed(3),
    +((latMax - lat) * metersPerLat).toFixed(3),
  ];

  const walls: RoomGeometry["walls"] = [];
  const furniturePolys: FurniturePoly[] = [];
  for (const f of geojson.features) {
    if (f.geometry.type === "LineString") {
      const kindRaw = f.properties.kind;
      const kind = kindRaw === "Door" ? "door" : kindRaw === "Window" ? "window" : "wall";
      walls.push({ points: (f.geometry.coordinates as [number, number][]).map(project), kind });
    } else if (f.geometry.type === "Polygon") {
      furniturePolys.push({
        kind: String(f.properties.kind ?? ""),
        ring: (f.geometry.coordinates as [number, number][][])[0].map(project),
      });
    }
  }
  if (walls.length === 0) return null;

  const wallPoints = walls.flatMap((w) => w.points);
  const widthM = +Math.max(...wallPoints.map((p) => p[0])).toFixed(2);
  const depthM = +Math.max(...wallPoints.map((p) => p[1])).toFixed(2);
  return { walls, furniturePolys, widthM, depthM };
}

/** kind -> {topic slug, display name, rough height estimate in meters} */
export const FURNITURE_KIND_MAP: Record<string, { topic: string; label: string; hM?: number }> = {
  stove: { topic: "appliances", label: "Stove", hM: 0.9 },
  oven: { topic: "appliances", label: "Oven", hM: 0.6 },
  sink: { topic: "appliances", label: "Sink", hM: 0.85 },
  toilet: { topic: "appliances", label: "Toilet", hM: 0.4 },
  television: { topic: "electronics", label: "Television", hM: 0.6 },
  chair: { topic: "furniture", label: "Chair", hM: 0.9 },
  table: { topic: "furniture", label: "Table", hM: 0.75 },
  sofa: { topic: "furniture", label: "Sofa", hM: 0.85 },
  storage: { topic: "furniture", label: "Storage", hM: 1.2 },
  stairs: { topic: "furniture", label: "Stairs", hM: 0 },
};
