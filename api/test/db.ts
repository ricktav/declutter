import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { is, getTableName } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import * as schema from "@db/schema";

/**
 * The test-database seam. Every DB-touching test imports from here.
 *
 *   requireTestDatabaseUrl()  refuses to run against the production DB
 *   getTestDb()               one pool per worker, against TEST_DATABASE_URL
 *   resetTestDb()             truncates every table declared in db/schema.ts
 *   closeTestDb()             ends the pool so vitest can exit
 *
 * `api/test/setup.ts` (a vitest setupFile) also points the app's own
 * getDb() at this database, so router code under test never reaches
 * DATABASE_URL.
 */

type EnvVars = { TEST_DATABASE_URL?: string; DATABASE_URL?: string };

function parse(url: string, label: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL: ${url}`);
  }
}

function sameDatabase(a: URL, b: URL): boolean {
  const port = (u: URL) => u.port || "3306";
  return a.hostname === b.hostname && port(a) === port(b) && a.pathname === b.pathname;
}

export function requireTestDatabaseUrl(vars: EnvVars = process.env as EnvVars): string {
  const testUrl = vars.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at a disposable MySQL database whose name ends in _test, e.g. " +
        "mysql://user:password@host:3306/declutter_test",
    );
  }
  const test = parse(testUrl, "TEST_DATABASE_URL");
  if (vars.DATABASE_URL) {
    const prod = parse(vars.DATABASE_URL, "DATABASE_URL");
    if (sameDatabase(test, prod)) {
      throw new Error(
        "TEST_DATABASE_URL points at the same database as DATABASE_URL. resetTestDb() truncates every " +
          "table and would destroy production data.",
      );
    }
  }
  if (!test.pathname.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL database name must end in _test (got "${test.pathname.slice(1)}"): ` +
        "resetTestDb() truncates every table in it.",
    );
  }
  return testUrl;
}

type TestDb = MySql2Database<typeof schema>;

let pool: mysql.Pool | undefined;
let instance: TestDb | undefined;

export function getTestDb(): TestDb {
  if (instance) return instance;
  const p = mysql.createPool({ uri: requireTestDatabaseUrl(), connectionLimit: 4, multipleStatements: true });
  const db: TestDb = drizzle(p, { mode: "default", schema });
  pool = p;
  instance = db;
  return db;
}

/** Every table exported from db/schema.ts, discovered at call time. */
export function schemaTables(): MySqlTable[] {
  return Object.values(schema as Record<string, unknown>).filter((v): v is MySqlTable => is(v, MySqlTable));
}

/**
 * TRUNCATE the given tables on ONE pooled connection with foreign key checks
 * off, and always switch them back on before that connection returns to the
 * pool: a failing TRUNCATE must not leave FOREIGN_KEY_CHECKS = 0 behind for
 * whichever test borrows the connection next. One round trip for the
 * truncates (multipleStatements is on for this pool only): per-table round
 * trips to a remote DB timed out db.smoke at 20+ tables.
 */
export async function truncateTables(names: string[]): Promise<void> {
  getTestDb();
  const conn = await pool!.getConnection();
  try {
    await conn.query(`SET FOREIGN_KEY_CHECKS = 0; ${names.map((n) => `TRUNCATE TABLE \`${n}\`;`).join(" ")}`);
  } finally {
    try {
      await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    } finally {
      conn.release();
    }
  }
}

export async function resetTestDb(): Promise<void> {
  await truncateTables(schemaTables().map((t) => getTableName(t)));
}

export async function closeTestDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  instance = undefined;
  if (p) await p.end();
}
