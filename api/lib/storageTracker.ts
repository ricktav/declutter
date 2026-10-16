/**
 * Import Data Tracker GET /api/sources (type=file) into storage.report.
 * Tracker already has Machine → Disk → Volume; HomeBase volumes stay on the
 * computer item (existing collectors) and overview groups them by `device`.
 * This module matches DT disks onto drive Things (serial, then model+size)
 * and sets `storage.disk` so grouping does not guess. Unmatched disks are
 * created as child/attached Things, or inferred in the overview until then.
 */
import { and, eq, inArray } from "drizzle-orm";
import { items, relations } from "@db/schema";
import type { getDb } from "../queries/connection";
import { logEvent } from "./events";
import { machineHintFromItem, matchMachine, machineHostKeys, normHost } from "./servicesFleet";
import { STORAGE_DISK_KEY, physicalDiskKey } from "./storageDisks";
import { applyReport, isDiskThing, isStorageComputer, isStorageDevice, type ReportVolume } from "./storage";

type Db = ReturnType<typeof getDb>;

export const TRACKER_SOURCE = "data-tracker";

/** DT host → HomeBase hostname, item id, or null to skip a stale/duplicate host. */
export const DEFAULT_TRACKER_HOST_MAP: Record<string, string | number | null> = {
  dockermac: "dockermac-1",
  "plugwise-pi": "plugwisepi",
  Mac: null,
};

export type TrackerHostMap = Record<string, string | number | null>;

export type TrackerDisk = {
  host: string;
  diskKey: string;
  name: string;
  model: string | null;
  serial: string | null;
  sizeBytes: number | null;
  mountpoints: string[];
};

export type TrackerVolume = {
  host: string;
  mountPoint: string;
  device: string | null;
  fsType: string | null;
  label: string | null;
  container: string | null;
  capacityBytes: number;
  usedBytes: number;
  diskName: string | null;
  diskKey: string | null;
};

export type ParsedTrackerSources = { disks: TrackerDisk[]; volumes: TrackerVolume[]; skipped: number };

type Attrs = Record<string, string | number> | null;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

const SIZE_MULT: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1e3,
  kib: 1024,
  mb: 1e6,
  mib: 1024 ** 2,
  gb: 1e9,
  gib: 1024 ** 3,
  tb: 1e12,
  tib: 1024 ** 4,
};

/** Bytes from a tracker size: 250GB, 4.0TB, 244e9, or a small number as GB. */
export function parseTrackerSize(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    if (v === 0) return 0;
    return Math.round(v >= 1e6 ? v : v * 1e9);
  }
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*(bytes?|b|ki?b|mi?b|gi?b|ti?b)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? (n >= 1e6 ? "b" : "gb")).toLowerCase();
  const mult = SIZE_MULT[unit] ?? 1;
  return Math.round(n * mult);
}

function listOfStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((x): x is string => x != null);
  const s = str(v);
  return s ? s.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [];
}

const SKIP_FS = new Set(["tmpfs", "devtmpfs", "overlay", "squashfs", "ramfs", "proc", "sysfs"]);

function skipFs(fsType: string | null): boolean {
  return fsType != null && SKIP_FS.has(fsType.toLowerCase());
}

function looksLikeDiskRest(rest: string): boolean {
  if (!rest || rest.startsWith("/")) return false;
  return /^(disk\d+|[hsv]d[a-z]+|[svx]vd[a-z]+|nvme\d+n\d+|mmcblk\d+|nvme\d+)$/i.test(rest);
}

function hostAndRest(name: string): { host: string; rest: string } | null {
  const i = name.indexOf(":");
  if (i <= 0) return null;
  const host = name.slice(0, i).trim();
  const rest = name.slice(i + 1).trim();
  if (!host) return null;
  return { host, rest };
}

function flattenSource(raw: unknown): Record<string, unknown> | null {
  const row = asRecord(raw);
  if (!row) return null;
  const meta = asRecord(row.metadata) ?? asRecord(row.meta) ?? {};
  return { ...row, ...meta };
}

