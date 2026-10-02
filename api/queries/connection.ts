import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { env } from "../lib/env";
import * as schema from "@db/schema";

type Db = MySql2Database<typeof schema>;

let instance: Db | undefined;

export function getDb(): Db {
  if (!instance) {
    instance = drizzle(env.databaseUrl, {
      mode: "default",
      schema,
    });
  }
  return instance;
}

/**
 * Test seam: make every getDb() caller (routers, libs) use the given
 * handle. Only api/test/setup.ts calls this; production code never does.
 */
export function setDbForTests(db: Db): void {
  instance = db;
}
