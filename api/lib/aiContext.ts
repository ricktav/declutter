import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { captures, items, photos, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;
type ItemRow = typeof items.$inferSelect;

/** Where a prompt's candidate Things come from: one house (null = all), its room listed first. */
export type PromptScope = { houseId: number | null; roomId: number | null };

export const PROMPT_ITEM_LIMIT = 200;

async function roomHouse(db: Db, roomId: number | null): Promise<number | null> {
  if (roomId == null) return null;
  const [r] = await db.select({ houseId: rooms.houseId }).from(rooms).where(eq(rooms.id, roomId));
  return r?.houseId ?? null;
}

/** A capture's scope: the room of its location Photo, else the house stamped on it, else the session house. */
export async function captureScope(db: Db, cap: typeof captures.$inferSelect, sessionHouseId: number | null): Promise<PromptScope> {
  const [loc] = await db
    .select({ roomId: photos.roomId })
    .from(photos)
    .where(and(eq(photos.sourceCaptureId, cap.id), isNull(photos.itemId)))
    .orderBy(asc(photos.id))
    .limit(1);
  const roomId = loc?.roomId ?? null;
  return { houseId: (await roomHouse(db, roomId)) ?? cap.houseId ?? sessionHouseId, roomId };
}

/** A Photo's scope: its own room, else its Thing's house, else the session house. */
export async function photoScope(db: Db, photo: typeof photos.$inferSelect, sessionHouseId: number | null): Promise<PromptScope> {
  const roomId = photo.roomId ?? null;
  let houseId = await roomHouse(db, roomId);
  if (houseId == null && photo.itemId != null) {
    const [it] = await db.select({ houseId: items.houseId }).from(items).where(eq(items.id, photo.itemId));
    houseId = it?.houseId ?? null;
  }
  return { houseId: houseId ?? sessionHouseId, roomId };
}

/**
 * The Things a prompt may match against: active, not rejected, in the scope's
 * house, the scope's room first, then most recently changed.
 */
export async function promptInventory(db: Db, scope: PromptScope, limit = PROMPT_ITEM_LIMIT): Promise<ItemRow[]> {
  return db
    .select()
    .from(items)
    .where(
      and(
        eq(items.status, "active"),
        ne(items.verificationStatus, "rejected"),
        scope.houseId != null ? eq(items.houseId, scope.houseId) : undefined,
      ),
    )
    .orderBy(
      ...(scope.roomId != null ? [desc(sql`(${items.roomId} = ${scope.roomId})`)] : []),
      desc(items.updatedAt),
    )
    .limit(limit);
}
