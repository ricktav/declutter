import { z } from "zod";
import { eq, and, ne, sql, isNotNull, desc, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, procedure } from "../middleware";
import { getDb } from "../queries/connection";
import { rooms, items, photos, roomScans, type RoomGeometry, type ItemPos, type RoomScanChange } from "@db/schema";
import { logEvent } from "../lib/events";
import { recordRoomScan, revertRoomScanTx, scanCounts, snapshotRoom } from "../lib/roomScans";
import { FURNITURE_KIND_MAP } from "../lib/geojsonFloor";
import { type ScanPoly } from "../lib/scanMerge";
import { mergeScanObjects, type ScanThingCounts } from "../lib/scanObjects";
import { releaseStoredFiles } from "../lib/entities";
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

/** One object RoomPlan found, as a footprint in the plan frame of the walls. */
const scanObjectInput = z.object({
  kind: z.string().trim().min(1).max(32),
  xM: z.number().finite(),
  yM: z.number().finite(),
  // contract: >= 0.1; thinner (a wall-mounted TV) is widened to 0.1, not refused
  wM: z.number().finite().nonnegative(),
  dM: z.number().finite().nonnegative(),
  rotDeg: z.number().finite().optional(),
  hM: z.number().finite().nonnegative().optional(),
});

const round2 = (n: number) => +n.toFixed(2);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A RoomPlan object as a scan polygon: known kinds take the map's label, unknown ones their own name capitalised. */
function objectPoly(o: z.infer<typeof scanObjectInput>): ScanPoly {
  return {
    kind: o.kind,
    label: FURNITURE_KIND_MAP[o.kind]?.label ?? capitalise(o.kind),
    xM: round2(o.xM),
    yM: round2(o.yM),
    wM: Math.max(0.1, round2(o.wM)),
    dM: Math.max(0.1, round2(o.dM)),
    ...(o.rotDeg != null ? { rotDeg: round2(o.rotDeg) } : {}),
    ...(o.hM != null ? { hM: round2(o.hM) } : {}),
  };
}

