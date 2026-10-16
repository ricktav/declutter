import { and, eq, inArray, sql } from "drizzle-orm";
import { items, relations, rooms, storageDirs, storageVolumes, type DataRole } from "@db/schema";
import type { getDb } from "../queries/connection";
import {
  claimLooseDisks,
  diskSightingKey,
  formatLastSeen,
  linkComputerDisks,
  newestMeasuredAt,
  physicalDiskKey,
  STALE_AFTER_MS,
  type DiskLinkCandidate,
  type DiskMeasure,
} from "./storageDisks";

export { STORAGE_DISK_KEY, physicalDiskKey, STALE_AFTER_MS, formatLastSeen, type DiskMeasure } from "./storageDisks";

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
  const reportedCapacity = new Map<string, number>();
  for (const v of input.volumes) {
    if (v.container == null) continue;
    const seen = reportedCapacity.get(v.container);
    if (seen !== undefined && seen !== v.capacityBytes) throw new StorageReportError(`container ${v.container}: capacity differs between volumes.`);
    reportedCapacity.set(v.container, v.capacityBytes);
  }
  const now = new Date();
  const measuredAtOf = (v: ReportVolume): Date => {
    if (v.measuredAt == null || v.measuredAt === "") return now;
    const at = v.measuredAt instanceof Date ? v.measuredAt : new Date(v.measuredAt);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= 0) return now;
    return at.getTime() > now.getTime() ? now : at;
  };
  let dirCount = 0;
  await db.transaction(async (tx) => {
    // read the item again inside the transaction so the attribute merge sees the same row it writes
    const current = await tx.query.items.findFirst({ where: eq(items.id, input.itemId) });
    if (!current) throw new StorageReportError("Item not found.");
    for (const v of input.volumes) {
      const measuredAt = measuredAtOf(v);
      await tx
        .insert(storageVolumes)
        .values({
          itemId: input.itemId,
          mountPoint: v.mountPoint,
          label: v.label ?? null,
          fsType: v.fsType ?? null,
          device: v.device ?? null,
          container: v.container ?? null,
          capacityBytes: v.capacityBytes,
          usedBytes: v.usedBytes,
          source: input.source,
          measuredAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            label: v.label ?? null,
            fsType: v.fsType ?? null,
            device: v.device ?? null,
            container: v.container ?? null,
            capacityBytes: v.capacityBytes,
            usedBytes: v.usedBytes,
            source: input.source,
            measuredAt,
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
    if (reportedCapacity.size > 0) {
      // the stored volumes of a container (this report's and earlier ones) must fit in its capacity
      const stored = await tx.select().from(storageVolumes).where(eq(storageVolumes.itemId, input.itemId));
      for (const [container, capacity] of reportedCapacity) {
        const used = deviceUsed(stored.filter((r) => r.container === container));
        if (used > capacity) throw new StorageReportError(`container ${container}: volumes use ${used} bytes, above its capacity (${capacity}).`);
      }
    }
    await syncDeviceTotals(tx, input.itemId, current.attributes);
  });
  return { volumes: input.volumes.length, dirs: dirCount };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Keep the whole-device lab keys (storage_gb, storage_free_gb) in step with the
 * volumes we know: capacity once per container, use summed over every volume.
 * With no volume left the keys stay as they are: the hand-entered value may be
 * all we have.
 */
async function syncDeviceTotals(tx: Tx, itemId: number, attributes: Record<string, string | number> | null) {
  const all = await tx.select().from(storageVolumes).where(eq(storageVolumes.itemId, itemId));
  if (all.length === 0) return;
  const capacity = deviceCapacity(all);
  const used = deviceUsed(all);
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
function deviceOf(row: DeviceRow, volumes: Awaited<ReturnType<typeof volumesForItems>>, roomName: string | null, links: DeviceLinks, extra?: DeviceExtra) {
  const mine = extra?.volumes ?? volumes.filter((v) => v.itemId === row.id);
  const measured = mine.length > 0;
  const gb = num(row.attributes?.storage_gb);
  const freeGb = num(row.attributes?.storage_free_gb);
  const capacityBytes = measured ? deviceCapacity(mine) : gb != null ? gb * 1e9 : null;
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
    const extras = claimLooseDisks(
      computerVols,
      unattached.filter((d) => isDiskThing(d) && !claimedLoose.has(d.id)),
    );
    for (const d of extras) claimedLoose.add(d.id);
    const diskThings = [...childRows, ...attRows, ...extras];
    const ownOnDrives = new Map(diskThings.map((d) => [d.id, volumes.filter((v) => v.itemId === d.id)] as const));
    const linked = linkComputerDisks(computerVols, diskThings, ownOnDrives);
    const asDisk = (d: (typeof childRows)[number]) =>
      deviceOf(d, volumes, d.roomName, links, {
        volumes: linked.volumesByDrive.get(d.id) ?? [],
        diskKey: linked.diskKeyByDrive.get(d.id) ?? null,
        measure: linked.measureByDrive.get(d.id),
        linkCandidates: linked.candidatesByDrive.get(d.id),
      });
    const inferredDisks = linked.inferred.map((g) =>
      deviceOf(
        { id: c.id, name: g.name, parentId: c.id, roomId: c.roomId, attributes: { role: "disk" } },
        volumes,
        c.roomName,
        links,
        {
          volumes: g.volumes,
          diskKey: g.diskKey,
          inferred: true,
          measure: "measured",
          linkCandidates: g.candidates,
        },
      ),
    );
    const computer = deviceOf(c, volumes, c.roomName, links, { volumes: [] });
    return {
      ...computer,
      ...storageViewFlags(c.attributes),
      ...machineIdentity(c.attributes),
      volumes: inferredDisks.flatMap((d) => d.volumes),
      drives: childRows.map((d) => asDisk(d)),
      attached: [...attRows, ...extras].map((d) => asDisk(d)),
      inferredDisks,
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
};

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
