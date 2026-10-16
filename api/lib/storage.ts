import { and, eq, inArray, sql } from "drizzle-orm";
import { items, relations, rooms, storageDirs, storageVolumes, type DataRole } from "@db/schema";
import type { getDb } from "../queries/connection";
import { normalizeIp, normHost } from "./hostNames";
import {
  claimLooseDisks,
  claimMachineDisks,
  clusterByTwinKeys,
  dedupeVolumesByMountPoint,
  diskSightingKey,
  formatLastSeen,
  isNetworkDisk,
  isNetworkVolume,
  linkComputerDisks,
  machineTwinKeys,
  newestMeasuredAt,
  normalizeMountPoint,
  physicalDiskKey,
  sameVolume,
  STALE_AFTER_MS,
  volumeDedupeIsSafe,
  type DiskLinkCandidate,
  type DiskMeasure,
} from "./storageDisks";

export {
  STORAGE_DISK_KEY,
  physicalDiskKey,
  STALE_AFTER_MS,
  formatLastSeen,
  normalizeMountPoint,
  dedupeVolumesByMountPoint,
  type DiskMeasure,
} from "./storageDisks";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
  /** APFS container (e.g. "disk3"): volumes sharing it share its capacity. Null or absent = its own container. */
  container?: string | null;
  capacityBytes: number;
  usedBytes: number;
  dirs?: Array<{ path: string; bytes: number }>;
  /** Tracker last-seen; omitted = now. Stale-only sightings keep their old time so the overview can badge them. */
  measuredAt?: Date | string | number | null;
};

export type ReportInput = { itemId: number; source: string; volumes: ReportVolume[] };

export class StorageReportError extends Error {}

type VolumeLike = { id: number; container: string | null; capacityBytes: number; usedBytes: number; measuredAt?: Date };

/** The key that groups volumes sharing capacity on one device: the container, or the volume alone. */
export function containerKey(v: { id: number; container: string | null }): string {
  return v.container ?? `vol:${v.id}`;
}

/**
 * Capacity per container key on one device. Volumes of one container carry the
 * same capacity; when stored rows disagree (reported at different times), the
 * most recent measurement wins.
 */
function containerCapacities(volumes: VolumeLike[]): Map<string, number> {
  const best = new Map<string, { capacity: number; at: number }>();
  for (const v of volumes) {
    const key = containerKey(v);
    const at = v.measuredAt?.getTime() ?? 0;
    const prev = best.get(key);
    if (!prev || at > prev.at || (at === prev.at && v.capacityBytes > prev.capacity)) best.set(key, { capacity: v.capacityBytes, at });
  }
  return new Map([...best].map(([k, b]) => [k, b.capacity]));
}

/** A device's capacity: each container counted once (container ?? "vol:" + id). */
export function deviceCapacity(volumes: VolumeLike[]): number {
  let total = 0;
  for (const c of containerCapacities(volumes).values()) total += c;
  return total;
}

/** A device's use: every volume's used bytes. */
export function deviceUsed(volumes: VolumeLike[]): number {
  return volumes.reduce((s, v) => s + v.usedBytes, 0);
}

type StoredVolume = typeof storageVolumes.$inferSelect;

function volumeMs(at: Date | string | null | undefined): number {
  if (at == null) return 0;
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(t) ? t : 0;
}

function reportFields(v: ReportVolume, mountPoint: string, measuredAt: Date, source: string) {
  return {
    mountPoint,
    label: v.label ?? null,
    fsType: v.fsType ?? null,
    device: v.device ?? null,
    container: v.container ?? null,
    capacityBytes: v.capacityBytes,
    usedBytes: v.usedBytes,
    source,
    measuredAt,
  };
}

/**
 * Computer this device belongs to, plus every child / attached disk on it.
 * A report upserts against this set so Mini + disk #243 cannot both hold `/Volumes/T7`.
 */
async function machineScope(
  tx: Tx,
  item: { id: number; parentId: number | null; attributes: Record<string, string | number> | null },
): Promise<{ computerId: number; memberIds: number[]; isComputer: boolean }> {
  const isComputer = isStorageComputer(item);
  let computerId = item.id;
  if (!isComputer) {
    if (item.parentId != null) {
      const parent = await tx.query.items.findFirst({ where: eq(items.id, item.parentId) });
      if (parent && isStorageComputer(parent)) computerId = parent.id;
    } else {
      const rels = await tx
        .select({ toItemId: relations.toItemId })
        .from(relations)
        .where(and(eq(relations.fromItemId, item.id), eq(relations.type, "attached-to"), eq(relations.status, "confirmed")));
      for (const r of rels) {
        const host = await tx.query.items.findFirst({ where: eq(items.id, r.toItemId) });
        if (host && isStorageComputer(host)) {
          computerId = host.id;
          break;
        }
      }
    }
  }
  const children = await tx
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.parentId, computerId), eq(items.status, "active")));
  const attached = await tx
    .select({ fromItemId: relations.fromItemId })
    .from(relations)
    .where(and(eq(relations.toItemId, computerId), eq(relations.type, "attached-to"), eq(relations.status, "confirmed")));
  const memberIds = [...new Set([computerId, item.id, ...children.map((c) => c.id), ...attached.map((a) => a.fromItemId)])];
  return { computerId, memberIds, isComputer };
}

function matchingMachineVolumes(rows: StoredVolume[], v: ReportVolume): StoredVolume[] {
  return rows.filter((r) => sameVolume(r, v));
}

function freshestVolume(group: StoredVolume[]): StoredVolume {
  return group.reduce((a, b) => (volumeMs(b.measuredAt) !== volumeMs(a.measuredAt) ? (volumeMs(b.measuredAt) > volumeMs(a.measuredAt) ? b : a) : b.id > a.id ? b : a));
}

