// api/lib/location.ts
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { items, rooms } from "@db/schema";
import type { getDb } from "../queries/connection";
import type { DbLike } from "./events";

type Db = ReturnType<typeof getDb>;
/** root db or a transaction handle: anything with the query builders we use */
export type LocDb = Pick<Db, "select" | "insert" | "update" | "query"> & DbLike;

/** Find-or-create a room in a house by name, case- and whitespace-insensitively. */
export async function ensureRoom(
  db: LocDb,
  input: { houseId: number; name: string; floor?: string | null },
): Promise<{ id: number; created: boolean }> {
  const name = input.name.trim();
  if (!name) throw new Error("A room needs a name.");
  const existing = await db
    .select({ id: rooms.id, floor: rooms.floor })
    .from(rooms)
    .where(and(eq(rooms.houseId, input.houseId), sql`lower(${rooms.name}) = ${name.toLowerCase()}`))
    .limit(1);
  if (existing[0]) {
    if (!existing[0].floor && input.floor) {
      await db.update(rooms).set({ floor: input.floor }).where(eq(rooms.id, existing[0].id));
    }
    return { id: existing[0].id, created: false };
  }
  const [{ id }] = await db
    .insert(rooms)
    .values({ houseId: input.houseId, name, floor: input.floor || null, source: "manual" })
    .$returningId();
  return { id, created: true };
}

/**
 * The only writer of items.roomId / items.houseId. Keeps the invariant:
 * in a room => houseId is that room's house; no room => houseId as given.
 */
export async function setItemLocation(
  db: LocDb,
  itemId: number,
  loc: { roomId: number } | { roomId: null; houseId: number | null },
): Promise<void> {
  if (loc.roomId != null) {
    const [room] = await db.select({ houseId: rooms.houseId }).from(rooms).where(eq(rooms.id, loc.roomId)).limit(1);
    if (!room) throw new Error(`Room #${loc.roomId} does not exist.`);
    await db.update(items).set({ roomId: loc.roomId, houseId: room.houseId }).where(eq(items.id, itemId));
    return;
  }
  await db.update(items).set({ roomId: null, houseId: loc.houseId }).where(eq(items.id, itemId));
}

export interface RoomSummary {
  id: number;
  name: string;
  floor: string | null;
  houseId: number;
  hasGeometry: boolean;
}

/** Small lookup used by list endpoints to attach room info to rows. */
export async function roomSummary(db: LocDb, roomIds: number[]): Promise<Map<number, RoomSummary>> {
  const ids = [...new Set(roomIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: rooms.id, name: rooms.name, floor: rooms.floor, houseId: rooms.houseId, hasGeometry: isNotNull(rooms.walls) })
    .from(rooms)
    .where(inArray(rooms.id, ids));
  return new Map(rows.map((r) => [r.id, { ...r, hasGeometry: !!r.hasGeometry }]));
}
