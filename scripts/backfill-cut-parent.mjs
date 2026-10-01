// One-off: backfill parentRoomId/offsetXM/offsetYM on rooms cut before those
// columns existed, using the offsets already reverse-derived in
// scripts/fix-cut-walls.mjs.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const db = getDb();
const FIXES = [
  { roomId: 4, parentRoomId: 3, offsetXM: 0.855, offsetYM: 4.492 },
  { roomId: 5, parentRoomId: 3, offsetXM: 5.514, offsetYM: 4.459 },
];
for (const f of FIXES) {
  await db
    .update(schema.rooms)
    .set({ parentRoomId: f.parentRoomId, offsetXM: f.offsetXM, offsetYM: f.offsetYM })
    .where(eq(schema.rooms.id, f.roomId));
  console.log("Backfilled room", f.roomId);
}
process.exit(0);
