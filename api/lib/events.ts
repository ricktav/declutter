import { getDb } from "../queries/connection";
import { events } from "@db/schema";

export type Actor = "user" | "ai" | "system";

export async function logEvent(entry: {
  entityType: string;
  entityId?: number;
  action: string;
  summary: string;
  actor?: Actor;
  payload?: Record<string, unknown>;
}) {
  await getDb()
    .insert(events)
    .values({
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      action: entry.action,
      summary: entry.summary,
      actor: entry.actor ?? "user",
      payload: entry.payload ?? null,
    });
}
