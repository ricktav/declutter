// One-off: delete a room and its placed items, to redo an import with a
// corrected projection. Only safe while nothing in it has been reviewed.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const ROOM_ID = Number(process.argv[2]);
const db = getDb();
const deleted = await db.delete(schema.items).where(eq(schema.items.roomId, ROOM_ID));
await db.delete(schema.rooms).where(eq(schema.rooms.id, ROOM_ID));
console.log("Deleted room", ROOM_ID, "and its items");
process.exit(0);
