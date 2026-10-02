import { getDb } from "../queries/connection";
import { events } from "@db/schema";

export type Actor = "user" | "ai" | "system";

/** Anything with Drizzle's insert(): the root db or a transaction handle. */
export type DbLike = Pick<ReturnType<typeof getDb>, "insert">;

export async function logEvent(
  entry: {
    entityType: string;
    entityId?: number;
    action: string;
    summary: string;
    actor?: Actor;
    payload?: Record<string, unknown>;
  },
  db: DbLike = getDb(),
) {
  await db.insert(events).values({
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    action: entry.action,
    summary: entry.summary,
    actor: entry.actor ?? "user",
    payload: entry.payload ?? null,
  });
}
