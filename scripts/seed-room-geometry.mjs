// One-off: seed real LiDAR room geometry (Kamer 1, from the lidarventory MVP's
// data/inventory.json "r-scan-001") into our rooms table, via the same
// upsert-by-houseId+name semantics as api/routers/rooms.ts#upsertFromScan.
// Geometry only - no items - so the 2D plan has something real to render
// against without injecting synthetic inventory into a real house.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const HOUSE_ID = 2; // Thuis RT
const NAME = "Kamer 1 (LiDAR scan)";

// Rectangle outline from the scan's width/depth; door opening laser-measured
// (see lidarventory home-inventory-feature-backlog.md). Window isn't part of
// our RoomGeometry schema yet - skipped for this seed.
const widthM = 4.03;
const depthM = 3.87;
const wallHeightM = 2.27;
const walls = [
  { points: [[0, 0], [widthM, 0]] },
  { points: [[widthM, 0], [widthM, depthM]] },
  { points: [[widthM, depthM], [0, depthM]] },
  { points: [[0, depthM], [0, 0]] },
];
const openings = [{ edge: "bottom", offsetM: 0.995, widthM: 2.366 }];

const db = getDb();
const existing = await db.query.rooms.findFirst({
  where: eq(schema.rooms.houseId, HOUSE_ID),
});
const match = existing?.name === NAME ? existing : undefined;

const values = {
  houseId: HOUSE_ID,
  name: NAME,
  source: "roomplan",
  scanDate: new Date("2026-09-22"),
  widthM,
  depthM,
  wallHeightM,
  walls,
  openings,
};

if (match) {
  await db.update(schema.rooms).set(values).where(eq(schema.rooms.id, match.id));
  console.log("Updated room", match.id);
} else {
  const [{ id }] = await db.insert(schema.rooms).values(values).$returningId();
  console.log("Created room", id);
}
process.exit(0);