const DETECTED_FROM = { roomplan: "LiDAR scan (RoomPlan)", mappedin: "floor scan (MappedIn export)", manual: "scan" } as const;

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
          widthM: rooms.widthM,
          depthM: rooms.depthM,
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
        /** the 2D plan's size; a room with both set has a plan to place Things on */
        widthM: z.number().positive().max(100).nullable().optional(),
        depthM: z.number().positive().max(100).nullable().optional(),
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
      const w = patch.widthM !== undefined ? (patch.widthM as number | null) : before.widthM;
      const d = patch.depthM !== undefined ? (patch.depthM as number | null) : before.depthM;
      if (w !== before.widthM || d !== before.depthM) parts.push(`size set to ${w ?? "?"}×${d ?? "?"} m`);
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
      // refuse merging a room into one of its own descendants (its cut sub-rooms)
      for (let cur = to, hops = 0; cur.parentRoomId != null && hops < 50; hops++) {
        if (cur.parentRoomId === from.id) {
          throw new TRPCError({ code: "CONFLICT", message: "You cannot merge a room into its own cut." });
        }
        const next = await db.query.rooms.findFirst({ where: eq(rooms.id, cur.parentRoomId) });
        if (!next) break;
        cur = next;
      }
      return db.transaction(async (tx) => {
        const movedItems = await tx.select().from(items).where(eq(items.roomId, from.id));
        for (const it of movedItems) {
          await setItemLocation(tx, it.id, { roomId: to.id });
          // pos is in the source room's frame: rebase into a parent, else drop it
          const p = it.pos as ItemPos | null;
          const newPos =
            p && from.parentRoomId === to.id
              ? { ...p, xM: +(p.xM + (from.offsetXM ?? 0)).toFixed(2), yM: +(p.yM + (from.offsetYM ?? 0)).toFixed(2) }
              : null;
          if (p) await tx.update(items).set({ pos: newPos }).where(eq(items.id, it.id));
        }
        const movedPhotos = await tx.select({ id: photos.id }).from(photos).where(eq(photos.roomId, from.id));
        if (movedPhotos.length) await tx.update(photos).set({ roomId: to.id, camera: null }).where(eq(photos.roomId, from.id)); // a camera is in the old frame
        await tx.update(rooms).set({ parentRoomId: to.id }).where(and(eq(rooms.parentRoomId, from.id), ne(rooms.id, to.id)));
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
        // the objects the scanner found; absent or empty = a geometry-only scan
        // that leaves the room's Things alone
        objects: z.array(scanObjectInput).max(200).optional(),
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
      const polys = (input.objects ?? []).map(objectPoly);

      // every scan is a recorded version: geometry before and after, and what
      // its objects did to the room's Things (the GeoJSON import's merge)
      return db.transaction(async (tx) => {
        const before = match ? await snapshotRoom(tx, match.id) : null;
        let id: number;
        if (match) {
          await tx.update(rooms).set(values).where(eq(rooms.id, match.id));
          id = match.id;
        } else {
          [{ id }] = await tx.insert(rooms).values(values).$returningId();
        }
        let things: ScanThingCounts = { matched: 0, moved: 0, created: 0, missing: 0 };
        let changes: RoomScanChange[] = [];
        if (polys.length) {
          ({ changes, counts: things } = await mergeScanObjects(tx, {
            roomId: id,
            houseId: input.houseId,
            roomName: input.name,
            polys,
            detectedFrom: DETECTED_FROM[input.source],
            areaFallback: true,
          }));
        }
        await recordRoomScan(tx, {
          roomId: id,
          houseId: input.houseId,
          source: input.source,
          scanDate: values.scanDate,
          before,
          after: await snapshotRoom(tx, id),
          changes,
        });
        await logEvent(
          {
            entityType: "room",
            entityId: id,
            action: match ? "rescanned" : "created",
            summary: match
              ? `Room "${input.name}" geometry updated from ${input.source} scan` +
                (polys.length ? `: ${things.matched} matched (${things.moved} moved), ${things.created} new, ${things.missing} missing` : "")
              : `Room "${input.name}" created from ${input.source} scan` + (polys.length ? ` (${things.created} item(s) detected)` : ""),
            actor: "system",
            ...(polys.length ? { payload: { ...things } } : {}),
          },
          tx,
        );
        return { id, created: !match, things };
      });
    }),

  /** A room's recorded scans, newest first, with what each did to its Things. */
  scans: procedure.input(z.object({ roomId: z.number() })).query(async ({ input }) => {
    const rows = await getDb().select().from(roomScans).where(eq(roomScans.roomId, input.roomId)).orderBy(desc(roomScans.id));
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      scanDate: r.scanDate,
      createdAt: r.createdAt,
      revertedAt: r.revertedAt,
      counts: scanCounts(r.changes),
    }));
  }),

  /** One scan compared with the room before it: both geometries and every Thing change, with names. */
  scanDiff: procedure.input(z.object({ scanId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const [scan] = await db.select().from(roomScans).where(eq(roomScans.id, input.scanId));
    if (!scan) throw new TRPCError({ code: "NOT_FOUND", message: "Scan not found." });
    const ids = [...new Set(scan.changes.map((c) => c.itemId))];
    const things = ids.length
      ? await db.select({ id: items.id, name: items.name, status: items.status }).from(items).where(inArray(items.id, ids))
      : [];
    const byId = new Map(things.map((t) => [t.id, t]));
    return {
      scan: { id: scan.id, roomId: scan.roomId, source: scan.source, scanDate: scan.scanDate, revertedAt: scan.revertedAt },
      before: scan.before ?? null,
      after: scan.after,
      changes: scan.changes.map((c) => {
        const t = byId.get(c.itemId);
        return { ...c, name: t?.name ?? "(deleted)", status: t?.status ?? "deleted" };
      }),
    };
  }),

  /**
   * Undo the room's latest scan: geometry and Thing positions and flags come
   * back, Things it created are deleted unless someone touched them since.
   */
  revertScan: procedure.input(z.object({ scanId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const { files, ...result } = await db.transaction((tx) => revertRoomScanTx(tx, input.scanId));
    await releaseStoredFiles(db, files);
    return result;
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
          await tx.update(photos).set({ roomId: parentId, camera: null }).where(eq(photos.roomId, input.id)); // a camera is in the cut's frame
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
        for (const it of roomItems) {
          await setItemLocation(tx, it.id, { roomId: null, houseId: room.houseId });
          if (it.pos) await tx.update(items).set({ pos: null }).where(eq(items.id, it.id));
        }
        await tx.update(photos).set({ roomId: null, camera: null }).where(eq(photos.roomId, input.id));
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
      if (existing && existing.id === source.id) {
        throw new TRPCError({ code: "CONFLICT", message: "A cut needs a different name from the room it is cut from." });
      }
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
