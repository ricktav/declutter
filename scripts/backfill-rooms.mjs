// scripts/backfill-rooms.mjs
// Usage: npx tsx scripts/backfill-rooms.mjs   (reads DATABASE_URL from .env)
import "dotenv/config";
import { getDb } from "../api/queries/connection.ts";
import { backfillRooms } from "../api/lib/backfillRooms.ts";

const r = await backfillRooms(getDb());
console.log(r);
process.exit(0);
