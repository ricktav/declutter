import { z } from "zod";
import { eq, asc, and, isNull } from "drizzle-orm";
import { createRouter, procedure } from "../middleware";
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

/**
 * Liang-Barsky segment-vs-axis-aligned-box clip. A wall spanning a whole
 * floor only has its endpoints at the floor's own corners, not at every
 * internal cut boundary - clipping (not all-or-nothing filtering) is what
 * keeps a cut room's walls complete when a real wall crosses the cut edge.
 */
function clipSegmentToBox(
  [x0, y0]: [number, number],
  [x1, y1]: [number, number],
  xmin: number,
  xmax: number,
  ymin: number,
  ymax: number,
): [[number, number], [number, number]] | null {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const checks: [number, number][] = [
    [-dx, x0 - xmin],
    [dx, xmax - x0],
    [-dy, y0 - ymin],
    [dy, ymax - y0],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  if (t0 >= t1) return null;
  return [
    [x0 + t0 * dx, y0 + t0 * dy],
    [x0 + t1 * dx, y0 + t1 * dy],
  ];
}

/**
 * Items from every descendant of a cut room, recursively, with pos remapped
 * into the given room's own frame (summing each ancestor's offset on the way
 * up). The source room's items never move from under it in the DB - this is
 * purely a read-time rollup so the original whole-floor overview keeps
 * showing everything, the way a floor plan should, even as sub-rooms get
 * cut out of it for day-to-day placement.
 */
async function collectDescendantItems(
  db: ReturnType<typeof getDb>,
  roomId: number,
  offsetXM: number,
  offsetYM: number,
): Promise<Array<ReturnType<typeof rollupItem>>> {
  const children = await db.select().from(rooms).where(eq(rooms.parentRoomId, roomId));
  const out: Array<ReturnType<typeof rollupItem>> = [];
  for (const child of children) {
    const cOx = offsetXM + (child.offsetXM ?? 0);
    const cOy = offsetYM + (child.offsetYM ?? 0);
    const childItems = await db.select().from(items).where(eq(items.roomId, child.id));
    for (const it of childItems) out.push(rollupItem(it, child, cOx, cOy));
    out.push(...(await collectDescendantItems(db, child.id, cOx, cOy)));
  }
  return out;
}

function rollupItem(
  it: typeof items.$inferSelect,
  owner: typeof rooms.$inferSelect,
  offsetXM: number,
  offsetYM: number,
) {
  const p = it.pos as ItemPos | null;
  return {
    ...it,
    ownerRoomId: owner.id,
    ownerRoomName: owner.name,
    pos: p ? { ...p, xM: +(p.xM + offsetXM).toFixed(2), yM: +(p.yM + offsetYM).toFixed(2) } : null,
  };
}

export const roomsRouter = createRouter({
  /** Every scanned room across every house - just enough to tell which
   * house+name combos already have a floor plan, without a per-house
   * round trip (used by the Inbox's "pick an unmapped location" picker). */
  listAll: procedure.query(async () => {
    const db = getDb();
    return db.select({ id: rooms.id, houseId: rooms.houseId, name: rooms.name }).from(rooms);
  }),

  listByHouse: procedure
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

  get: procedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const room = await db.query.rooms.findFirst({ where: eq(rooms.id, input.id) });
    if (!room) return null;
    const ownItems = await db.select().from(items).where(eq(items.roomId, input.id));
    const rolledUp = await collectDescendantItems(db, input.id, 0, 0);
    const allItems = [...ownItems.map((it) => rollupItem(it, room, 0, 0)), ...rolledUp];
    return { ...room, items: allItems };
  }),

  /**
   * Upsert a room's geometry from a normalizer run (MappedIn today, a
   * RoomPlan-based capture app later). Matches by houseId+name — re-running
   * the same export updates the existing room instead of duplicating it,
   * so a rescan doesn't orphan already-placed items.
   */
  upsertFromScan: procedure
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
      const match = await db.query.rooms.findFirst({
        where: and(eq(rooms.houseId, input.houseId), eq(rooms.name, input.name)),
      });

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

  update: procedure
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

  /**
   * Deleting a cut room "un-cuts" it: its items move back to the parent
   * (pos re-expressed in the parent's frame via the stored offset) since
   * the parent's own geometry was never touched and still has room for
   * them. A room with no parent (a root scan) has nowhere to send items
   * back to - they're orphaned (roomId null), which is why the frontend
   * asks harder before allowing that case.
   */
  remove: procedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const room = await db.query.rooms.findFirst({ where: eq(rooms.id, input.id) });
    if (!room) return { ok: true };

    if (room.parentRoomId != null) {
      const ox = room.offsetXM ?? 0, oy = room.offsetYM ?? 0;
      const parentId = room.parentRoomId;
      const moved = await db.transaction(async (tx) => {
        const roomItems = await tx.select().from(items).where(eq(items.roomId, input.id));
        for (const it of roomItems) {
          const p = it.pos as ItemPos | null;
          await tx
            .update(items)
            .set({
              roomId: parentId,
              pos: p ? { ...p, xM: +(p.xM + ox).toFixed(2), yM: +(p.yM + oy).toFixed(2) } : p,
            })
            .where(eq(items.id, it.id));
        }
        await tx.delete(rooms).where(eq(rooms.id, input.id));
        await logEvent(
          {
            entityType: "room",
            entityId: input.id,
            action: "deleted",
            summary: `Room "${room.name}" deleted, ${roomItems.length} item(s) moved back to parent room #${parentId}`,
          },
          tx,
        );
        return roomItems.length;
      });
      return { ok: true, moved };
    }

    await db.transaction(async (tx) => {
      await tx.update(items).set({ roomId: null }).where(eq(items.roomId, input.id));
      await tx.delete(rooms).where(eq(rooms.id, input.id));
      await logEvent(
        {
          entityType: "room",
          entityId: input.id,
          action: "deleted",
          summary: `Room "${room.name}" deleted (no parent - items unassigned)`,
        },
        tx,
      );
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
  unlinkedLocations: procedure.input(z.object({ houseId: z.number() })).query(async ({ input }) => {
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
  cutFromRoom: procedure
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
      const sourceWalls = (source.walls ?? []) as RoomGeometry["walls"];
      const cutWalls: RoomGeometry["walls"] = [];
      for (const w of sourceWalls) {
        for (let i = 0; i < w.points.length - 1; i++) {
          const clipped = clipSegmentToBox(w.points[i], w.points[i + 1], bx, bx + bw, by, by + bd);
          if (!clipped) continue; // wall segment is a full-length piece of the whole-floor wall;
          // only the part inside the cut rectangle belongs to the new room - the rest
          // stays implicit in the untouched source geometry.
          cutWalls.push({
            kind: w.kind,
            points: clipped.map(([x, y]) => [+(x - bx).toFixed(3), +(y - by).toFixed(3)] as [number, number]),
          });
        }
      }

      const { newRoomId, moved } = await db.transaction(async (tx) => {
      const [{ id: newRoomId }] = await tx
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
          parentRoomId: source.id,
          offsetXM: bx,
          offsetYM: by,
        })
        .$returningId();

      const sourceItems = await tx.select().from(items).where(eq(items.roomId, input.sourceRoomId));
      let moved = 0;
      for (const it of sourceItems) {
        if (!it.pos) continue;
        const p = it.pos as ItemPos;
        const cx = p.xM + p.wM / 2, cy = p.yM + p.dM / 2;
        if (cx < bx || cx > bx + bw || cy < by || cy > by + bd) continue;
        await tx
          .update(items)
          .set({
            roomId: newRoomId,
            room: input.name,
            pos: { ...p, xM: +(p.xM - bx).toFixed(2), yM: +(p.yM - by).toFixed(2) },
          })
          .where(eq(items.id, it.id));
        moved++;
      }

      await tx
        .update(items)
        .set({ roomId: newRoomId })
        .where(and(eq(items.houseId, source.houseId), eq(items.room, input.name), isNull(items.roomId)));

      await logEvent(
        {
          entityType: "room",
          entityId: newRoomId,
          action: "cut",
          summary: `Room "${input.name}" cut from room #${input.sourceRoomId} (${moved} placed item${moved === 1 ? "" : "s"})`,
        },
        tx,
      );
      return { newRoomId, moved };
      });

      return { id: newRoomId, itemsMoved: moved };
    }),
});
