// api/lib/backfillRooms.ts
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { attachments, items, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * One-shot, idempotent: turn every free-text (houseId, floor, room) tuple on
 * items and attachments into a rooms row and link by roomId. Safe to re-run;
 * does nothing once every string has a room.
 *
 * Rules
 *  - match an existing room in the same house by name, case-insensitively
 *  - an item that already has a roomId keeps it (scan geometry is truth);
 *    its strings only contribute a floor to that room if the room has none
 *  - a room created here is source "manual", floor from the first item
 *  - rows with no house, or no room text, are left alone
 */
export async function backfillRooms(db: Db) {
  const result = { roomsCreated: 0, itemsLinked: 0, attachmentsLinked: 0, floorsSet: 0 };

  const existing = await db.select().from(rooms);
  const byKey = new Map<string, { id: number; floor: string | null }>();
  for (const r of existing) byKey.set(`${r.houseId}|${norm(r.name)}`, { id: r.id, floor: r.floor });

  async function roomFor(houseId: number, name: string, floor: string | null): Promise<number> {
    const key = `${houseId}|${norm(name)}`;
    const hit = byKey.get(key);
    if (hit) {
      if (!hit.floor && floor) {
        await db.update(rooms).set({ floor }).where(eq(rooms.id, hit.id));
        hit.floor = floor;
        result.floorsSet++;
      }
      return hit.id;
    }
    const [{ id }] = await db
      .insert(rooms)
      .values({ houseId, name: name.trim(), floor: floor || null, source: "manual" })
      .$returningId();
    byKey.set(key, { id, floor: floor || null });
    result.roomsCreated++;
    return id;
  }

  // 1. items that already sit in a room: only donate a floor
  const placed = await db
    .select({ roomId: items.roomId, floor: items.floor })
    .from(items)
    .where(and(isNotNull(items.roomId), isNotNull(items.floor)));
  for (const p of placed) {
    const room = existing.find((r) => r.id === p.roomId);
    const entry = room ? byKey.get(`${room.houseId}|${norm(room.name)}`) : undefined;
    if (room && entry && !entry.floor && p.floor) {
      await db.update(rooms).set({ floor: p.floor }).where(eq(rooms.id, room.id));
      entry.floor = p.floor;
      result.floorsSet++;
    }
  }

  // 2. items with room text but no roomId
  const unplaced = await db
    .select({ id: items.id, houseId: items.houseId, floor: items.floor, room: items.room })
    .from(items)
    .where(and(isNull(items.roomId), isNotNull(items.houseId), isNotNull(items.room)));
  for (const it of unplaced) {
    if (!it.room?.trim() || it.houseId == null) continue;
    const roomId = await roomFor(it.houseId, it.room, it.floor);
    await db.update(items).set({ roomId }).where(eq(items.id, it.id));
    result.itemsLinked++;
  }

  // 3. location photos
  const photos = await db
    .select({ id: attachments.id, houseId: attachments.houseId, floor: attachments.floor, room: attachments.room })
    .from(attachments)
    .where(and(isNull(attachments.roomId), isNotNull(attachments.houseId), isNotNull(attachments.room)));
  for (const a of photos) {
    if (!a.room?.trim() || a.houseId == null) continue;
    const roomId = await roomFor(a.houseId, a.room, a.floor);
    await db.update(attachments).set({ roomId }).where(eq(attachments.id, a.id));
    result.attachmentsLinked++;
  }

  // 4. invariant: houseId follows the room
  await db.execute(sql`update items i join rooms r on r.id = i.roomId set i.houseId = r.houseId where i.houseId <> r.houseId or i.houseId is null`);

  return result;
}
