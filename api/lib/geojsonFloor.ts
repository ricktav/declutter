import type { RoomGeometry } from "@db/schema";

type GeojsonFeature = {
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
};
type Geojson = {
  features: GeojsonFeature[];
  format?: unknown;
  properties?: Record<string, unknown>;
};

export type FurniturePoly = {
  kind: string;
  ring: [number, number][];
  /** Explicit footprint from homebase-scan/1; absent = bbox of `ring`. */
  xM?: number;
  yM?: number;
  wM?: number;
  dM?: number;
  hM?: number;
  rotDeg?: number;
};

export type ScanPhotoPoint = { xM: number; yM: number; properties: Record<string, unknown> };

export const HOMEBASE_SCAN_FORMAT = "homebase-scan/1";

/**
 * Project a MappedIn-style GeoJSON floor export's lon/lat-shaped local
 * coordinates into meters - an equirectangular approximation around the
 * floor's own bounding-box corner (good enough at this scale; precision
 * doesn't matter since the "geo" values were never real GPS). Ported from
 * scripts/import-geojson-floor.mjs so the Inbox preview (src/lib/geojsonFloor.ts)
 * and the actual import land on the same shape.
 *
 * `homebase-scan/1` (FeatureCollection.properties.format, or any feature
 * with properties.featureType) is already in room-frame metres: room
 * polygons are the floor outline (not furniture), wall LineStrings are
 * walls, opening LineStrings are door/window/opening segments, object
 * Polygons are furniture, photo Points are ignored for the plan.
 */
export function parseGeojsonFloor(geojson: Geojson): {
  walls: RoomGeometry["walls"];
  furniturePolys: FurniturePoly[];
  widthM: number;
  depthM: number;
  photos: ScanPhotoPoint[];
} | null {
  if (!geojson?.features?.length) return null;
  if (isHomebaseScan(geojson)) return parseHomebaseScan(geojson);
  return parseMappedInFloor(geojson);
}

export function isHomebaseScan(geojson: Geojson): boolean {
  const format = geojson.format ?? geojson.properties?.format;
  if (format === HOMEBASE_SCAN_FORMAT) return true;
  return geojson.features.some((f) => {
    const t = f.properties?.featureType;
    return t != null && String(t).trim() !== "";
  });
}

function parseMappedInFloor(geojson: Geojson): {
  walls: RoomGeometry["walls"];
  furniturePolys: FurniturePoly[];
  widthM: number;
  depthM: number;
  photos: ScanPhotoPoint[];
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
  return { walls, furniturePolys, widthM, depthM, photos: [] };
}

