import { asc, eq } from "drizzle-orm";
import { areas, items, type ItemPos, type RoomScanChange } from "@db/schema";
import { FURNITURE_KIND_MAP } from "./geojsonFloor";
import { matchScanItems, type ScanPoly } from "./scanMerge";
import { logEvent } from "./events";
import type { Tx } from "./entities";

/** topic, display name and height for a scan polygon kind (the GeoJSON import's rule: an unknown kind keeps its own name) */
export function scanMeta(kind: string): { topic: string; label: string; hM?: number } {
  return FURNITURE_KIND_MAP[kind] ?? { topic: "furniture", label: kind || "Item" };
}

/** YYYY-MM-DD in local time (attribute dates are calendar days, not UTC) */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type ScanThingCounts = { matched: number; moved: number; created: number; missing: number };

/**
 * Merge one scan's furniture into a room, inside the caller's transaction:
 * the room's active Things are matched to the polygons by `scan_kind` and
 * distance (`matchScanItems`), matched Things move to the new footprint,
 * unmatched polygons become new detected Things with `scan_kind`, and scan
 * Things not found this time get `scan.missing_at`. Returns the changes for
 * `recordRoomScan` and the counts (`matched` includes the moved ones).
 *
 * A polygon whose topic area does not exist is skipped, unless
 * `areaFallback` is set: then it goes to the `furniture` area, then to the
 * first area. The GeoJSON import keeps the skip.
 */
export async function mergeScanObjects(
  tx: Tx,
  opts: {
    roomId: number;
    houseId: number;
    roomName: string;
    polys: ScanPoly[];
    /** "floor scan (MappedIn export)" -> "Auto-detected from the Keuken floor scan (MappedIn export) - not yet reviewed." */
    detectedFrom: string;
    areaFallback?: boolean;
    today?: string;
  },
): Promise<{ changes: RoomScanChange[]; counts: ScanThingCounts }> {
  const { roomId, houseId, roomName, polys } = opts;
  const today = opts.today ?? localDate(new Date());
  const changes: RoomScanChange[] = [];

  // A rescan is a new version of the same room: Things a scan put here
  // before are matched by scan_kind and moved, never inserted again.
  const roomThings = await tx.select().from(items).where(eq(items.roomId, roomId)).orderBy(items.id);
  // rejected Things take part, so a false positive the scanner keeps
  // finding matches its rejected Thing and is left alone, not re-created
  const active = roomThings.filter((t) => t.status === "active");
  const byId = new Map(active.map((t) => [t.id, t]));
  const { matched, unmatchedPolys, missingItemIds } = matchScanItems(
    active.map((t) => ({ id: t.id, name: t.name, scanKind: t.attributes?.scan_kind != null ? String(t.attributes.scan_kind) : null, pos: t.pos ?? null })),
    polys,
  );

  let moved = 0;
  for (const m of matched) {
    const t = byId.get(m.itemId)!;
    if (t.verificationStatus === "rejected") {
      changes.push({ itemId: t.id, action: "matched", posBefore: t.pos ?? null, posAfter: t.pos ?? null });
      continue;
    }
    const meta = scanMeta(m.poly.kind);
    const old = t.pos!;
    const hM = m.poly.hM ?? meta.hM ?? old.hM;
    const pos: ItemPos = {
      ...old,
      xM: m.poly.xM,
      yM: m.poly.yM,
      wM: m.poly.wM,
      dM: m.poly.dM,
      // a GeoJSON polygon has no rotation: the Thing keeps its own
      ...(m.poly.rotDeg != null ? { rotDeg: m.poly.rotDeg } : {}),
      ...(hM != null ? { hM } : {}),
    };
    const rest = { ...(t.attributes ?? {}) };
    delete rest["scan.missing_at"];
    // a legacy scan Thing (matched by name) learns its kind, so a later
    // rename cannot lose the match
    const attributes = { ...rest, scan_kind: m.poly.kind };
    await tx.update(items).set({ pos, attributes }).where(eq(items.id, t.id));
    changes.push({
      itemId: t.id,
      action: m.movedM > 0.05 ? "moved" : "matched",
      posBefore: old,
      posAfter: pos,
      attrsBefore: { scan_kind: t.attributes?.scan_kind ?? null, "scan.missing_at": t.attributes?.["scan.missing_at"] ?? null },
    });
    if (m.movedM > 0.05) {
      moved++;
      await logEvent(
        {
          entityType: "item",
          entityId: t.id,
          action: "moved",
          summary: `Moved by the ${roomName} rescan (${m.movedM.toFixed(2)} m)`,
          actor: "system",
        },
        tx,
      );
    }
  }

  // new Things continue each label's counter after the room's existing
  // ones ("Chair 3" after "Chair" and "Chair 2"), so names stay unique
  const areaRows = await tx.select({ id: areas.id, slug: areas.slug }).from(areas).orderBy(asc(areas.sortOrder), asc(areas.id));
  const areaBySlug = new Map(areaRows.map((a) => [a.slug, a.id]));
  const fallbackAreaId = opts.areaFallback ? (areaBySlug.get("furniture") ?? areaRows[0]?.id) : undefined;
  const nameCounts: Record<string, number> = {};
  for (const t of roomThings) {
    const m = /^(.*?)(?:\s+(\d+))?$/.exec(t.name.trim())!;
    const label = m[1].toLowerCase();
    nameCounts[label] = Math.max(nameCounts[label] ?? 0, m[2] ? Number(m[2]) : 1);
  }
  let created = 0;
  for (const poly of unmatchedPolys) {
    const meta = scanMeta(poly.kind);
    const areaId = areaBySlug.get(meta.topic) ?? fallbackAreaId;
    if (!areaId) continue;
    const key = poly.label.toLowerCase();
    const n = (nameCounts[key] = (nameCounts[key] ?? 0) + 1);
    const name = n > 1 ? `${poly.label} ${n}` : poly.label;
    const hM = poly.hM ?? meta.hM;

    const pos: ItemPos = {
      xM: poly.xM,
      yM: poly.yM,
      wM: poly.wM,
      dM: poly.dM,
      rotDeg: poly.rotDeg ?? 0,
      ...(hM != null ? { hM } : {}),
    };
    const [{ id: newId }] = await tx.insert(items).values({
      areaId,
      houseId,
      roomId,
      name,
      status: "active",
      verificationStatus: "detected",
      attributes: { scan_kind: poly.kind },
      pos,
      description: `Auto-detected from the ${roomName} ${opts.detectedFrom} - not yet reviewed.`,
    }).$returningId();
    changes.push({ itemId: newId, action: "created", posBefore: null, posAfter: pos });
    created++;
  }

  // not detected this time: flag only; position, room and verification stay
  const missing = missingItemIds.filter((id) => byId.get(id)!.verificationStatus !== "rejected");
  for (const id of missing) {
    const t = byId.get(id)!;
    await tx.update(items).set({ attributes: { ...(t.attributes ?? {}), "scan.missing_at": today } }).where(eq(items.id, id));
    changes.push({
      itemId: id,
      action: "missing",
      posBefore: t.pos ?? null,
      posAfter: t.pos ?? null,
      attrsBefore: { "scan.missing_at": t.attributes?.["scan.missing_at"] ?? null },
    });
  }

  return { changes, counts: { matched: matched.length, moved, created, missing: missing.length } };
}