function sourceKind(row: Record<string, unknown>, rest: string | null): "disk" | "volume" | null {
  const kind = str(row.kind ?? row.source_kind ?? row.file_kind)?.toLowerCase();
  if (kind === "disk" || kind === "drive") return "disk";
  if (kind === "volume" || kind === "vol" || kind === "mount") return "volume";
  if (str(row.disk) && str(row.disk) !== str(row.name)) return "volume";
  if (row.used != null || row.usedBytes != null || row.usage_pct != null || row.usagePct != null) return "volume";
  if (Array.isArray(row.mountpoints) || Array.isArray(row.mount_points)) return "disk";
  if (rest?.startsWith("/")) return "volume";
  if (rest && looksLikeDiskRest(rest)) return "disk";
  return null;
}

function diskKeyOf(name: string | null, device: string | null): string | null {
  if (name) {
    const parts = hostAndRest(name);
    const rest = parts?.rest ?? name;
    if (rest && looksLikeDiskRest(rest)) return physicalDiskKey(rest, rest) ?? rest.toLowerCase();
  }
  return physicalDiskKey(device, null);
}

function serialOf(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const n = s.replace(/\s+/g, "");
  if (!n) return null;
  if (/^(unknown|none|n\/?a|null|-|0)$/i.test(n)) return null;
  return n.toUpperCase();
}

function modelOf(row: Record<string, unknown>): string | null {
  return str(row.model) ?? str(row.product) ?? str(row.media_name) ?? null;
}

/**
 * Read GET /api/sources JSON (array, `{ sources }`, or `{ data }`).
 * Only `type=file` rows become disks and volumes. Other types are skipped.
 */
export function parseTrackerSources(payload: unknown): ParsedTrackerSources {
  const root = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.sources)
      ? root!.sources
      : Array.isArray(root?.data)
        ? root!.data
        : Array.isArray(root?.items)
          ? root!.items
          : [];
  const disks: TrackerDisk[] = [];
  const volumes: TrackerVolume[] = [];
  let skipped = 0;
  for (const raw of list.slice(0, 2000)) {
    const row = flattenSource(raw);
    if (!row) {
      skipped++;
      continue;
    }
    const type = str(row.type)?.toLowerCase();
    if (type && type !== "file") {
      skipped++;
      continue;
    }
    const name = str(row.name);
    const parts = name ? hostAndRest(name) : null;
    const host = str(row.host) ?? str(row.hostname) ?? parts?.host;
    if (!host) {
      skipped++;
      continue;
    }
    const kind = sourceKind(row, parts?.rest ?? null);
    if (kind === "disk") {
      const diskKey = diskKeyOf(name, str(row.device));
      if (!diskKey) {
        skipped++;
        continue;
      }
      disks.push({
        host,
        diskKey,
        name: name ?? `${host}:${diskKey}`,
        model: modelOf(row),
        serial: serialOf(row.serial ?? row.serial_number ?? row.SerialNumber),
        sizeBytes: parseTrackerSize(row.size ?? row.sizeBytes ?? row.capacity ?? row.capacityBytes),
        mountpoints: listOfStrings(row.mountpoints ?? row.mount_points),
      });
      continue;
    }
    if (kind === "volume") {
      const mountPoint = (parts?.rest?.startsWith("/") ? parts.rest : null) ?? str(row.mountpoint ?? row.mountPoint ?? row.path);
      const capacityBytes = parseTrackerSize(row.size ?? row.sizeBytes ?? row.capacity ?? row.capacityBytes);
      if (!mountPoint || capacityBytes == null || capacityBytes <= 0) {
        skipped++;
        continue;
      }
      const fsType = str(row.fstype ?? row.fsType ?? row.fs);
      if (skipFs(fsType)) {
        skipped++;
        continue;
      }
      const usedRaw = parseTrackerSize(row.used ?? row.usedBytes);
      const pct = typeof row.usage_pct === "number" ? row.usage_pct : typeof row.usagePct === "number" ? row.usagePct : null;
      const usedBytes = Math.min(capacityBytes, Math.max(0, usedRaw ?? (pct != null && pct >= 0 ? Math.round((capacityBytes * pct) / 100) : 0)));
      const diskName = str(row.disk);
      volumes.push({
        host,
        mountPoint: mountPoint.slice(0, 255),
        device: (str(row.device) ?? diskKeyOf(diskName, null))?.slice(0, 128) ?? null,
        fsType: fsType?.slice(0, 32) ?? null,
        label: (str(row.label) ?? str(row.volume) ?? (mountPoint === "/" ? "/" : mountPoint.split("/").filter(Boolean).pop() ?? null))?.slice(0, 128) ?? null,
        container: str(row.container)?.slice(0, 64) ?? null,
        capacityBytes,
        usedBytes,
        diskName,
        diskKey: diskKeyOf(diskName, str(row.device)),
      });
      continue;
    }
    skipped++;
  }
  const byDisk = new Map<string, TrackerDisk>();
  for (const d of disks) byDisk.set(`${normHost(d.host)}:${d.diskKey}`, d);
  const byVol = new Map<string, TrackerVolume>();
  for (const v of volumes) byVol.set(`${normHost(v.host)}:${v.mountPoint}`, v);
  return { disks: [...byDisk.values()], volumes: [...byVol.values()], skipped };
}

