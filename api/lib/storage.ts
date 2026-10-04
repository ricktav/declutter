import { and, eq, inArray, sql } from "drizzle-orm";
import { items, rooms, storageDirs, storageVolumes, type DataRole } from "@db/schema";
import type { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;

export const DATA_ROLES = ["unique", "test", "backup", "archive", "system", "media", "scratch"] as const satisfies readonly DataRole[];

/** Roles that mean "this item can hold volumes": computers and the drives/NAS around them. */
const DEVICE_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas", "storage"]);

export function isStorageDevice(item: { attributes: Record<string, string | number> | null }): boolean {
  const role = item.attributes?.role;
  return typeof role === "string" && DEVICE_ROLES.has(role);
}

export type ReportVolume = {
  mountPoint: string;
  label?: string | null;
  fsType?: string | null;
  device?: string | null;
  capacityBytes: number;
  usedBytes: number;
  dirs?: Array<{ path: string; bytes: number }>;
};

export type ReportInput = { itemId: number; source: string; volumes: ReportVolume[] };

export class StorageReportError extends Error {}

/**
 * Upsert the reported volumes of one device (keyed by itemId + mountPoint),
 * replace their directory lists when the report carries them, and keep the
 * device's lab keys (storage_gb, storage_free_gb) equal to the sum of all its
 * known volumes. Volumes absent from this report keep their last measurement
 * and their data role; a data role is never touched by a report.
 */
export async function applyReport(db: Db, input: ReportInput): Promise<{ volumes: number; dirs: number }> {
  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new StorageReportError("Item not found.");
  if (!isStorageDevice(item)) throw new StorageReportError("Not a computer, drive or NAS: give the report a storage device.");
  if (item.status === "archived") throw new StorageReportError("Item is archived: a report needs an active device.");
  for (const v of input.volumes) {
    if (v.usedBytes > v.capacityBytes) throw new StorageReportError(`${v.mountPoint}: used (${v.usedBytes}) above capacity (${v.capacityBytes}).`);
  }
  const now = new Date();
  let dirCount = 0;
  await db.transaction(async (tx) => {
    // read the item again inside the transaction so the attribute merge sees the same row it writes
    const current = await tx.query.items.findFirst({ where: eq(items.id, input.itemId) });
    if (!current) throw new StorageReportError("Item not found.");
    for (const v of input.volumes) {
      await tx
        .insert(storageVolumes)
        .values({
          itemId: input.itemId,
          mountPoint: v.mountPoint,
          label: v.label ?? null,
          fsType: v.fsType ?? null,
          device: v.device ?? null,
          capacityBytes: v.capacityBytes,
          usedBytes: v.usedBytes,
          source: input.source,
          measuredAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            label: v.label ?? null,
            fsType: v.fsType ?? null,
            device: v.device ?? null,
            capacityBytes: v.capacityBytes,
            usedBytes: v.usedBytes,
            source: input.source,
            measuredAt: now,
          },
        });
      if (v.dirs) {
        const row = await tx.query.storageVolumes.findFirst({
          where: and(eq(storageVolumes.itemId, input.itemId), eq(storageVolumes.mountPoint, v.mountPoint)),
        });
        if (!row) throw new StorageReportError(`${v.mountPoint}: volume row missing after upsert.`);
        await tx.delete(storageDirs).where(eq(storageDirs.volumeId, row.id));
        if (v.dirs.length > 0) {
          await tx.insert(storageDirs).values(v.dirs.map((d) => ({ volumeId: row.id, path: d.path, bytes: d.bytes, measuredAt: now })));
          dirCount += v.dirs.length;
        }
      }
    }
    await syncDeviceTotals(tx, input.itemId, current.attributes);
  });
  return { volumes: input.volumes.length, dirs: dirCount };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Keep the whole-device lab keys (storage_gb, storage_free_gb) equal to the sum
 * of every volume we know. With no volume left the keys stay as they are: the
 * hand-entered value may be all we have.
 */
async function syncDeviceTotals(tx: Tx, itemId: number, attributes: Record<string, string | number> | null) {
  const all = await tx.select().from(storageVolumes).where(eq(storageVolumes.itemId, itemId));
  if (all.length === 0) return;
  const capacity = all.reduce((s, r) => s + r.capacityBytes, 0);
  const used = all.reduce((s, r) => s + r.usedBytes, 0);
  await tx
    .update(items)
    .set({
      attributes: {
        ...(attributes ?? {}),
        storage_gb: Math.round(capacity / 1e9),
        storage_free_gb: Math.round((capacity - used) / 1e9),
      },
    })
    .where(eq(items.id, itemId));
}

/** Delete one volume with its directories and bring the device's lab keys in step. Null when the id is unknown. */
export async function removeVolume(db: Db, volumeId: number): Promise<{ itemId: number; mountPoint: string } | null> {
  return db.transaction(async (tx) => {
    const row = await tx.query.storageVolumes.findFirst({ where: eq(storageVolumes.id, volumeId) });
    if (!row) return null;
    await tx.delete(storageDirs).where(eq(storageDirs.volumeId, volumeId));
    await tx.delete(storageVolumes).where(eq(storageVolumes.id, volumeId));
    const item = await tx.query.items.findFirst({ where: eq(items.id, row.itemId) });
    if (item) await syncDeviceTotals(tx, row.itemId, item.attributes);
    return { itemId: row.itemId, mountPoint: row.mountPoint };
  });
}

/** Capacity and use per data role over every volume of an active device, plus the unassigned rest. */
export async function roleTotals(db: Db) {
  const rows = await db
    .select({
      dataRole: storageVolumes.dataRole,
      volumes: sql<number>`count(*)`,
      capacityBytes: sql<number>`sum(${storageVolumes.capacityBytes})`,
      usedBytes: sql<number>`sum(${storageVolumes.usedBytes})`,
    })
    .from(storageVolumes)
    .innerJoin(items, eq(items.id, storageVolumes.itemId))
    .where(eq(items.status, "active"))
    .groupBy(storageVolumes.dataRole);
  return rows.map((r) => ({
    dataRole: r.dataRole ?? null,
    volumes: Number(r.volumes),
    capacityBytes: Number(r.capacityBytes),
    usedBytes: Number(r.usedBytes),
  }));
}

export async function volumesForItems(db: Db, itemIds: number[]) {
  if (itemIds.length === 0) return [];
  const vols = await db.select().from(storageVolumes).where(inArray(storageVolumes.itemId, itemIds)).orderBy(storageVolumes.mountPoint);
  const counts = vols.length
    ? await db
        .select({ volumeId: storageDirs.volumeId, n: sql<number>`count(*)` })
        .from(storageDirs)
        .where(inArray(storageDirs.volumeId, vols.map((v) => v.id)))
        .groupBy(storageDirs.volumeId)
    : [];
  const dirCount = new Map(counts.map((c) => [c.volumeId, Number(c.n)]));
  return vols.map((v) => ({ ...v, dirCount: dirCount.get(v.id) ?? 0 }));
}

const COMPUTER_ROLES = new Set(["laptop", "desktop", "server", "sbc"]);

type DeviceRow = { id: number; name: string; parentId: number | null; roomId: number | null; attributes: Record<string, string | number> | null };

function num(v: string | number | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One device with its volumes; without volumes the block comes from the lab keys (GB → bytes, decimal). */
function deviceOf(row: DeviceRow, volumes: Awaited<ReturnType<typeof volumesForItems>>, roomName: string | null) {
  const mine = volumes.filter((v) => v.itemId === row.id);
  const measured = mine.length > 0;
  const gb = num(row.attributes?.storage_gb);
  const freeGb = num(row.attributes?.storage_free_gb);
  const capacityBytes = measured ? mine.reduce((s, v) => s + v.capacityBytes, 0) : gb != null ? gb * 1e9 : null;
  const usedBytes = measured ? mine.reduce((s, v) => s + v.usedBytes, 0) : gb != null && freeGb != null ? Math.max(0, Math.min(gb, gb - freeGb)) * 1e9 : null;
  return {
    id: row.id,
    name: row.name,
    kind: String(row.attributes?.role ?? "storage"),
    driveType: row.attributes?.drive_type != null ? String(row.attributes.drive_type) : null,
    parentId: row.parentId,
    roomName,
    capacityBytes,
    usedBytes,
    measured,
    volumes: mine.map((v) => ({
      id: v.id,
      mountPoint: v.mountPoint,
      label: v.label,
      fsType: v.fsType,
      device: v.device,
      capacityBytes: v.capacityBytes,
      usedBytes: v.usedBytes,
      dataRole: v.dataRole,
      measuredAt: v.measuredAt,
      dirCount: v.dirCount,
    })),
  };
}

export async function overviewFor(db: Db, houseId: number | null) {
  const where = houseId != null ? and(eq(items.status, "active"), eq(items.houseId, houseId)) : eq(items.status, "active");
  const all = await db
    .select({ id: items.id, name: items.name, parentId: items.parentId, roomId: items.roomId, attributes: items.attributes, roomName: rooms.name })
    .from(items)
    .leftJoin(rooms, eq(rooms.id, items.roomId))
    .where(where)
    .orderBy(items.name);
  const devices = all.filter((r) => isStorageDevice(r));
  const volumes = await volumesForItems(db, devices.map((d) => d.id));
  const computers = devices.filter((d) => COMPUTER_ROLES.has(String(d.attributes?.role)));
  const computerIds = new Set(computers.map((c) => c.id));
  const internal = devices.filter((d) => d.parentId != null && computerIds.has(d.parentId));
  const externals = devices.filter((d) => !computerIds.has(d.id) && !(d.parentId != null && computerIds.has(d.parentId)));
  const totals = await roleTotals(db);
  return {
    computers: computers.map((c) => ({
      ...deviceOf(c, volumes, c.roomName),
      drives: internal.filter((d) => d.parentId === c.id).map((d) => deviceOf(d, volumes, d.roomName)),
    })),
    externals: externals.map((d) => deviceOf(d, volumes, d.roomName)),
    totals,
    unassignedVolumes: totals.find((t) => t.dataRole === null)?.volumes ?? 0,
  };
}
