import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import {
  captures,
  events,
  ideaItems,
  tasks,
  items,
  itemLinks,
  photos,
  photoPins,
  relations,
  rooms,
  roomScans,
  type ItemPos,
  type RoomScanChange,
  type RoomScanGeometry,
  type RoomScanRow,
} from "@db/schema";
import { deleteItemTx, type Tx } from "./entities";
import { logEvent } from "./events";

export type ScanSource = RoomScanRow["source"];

/** The room's geometry as it is in the database now (inside the caller's transaction). */
export async function snapshotRoom(tx: Tx, roomId: number): Promise<RoomScanGeometry> {
  const [r] = await tx.select().from(rooms).where(eq(rooms.id, roomId));
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Room not found." });
  return {
    walls: r.walls ?? null,
    openings: r.openings ?? null,
    widthM: r.widthM ?? null,
    depthM: r.depthM ?? null,
    wallHeightM: r.wallHeightM ?? null,
    scanDate: r.scanDate ? r.scanDate.toISOString() : null,
    source: r.source,
    floor: r.floor ?? null,
  };
}

/** Record one scan of a room. Call inside the import's transaction, after the merge. */
export async function recordRoomScan(
  tx: Tx,
  scan: {
    roomId: number;
    houseId: number;
    captureId?: number | null;
    source: ScanSource;
    scanDate: Date;
    before: RoomScanGeometry | null;
    after: RoomScanGeometry;
    changes: RoomScanChange[];
  },
): Promise<number> {
  const [{ id }] = await tx
    .insert(roomScans)
    .values({ ...scan, captureId: scan.captureId ?? null })
    .$returningId();
  return id;
}

export function scanCounts(changes: RoomScanChange[]) {
  const counts = { matched: 0, moved: 0, created: 0, missing: 0 };
  for (const c of changes) counts[c.action]++;
  return counts;
}

/** Put back exactly the attribute keys a scan touched; other keys keep any later edit. */
function restoreAttrs(current: Record<string, string | number> | null, before: Record<string, string | number | null>) {
  const next: Record<string, string | number> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(before)) {
    if (v == null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/**
 * Undo the newest non-reverted scan of a room, inside the caller's
 * transaction: the room's geometry comes back from `before`, matched and
 * moved Things get their old position and flags, missing flags are put back
 * as they were, and Things the scan created are deleted unless someone has
 * touched them since (confirmed or rejected, a decision, a user edit, a
 * photo, a pin, a relation, a link, a task, an idea or a child). The scan's
 * capture goes back to pending. Returns the stored files of deleted Things
 * so the caller can release them after the commit.
 */
export async function revertRoomScanTx(tx: Tx, scanId: number) {
  const [scan] = await tx.select().from(roomScans).where(eq(roomScans.id, scanId)).for("update");
  if (!scan) throw new TRPCError({ code: "NOT_FOUND", message: "Scan not found." });
  if (scan.revertedAt) throw new TRPCError({ code: "CONFLICT", message: "This scan was already undone." });
  const [latest] = await tx
    .select({ id: roomScans.id })
    .from(roomScans)
    .where(and(eq(roomScans.roomId, scan.roomId), isNull(roomScans.revertedAt)))
    .orderBy(desc(roomScans.id))
    .limit(1)
    .for("update");
  if (latest?.id !== scan.id) {
    throw new TRPCError({ code: "CONFLICT", message: "Only the latest scan of a room can be reverted" });
  }
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, scan.roomId));
  if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "Room not found." });

  const b = scan.before;
  await tx
    .update(rooms)
    .set({
      walls: b?.walls ?? null,
      openings: b?.openings ?? null,
      widthM: b?.widthM ?? null,
      depthM: b?.depthM ?? null,
      wallHeightM: b?.wallHeightM ?? null,
      scanDate: b?.scanDate ? new Date(b.scanDate) : null,
      // a room the scan created keeps its source and floor; otherwise both come back
      ...(b?.source ? { source: b.source } : {}),
      ...(b && b.floor !== undefined ? { floor: b.floor } : {}),
    })
    .where(eq(rooms.id, room.id));

  const ids = [...new Set(scan.changes.map((c) => c.itemId))];
  const things = ids.length ? await tx.select().from(items).where(inArray(items.id, ids)) : [];
  const byId = new Map(things.map((t) => [t.id, t]));

  let restored = 0;
  let deleted = 0;
  let kept = 0;
  const files: string[] = [];
  const keptNames: string[] = [];
  for (const c of scan.changes) {
    const t = byId.get(c.itemId);
    // deleted since, or moved to another room: its position is in another frame now
    if (!t || t.roomId !== scan.roomId) continue;
    if (c.action === "created") {
      const reasons = await touchedBy(tx, t, scan.createdAt);
      if (reasons.length === 0) {
        files.push(...(await deleteItemTx(tx, t.id, { summary: `Thing "${t.name}" deleted: the scan of "${room.name}" that found it was undone` })));
        deleted++;
      } else {
        kept++;
        keptNames.push(t.name);
        await logEvent(
          {
            entityType: "item",
            entityId: t.id,
            action: "scan-reverted-kept",
            summary: `Kept after undoing the scan of "${room.name}" that found it (${reasons.join(", ")})`,
            actor: "system",
            payload: { scanId: scan.id, reasons },
          },
          tx,
        );
      }
      continue;
    }
    const patch: { pos?: ItemPos | null; attributes?: Record<string, string | number> } = {};
    if (c.action === "matched" || c.action === "moved") patch.pos = c.posBefore;
    if (c.attrsBefore) patch.attributes = restoreAttrs(t.attributes, c.attrsBefore);
    if (Object.keys(patch).length) {
      await tx.update(items).set(patch).where(eq(items.id, t.id));
      restored++;
    }
  }

  await tx.update(roomScans).set({ revertedAt: new Date() }).where(eq(roomScans.id, scan.id));
  // the scan's file can be imported again after an undo
  if (scan.captureId != null) await tx.update(captures).set({ status: "pending" }).where(eq(captures.id, scan.captureId));
  await logEvent(
    {
      entityType: "room",
      entityId: room.id,
      action: "scan-reverted",
      summary:
        `Scan of "${room.name}" from ${scan.scanDate.toISOString().slice(0, 10)} undone: ${restored} restored, ${deleted} deleted, ${kept} kept` +
        (keptNames.length ? ` (${keptNames.join(", ")})` : ""),
      actor: "user",
      payload: { scanId: scan.id, restored, deleted, kept },
    },
    tx,
  );
  return { restored, deleted, kept, files };
}

