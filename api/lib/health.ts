import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { uploadsWritable } from "./filestore";

const startedAt = Date.now();
const DB_TIMEOUT_MS = 3000;

export type Health = { ok: boolean; db: boolean; uploadsWritable: boolean; version: string | null; uptimeS: number };

async function dbReachable(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS);
    });
    await Promise.race([getDb().execute(sql`select 1`), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness for launchd and uptime checks. Booleans only: it is served without the app token. */
export async function health(): Promise<Health> {
  const [db, uploads] = await Promise.all([dbReachable(), uploadsWritable()]);
  return {
    ok: db && uploads,
    db,
    uploadsWritable: uploads,
    version: process.env.HOMEBASE_VERSION?.trim() || null,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
  };
}
