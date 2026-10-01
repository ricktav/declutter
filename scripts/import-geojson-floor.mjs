// One-off: import a MappedIn-style GeoJSON floor export (sent via Telegram,
// saved to uploads/) into the rooms table as one room covering the whole
// floor, plus a detected item per furniture/fixture polygon. The file's
// coordinates are MappedIn's own local lon/lat-shaped container, not real
// GPS - projected to meters here via a simple equirectangular approximation
// around the floor's own bounding-box corner (good enough at this scale;
// precision doesn't matter since the "geo" values were never real GPS).
import "dotenv/config";
import fs from "node:fs";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const FILE = process.argv[2];
const HOUSE_ID = Number(process.argv[3] ?? 2);
const ROOM_NAME = process.argv[4] ?? "Begane grond";

if (!FILE) {
  console.error("Usage: import-geojson-floor.mjs <path-to-geojson> [houseId] [roomName]");
  process.exit(1);
}

const geojson = JSON.parse(fs.readFileSync(FILE, "utf8"));
const allCoords = [];
for (const f of geojson.features) {
  if (f.geometry.type === "LineString") allCoords.push(...f.geometry.coordinates);
  if (f.geometry.type === "Polygon") for (const ring of f.geometry.coordinates) allCoords.push(...ring);
}
const lon0 = Math.min(...allCoords.map((c) => c[0]));
// North (higher latitude) must land at smaller Y (top of a top-down plan,
// matching the "up = north" convention) - project against the MAX latitude,
// not the min, or the whole floor renders mirrored across a horizontal axis.
const latMax = Math.max(...allCoords.map((c) => c[1]));
const metersPerLat = 111320;
const metersPerLon = 111320 * Math.cos((latMax * Math.PI) / 180);
const project = ([lon, lat]) => [+((lon - lon0) * metersPerLon).toFixed(3), +((latMax - lat) * metersPerLat).toFixed(3)];

const walls = [];
const furniturePolys = [];
for (const f of geojson.features) {
  if (f.geometry.type === "LineString") {
    const kindRaw = f.properties.kind;
    const kind = kindRaw === "Door" ? "door" : kindRaw === "Window" ? "window" : "wall";
    walls.push({ points: f.geometry.coordinates.map(project), kind });
  } else if (f.geometry.type === "Polygon") {
    furniturePolys.push({ kind: f.properties.kind, ring: f.geometry.coordinates[0].map(project) });
  }
}

const wallPoints = walls.flatMap((w) => w.points);
const widthM = +(Math.max(...wallPoints.map((p) => p[0])).toFixed(2));
const depthM = +(Math.max(...wallPoints.map((p) => p[1])).toFixed(2));

const db = getDb();
const [{ id: roomId }] = await db
  .insert(schema.rooms)
  .values({
    houseId: HOUSE_ID,
    name: ROOM_NAME,
    source: "mappedin",
    scanDate: new Date(),
    widthM,
    depthM,
    walls,
    openings: [],
  })
  .$returningId();
console.log(`Created room ${roomId} "${ROOM_NAME}" (${widthM}×${depthM} m), ${walls.length} wall segments`);

// kind -> {topic slug, display name, rough height estimate in meters}
const KIND_MAP = {
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

const areaRows = await db.select().from(schema.areas);
const areaBySlug = new Map(areaRows.map((a) => [a.slug, a.id]));

const nameCounts = {};
let created = 0;
for (const poly of furniturePolys) {
  const meta = KIND_MAP[poly.kind] ?? { topic: "furniture", label: poly.kind, hM: undefined };
  const areaId = areaBySlug.get(meta.topic);
  if (!areaId) {
    console.warn("No area for topic", meta.topic, "- skipping", poly.kind);
    continue;
  }
  nameCounts[meta.label] = (nameCounts[meta.label] ?? 0) + 1;
  const n = nameCounts[meta.label];
  const name = n > 1 ? `${meta.label} ${n}` : meta.label;

  const xs = poly.ring.map((p) => p[0]), ys = poly.ring.map((p) => p[1]);
  const xM = +Math.min(...xs).toFixed(2), yM = +Math.min(...ys).toFixed(2);
  const wM = +(Math.max(...xs) - Math.min(...xs)).toFixed(2);
  const dM = +(Math.max(...ys) - Math.min(...ys)).toFixed(2);

  await db.insert(schema.items).values({
    areaId,
    houseId: HOUSE_ID,
    roomId,
    name,
    status: "active",
    verificationStatus: "detected",
    pos: { xM, yM, wM: Math.max(0.1, wM), dM: Math.max(0.1, dM), rotDeg: 0, ...(meta.hM != null ? { hM: meta.hM } : {}) },
    room: ROOM_NAME,
    description: `Auto-detected from the ${ROOM_NAME} floor scan (MappedIn export) - not yet reviewed.`,
  });
  created++;
}
console.log(`Created ${created} detected items from ${furniturePolys.length} furniture polygons`);
process.exit(0);