async function copyRoleAndDirsThenDrop(tx: Tx, keep: StoredVolume, extras: StoredVolume[]) {
  if (extras.length === 0) return;
  if (keep.dataRole == null) {
    const donor = extras.find((e) => e.dataRole != null);
    if (donor) await tx.update(storageVolumes).set({ dataRole: donor.dataRole }).where(eq(storageVolumes.id, keep.id));
  }
  const keepDirs = await tx.select({ id: storageDirs.id }).from(storageDirs).where(eq(storageDirs.volumeId, keep.id));
  if (keepDirs.length === 0) {
    const donor = extras[0];
    const from = await tx.select({ id: storageDirs.id }).from(storageDirs).where(eq(storageDirs.volumeId, donor.id));
    if (from.length > 0) await tx.update(storageDirs).set({ volumeId: keep.id }).where(eq(storageDirs.volumeId, donor.id));
  }
  for (const extra of extras) {
    await tx.delete(storageDirs).where(eq(storageDirs.volumeId, extra.id));
    await tx.delete(storageVolumes).where(eq(storageVolumes.id, extra.id));
  }
}

/**
 * Upsert the reported volumes of one device. Key is the machine (computer +
 * its disks) plus mountPoint, with a unique-device fallback, not only
 * (itemId, mountPoint): a Mini local report updates a leftover T7 row on the
 * disk Thing instead of inserting a second. A newer measurement is never
 * overwritten by an older one. Volumes absent from this report keep their
 * last measurement and their data role; a data role is never touched by a report.
 */
export async function applyReport(db: Db, input: ReportInput): Promise<{ volumes: number; dirs: number }> {
  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new StorageReportError("Item not found.");
  if (!isStorageDevice(item)) throw new StorageReportError("Not a computer, drive or NAS: give the report a storage device.");
  if (item.status === "archived") throw new StorageReportError("Item is archived: a report needs an active device.");
  for (const v of input.volumes) {
    if (v.usedBytes > v.capacityBytes) throw new StorageReportError(`${v.mountPoint}: used (${v.usedBytes}) above capacity (${v.capacityBytes}).`);
  }
  const reportedCapacity = new Map<string, number>();
  for (const v of input.volumes) {
    if (v.container == null) continue;
    const seen = reportedCapacity.get(v.container);
    if (seen !== undefined && seen !== v.capacityBytes) throw new StorageReportError(`container ${v.container}: capacity differs between volumes.`);
    reportedCapacity.set(v.container, v.capacityBytes);
  }
  const now = new Date();
  const explicitMeasuredAt = (v: ReportVolume): Date | null => {
    if (v.measuredAt == null || v.measuredAt === "") return null;
    const at = v.measuredAt instanceof Date ? v.measuredAt : new Date(v.measuredAt);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= 0) return null;
    return at;
  };
  let dirCount = 0;
  await db.transaction(async (tx) => {
    const current = await tx.query.items.findFirst({ where: eq(items.id, input.itemId) });
    if (!current) throw new StorageReportError("Item not found.");
    const scope = await machineScope(tx, current);
    const affected = new Set<number>([input.itemId]);
    let machineVols = scope.memberIds.length
      ? await tx.select().from(storageVolumes).where(inArray(storageVolumes.itemId, scope.memberIds))
      : [];

    for (const v of input.volumes) {
      const explicitAt = explicitMeasuredAt(v);
      const measuredAt = explicitAt ? (explicitAt.getTime() > now.getTime() ? now : explicitAt) : now;
      const mountPoint = normalizeMountPoint(v.mountPoint);
      const fields = reportFields(v, mountPoint, measuredAt, input.source);
      const group = matchingMachineVolumes(machineVols, { ...v, mountPoint });
      const newest = group.length ? freshestVolume(group) : null;
      // Live collectors omit measuredAt (= now). Only skip when the payload
      // sent an older timestamp, so Mini local `/` is not clobbered by a
      // tracker-era date, while sequential reports in the same second still write.
      const incomingNewer = explicitAt == null || !newest || volumeMs(measuredAt) >= volumeMs(newest.measuredAt);
      const onReporter = group.find((r) => r.itemId === input.itemId && normalizeMountPoint(r.mountPoint) === mountPoint);
      let keep: StoredVolume;
      if (!incomingNewer && newest) {
        keep = newest;
      } else if (scope.isComputer && onReporter) {
        await tx.update(storageVolumes).set(fields).where(eq(storageVolumes.id, onReporter.id));
        keep = { ...onReporter, ...fields };
      } else if (scope.isComputer) {
        const [{ id }] = await tx.insert(storageVolumes).values({ itemId: input.itemId, ...fields }).$returningId();
        keep = { id, itemId: input.itemId, dataRole: null, createdAt: now, ...fields };
      } else if (onReporter) {
        await tx.update(storageVolumes).set(fields).where(eq(storageVolumes.id, onReporter.id));
        keep = { ...onReporter, ...fields };
      } else if (newest) {
        await tx.update(storageVolumes).set(fields).where(eq(storageVolumes.id, newest.id));
        keep = { ...newest, ...fields };
      } else {
        const [{ id }] = await tx.insert(storageVolumes).values({ itemId: input.itemId, ...fields }).$returningId();
        keep = { id, itemId: input.itemId, dataRole: null, createdAt: now, ...fields };
      }
      const extraRows = machineVols.filter((r) => r.id !== keep.id && sameVolume(r, { ...v, mountPoint }));
      for (const extra of extraRows) affected.add(extra.itemId);
      await copyRoleAndDirsThenDrop(tx, keep, extraRows);
      if (incomingNewer && v.dirs) {
        await tx.delete(storageDirs).where(eq(storageDirs.volumeId, keep.id));
        if (v.dirs.length > 0) {
          await tx.insert(storageDirs).values(v.dirs.map((d) => ({ volumeId: keep.id, path: d.path, bytes: d.bytes, measuredAt: now })));
          dirCount += v.dirs.length;
        }
      }
      affected.add(keep.itemId);
      machineVols = scope.memberIds.length
        ? await tx.select().from(storageVolumes).where(inArray(storageVolumes.itemId, scope.memberIds))
        : [];
    }
    if (reportedCapacity.size > 0) {
      for (const [container, capacity] of reportedCapacity) {
        const used = deviceUsed(machineVols.filter((r) => r.container === container));
        if (used > capacity) throw new StorageReportError(`container ${container}: volumes use ${used} bytes, above its capacity (${capacity}).`);
      }
    }
    for (const id of affected) {
      const row = id === input.itemId ? current : await tx.query.items.findFirst({ where: eq(items.id, id) });
      if (row) await syncDeviceTotals(tx, id, row.attributes);
    }
  });
  return { volumes: input.volumes.length, dirs: dirCount };
}

