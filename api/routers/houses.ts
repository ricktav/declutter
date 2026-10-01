import { z } from "zod";
import { eq, asc, isNotNull, and } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { houses, items } from "@db/schema";
import { logEvent } from "../lib/events";

export const housesRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    const all = await db.select().from(houses).orderBy(asc(houses.name), asc(houses.id));
    const counts = await db.select({ houseId: items.houseId, count: items.id }).from(items);
    const countMap = new Map<number, number>();
    for (const c of counts) {
      if (c.houseId) countMap.set(c.houseId, (countMap.get(c.houseId) ?? 0) + 1);
    }
    return all.map((h) => ({ ...h, itemCount: countMap.get(h.id) ?? 0 }));
  }),

  /** distinct floor/room combos discovered from items in a house — used by RoomPicker */
  rooms: publicQuery
    .input(z.object({ houseId: z.number() }))
    .query(async ({ input }) => {
      const rows = await getDb()
        .select({ floor: items.floor, room: items.room })
        .from(items)
        .where(
          and(
            eq(items.houseId, input.houseId),
            isNotNull(items.room),
          ),
        );
      const seen = new Set<string>();
      const out: { floor: string | null; room: string }[] = [];
      for (const r of rows) {
        const room = r.room!;
        if (seen.has(room)) continue;
        seen.add(room);
        out.push({ floor: r.floor, room });
      }
      return out;
    }),

  create: publicQuery
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

  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        address: z.string().nullable().optional(),
        lat: z.number().min(-90).max(90).nullable().optional(),
        lng: z.number().min(-180).max(180).nullable().optional(),
        notes: z.string().nullable().optional(),
        floors: z.array(z.string()).nullable().optional(),
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

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.update(items).set({ houseId: null }).where(eq(items.houseId, input.id));
    await db.delete(houses).where(eq(houses.id, input.id));
    await logEvent({
      entityType: "house",
      entityId: input.id,
      action: "deleted",
      summary: `House #${input.id} deleted (items unassigned)`,
    });
    return { ok: true };
  }),
});
