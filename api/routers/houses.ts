import { z } from "zod";
import { eq, asc, inArray, or, and, ne } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { houses, items, photos, rooms } from "@db/schema";
import { logEvent } from "../lib/events";
import { setItemLocation } from "../lib/location";

/** Photos of a house: photos in one of its rooms, or on one of its items. */
async function photosOfHouse(db: ReturnType<typeof getDb>, houseId: number) {
  const roomIds = (await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.houseId, houseId))).map((r) => r.id);
  const itemIds = (await db.select({ id: items.id }).from(items).where(eq(items.houseId, houseId))).map((r) => r.id);
  const conds = [
    roomIds.length ? inArray(photos.roomId, roomIds) : undefined,
    itemIds.length ? inArray(photos.itemId, itemIds) : undefined,
  ].filter((c) => c !== undefined);
  if (!conds.length) return [];
  return db.select({ id: photos.id }).from(photos).where(or(...conds));
}

export const housesRouter = createRouter({
  list: procedure.query(async () => {
    const db = getDb();
    const all = await db.select().from(houses).orderBy(asc(houses.name), asc(houses.id));
    const counts = await db.select({ houseId: items.houseId, count: items.id }).from(items);
    const countMap = new Map<number, number>();
    for (const c of counts) {
      if (c.houseId) countMap.set(c.houseId, (countMap.get(c.houseId) ?? 0) + 1);
    }
    return all.map((h) => ({ ...h, itemCount: countMap.get(h.id) ?? 0 }));
  }),

  create: procedure
    .input(
      z.object({
        name: z.string().min(1),
        address: z.string().optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        notes: z.string().optional(),
        bagId: z.string().optional(),
        parcelId: z.string().optional(),
        parcelAreaM2: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [{ id }] = await db
        .insert(houses)
        .values({
          name: input.name,
          address: input.address ?? null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          notes: input.notes ?? null,
          bagId: input.bagId ?? null,
          parcelId: input.parcelId ?? null,
          parcelAreaM2: input.parcelAreaM2 ?? null,
        })
        .$returningId();
      await logEvent({
        entityType: "house",
        entityId: id,
        action: "created",
        summary: `House "${input.name}" added`,
      });
      return db.query.houses.findFirst({ where: eq(houses.id, id) });
    }),

  update: procedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        address: z.string().nullable().optional(),
        lat: z.number().min(-90).max(90).nullable().optional(),
        lng: z.number().min(-180).max(180).nullable().optional(),
        notes: z.string().nullable().optional(),
        bagId: z.string().nullable().optional(),
        parcelId: z.string().nullable().optional(),
        parcelAreaM2: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      await getDb().update(houses).set(patch).where(eq(houses.id, id));
      return { ok: true };
    }),

  /** What moving everything out of a house would touch - shown before the
   * actual move, so the impact (how many items/photos) is visible up front
   * rather than discovered after the fact. */
  impact: procedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const itemRows = await db.select({ id: items.id }).from(items).where(eq(items.houseId, input.id));
    const photoRows = await photosOfHouse(db, input.id);
    return { itemCount: itemRows.length, photoCount: photoRows.length };
  }),

  /** Move every item, room and location-linked photo from one house to
   * another - the "replace a building" flow: re-point everything at the new
   * address, then the old (now-empty) house can be deleted with nothing lost.
   * Rooms are unique by name per house, so a source room whose name already
   * exists in the target is merged into it (items, photos and child rooms
   * move; a plan moves too if only the source has one). If both have a plan
   * the call is refused before anything is written. */
  reassign: procedure
    .input(z.object({ fromId: z.number(), toId: z.number() }))
    .mutation(async ({ input }) => {
      if (input.fromId === input.toId) throw new Error("Pick a different house to move into");
      const db = getDb();
      const fromHouse = await db.query.houses.findFirst({ where: eq(houses.id, input.fromId) });
      const toHouse = await db.query.houses.findFirst({ where: eq(houses.id, input.toId) });
      if (!fromHouse || !toHouse) throw new Error("House not found");
      const itemRows = await db.select({ id: items.id }).from(items).where(eq(items.houseId, input.fromId));
      const photoRows = await photosOfHouse(db, input.fromId);
      await db.transaction(async (tx) => {
        const srcRooms = await tx.select().from(rooms).where(eq(rooms.houseId, input.fromId));
        const dstRooms = await tx.select().from(rooms).where(eq(rooms.houseId, input.toId));
        const norm = (n: string) => n.trim().toLowerCase();
        const dstByName = new Map(dstRooms.map((r) => [norm(r.name), r]));
        const pairs = srcRooms.flatMap((s) => {
          const t = dstByName.get(norm(s.name));
          return t ? [{ s, t }] : [];
        });
        for (const { s, t } of pairs) {
          if (s.walls && t.walls) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `Both houses have a room called "${s.name.trim()}" with a plan; merge or rename one first.`,
            });
          }
        }
        for (const { s, t } of pairs) {
          const moved = await tx.select({ id: items.id }).from(items).where(eq(items.roomId, s.id));
          for (const it of moved) await setItemLocation(tx, it.id, { roomId: t.id });
          await tx.update(photos).set({ roomId: t.id }).where(eq(photos.roomId, s.id));
          await tx.update(rooms).set({ parentRoomId: t.id }).where(and(eq(rooms.parentRoomId, s.id), ne(rooms.id, t.id)));
          if (s.walls && !t.walls) {
            await tx
              .update(rooms)
              .set({
                walls: s.walls,
                openings: s.openings,
                widthM: s.widthM,
                depthM: s.depthM,
                wallHeightM: s.wallHeightM,
                source: s.source,
                scanDate: s.scanDate,
                floor: t.floor ?? s.floor,
              })
              .where(eq(rooms.id, t.id));
          } else if (!t.floor && s.floor) {
            await tx.update(rooms).set({ floor: s.floor }).where(eq(rooms.id, t.id));
          }
          await tx.delete(rooms).where(eq(rooms.id, s.id));
        }
        await tx.update(items).set({ houseId: input.toId }).where(eq(items.houseId, input.fromId));
        await tx.update(rooms).set({ houseId: input.toId }).where(eq(rooms.houseId, input.fromId));
        await logEvent(
          {
            entityType: "house",
            entityId: input.toId,
            action: "merged",
            summary: `Moved ${itemRows.length} item(s) and ${photoRows.length} photo(s) from "${fromHouse.name}" to "${toHouse.name}"`,
          },
          tx,
        );
      });
      return { itemCount: itemRows.length, photoCount: photoRows.length };
    }),

  remove: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.transaction(async (tx) => {
      const roomRows = await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.houseId, input.id));
      const roomIds = roomRows.map((r) => r.id);
      if (roomIds.length) {
        await tx.update(items).set({ roomId: null }).where(inArray(items.roomId, roomIds));
        await tx.update(photos).set({ roomId: null }).where(inArray(photos.roomId, roomIds));
        await tx.delete(rooms).where(inArray(rooms.id, roomIds));
      }
      await tx.update(items).set({ houseId: null }).where(eq(items.houseId, input.id));
      await tx.delete(houses).where(eq(houses.id, input.id));
      await logEvent(
        {
          entityType: "house",
          entityId: input.id,
          action: "deleted",
          summary: `House #${input.id} deleted (items unassigned, ${roomIds.length} room scan(s) removed)`,
        },
        tx,
      );
    });
    return { ok: true };
  }),
});