export type DirsReportVolume = {
  mountPoint: string;
  label?: string | null;
  device?: string | null;
  dirs: Array<{ path: string; bytes: number }>;
};

export type DirsReportInput = {
  itemId?: number;
  /** Hostname, IP or `machine.id` — never the display name. Ignored when itemId is set. */
  host?: string;
  source: string;
  volumes: DirsReportVolume[];
};

export type DirsReportResult = {
  itemId: number;
  itemName: string;
  volumes: number;
  dirs: number;
  skipped: Array<{ mountPoint: string; reason: string }>;
};

function uniqueDirRows(dirs: Array<{ path: string; bytes: number }>): Array<{ path: string; bytes: number }> {
  const byPath = new Map<string, number>();
  for (const d of dirs) {
    const path = d.path.trim().slice(0, 512);
    if (!path || !Number.isFinite(d.bytes) || d.bytes < 0) continue;
    const prev = byPath.get(path);
    if (prev == null || d.bytes > prev) byPath.set(path, d.bytes);
  }
  return [...byPath.entries()]
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 100);
}

function hostMatchesItem(item: { attributes: Record<string, string | number> | null }, host: string): boolean {
  const wantHost = normHost(host);
  const wantIp = normalizeIp(host);
  if (!wantHost && !wantIp) return false;
  for (const raw of machineIdentity(item.attributes).identityOptions) {
    if (wantIp && normalizeIp(raw) === wantIp) return true;
    if (wantHost && normHost(raw) === wantHost) return true;
  }
  return false;
}

/**
 * Biggest-folder ingest for a file inventory: replace `storage_dirs` on
 * volumes that already exist. Never creates a volume, never writes capacity,
 * use, data role or the volume's measuredAt (those stay with df collectors).
 */
export async function applyDirsReport(db: Db, input: DirsReportInput): Promise<DirsReportResult> {
  let item =
    input.itemId != null ? await db.query.items.findFirst({ where: eq(items.id, input.itemId) }) : null;
  if (item == null && input.host) {
    const active = await db.select().from(items).where(eq(items.status, "active"));
    const hits = active.filter((r) => isStorageDevice(r) && hostMatchesItem(r, input.host!));
    const computers = hits.filter(isStorageComputer);
    const pick = computers.length > 0 ? computers : hits;
    if (pick.length > 1) throw new StorageReportError(`Host ${input.host} matches more than one machine.`);
    item = pick[0] ?? null;
  }
  if (!item) throw new StorageReportError(input.host ? `No machine for host ${input.host}.` : "Item not found.");
  if (!isStorageDevice(item)) throw new StorageReportError("Not a computer, drive or NAS: give the report a storage device.");
  if (item.status === "archived") throw new StorageReportError("Item is archived: a report needs an active device.");

  const skipped: Array<{ mountPoint: string; reason: string }> = [];
  let updated = 0;
  let dirCount = 0;
  const now = new Date();
  await db.transaction(async (tx) => {
    const current = await tx.query.items.findFirst({ where: eq(items.id, item.id) });
    if (!current) throw new StorageReportError("Item not found.");
    const scope = await machineScope(tx, current);
    const machineVols = scope.memberIds.length
      ? await tx.select().from(storageVolumes).where(inArray(storageVolumes.itemId, scope.memberIds))
      : [];
    for (const v of input.volumes) {
      const mountPoint = normalizeMountPoint(v.mountPoint);
      const group = matchingMachineVolumes(machineVols, { ...v, mountPoint, capacityBytes: 0, usedBytes: 0 });
      if (group.length === 0) {
        skipped.push({ mountPoint, reason: "no matching volume" });
        continue;
      }
      const keep = freshestVolume(group);
      const rows = uniqueDirRows(v.dirs);
      await tx.delete(storageDirs).where(eq(storageDirs.volumeId, keep.id));
      if (rows.length > 0) {
        await tx.insert(storageDirs).values(rows.map((d) => ({ volumeId: keep.id, path: d.path, bytes: d.bytes, measuredAt: now })));
        dirCount += rows.length;
      }
      updated++;
    }
  });
  return { itemId: item.id, itemName: item.name, volumes: updated, dirs: dirCount, skipped };
}

/**
 * Keep the whole-device lab keys (storage_gb, storage_free_gb) in step with the
 * volumes we know: capacity once per container, use summed over every volume.
 * With no volume left the keys stay as they are: the hand-entered value may be
 * all we have.
 */
