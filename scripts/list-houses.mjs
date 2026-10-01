// One-off: list houses with id/name, to pick a target for room-geometry seeding.
import "dotenv/config";
import { getDb } from "../api/queries/connection.ts";
import * as schema from "../db/schema.ts";

const db = getDb();
const rows = await db.select().from(schema.houses);
for (const r of rows) console.log(r.id, r.name);
process.exit(0);
