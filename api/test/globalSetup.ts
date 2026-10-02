import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { requireTestDatabaseUrl } from "./db";

/**
 * Runs once before the whole suite: brings the test database up to the
 * committed migrations in db/migrations. Unconditional on every run, so
 * a hand-edited or half-migrated test DB fails here, not in a test.
 */
export default async function globalSetup() {
  const pool = mysql.createPool({ uri: requireTestDatabaseUrl(), connectionLimit: 1 });
  try {
    await migrate(drizzle(pool, { mode: "default" }), { migrationsFolder: "./db/migrations" });
  } finally {
    await pool.end();
  }
}
