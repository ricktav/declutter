// One-off: place one real item on the seeded Kamer 1 room plan, so phase
// 4b (drag/rotate/resize) has something real to interact with.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const ITEM_ID = 30; // Purple suede reclining sofa
const ROOM_ID = 1; // Kamer 1 (LiDAR scan)

const db = getDb();
await db
  .update(schema.items)
  .set({
    roomId: ROOM_ID,
    pos: { xM: 0.5, yM: 0.5, wM: 2.2, dM: 0.95, rotDeg: 0 },
  })
  .where(eq(schema.items.id, ITEM_ID));
console.log("Placed item", ITEM_ID, "in room", ROOM_ID);
process.exit(0);
