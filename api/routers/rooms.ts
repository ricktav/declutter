import { z } from "zod";
import { eq, and, sql, isNotNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { rooms, items, attachments, type RoomGeometry, type ItemPos } from "@db/schema";
import { logEvent } from "../lib/events";
import { ensureRoom, setItemLocation } from "../lib/location";

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
  /** Every room of a house (default: the context house; null = all houses). */
  list: procedure
    .input(z.object({ houseId: z.number().nullable().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const houseId = input?.houseId !== undefined ? input.houseId : ctx.houseId;
      const db = getDb();
      const rows = await db
        .select({
          id: rooms.id,
          houseId: rooms.houseId,
          name: rooms.name,
          floor: rooms.floor,
          parentRoomId: rooms.parentRoomId,
          hasGeometry: isNotNull(rooms.walls),
          itemCount: sql<number>`(select count(*) from items i where i.roomId = rooms.id and i.status = 'active')`,
        })
        .from(rooms)
        .where(houseId != null ? eq(rooms.houseId, houseId) : undefined);
      return rows
        .map((r) => ({ ...r, hasGeometry: !!r.hasGeometry, itemCount: Number(r.itemCount) }))
        .sort((a, b) => (a.floor ?? "").localeCompare(b.floor ?? "") || a.name.localeCompare(b.name));
    }),

  /** Find-or-create by name in a house (the picker's "create room …" row). */
  ensure: procedure
    .input(z.object({ name: z.string().min(1), floor: z.string().nullable().optional(), houseId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      const houseId = input.houseId ?? ctx.houseId;
      if (houseId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a house first." });
      const r = await ensureRoom(getDb(), { houseId, name: input.name, floor: input.floor });
      if (r.created) {
        await logEvent({ entityType: "room", entityId: r.id, action: "created", summary: `Room "${input.name.trim()}" added` });
      }
      return r;
    }),

  /** Strict create: a second room with the same name in one house is an error. */
  create: procedure
    .input(z.object({ name: z.string().min(1), floor: z.string().nullable().optional(), houseId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      const houseId = input.houseId ?? ctx.houseId;
      if (houseId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a house first." });
      const r = await ensureRoom(getDb(), { houseId, name: input.name, floor: input.floor });
      if (!r.created) throw new TRPCError({ code: "CONFLICT", message: `A room called "${input.name.trim()}" already exists in this house.` });
      await logEvent({ entityType: "room", entityId: r.id, action: "created", summary: `Room "${input.name.trim()}" added` });
      return { id: r.id };
    }),

  update: procedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        floor: z.string().nullable().optional(),
        lat: z.number().min(-90).max(90).nullable().optional(),
        lng: z.number().min(-180).max(180).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...rest } = input;
      const before = await db.query.rooms.findFirst({ where: eq(rooms.id, id) });
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Room not found." });
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = k === "name" ? String(v).trim() : v;
      try {
        await db.update(rooms).set(patch).where(eq(rooms.id, id));
      } catch (err) {
        if ((err as { cause?: { code?: string } }).cause?.code === "ER_DUP_ENTRY") {
          throw new TRPCError({ code: "CONFLICT", message: `A room called "${patch.name}" already exists in this house.` });
        }
        throw err;
      }
      const parts: string[] = [];
      if (patch.name !== undefined && patch.name !== before.name) parts.push(`renamed from "${before.name}" to "${patch.name}"`);
      if (patch.floor !== undefined && patch.floor !== before.floor) parts.push(`floor set to ${patch.floor ?? "none"}`);
      if (patch.lat !== undefined || patch.lng !== undefined) parts.push("position updated");
      await logEvent({
        entityType: "room",
        entityId: id,
        action: "updated",
        summary: parts.length ? `Room "${before.name}" ${parts.join(", ")}` : `Room "${before.name}" updated (no changes)`,
        payload: patch,
      });
      return { ok: true };
    }),

  /**
   * Fold one room into another (the old "rename location to merge" flow).
   * Items and location photos move; geometry moves only if the target has
   * none; two scanned rooms cannot be merged.
   */
  merge: procedure
    .input(z.object({ fromId: z.number(), toId: z.number() }))
    .mutation(async ({ input }) => {
      if (input.fromId === input.toId) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a different room to merge into." });
      const db = getDb();
      const from = await db.query.rooms.findFirst({ where: eq(rooms.id, input.fromId) });
      const to = await db.query.rooms.findFirst({ where: eq(rooms.id, input.toId) });
      if (!from || !to) throw new TRPCError({ code: "NOT_FOUND", message: "Room not found." });
      if (from.houseId !== to.houseId) throw new TRPCError({ code: "BAD_REQUEST", message: "Rooms must be in the same house to merge." });
      if (from.walls && to.walls) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Both rooms have scanned geometry; merging would drop one scan. Delete or cut rooms on the plan instead." });
      }
      return db.transaction(async (tx) => {
        const movedItems = await tx.select({ id: items.id }).from(items).where(eq(items.roomId, from.id));
        for (const it of movedItems) await setItemLocation(tx, it.id, { roomId: to.id });
        const movedPhotos = await tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.roomId, from.id));
        if (movedPhotos.length) await tx.update(attachments).set({ roomId: to.id }).where(eq(attachments.roomId, from.id));
        await tx.update(rooms).set({ parentRoomId: to.id }).where(eq(rooms.parentRoomId, from.id));
        if (from.walls && !to.walls) {
          await tx
            .update(rooms)
            .set({
              walls: from.walls,
              openings: from.openings,
              widthM: from.widthM,
              depthM: from.depthM,
              wallHeightM: from.wallHeightM,
              source: from.source,
              scanDate: from.scanDate,
              floor: to.floor ?? from.floor,
            })
            .where(eq(rooms.id, to.id));
        } else if (!to.floor && from.floor) {
          await tx.update(rooms).set({ floor: from.floor }).where(eq(rooms.id, to.id));
        }
        await tx.delete(rooms).where(eq(rooms.id, from.id));
        await logEvent(
          {
            entityType: "room",
            entityId: to.id,
            action: "merged",
            summary: `Room "${from.name}" merged into "${to.name}" (${movedItems.length} item(s), ${movedPhotos.length} photo(s))`,
          },
          tx,
        );
        return { ok: true as const, itemsMoved: movedItems.length, photosMoved: movedPhotos.length };
      });
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
        floor: z.string().nullable().optional(),
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
        floor: input.floor ?? undefined,
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

  remove: procedure
    .input(z.object({ id: z.number(), force: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const room = await db.query.rooms.findFirst({ where: eq(rooms.id, input.id) });
      if (!room) return { ok: true, moved: 0 };
      const roomItems = await db.select().from(items).where(eq(items.roomId, input.id));

      if (room.parentRoomId != null) {
        // un-cut: items go back to the parent in the parent's frame
        const ox = room.offsetXM ?? 0, oy = room.offsetYM ?? 0;
        const parentId = room.parentRoomId;
        await db.transaction(async (tx) => {
          for (const it of roomItems) {
            const p = it.pos as ItemPos | null;
            await tx
              .update(items)
              .set({ roomId: parentId, pos: p ? { ...p, xM: +(p.xM + ox).toFixed(2), yM: +(p.yM + oy).toFixed(2) } : p })
              .where(eq(items.id, it.id));
          }
          await tx.update(attachments).set({ roomId: parentId }).where(eq(attachments.roomId, input.id));
          await tx.delete(rooms).where(eq(rooms.id, input.id));
          await logEvent(
            { entityType: "room", entityId: input.id, action: "deleted", summary: `Room "${room.name}" deleted, ${roomItems.length} item(s) moved back to parent room #${parentId}` },
            tx,
          );
        });
        return { ok: true, moved: roomItems.length };
      }

      if (roomItems.length > 0 && !input.force) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `"${room.name}" still holds ${roomItems.length} item(s). Merge it into another room, or delete anyway to leave them unplaced in the house.`,
        });
      }
      await db.transaction(async (tx) => {
        for (const it of roomItems) await setItemLocation(tx, it.id, { roomId: null, houseId: room.houseId });
        await tx.update(attachments).set({ roomId: null }).where(eq(attachments.roomId, input.id));
        await tx.update(rooms).set({ parentRoomId: null }).where(eq(rooms.parentRoomId, input.id));
        await tx.delete(rooms).where(eq(rooms.id, input.id));
        await logEvent(
          { entityType: "room", entityId: input.id, action: "deleted", summary: `Room "${room.name}" deleted (${roomItems.length} item(s) left unplaced)` },
          tx,
        );
      });
      return { ok: true, moved: roomItems.length };
    }),

  /**
   * Carve a named sub-room out of a whole-floor geometry blob: wall/door/
   * window segments fully inside the given rectangle move to a new room
   * (rebased to a local origin), as do placed items whose footprint center
   * falls inside it. The source room's own geometry is never touched -
   * sacred raw scan, same principle lidarventory's docs state explicitly.
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

      const name = input.name.trim();
      const [existing] = await db
        .select()
        .from(rooms)
        .where(and(eq(rooms.houseId, source.houseId), sql`lower(${rooms.name}) = ${name.toLowerCase()}`))
        .limit(1);
      if (existing?.walls) {
        throw new TRPCError({ code: "CONFLICT", message: `A room called "${name}" already has a plan in this house.` });
      }

      const { newRoomId, moved } = await db.transaction(async (tx) => {
      const cutValues = {
        source: "manual" as const,
        scanDate: new Date(),
        widthM: bw,
        depthM: bd,
        wallHeightM: source.wallHeightM,
        walls: cutWalls,
        openings: [],
        parentRoomId: source.id,
        offsetXM: bx,
        offsetYM: by,
      };
      let newRoomId: number;
      if (existing) {
        newRoomId = existing.id;
        await tx.update(rooms).set({ ...cutValues, floor: existing.floor ?? source.floor }).where(eq(rooms.id, existing.id));
      } else {
        [{ id: newRoomId }] = await tx
          .insert(rooms)
          .values({ houseId: source.houseId, name, floor: source.floor, ...cutValues })
          .$returningId();
      }

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
            houseId: source.houseId,
            pos: { ...p, xM: +(p.xM - bx).toFixed(2), yM: +(p.yM - by).toFixed(2) },
          })
          .where(eq(items.id, it.id));
        moved++;
      }

      await logEvent(
        {
          entityType: "room",
          entityId: newRoomId,
          action: "cut",
          summary: `Room "${name}" cut from room #${input.sourceRoomId} (${moved} placed item${moved === 1 ? "" : "s"})`,
        },
        tx,
      );
      return { newRoomId, moved };
      });

      return { id: newRoomId, itemsMoved: moved };
    }),
});
