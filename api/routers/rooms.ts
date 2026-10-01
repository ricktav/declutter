import { z } from "zod";
import { eq, asc, and, isNull } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rooms, items, type RoomGeometry, type ItemPos } from "@db/schema";
import { logEvent } from "../lib/events";

const geometryInput = z.object({
  walls: z.array(
    z.object({
      points: z.array(z.tuple([z.number(), z.number()])),
      kind: z.enum(["wall", "door", "window"]).optional(),
    }),
  ),
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

  /**
   * Existing floor/room text labels (the plain location field used all over
   * the app, independent of any geometry) that don't have a matching rooms
   * row yet for this house - the pick list for naming a room cut out of a
   * whole-floor scan, so cut rooms reuse the vocabulary already in use
   * instead of inventing new names.
   */
  unlinkedLocations: publicQuery.input(z.object({ houseId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const itemRows = await db.select({ room: items.room }).from(items).where(eq(items.houseId, input.houseId));
    const existing = new Set(
      (await db.select({ name: rooms.name }).from(rooms).where(eq(rooms.houseId, input.houseId))).map((r) => r.name),
    );
    const names = new Set<string>();
    for (const r of itemRows) {
      const name = r.room?.trim();
      if (name && !existing.has(name)) names.add(name);
    }
    return [...names].sort();
  }),

  /**
   * Carve a named sub-room out of a whole-floor geometry blob: wall/door/
   * window segments fully inside the given rectangle move to a new room
   * (rebased to a local origin), as do placed items whose footprint center
   * falls inside it. The source room's own geometry is never touched -
   * sacred raw scan, same principle lidarventory's docs state explicitly.
   * Items already using this location name (string match) but not yet
   * linked to any room get linked too, landing "unplaced" (pos stays null)
   * until someone drags them onto the new plan.
   */
  cutFromRoom: publicQuery
    .input(
      z.object({
        sourceRoomId: z.number(),
        name: z.string().min(1),
        bounds: z.object({ xM: z.number(), yM: z.number(), wM: z.number(), dM: z.number() }),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const source = await db.query.rooms.findFirst({ where: eq(rooms.id, input.sourceRoomId) });
      if (!source) throw new Error("Source room not found");

      const { xM: bx, yM: by, wM: bw, dM: bd } = input.bounds;
      const EPS = 0.05;
      const within = ([x, y]: [number, number]) => x >= bx - EPS && x <= bx + bw + EPS && y >= by - EPS && y <= by + bd + EPS;
      const sourceWalls = (source.walls ?? []) as RoomGeometry["walls"];
      const cutWalls = sourceWalls
        .filter((w) => w.points.every(within))
        .map((w) => ({
          kind: w.kind,
          points: w.points.map(([x, y]) => [+(x - bx).toFixed(3), +(y - by).toFixed(3)] as [number, number]),
        }));

      const [{ id: newRoomId }] = await db
        .insert(rooms)
        .values({
          houseId: source.houseId,
          name: input.name,
          source: "manual",
          scanDate: new Date(),
          widthM: bw,
          depthM: bd,
          wallHeightM: source.wallHeightM,
          walls: cutWalls,
          openings: [],
        })
        .$returningId();

      const sourceItems = await db.select().from(items).where(eq(items.roomId, input.sourceRoomId));
      let moved = 0;
      for (const it of sourceItems) {
        if (!it.pos) continue;
        const p = it.pos as ItemPos;
        const cx = p.xM + p.wM / 2, cy = p.yM + p.dM / 2;
        if (cx < bx || cx > bx + bw || cy < by || cy > by + bd) continue;
        await db
          .update(items)
          .set({
            roomId: newRoomId,
            room: input.name,
            pos: { ...p, xM: +(p.xM - bx).toFixed(2), yM: +(p.yM - by).toFixed(2) },
          })
          .where(eq(items.id, it.id));
        moved++;
      }

      await db
        .update(items)
        .set({ roomId: newRoomId })
        .where(and(eq(items.houseId, source.houseId), eq(items.room, input.name), isNull(items.roomId)));

      await logEvent({
        entityType: "room",
        entityId: newRoomId,
        action: "cut",
        summary: `Room "${input.name}" cut from room #${input.sourceRoomId} (${moved} placed item${moved === 1 ? "" : "s"})`,
      });

      return { id: newRoomId, itemsMoved: moved };
    }),
});
