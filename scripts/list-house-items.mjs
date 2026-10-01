// One-off: list items for a house, to pick one to place on the seeded
// Kamer 1 room plan for interactive-phase testing.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const HOUSE_ID = Number(process.argv[2] ?? 2);
const db = getDb();
const rows = await db.select().from(schema.items).where(eq(schema.items.houseId, HOUSE_ID));
for (const r of rows) console.log(r.id, "|", r.name, "| room:", r.room, "| roomId:", r.roomId, "| pos:", JSON.stringify(r.pos));
process.exit(0);