function attrStr(attrs: Attrs, key: string): string | null {
  const v = attrs?.[key];
  if (v == null || v === "") return null;
  return String(v);
}

function num(v: string | number | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function sizeClose(storageGb: number | null, bytes: number | null): boolean {
  if (storageGb == null || bytes == null || !(bytes > 0)) return false;
  return Math.abs(storageGb * 1e9 - bytes) / bytes <= 0.2;
}

function normModel(s: string | null): string | null {
  if (!s) return null;
  const n = s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return n || null;
}

function thingModel(d: { name: string; attributes: Attrs }): string {
  return [attrStr(d.attributes, "model"), attrStr(d.attributes, "brand"), d.name].filter(Boolean).join(" ");
}

function lookupHostMap(host: string, hostMap: TrackerHostMap): { skip: true } | { skip: false; mapped: string | number } {
  const n = normHost(host);
  for (const [k, v] of Object.entries(hostMap)) {
    if (normHost(k) !== n) continue;
    if (v == null || v === "") return { skip: true };
    return { skip: false, mapped: v };
  }
  return { skip: false, mapped: host };
}

function isHostThing(item: InventoryItem): boolean {
  const role = String(item.attributes?.role ?? "");
  return isStorageComputer({ attributes: item.attributes }) || role === "nas";
}

const INTERNAL_MOUNTS = new Set(["/", "/boot", "/boot/efi", "/System/Volumes/Data"]);

function diskLooksInternal(disk: TrackerDisk, volumes: TrackerVolume[]): boolean {
  const mounts = disk.mountpoints.length ? disk.mountpoints : volumes.map((v) => v.mountPoint);
  return mounts.some((m) => INTERNAL_MOUNTS.has(m));
}

export type TrackerDiskMatch = {
  diskKey: string;
  name: string;
  model: string | null;
  serial: string | null;
  sizeBytes: number | null;
  itemId: number | null;
  itemName: string | null;
  match: "serial" | "model-size" | "create" | "inferred" | "ambiguous" | "override";
  internal: boolean;
  candidates: Array<{ id: number; name: string }>;
};

export type TrackerHostPlan = {
  host: string;
  itemId: number | null;
  itemName: string | null;
  status: "matched" | "skipped" | "unmatched" | "ambiguous";
  reason?: string;
  disks: TrackerDiskMatch[];
  volumes: ReportVolume[];
};

export type TrackerImportPlan = { dry: boolean; hosts: TrackerHostPlan[]; skippedSources: number };

export type InventoryItem = {
  id: number;
  name: string;
  areaId: number;
  houseId: number | null;
  roomId: number | null;
  parentId: number | null;
  attributes: Attrs;
};

function matchDiskToThings(disk: TrackerDisk, things: InventoryItem[]): Omit<TrackerDiskMatch, "internal"> {
  const serial = disk.serial;
  if (serial) {
    const hits = things.filter((t) => serialOf(attrStr(t.attributes, "serial")) === serial);
    if (hits.length === 1) {
      const t = hits[0];
      const existing = attrStr(t.attributes, STORAGE_DISK_KEY);
      return {
        diskKey: disk.diskKey,
        name: disk.model ?? disk.diskKey,
        model: disk.model,
        serial: disk.serial,
        sizeBytes: disk.sizeBytes,
        itemId: t.id,
        itemName: t.name,
        match: existing && existing !== disk.diskKey ? "override" : "serial",
        candidates: [],
      };
    }
    if (hits.length > 1) {
      return {
        diskKey: disk.diskKey,
        name: disk.model ?? disk.diskKey,
        model: disk.model,
        serial: disk.serial,
        sizeBytes: disk.sizeBytes,
        itemId: null,
        itemName: null,
        match: "ambiguous",
        candidates: hits.map((t) => ({ id: t.id, name: t.name })),
      };
    }
  }
  const want = normModel(disk.model);
  if (want && disk.sizeBytes) {
    const hits = things.filter((t) => {
      const hay = normModel(thingModel(t));
      if (!hay || !hay.includes(want)) return false;
      return sizeClose(num(t.attributes?.storage_gb), disk.sizeBytes);
    });
    if (hits.length === 1) {
      const t = hits[0];
      const existing = attrStr(t.attributes, STORAGE_DISK_KEY);
      return {
        diskKey: disk.diskKey,
        name: disk.model ?? disk.diskKey,
        model: disk.model,
        serial: disk.serial,
        sizeBytes: disk.sizeBytes,
        itemId: t.id,
        itemName: t.name,
        match: existing && existing !== disk.diskKey ? "override" : "model-size",
        candidates: [],
      };
    }
    if (hits.length > 1) {
      return {
        diskKey: disk.diskKey,
        name: disk.model ?? disk.diskKey,
        model: disk.model,
        serial: disk.serial,
        sizeBytes: disk.sizeBytes,
        itemId: null,
        itemName: null,
        match: "ambiguous",
        candidates: hits.map((t) => ({ id: t.id, name: t.name })),
      };
    }
  }
  return {
    diskKey: disk.diskKey,
    name: disk.model ?? disk.diskKey,
    model: disk.model,
    serial: disk.serial,
    sizeBytes: disk.sizeBytes,
    itemId: null,
    itemName: null,
    match: "create",
    candidates: things.map((t) => ({ id: t.id, name: t.name })),
  };
}

function volumesForReport(vols: TrackerVolume[]): ReportVolume[] {
  return vols.slice(0, 64).map((v) => ({
    mountPoint: v.mountPoint,
    label: v.label,
    fsType: v.fsType,
    device: v.device,
    container: v.container,
    capacityBytes: v.capacityBytes,
    usedBytes: v.usedBytes,
  }));
}

/**
 * Match DT hosts to computer Things and DT disks to drive Things.
 * Does not write. `create` means apply will insert a disk Thing; until then
 * overview infers it from the volume's `device`.
 */
export function planTrackerImport(
  parsed: ParsedTrackerSources,
  inventory: InventoryItem[],
  attached: Array<{ fromItemId: number; toItemId: number }>,
  hostMap: TrackerHostMap = DEFAULT_TRACKER_HOST_MAP,
  dry = true,
): TrackerImportPlan {
  const hosts = inventory.filter(isHostThing);
  const disks = inventory.filter((d) => isDiskThing({ attributes: d.attributes }));
  const attachedTo = new Map<number, number>();
  for (const r of attached) attachedTo.set(r.fromItemId, r.toItemId);
  const disksOf = (computerId: number) =>
    disks.filter((d) => d.parentId === computerId || attachedTo.get(d.id) === computerId);

  const hostNames = [...new Set([...parsed.disks.map((d) => d.host), ...parsed.volumes.map((v) => v.host)])].sort();
  const planHosts: TrackerHostPlan[] = [];

  for (const host of hostNames) {
    const mapped = lookupHostMap(host, hostMap);
    if (mapped.skip) {
      planHosts.push({ host, itemId: null, itemName: null, status: "skipped", reason: "host map", disks: [], volumes: [] });
      continue;
    }
    let item: InventoryItem | null = null;
    let status: TrackerHostPlan["status"] = "matched";
    let reason: string | undefined;
    if (typeof mapped.mapped === "number") {
      item = hosts.find((h) => h.id === mapped.mapped) ?? null;
      if (!item) {
        status = "unmatched";
        reason = `item #${mapped.mapped}`;
      }
    } else {
      const hints = hosts.map(machineHintFromItem);
      const n = normHost(mapped.mapped);
      const hits = hints.filter((m) => machineHostKeys(m).includes(n));
      if (hits.length > 1) {
        status = "ambiguous";
        reason = hits.map((h) => h.name).join(", ");
      } else if (hits.length === 1) {
        item = hosts.find((h) => h.id === hits[0].id) ?? null;
      } else {
        const m = matchMachine(mapped.mapped, hints);
        item = m ? (hosts.find((h) => h.id === m.id) ?? null) : null;
        if (!item) status = "unmatched";
      }
    }
    const hostDisks = parsed.disks.filter((d) => normHost(d.host) === normHost(host));
    const hostVols = parsed.volumes.filter((v) => normHost(v.host) === normHost(host) && v.usedBytes <= v.capacityBytes);
    if (!item) {
      planHosts.push({ host, itemId: null, itemName: null, status, reason, disks: [], volumes: [] });
      continue;
    }
    const things = disksOf(item.id);
    const diskPlans = hostDisks.map((d) => {
      const vols = hostVols.filter((v) => v.diskKey === d.diskKey);
      const internal = diskLooksInternal(d, vols);
      const m = matchDiskToThings(d, things);
      if (m.match === "create" && vols.length === 0) return { ...m, match: "inferred" as const, internal };
      return { ...m, internal };
    });
    for (const v of hostVols) {
      if (v.diskKey && !diskPlans.some((d) => d.diskKey === v.diskKey)) {
        diskPlans.push({
          diskKey: v.diskKey,
          name: v.diskKey,
          model: null,
          serial: null,
          sizeBytes: null,
          itemId: null,
          itemName: null,
          match: "inferred",
          internal: INTERNAL_MOUNTS.has(v.mountPoint),
          candidates: things.map((t) => ({ id: t.id, name: t.name })),
        });
      }
    }
    planHosts.push({
      host,
      itemId: item.id,
      itemName: item.name,
      status: "matched",
      disks: diskPlans,
      volumes: volumesForReport(hostVols),
    });
  }
  return { dry, hosts: planHosts, skippedSources: parsed.skipped };
}

function mergeAttrs(current: Attrs, patch: Record<string, string | number | null>): { next: Record<string, string | number>; changed: string[] } {
  const next: Record<string, string | number> = { ...(current ?? {}) };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") continue;
    if (next[k] === v) continue;
    if (k !== STORAGE_DISK_KEY && next[k] != null && next[k] !== "") continue;
    if (k === STORAGE_DISK_KEY && next[k] != null && next[k] !== "" && next[k] !== v) continue;
    next[k] = v;
    changed.push(`${k} = ${v}`);
  }
  return { next, changed };
}

