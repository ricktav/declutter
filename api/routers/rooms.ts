import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rooms, items, type RoomGeometry } from "@db/schema";
import { logEvent } from "../lib/events";

const geometryInput = z.object({
  walls: z.array(z.object({ points: z.array(z.tuple([z.number(), z.number()])) })),
  openings: z.array(
    z.object({
      edge: z.string(),
      offsetM: z.number(),
      widthM: z.number(),
      connectsTo: z.number().optional(),
    }),
  ),
});

export const roomsRouter = createRouter({
  listByHouse: publicQuery
    .input(z.object({ houseId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const all = await db
        .select()
        .from(rooms)
        .where(eq(rooms.houseId, input.houseId))
        .orderBy(asc(rooms.name));
      const counts = await db.select({ roomId: items.roomId }).from(items);
      const countMap = new Map<number, number>();
      for (const c of counts) {
        if (c.roomId) countMap.set(c.roomId, (countMap.get(c.roomId) ?? 0) + 1);
      }
      return all.map((r) => ({ ...r, itemCount: countMap.get(r.id) ?? 0 }));
    }),

  get: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const room = await db.query.rooms.findFirst({ where: eq(rooms.id, input.id) });
    if (!room) return null;
    const roomItems = await db.select().from(items).where(eq(items.roomId, input.id));
    return { ...room, items: roomItems };
  }),

  /**
   * Upsert a room's geometry from a normalizer run (MappedIn today, a
   * RoomPlan-based capture app later). Matches by houseId+name — re-running
   * the same export updates the existing room instead of duplicating it,
   * so a rescan doesn't orphan already-placed items.
   */
  upsertFromScan: publicQuery
    .input(
      z.object({
        houseId: z.number(),
        name: z.string().min(1),
        source: z.enum(["mappedin", "roomplan", "manual"]),
        scanDate: z.coerce.date().optional(),
        widthM: z.number().optional(),
        depthM: z.number().optional(),
        wallHeightM: z.number().optional(),
        geometry: geometryInput,
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.query.rooms.findFirst({
        where: eq(rooms.houseId, input.houseId),
      });
      const match = existing?.name === input.name ? existing : undefined;

      const values = {
        houseId: input.houseId,
        name: input.name,
        source: input.source,
        scanDate: input.scanDate ?? new Date(),
        widthM: input.widthM ?? null,
        depthM: input.depthM ?? null,
        wallHeightM: input.wallHeightM ?? null,
        walls: input.geometry.walls as RoomGeometry["walls"],
        openings: input.geometry.openings as RoomGeometry["openings"],
      };

      if (match) {
        await db.update(rooms).set(values).where(eq(rooms.id, match.id));
        await logEvent({
          entityType: "room",
          entityId: match.id,
          action: "rescanned",
          summary: `Room "${input.name}" geometry updated from ${input.source} scan`,
          actor: "system",
        });
        return { id: match.id, created: false };
      }

      const [{ id }] = await db.insert(rooms).values(values).$returningId();
      await logEvent({
        entityType: "room",
        entityId: id,
        action: "created",
        summary: `Room "${input.name}" created from ${input.source} scan`,
        actor: "system",
      });
      return { id, created: true };
    }),

  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        lat: z.number().min(-90).max(90).nullable().optional(),
        lng: z.number().min(-180).max(180).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      await getDb().update(rooms).set(patch).where(eq(rooms.id, id));
      return { ok: true };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.update(items).set({ roomId: null }).where(eq(items.roomId, input.id));
    await db.delete(rooms).where(eq(rooms.id, input.id));
    await logEvent({
      entityType: "room",
      entityId: input.id,
      action: "deleted",
      summary: `Room #${input.id} deleted (items unassigned)`,
    });
    return { ok: true };
  }),
});