function parseHomebaseScan(geojson: Geojson): {
  walls: RoomGeometry["walls"];
  furniturePolys: FurniturePoly[];
  widthM: number;
  depthM: number;
  photos: ScanPhotoPoint[];
} | null {
  const walls: RoomGeometry["walls"] = [];
  const furniturePolys: FurniturePoly[] = [];
  const photos: ScanPhotoPoint[] = [];
  const roomRings: [number, number][][] = [];

  for (const f of geojson.features) {
    const ft = String(f.properties?.featureType ?? "").trim().toLowerCase();
    const geom = f.geometry;
    if (ft === "photo" || geom.type === "Point") {
      if (geom.type === "Point") {
        const c = geom.coordinates as [number, number];
        if (Array.isArray(c) && c.length >= 2) photos.push({ xM: c[0], yM: c[1], properties: f.properties ?? {} });
      }
      continue;
    }
    if (ft === "wall" && geom.type === "LineString") {
      const pts = asLine(geom.coordinates);
      if (pts) walls.push({ points: pts, kind: "wall" });
      continue;
    }
    if (ft === "opening" && geom.type === "LineString") {
      const pts = asLine(geom.coordinates);
      if (pts) walls.push({ points: pts, kind: openingWallKind(f.properties?.kind) });
      continue;
    }
    if (ft === "room" && geom.type === "Polygon") {
      const ring = asRing(geom.coordinates);
      if (ring) roomRings.push(ring);
      continue;
    }
    if (ft === "object" && geom.type === "Polygon") {
      const ring = asRing(geom.coordinates) ?? [];
      furniturePolys.push({
        kind: objectKind(f.properties),
        ring,
        ...objectDims(f.properties),
      });
    }
  }

  if (walls.length === 0 && roomRings.length > 0) {
    walls.push({ points: roomRings[0], kind: "wall" });
  }
  if (walls.length === 0) return null;

  const planPts = [
    ...walls.flatMap((w) => w.points),
    ...roomRings.flat(),
    ...furniturePolys.flatMap((p) => p.ring),
    ...photos.map((p) => [p.xM, p.yM] as [number, number]),
  ];
  const originX = Math.min(...planPts.map((p) => p[0]));
  const originY = Math.min(...planPts.map((p) => p[1]));
  const shift = (pts: [number, number][]): [number, number][] =>
    pts.map(([x, y]) => [+(x - originX).toFixed(3), +(y - originY).toFixed(3)]);

  for (const w of walls) w.points = shift(w.points);
  for (const ring of roomRings) {
    const moved = shift(ring);
    ring.splice(0, ring.length, ...moved);
  }
  for (const poly of furniturePolys) {
    poly.ring = shift(poly.ring);
    if (poly.xM != null) poly.xM = +(poly.xM - originX).toFixed(2);
    if (poly.yM != null) poly.yM = +(poly.yM - originY).toFixed(2);
  }
  for (const p of photos) {
    p.xM = +(p.xM - originX).toFixed(3);
    p.yM = +(p.yM - originY).toFixed(3);
  }

  const sizePts = [...walls.flatMap((w) => w.points), ...roomRings.flat()];
  const widthM = +Math.max(...sizePts.map((p) => p[0])).toFixed(2);
  const depthM = +Math.max(...sizePts.map((p) => p[1])).toFixed(2);
  return { walls, furniturePolys, widthM, depthM, photos };
}

function asLine(coordinates: unknown): [number, number][] | null {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const pts = coordinates.filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2);
  return pts.length >= 2 ? pts.map(([x, y]) => [Number(x), Number(y)] as [number, number]) : null;
}

function asRing(coordinates: unknown): [number, number][] | null {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
  return asLine(coordinates[0]);
}

function openingWallKind(raw: unknown): "door" | "window" {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "window" ? "window" : "door";
}

function objectKind(props: Record<string, unknown> | undefined): string {
  const v = props?.kind ?? props?.category ?? props?.scan_kind ?? "";
  return String(v);
}

function objectDims(props: Record<string, unknown> | undefined): Partial<FurniturePoly> {
  const num = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = props?.[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
    }
    return undefined;
  };
  const out: Partial<FurniturePoly> = {};
  const xM = num(["xM", "x"]);
  const yM = num(["yM", "y"]);
  const wM = num(["wM", "widthM", "width"]);
  const dM = num(["dM", "depthM", "depth"]);
  const hM = num(["hM", "heightM", "height"]);
  const rotDeg = num(["rotDeg", "rotation"]);
  if (xM != null) out.xM = xM;
  if (yM != null) out.yM = yM;
  if (wM != null) out.wM = wM;
  if (dM != null) out.dM = dM;
  if (hM != null) out.hM = hM;
  if (rotDeg != null) out.rotDeg = rotDeg;
  return out;
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
  // RoomPlan categories the MappedIn export does not use
  refrigerator: { topic: "appliances", label: "Fridge", hM: 1.8 },
  bed: { topic: "furniture", label: "Bed", hM: 0.5 },
  washerDryer: { topic: "appliances", label: "Washer", hM: 0.85 },
  bathtub: { topic: "furniture", label: "Bathtub", hM: 0.6 },
  dishwasher: { topic: "appliances", label: "Dishwasher", hM: 0.85 },
  fireplace: { topic: "furniture", label: "Fireplace", hM: 1.0 },
};