/** Why a Thing a scan created is no longer the scan's alone; empty = untouched. */
async function touchedBy(tx: Tx, t: typeof items.$inferSelect, since: Date): Promise<string[]> {
  const reasons: string[] = [];
  if (t.verificationStatus !== "detected") reasons.push(t.verificationStatus);
  if (t.decision != null) reasons.push(`decision ${t.decision}`);
  if (t.status !== "active") reasons.push(t.status);
  const has = async (q: Promise<unknown[]>) => (await q).length > 0;
  if (await has(tx.select({ id: photos.id }).from(photos).where(eq(photos.itemId, t.id)).limit(1))) reasons.push("photos");
  if (await has(tx.select({ id: photoPins.id }).from(photoPins).where(eq(photoPins.itemId, t.id)).limit(1))) reasons.push("pins");
  if (
    await has(
      tx
        .select({ id: relations.id })
        .from(relations)
        .where(or(eq(relations.fromItemId, t.id), eq(relations.toItemId, t.id)))
        .limit(1),
    )
  )
    reasons.push("relations");
  if (await has(tx.select({ id: itemLinks.id }).from(itemLinks).where(eq(itemLinks.itemId, t.id)).limit(1))) reasons.push("links");
  if (await has(tx.select({ id: items.id }).from(items).where(eq(items.parentId, t.id)).limit(1))) reasons.push("holds Things");
  if (await has(tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.itemId, t.id)).limit(1))) reasons.push("tasks");
  if (await has(tx.select({ id: ideaItems.ideaId }).from(ideaItems).where(eq(ideaItems.itemId, t.id)).limit(1))) reasons.push("ideas");
  // a rename, description or attribute edit leaves a user event; the import
  // itself writes none for a Thing it creates (>=: timestamps are whole seconds)
  if (
    await has(
      tx
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.entityType, "item"), eq(events.entityId, t.id), eq(events.actor, "user"), gte(events.createdAt, since)))
        .limit(1),
    )
  )
    reasons.push("edited");
  return reasons;
}
