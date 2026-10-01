// One-off: find a real unconfirmed ("detected") item to test the
// room-plan confirm/reject panel against.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const db = getDb();
const rows = await db.select().from(schema.items).where(eq(schema.items.verificationStatus, "detected"));
console.log(rows.length, "detected items");
for (const r of rows.slice(0, 10)) console.log(r.id, r.name, "house:", r.houseId);
process.exit(0);