async function syncDeviceTotals(tx: Tx, itemId: number, attributes: Record<string, string | number> | null) {
  const all = await tx.select().from(storageVolumes).where(eq(storageVolumes.itemId, itemId));
  if (all.length === 0) return;
  const used = deviceUsed(all);
  const existingGb = num(attributes?.storage_gb);
  // Disk Things keep a hand-entered / tracker physical size; computers still follow volume totals.
  if (isDiskThing({ attributes }) && existingGb != null) {
    await tx
      .update(items)
      .set({
        attributes: {
          ...(attributes ?? {}),
          storage_free_gb: Math.round((existingGb * 1e9 - used) / 1e9),
        },
      })
      .where(eq(items.id, itemId));
    return;
  }
  const capacity = deviceCapacity(all);
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

/** Delete volumes on a computer whose kernel disk name is in `diskKeys` (a disk that moved away). */
export async function removeVolumesByDiskKeys(db: Db, itemId: number, diskKeys: string[]): Promise<number> {
  const want = new Set(diskKeys.map((k) => k.toLowerCase()).filter(Boolean));
  if (want.size === 0) return 0;
  const vols = await db.select().from(storageVolumes).where(eq(storageVolumes.itemId, itemId));
  let n = 0;
  for (const v of vols) {
    const key = physicalDiskKey(v.device, v.container);
    if (!key || !want.has(key)) continue;
    const removed = await removeVolume(db, v.id);
    if (removed) n++;
  }
  return n;
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

export type VolumeDedupeHit = {
  id: number;
  itemId: number;
  itemName: string;
  mountPoint: string;
  device?: string | null;
  measuredAt: Date | null;
  source: string;
};

export type VolumeDedupeGroup = {
  machineId: number;
  machineName: string;
  keep: VolumeDedupeHit;
  drop: VolumeDedupeHit[];
  ambiguous: boolean;
};

export type DiskMergeOffer = {
  machineId: number;
  machineName: string;
  keep: { id: number; name: string };
  drop: Array<{ id: number; name: string }>;
  reason: string;
};

function twinKeysForItem(
  item: { name: string; attributes: Record<string, string | number> | null },
  vols: Array<{ label: string | null; mountPoint: string; capacityBytes: number }>,
) {
  return machineTwinKeys({
    name: item.name,
    capacityBytes: num(item.attributes?.size_bytes) ?? (num(item.attributes?.storage_gb) != null ? num(item.attributes?.storage_gb)! * 1e9 : null),
    serial: item.attributes?.serial != null ? String(item.attributes.serial) : null,
    uuid: item.attributes?.uuid != null ? String(item.attributes.uuid) : null,
    attributes: item.attributes,
    volumes: vols,
  });
}

/** Duplicate volume rows on a machine, and enclosure/inner-drive Thing twins to merge (not auto-delete). */
export async function planStorageDedupes(db: Db): Promise<{
  volumes: VolumeDedupeGroup[];
  diskMerges: DiskMergeOffer[];
}> {
  const deviceRows = await db
    .select({ id: items.id, name: items.name, parentId: items.parentId, houseId: items.houseId, attributes: items.attributes, status: items.status })
    .from(items)
    .where(eq(items.status, "active"));
  const devices = deviceRows.filter((r) => isStorageDevice(r));
  const computers = devices.filter((d) => isStorageComputer(d));
  const computerIds = new Set(computers.map((c) => c.id));
  const attached =
    computerIds.size === 0
      ? []
      : await db
          .select({ fromItemId: relations.fromItemId, toItemId: relations.toItemId })
          .from(relations)
          .where(and(eq(relations.type, "attached-to"), eq(relations.status, "confirmed"), inArray(relations.toItemId, [...computerIds])));
  const hostOf = new Map<number, number>();
  for (const r of attached) hostOf.set(r.fromItemId, r.toItemId);
  const ownedDiskIds = new Set<number>();
  for (const d of devices) {
    if (!isDiskThing(d)) continue;
    if (d.parentId != null && computerIds.has(d.parentId)) ownedDiskIds.add(d.id);
    if (hostOf.has(d.id)) ownedDiskIds.add(d.id);
  }
  const machineOf = (itemId: number): number => {
    const item = devices.find((d) => d.id === itemId);
    if (!item) return itemId;
    if (computerIds.has(item.id)) return item.id;
    if (item.parentId != null && computerIds.has(item.parentId)) return item.parentId;
    return hostOf.get(item.id) ?? item.id;
  };
  const vols = await db.select().from(storageVolumes);
  const nameOf = (id: number) => devices.find((d) => d.id === id)?.name ?? computers.find((c) => c.id === id)?.name ?? `#${id}`;
  const byMachine = new Map<number, StoredVolume[]>();
  for (const v of vols) {
    const mid = machineOf(v.itemId);
    byMachine.set(mid, [...(byMachine.get(mid) ?? []), v]);
  }
  const volumeGroups: VolumeDedupeGroup[] = [];
  for (const [machineId, rows] of byMachine) {
    const clusters: StoredVolume[][] = [];
    for (const row of rows) {
      const hit = clusters.find((g) => sameVolume(g[0], row));
      if (hit) hit.push(row);
      else clusters.push([row]);
    }
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const keepRow = freshestVolume(cluster);
      const asHit = (r: StoredVolume): VolumeDedupeHit => ({
        id: r.id,
        itemId: r.itemId,
        itemName: nameOf(r.itemId),
        mountPoint: r.mountPoint,
        device: r.device,
        measuredAt: r.measuredAt,
        source: r.source,
      });
      const drop = cluster.filter((r) => r.id !== keepRow.id);
      volumeGroups.push({
        machineId,
        machineName: nameOf(machineId),
        keep: asHit(keepRow),
        drop: drop.map(asHit),
        ambiguous: drop.some((r) => !volumeDedupeIsSafe(keepRow, r)),
      });
    }
  }
  const diskMerges: DiskMergeOffer[] = [];
  const volsByItem = new Map<number, StoredVolume[]>();
  for (const v of vols) volsByItem.set(v.itemId, [...(volsByItem.get(v.itemId) ?? []), v]);
  const claimedLoose = new Set<number>();
  for (const c of computers) {
    const computerVols = volsByItem.get(c.id) ?? [];
    const children = devices.filter((d) => isDiskThing(d) && d.parentId === c.id);
    const att = devices.filter((d) => isDiskThing(d) && hostOf.get(d.id) === c.id);
    const loose = devices.filter(
      (d) =>
        isDiskThing(d) &&
        !ownedDiskIds.has(d.id) &&
        !claimedLoose.has(d.id) &&
        (c.houseId == null || d.houseId == null || d.houseId === c.houseId),
    );
    const extras = [
      ...claimLooseDisks(computerVols, loose),
      ...claimMachineDisks(
        computerVols,
        loose.filter((d) => !claimedLoose.has(d.id)),
      ),
    ];
    const seen = new Set<number>();
    const members = [...children, ...att, ...extras].filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
    for (const d of extras) claimedLoose.add(d.id);
    const ownOnDrives = new Map(members.map((d) => [d.id, volsByItem.get(d.id) ?? []] as const));
    const linked = linkComputerDisks(computerVols, members, ownOnDrives);
    const groups = clusterByTwinKeys(members, (d) => twinKeysForItem(d, linked.volumesByDrive.get(d.id) ?? ownOnDrives.get(d.id) ?? []));
    for (const g of groups) {
      if (g.length < 2) continue;
      const score = (x: (typeof g)[number]) =>
        (x.attributes?.serial != null && String(x.attributes.serial) !== "" ? 2 : 0) + ((linked.volumesByDrive.get(x.id) ?? volsByItem.get(x.id) ?? []).length > 0 ? 1 : 0);
      const keep = g.reduce((a, b) => {
        const d = score(b) - score(a);
        if (d !== 0) return d > 0 ? b : a;
        return a.id <= b.id ? a : b;
      });
      const keys = twinKeysForItem(keep, linked.volumesByDrive.get(keep.id) ?? volsByItem.get(keep.id) ?? []);
      diskMerges.push({
        machineId: c.id,
        machineName: c.name,
        keep: { id: keep.id, name: keep.name },
        drop: g.filter((d) => d.id !== keep.id).map((d) => ({ id: d.id, name: d.name })),
        reason: [...keys.hard, ...keys.names][0] ?? "size+volume",
      });
    }
  }
  return { volumes: volumeGroups, diskMerges };
}

export async function applyStorageDedupes(
  db: Db,
  input: { dry?: boolean; mergeDisks?: boolean } = {},
): Promise<{
  dry: boolean;
  droppedVolumes: number;
  skippedVolumes: number;
  mergedDisks: number;
  volumes: VolumeDedupeGroup[];
  skipped: VolumeDedupeGroup[];
  diskMerges: DiskMergeOffer[];
}> {
  const plan = await planStorageDedupes(db);
  const skipped = plan.volumes.filter((g) => g.ambiguous);
  const dry = input.dry !== false;
  if (dry) {
    return {
      dry: true,
      droppedVolumes: 0,
      skippedVolumes: skipped.length,
      mergedDisks: 0,
      volumes: plan.volumes,
      skipped,
      diskMerges: plan.diskMerges,
    };
  }
  let droppedVolumes = 0;
  for (const g of plan.volumes) {
    if (g.ambiguous) continue;
    const keep = await db.query.storageVolumes.findFirst({ where: eq(storageVolumes.id, g.keep.id) });
    if (!keep) continue;
    const extras: StoredVolume[] = [];
    for (const d of g.drop) {
      const row = await db.query.storageVolumes.findFirst({ where: eq(storageVolumes.id, d.id) });
      if (row) extras.push(row);
    }
    if (extras.length === 0) continue;
    try {
      await db.transaction(async (tx) => {
        await copyRoleAndDirsThenDrop(tx, keep, extras);
        const item = await tx.query.items.findFirst({ where: eq(items.id, keep.itemId) });
        if (item) await syncDeviceTotals(tx, keep.itemId, item.attributes);
        for (const extra of extras) {
          const it = await tx.query.items.findFirst({ where: eq(items.id, extra.itemId) });
          if (it) await syncDeviceTotals(tx, extra.itemId, it.attributes);
        }
      });
      droppedVolumes += extras.length;
    } catch {
      skipped.push(g);
    }
  }
  let mergedDisks = 0;
  if (input.mergeDisks) {
    for (const m of plan.diskMerges) {
      try {
        for (const d of m.drop) {
          await db.update(items).set({ parentId: null }).where(eq(items.id, d.id));
          await db.delete(relations).where(and(eq(relations.fromItemId, d.id), eq(relations.type, "attached-to")));
          mergedDisks++;
        }
      } catch {
        /* keep going: one twin must not block the rest */
      }
    }
  }
  return { dry: false, droppedVolumes, skippedVolumes: skipped.length, mergedDisks, volumes: plan.volumes, skipped, diskMerges: plan.diskMerges };
}

/**
 * Use per data role over every volume of an active device, plus the unassigned
 * rest. Capacity is never attributed to a role: volumes of one container share
 * it, so free space belongs to no role (see capacityTotals).
 */
export async function roleTotals(db: Db) {
  const rows = await db
    .select({
      dataRole: storageVolumes.dataRole,
      volumes: sql<number>`count(*)`,
      usedBytes: sql<number>`sum(${storageVolumes.usedBytes})`,
    })
    .from(storageVolumes)
    .innerJoin(items, eq(items.id, storageVolumes.itemId))
    .where(eq(items.status, "active"))
    .groupBy(storageVolumes.dataRole);
  return rows.map((r) => ({
    dataRole: r.dataRole ?? null,
    volumes: Number(r.volumes),
    usedBytes: Number(r.usedBytes),
  }));
}

/** Capacity (each container once per device) and free space over every volume of an active device, the same scope as roleTotals. */
async function capacityTotals(db: Db): Promise<{ capacityBytes: number; freeBytes: number }> {
  const rows = await db
    .select({
      id: storageVolumes.id,
      itemId: storageVolumes.itemId,
      container: storageVolumes.container,
      capacityBytes: storageVolumes.capacityBytes,
      usedBytes: storageVolumes.usedBytes,
      measuredAt: storageVolumes.measuredAt,
    })
    .from(storageVolumes)
    .innerJoin(items, eq(items.id, storageVolumes.itemId))
    .where(eq(items.status, "active"));
  const byItem = new Map<number, typeof rows>();
  for (const r of rows) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
  let capacityBytes = 0;
  let usedBytes = 0;
  for (const vols of byItem.values()) {
    capacityBytes += deviceCapacity(vols);
    usedBytes += deviceUsed(vols);
  }
  return { capacityBytes, freeBytes: capacityBytes - usedBytes };
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

/** Machines that get a Storage card: computers and NAS boxes. */
const COMPUTER_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas"]);

/** Workflow keys on a computer: Storage pins starred machines first and hides the rest until "Show hidden". */
export const STORAGE_STARRED_KEY = "storage.starred";
export const STORAGE_HIDDEN_KEY = "storage.hidden";
/** Preferred tracker hostname / IP / MAC this computer is known by. */
export const MACHINE_ID_KEY = "machine.id";
const STORAGE_FLAG_YES = "yes";

function splitIdentityList(raw: string | number | null | undefined): string[] {
  if (raw == null || raw === "") return [];
  return String(raw)
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Hostname, IP, MAC and aliases a computer can be matched by — never the display name. */
export function machineIdentity(attrs: Record<string, string | number> | null | undefined): {
  machineId: string | null;
  hostname: string | null;
  ip: string | null;
  mac: string | null;
  aliases: string | null;
  identityOptions: string[];
} {
  const machineId = attrs?.[MACHINE_ID_KEY] != null && attrs[MACHINE_ID_KEY] !== "" ? String(attrs[MACHINE_ID_KEY]) : null;
  const hostname = attrs?.hostname != null && attrs.hostname !== "" ? String(attrs.hostname) : attrs?.host != null && attrs.host !== "" ? String(attrs.host) : null;
  const ip = attrs?.ip != null && attrs.ip !== "" ? String(attrs.ip) : attrs?.ip_address != null && attrs.ip_address !== "" ? String(attrs.ip_address) : null;
  const mac = attrs?.mac != null && attrs.mac !== "" ? String(attrs.mac) : attrs?.mac_address != null && attrs.mac_address !== "" ? String(attrs.mac_address) : null;
  const aliasParts = [...splitIdentityList(attrs?.aliases), ...splitIdentityList(attrs?.host_alias)];
  const aliases = aliasParts.length ? aliasParts.join(", ") : null;
  const identityOptions = [...new Set([machineId, hostname, ip, mac, ...aliasParts].filter((x): x is string => x != null && x !== ""))];
  return { machineId, hostname, ip, mac, aliases, identityOptions };
}

export function isStorageComputer(item: { attributes: Record<string, string | number> | null }): boolean {
  return COMPUTER_ROLES.has(String(item.attributes?.role ?? ""));
}

export function isDiskThing(item: { attributes: Record<string, string | number> | null }): boolean {
  return String(item.attributes?.role ?? "") === "storage";
}

export function storageViewFlags(attrs: Record<string, string | number> | null | undefined): { starred: boolean; hidden: boolean } {
  return {
    starred: attrs?.[STORAGE_STARRED_KEY] === STORAGE_FLAG_YES,
    hidden: attrs?.[STORAGE_HIDDEN_KEY] === STORAGE_FLAG_YES,
  };
}

/** Set or clear a Storage view flag on an attributes map. Returns whether anything changed. */
export function applyStorageViewFlag(next: Record<string, string | number>, key: typeof STORAGE_STARRED_KEY | typeof STORAGE_HIDDEN_KEY, on: boolean): boolean {
  if (on) {
    if (next[key] === STORAGE_FLAG_YES) return false;
    next[key] = STORAGE_FLAG_YES;
    return true;
  }
  if (!(key in next)) return false;
  delete next[key];
  return true;
}

type DeviceRow = { id: number; name: string; parentId: number | null; roomId: number | null; attributes: Record<string, string | number> | null };

function num(v: string | number | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

type DeviceLinks = {
  /** The device's `attached-to` relation (drive → computer), or null. */
  attachedRelationId: (id: number) => number | null;
  /** The items this device holds backups of (`backs-up` relations from it), active items only. */
  backsUp: (id: number) => Array<{ relationId: number; itemId: number; name: string }>;
};

type DeviceExtra = {
  volumes?: Awaited<ReturnType<typeof volumesForItems>>;
  diskKey?: string | null;
    inferred?: boolean;
    measure?: DiskMeasure;
    linkCandidates?: DiskLinkCandidate[];
    lastSeenAt?: Date | null;
    stale?: boolean;
    lastSeenLabel?: string | null;
};

/** One device with its volumes; without volumes the block comes from the lab keys (GB → bytes, decimal). */
function physicalDiskBytes(attrs: Record<string, string | number> | null | undefined, volumes: VolumeLike[]): number | null {
  const sizeBytes = num(attrs?.size_bytes);
  if (sizeBytes != null && sizeBytes > 0) return sizeBytes;
  const gb = num(attrs?.storage_gb);
  if (gb != null && gb > 0) return gb * 1e9;
  return volumes.length ? deviceCapacity(volumes) : null;
}

function deviceOf(row: DeviceRow, volumes: Awaited<ReturnType<typeof volumesForItems>>, roomName: string | null, links: DeviceLinks, extra?: DeviceExtra) {
  const raw = extra?.volumes ?? volumes.filter((v) => v.itemId === row.id);
  const mine = dedupeVolumesByMountPoint(raw);
  const measured = mine.length > 0;
  const gb = num(row.attributes?.storage_gb);
  const freeGb = num(row.attributes?.storage_free_gb);
  const capacityBytes = physicalDiskBytes(row.attributes, mine) ?? (gb != null ? gb * 1e9 : null);
  const usedBytes = measured ? deviceUsed(mine) : gb != null && freeGb != null ? Math.max(0, Math.min(gb, gb - freeGb)) * 1e9 : null;
  const freeBytes = capacityBytes != null && usedBytes != null ? capacityBytes - usedBytes : null;
  const capOf = containerCapacities(mine);
  const measure: DiskMeasure = extra?.measure ?? (measured ? "measured" : "no-collector");
  const lastSeenMs = newestMeasuredAt(mine);
  const stale = lastSeenMs != null && Date.now() - lastSeenMs > STALE_AFTER_MS;
  const lastSeenAt = lastSeenMs != null ? new Date(lastSeenMs) : extra?.lastSeenAt ?? null;
  return {
    id: row.id,
    name: row.name,
    kind: String(row.attributes?.role ?? "storage"),
    driveType: row.attributes?.drive_type != null ? String(row.attributes.drive_type) : null,
    parentId: row.parentId,
    roomName,
    capacityBytes,
    usedBytes,
    freeBytes,
    measured,
    measure,
    diskKey: extra?.diskKey ?? null,
    inferred: extra?.inferred ?? false,
    linkCandidates: extra?.linkCandidates ?? [],
    lastSeenAt,
    stale,
    lastSeenLabel: stale && lastSeenAt ? formatLastSeen(lastSeenAt) : null,
    serial: row.attributes?.serial != null && row.attributes.serial !== "" ? String(row.attributes.serial) : row.attributes?.serial_number != null && row.attributes.serial_number !== "" ? String(row.attributes.serial_number) : null,
    uuid: row.attributes?.uuid != null && row.attributes.uuid !== "" ? String(row.attributes.uuid) : row.attributes?.disk_uuid != null && row.attributes.disk_uuid !== "" ? String(row.attributes.disk_uuid) : null,
    attachedRelationId: links.attachedRelationId(row.id),
    backsUp: links.backsUp(row.id),
    volumes: mine.map((v) => ({
      id: v.id,
      mountPoint: v.mountPoint,
      label: v.label,
      fsType: v.fsType,
      device: v.device,
      container: v.container,
      capacityBytes: v.capacityBytes,
      usedBytes: v.usedBytes,
      /** This volume's share of its container (used ÷ container capacity), for the segment width. */
      shareOfContainer: (() => {
        const cap = capOf.get(containerKey(v)) ?? 0;
        return cap > 0 ? v.usedBytes / cap : 0;
      })(),
      dataRole: v.dataRole,
      measuredAt: v.measuredAt,
      dirCount: v.dirCount,
    })),
  };
}

/**
 * The relations the overview draws: `attached-to` (drive → computer) and
 * `backs-up` (holder → device), confirmed ones only, from the given devices.
 * One query per type plus one for the names of the backed-up items, whatever
 * the number of devices.
 */
async function deviceLinks(db: Db, deviceIds: number[], computerIds: Set<number>) {
  const ofType = (type: string) =>
    deviceIds.length === 0
      ? Promise.resolve([] as Array<typeof relations.$inferSelect>)
      : db
          .select()
          .from(relations)
          .where(and(eq(relations.type, type), eq(relations.status, "confirmed"), inArray(relations.fromItemId, deviceIds)))
          .orderBy(relations.id);
  const [attachedRels, backupRels] = await Promise.all([ofType("attached-to"), ofType("backs-up")]);
  // a device with several attached-to relations hangs under the first whose computer is shown; else it keeps its first one
  const attachedTo = new Map<number, { relationId: number; computerId: number | null }>();
  for (const r of attachedRels) {
    const shown = computerIds.has(r.toItemId);
    const prev = attachedTo.get(r.fromItemId);
    if (!prev || (prev.computerId == null && shown)) attachedTo.set(r.fromItemId, { relationId: r.id, computerId: shown ? r.toItemId : null });
  }
  const targetIds = [...new Set(backupRels.map((r) => r.toItemId))];
  // names come from every active item, whatever the house scope: a NAS may back up a device in another house
  const names = targetIds.length
    ? new Map(
        (await db.select({ id: items.id, name: items.name }).from(items).where(and(inArray(items.id, targetIds), eq(items.status, "active")))).map(
          (r) => [r.id, r.name] as const,
        ),
      )
    : new Map<number, string>();
  const backsUp = new Map<number, Array<{ relationId: number; itemId: number; name: string }>>();
  for (const r of backupRels) {
    const name = names.get(r.toItemId);
    if (name === undefined) continue;
    backsUp.set(r.fromItemId, [...(backsUp.get(r.fromItemId) ?? []), { relationId: r.id, itemId: r.toItemId, name }]);
  }
  return {
    /** The shown computer a device hangs under, or null. */
    hostOf: (id: number) => attachedTo.get(id)?.computerId ?? null,
    links: {
      attachedRelationId: (id: number) => attachedTo.get(id)?.relationId ?? null,
      backsUp: (id: number) => backsUp.get(id) ?? [],
    } satisfies DeviceLinks,
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
  const loose = devices.filter((d) => !computerIds.has(d.id) && !(d.parentId != null && computerIds.has(d.parentId)));
  const { hostOf, links } = await deviceLinks(db, devices.map((d) => d.id), computerIds);
  // an attached-to drive hangs under its computer only when that computer is shown; else it stays external
  const attached = loose.filter((d) => hostOf(d.id) != null);
  const unattached = loose.filter((d) => hostOf(d.id) == null);
  const claimedLoose = new Set<number>();
  const computersOut = computers.map((c) => {
    const childRows = internal.filter((d) => d.parentId === c.id);
    const attRows = attached.filter((d) => hostOf(d.id) === c.id);
    const computerVols = volumes.filter((v) => v.itemId === c.id);
    const looseDisks = unattached.filter((d) => isDiskThing(d) && !claimedLoose.has(d.id));
    const extras = [
      ...claimLooseDisks(computerVols, looseDisks),
      ...claimMachineDisks(
        computerVols,
        looseDisks.filter((d) => !claimedLoose.has(d.id)),
      ),
    ].filter((d, i, arr) => arr.findIndex((x) => x.id === d.id) === i);
    for (const d of extras) claimedLoose.add(d.id);
    const diskThings = [...childRows, ...attRows, ...extras];
    const ownOnDrives = new Map(diskThings.map((d) => [d.id, volumes.filter((v) => v.itemId === d.id)] as const));
    const linked = linkComputerDisks(computerVols, diskThings, ownOnDrives);
    const asDisk = (d: (typeof childRows)[number]) => {
      const built = deviceOf(d, volumes, d.roomName, links, {
        volumes: linked.volumesByDrive.get(d.id) ?? [],
        diskKey: linked.diskKeyByDrive.get(d.id) ?? null,
        measure: linked.measureByDrive.get(d.id),
        linkCandidates: linked.candidatesByDrive.get(d.id),
      });
      if (isNetworkDisk({ name: d.name, attributes: d.attributes, volumes: built.volumes })) {
        return { ...built, measure: "remote" as const };
      }
      return built;
    };
    const inferredDisks = linked.inferred.map((g) => {
      const remote = g.volumes.every(isNetworkVolume) || isNetworkDisk({ name: g.name, volumes: g.volumes });
      return deviceOf(
        { id: c.id, name: g.name, parentId: c.id, roomId: c.roomId, attributes: { role: "disk" } },
        volumes,
        c.roomName,
        links,
        {
          volumes: g.volumes,
          diskKey: g.diskKey,
          inferred: true,
          measure: remote ? "remote" : "measured",
          linkCandidates: g.candidates,
        },
      );
    });
    const computer = deviceOf(c, volumes, c.roomName, links, { volumes: [] });
    const stacked = collapseSameMachineTwins({
      id: c.id,
      drives: childRows.map((d) => asDisk(d)),
      attached: [...attRows, ...extras].map((d) => asDisk(d)),
      inferredDisks,
      volumes: [],
    });
    const split = splitMachineDisks(stacked);
    return {
      ...computer,
      ...storageViewFlags(c.attributes),
      ...machineIdentity(c.attributes),
      volumes: split.inferredDisks.flatMap((d) => d.volumes),
      drives: split.drives,
      attached: split.attached,
      inferredDisks: split.inferredDisks,
      unlinkedDisks: split.unlinkedDisks,
      remoteMounts: split.remoteMounts,
    };
  });
  const hiddenMoved = hideMovedDisks(computersOut);
  const externals = unattached.filter((d) => !claimedLoose.has(d.id)).map((d) => deviceOf(d, volumes, d.roomName, links));
  const totals = await roleTotals(db);
  const { capacityBytes, freeBytes } = await capacityTotals(db);
  return {
    computers: hiddenMoved.sort((a, b) => Number(b.starred) - Number(a.starred) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    externals,
    totals,
    capacityBytes,
    freeBytes,
    unassignedVolumes: totals.find((t) => t.dataRole === null)?.volumes ?? 0,
  };
}

type OverviewDisk = ReturnType<typeof deviceOf>;
type OverviewMachine = {
  id: number;
  drives: OverviewDisk[];
  attached: OverviewDisk[];
  inferredDisks: OverviewDisk[];
  volumes: OverviewDisk["volumes"];
  unlinkedDisks?: OverviewDisk[];
  remoteMounts?: OverviewDisk[];
};

function preferTwin(a: OverviewDisk, b: OverviewDisk): OverviewDisk {
  const score = (d: OverviewDisk) => (d.inferred ? 0 : 4) + (d.serial ? 2 : 0) + (d.volumes.length > 0 ? 1 : 0);
  const d = score(b) - score(a);
  if (d !== 0) return d > 0 ? b : a;
  return a.id <= b.id ? a : b;
}

function collapseSameMachineTwins<T extends OverviewMachine>(c: T): T {
  type Loc = { kind: "drives" | "attached" | "inferredDisks"; index: number };
  const locs: Array<Loc & { disk: OverviewDisk }> = [];
  for (const kind of ["drives", "attached", "inferredDisks"] as const) {
    (c[kind] ?? []).forEach((disk, index) => locs.push({ kind, index, disk }));
  }
  const groups = clusterByTwinKeys(locs, (loc) =>
    machineTwinKeys({
      name: loc.disk.name,
      capacityBytes: loc.disk.capacityBytes,
      serial: loc.disk.serial,
      uuid: loc.disk.uuid,
      attributes: undefined,
      volumes: loc.disk.volumes,
    }),
  );
  const drop = new Set<string>();
  const keepVols = new Map<string, OverviewDisk["volumes"]>();
  for (const members of groups) {
    if (members.length < 2) continue;
    const keep = members.reduce((a, b) => (preferTwin(a.disk, b.disk) === b.disk ? b : a));
    let vols = [...keep.disk.volumes];
    for (const m of members) {
      if (m === keep) continue;
      drop.add(`${m.kind}:${m.index}`);
      vols = dedupeVolumesByMountPoint([...vols, ...m.disk.volumes]);
    }
    keepVols.set(`${keep.kind}:${keep.index}`, vols);
  }
  const rewrite = (kind: "drives" | "attached" | "inferredDisks") =>
    (c[kind] ?? [])
      .map((d, i) => {
        const vols = keepVols.get(`${kind}:${i}`);
        return vols
          ? {
              ...d,
              volumes: vols,
              usedBytes: deviceUsed(vols),
              freeBytes: d.capacityBytes != null ? d.capacityBytes - deviceUsed(vols) : d.freeBytes,
              measured: vols.length > 0,
              measure: vols.length > 0 ? ("measured" as const) : d.measure,
            }
          : d;
      })
      .filter((_, i) => !drop.has(`${kind}:${i}`));
  const inferredDisks = rewrite("inferredDisks");
  return { ...c, drives: rewrite("drives"), attached: rewrite("attached"), inferredDisks, volumes: inferredDisks.flatMap((d) => d.volumes) };
}

function splitMachineDisks<T extends OverviewMachine>(c: T): T & { unlinkedDisks: OverviewDisk[]; remoteMounts: OverviewDisk[] } {
  const remoteMounts: OverviewDisk[] = [];
  const unlinkedDisks: OverviewDisk[] = [];
  const take = (list: OverviewDisk[]) => {
    const rest: OverviewDisk[] = [];
    for (const d of list) {
      if (d.measure === "remote" || isNetworkDisk({ name: d.name, volumes: d.volumes })) remoteMounts.push({ ...d, measure: "remote" });
      else if (d.measure === "unlinked" && d.volumes.length === 0) unlinkedDisks.push(d);
      else rest.push(d);
    }
    return rest;
  };
  const inferredDisks = take(c.inferredDisks ?? []);
  return {
    ...c,
    drives: take(c.drives),
    attached: take(c.attached),
    inferredDisks,
    unlinkedDisks,
    remoteMounts,
    volumes: inferredDisks.flatMap((d) => d.volumes),
  };
}

function hideMovedDisks<T extends OverviewMachine>(computers: T[]): T[] {
  type Hit = { computerId: number; kind: "drives" | "attached" | "inferredDisks"; index: number; key: string; at: number };
  const hits: Hit[] = [];
  for (const c of computers) {
    for (const kind of ["drives", "attached", "inferredDisks"] as const) {
      (c[kind] ?? []).forEach((d, index) => {
        const key = diskSightingKey(d);
        const at = newestMeasuredAt(d.volumes) ?? 0;
        if (key) hits.push({ computerId: c.id, kind, index, key, at });
      });
    }
  }
  const best = new Map<string, { at: number; computerId: number }>();
  for (const h of hits) {
    const prev = best.get(h.key);
    if (!prev || h.at > prev.at) best.set(h.key, { at: h.at, computerId: h.computerId });
  }
  const hide = new Set(
    hits.filter((h) => {
      const w = best.get(h.key)!;
      return w.computerId !== h.computerId && w.at > h.at;
    }).map((h) => `${h.computerId}:${h.kind}:${h.index}`),
  );
  const keep = (c: T, kind: "drives" | "attached" | "inferredDisks") =>
    (c[kind] ?? []).filter((_, i) => !hide.has(`${c.id}:${kind}:${i}`));
  return computers.map((c) => {
    const inferredDisks = keep(c, "inferredDisks");
    return { ...c, drives: keep(c, "drives"), attached: keep(c, "attached"), inferredDisks, volumes: inferredDisks.flatMap((d) => d.volumes) };
  });
}