export type TrackerImportResult = TrackerImportPlan & {
  applied: { reports: number; volumes: number; diskLinks: number; created: number };
};

/**
 * Dry-run (default) returns the plan. Apply writes storage.report per computer
 * (no dirs: local collector keeps those), sets `storage.disk` when absent, and
 * creates a disk Thing when DT has a disk with volumes and no match.
 */
export async function applyTrackerImport(
  db: Db,
  input: { sources: unknown; dry?: boolean; hostMap?: TrackerHostMap },
): Promise<TrackerImportResult> {
  const dry = input.dry !== false;
  const parsed = parseTrackerSources(input.sources);
  const all = await db
    .select({
      id: items.id,
      name: items.name,
      areaId: items.areaId,
      houseId: items.houseId,
      roomId: items.roomId,
      parentId: items.parentId,
      attributes: items.attributes,
      status: items.status,
    })
    .from(items)
    .where(eq(items.status, "active"));
  const inventory = all.filter((r) => isStorageDevice(r));
  const computerIds = inventory.filter(isHostThing).map((h) => h.id);
  const attached =
    computerIds.length === 0
      ? []
      : await db
          .select({ fromItemId: relations.fromItemId, toItemId: relations.toItemId })
          .from(relations)
          .where(and(eq(relations.type, "attached-to"), eq(relations.status, "confirmed"), inArray(relations.toItemId, computerIds)));
  const plan = planTrackerImport(parsed, inventory, attached, input.hostMap ?? DEFAULT_TRACKER_HOST_MAP, dry);
  const applied = { reports: 0, volumes: 0, diskLinks: 0, created: 0 };
  if (dry) return { ...plan, applied };

  const byId = new Map(inventory.map((i) => [i.id, i]));
  for (const host of plan.hosts) {
    if (host.status !== "matched" || host.itemId == null) continue;
    const computer = byId.get(host.itemId);
    if (!computer) continue;
    if (host.volumes.length > 0) {
      const result = await applyReport(db, { itemId: host.itemId, source: TRACKER_SOURCE, volumes: host.volumes });
      applied.reports++;
      applied.volumes += result.volumes;
      await logEvent({
        entityType: "item",
        entityId: host.itemId,
        action: "storage.report",
        actor: "system",
        summary: `${TRACKER_SOURCE} reported ${result.volumes} volume(s) for ${host.host}`,
        payload: { source: TRACKER_SOURCE, host: host.host, volumes: host.volumes.map((v) => v.mountPoint) },
      });
    }
    for (const disk of host.disks) {
      let itemId = disk.itemId;
      if (disk.match === "create" && itemId == null) {
        const attrs: Record<string, string | number> = {
          role: "storage",
          ...(disk.model ? { model: disk.model } : {}),
          ...(disk.serial ? { serial: disk.serial } : {}),
          ...(disk.sizeBytes ? { storage_gb: Math.round(disk.sizeBytes / 1e9) } : {}),
          [STORAGE_DISK_KEY]: disk.diskKey,
        };
        const [{ id }] = await db
          .insert(items)
          .values({
            areaId: computer.areaId,
            houseId: computer.houseId,
            roomId: disk.internal ? computer.roomId : computer.roomId,
            parentId: disk.internal ? computer.id : null,
            name: (disk.model ?? disk.diskKey).slice(0, 255),
            attributes: attrs,
            verificationStatus: "detected",
          })
          .$returningId();
        itemId = id;
        disk.itemId = id;
        disk.itemName = attrs.model ? String(attrs.model) : disk.diskKey;
        applied.created++;
        applied.diskLinks++;
        await logEvent({
          entityType: "item",
          entityId: id,
          action: "created",
          actor: "system",
          summary: `Item "${disk.model ?? disk.diskKey}" created`,
          payload: { from: TRACKER_SOURCE, host: host.host, diskKey: disk.diskKey },
        });
        if (!disk.internal) {
          await db.insert(relations).values({
            fromItemId: id,
            toItemId: computer.id,
            type: "attached-to",
            origin: "user",
            status: "confirmed",
          });
        }
        continue;
      }
      if (itemId == null || disk.match === "ambiguous" || disk.match === "inferred") continue;
      if (disk.match === "override") continue;
      const row = byId.get(itemId) ?? (await db.query.items.findFirst({ where: eq(items.id, itemId) }));
      if (!row) continue;
      const { next, changed } = mergeAttrs(row.attributes, {
        [STORAGE_DISK_KEY]: disk.diskKey,
        ...(disk.serial ? { serial: disk.serial } : {}),
        ...(disk.model ? { model: disk.model } : {}),
      });
      if (changed.length === 0) continue;
      await db.update(items).set({ attributes: next }).where(eq(items.id, itemId));
      applied.diskLinks++;
      await logEvent({
        entityType: "item",
        entityId: itemId,
        action: "storage.disk",
        actor: "system",
        summary: `${row.name}: ${changed.join(", ")}`,
      });
    }
  }
  return { ...plan, dry: false, applied };
}
