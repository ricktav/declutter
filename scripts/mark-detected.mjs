// One-off: flip one real item back to "detected" to exercise the room-plan
// confirm/reject panel end-to-end (no real unconfirmed items exist right now).
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const ITEM_ID = Number(process.argv[2]);
await getDb().update(schema.items).set({ verificationStatus: "detected" }).where(eq(schema.items.id, ITEM_ID));
console.log("Marked", ITEM_ID, "as detected");
process.exit(0);
