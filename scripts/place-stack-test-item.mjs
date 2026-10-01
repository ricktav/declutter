// One-off: place a second real item (small speaker) with its center inside
// the sofa's footprint, to exercise stacking (phase 4c) against real data.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const ITEM_ID = 40; // Harman Kardon Onyx Studio bluetooth speaker
const ROOM_ID = 1; // Kamer 1 (LiDAR scan)

const db = getDb();
await db
  .update(schema.items)
  .set({
    roomId: ROOM_ID,
    pos: { xM: 2.0, yM: 2.2, wM: 0.2, dM: 0.2, rotDeg: 0 },
  })
  .where(eq(schema.items.id, ITEM_ID));
console.log("Placed item", ITEM_ID, "in room", ROOM_ID);
process.exit(0);
