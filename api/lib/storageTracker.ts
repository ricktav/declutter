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
import { STORAGE_DISK_KEY, physicalDiskKey, serialOf as serialNorm, uuidOf } from "./storageDisks";
import {
  applyReport,
  isDiskThing,
  isStorageComputer,
  isStorageDevice,
  machineIdentity,
  removeVolumesByDiskKeys,
  type ReportVolume,
} from "./storage";
import { normalizeIdentityValue } from "./identityAttrs";
import { normalizeIp, normHost } from "./servicesFleet";

type Db = ReturnType<typeof getDb>;

export const TRACKER_SOURCE = "data-tracker";
/** Calendar age for the "last seen" badge. Old rows are skipped only when a newer sighting of the same disk exists. */
export const DEFAULT_STALE_DAYS = 7;

/** DT host → HomeBase hostname, item id, or null to skip a duplicate/lab host. Match is never the display name. */
export const DEFAULT_TRACKER_HOST_MAP: Record<string, string | number | null> = {
  dockermac: "dockermac-1",
  "plugwise-pi": "plugwisepi",
  TavServ: "synology-nas",
  Mac: null,
};

export type TrackerHostMap = Record<string, string | number | null>;

export type TrackerDisk = {
  host: string;
  diskKey: string;
  name: string;
  model: string | null;
  serial: string | null;
  uuid: string | null;
  sizeBytes: number | null;
  mountpoints: string[];
  lastSeen: number | null;
  hostname: string | null;
  ip: string | null;
  mac: string | null;
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
  lastSeen: number | null;
  hostname: string | null;
  ip: string | null;
  mac: string | null;
};

export type TrackerHostIdentity = {
  host: string;
  hostname: string | null;
  ip: string | null;
  mac: string | null;
  lastSeen: number | null;
};

export type ParsedTrackerSources = {
  disks: TrackerDisk[];
  volumes: TrackerVolume[];
  hosts: TrackerHostIdentity[];
  skipped: number;
};

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

const TIME_KEYS = [
  "last_seen",
  "lastSeen",
  "last_seen_at",
  "lastSeenAt",
  "updated_at",
  "updatedAt",
  "updated",
  "seen_at",
  "seenAt",
  "last_updated",
  "lastUpdated",
  "observed_at",
  "timestamp",
  "ts",
];

/** Epoch ms from a tracker last-seen / updated field (ISO, unix seconds or ms). */
export function parseTrackerTime(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v < 1e12 ? v * 1000 : v);
  const s = str(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseTrackerTime(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function firstTime(row: Record<string, unknown>): number | null {
  for (const k of TIME_KEYS) {
    const t = parseTrackerTime(row[k]);
    if (t != null) return t;
  }
  return null;
}

function hostIp(row: Record<string, unknown>): string | null {
  return normalizeIp(str(row.ip) ?? str(row.ipv4) ?? str(row.ip_address) ?? str(row.address));
}

function hostMac(row: Record<string, unknown>): string | null {
  const raw = str(row.mac) ?? str(row.mac_address) ?? str(row.hwaddr);
  if (!raw) return null;
  const n = normalizeIdentityValue("mac", raw);
  return n || null;
}

function hostNameOf(row: Record<string, unknown>, host: string): string | null {
  return str(row.hostname) ?? str(row.host) ?? host;
}

export function isTrackerStale(lastSeen: number | null, now: number = Date.now(), staleDays: number = DEFAULT_STALE_DAYS): boolean {
  if (lastSeen == null || !(staleDays > 0)) return false;
  return now - lastSeen > staleDays * 86400000;
}

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

function firstSize(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    if (row[k] == null) continue;
    const n = parseTrackerSize(row[k]);
    if (n != null) return n;
  }
  return null;
}

const SIZE_KEYS = ["size_bytes", "sizeBytes", "size", "capacity_bytes", "capacityBytes", "capacity"];
const USED_KEYS = ["used_bytes", "usedBytes", "used"];

function subtypeIsDisk(subtype: string | null): boolean {
  if (!subtype) return false;
  if (/volume|mount|filesystem|\bfs\b/.test(subtype)) return false;
  return /disk|drive|hdd|ssd|nvme/.test(subtype);
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
  // Live disk rows are `host:sda` with subtype external-drive, metadata.mountpoints
  // and usage_pct — never `kind: disk`. Name / mountpoints / serial before usage.
  if (rest && looksLikeDiskRest(rest)) return "disk";
  if (subtypeIsDisk(str(row.subtype))) return "disk";
  const mounts = listOfStrings(row.mountpoints ?? row.mount_points);
  const serial = serialOf(row.serial ?? row.serial_number ?? row.SerialNumber);
  if ((mounts.length > 0 || serial) && !rest?.startsWith("/")) return "disk";
  if (str(row.disk) && str(row.disk) !== str(row.name)) return "volume";
  if (row.used != null || row.used_bytes != null || row.usedBytes != null || row.usage_pct != null || row.usagePct != null) return "volume";
  if (rest?.startsWith("/")) return "volume";
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
  return serialNorm(v);
}

function uuidFromRow(row: Record<string, unknown>): string | null {
  return uuidOf(row.uuid ?? row.disk_uuid ?? row.diskUuid ?? row.volume_uuid ?? row.VolumeUUID ?? row.uuid_str);
}

function modelOf(row: Record<string, unknown>): string | null {
  return str(row.disk_model) ?? str(row.model) ?? str(row.product) ?? str(row.media_name) ?? null;
}

function pathOrUrl(row: Record<string, unknown>): string | null {
  return str(row.path_or_url) ?? str(row.path);
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
  const hostAcc = new Map<string, TrackerHostIdentity>();
  let skipped = 0;
  const noteHost = (host: string, row: Record<string, unknown>, lastSeen: number | null) => {
    const key = normHost(host);
    const prev = hostAcc.get(key);
    const next: TrackerHostIdentity = {
      host: prev?.host ?? host,
      hostname: hostNameOf(row, host) ?? prev?.hostname ?? null,
      ip: hostIp(row) ?? prev?.ip ?? null,
      mac: hostMac(row) ?? prev?.mac ?? null,
      lastSeen: [lastSeen, prev?.lastSeen ?? null].reduce((a, b) => (a == null ? b : b == null ? a : Math.max(a, b))),
    };
    hostAcc.set(key, next);
  };
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
      const lastSeen = firstTime(row);
      noteHost(host, row, lastSeen);
      disks.push({
        host,
        diskKey,
        name: name ?? `${host}:${diskKey}`,
        model: modelOf(row),
        serial: serialOf(row.serial ?? row.serial_number ?? row.SerialNumber),
        uuid: uuidFromRow(row),
        sizeBytes: firstSize(row, SIZE_KEYS),
        mountpoints: listOfStrings(row.mountpoints ?? row.mount_points),
        lastSeen,
        hostname: hostNameOf(row, host),
        ip: hostIp(row),
        mac: hostMac(row),
      });
      continue;
    }
    if (kind === "volume") {
      const fromPath = pathOrUrl(row);
      const mountPoint =
        (parts?.rest?.startsWith("/") ? parts.rest : null) ??
        (fromPath && fromPath.startsWith("/") && !fromPath.startsWith("/dev/") ? fromPath : null) ??
        str(row.mountpoint ?? row.mountPoint);
      const capacityBytes = firstSize(row, SIZE_KEYS);
      if (!mountPoint || capacityBytes == null || capacityBytes <= 0) {
        skipped++;
        continue;
      }
      const fsType = str(row.fstype ?? row.fsType ?? row.fs);
      if (skipFs(fsType)) {
        skipped++;
        continue;
      }
      const usedRaw = firstSize(row, USED_KEYS);
      const pct = typeof row.usage_pct === "number" ? row.usage_pct : typeof row.usagePct === "number" ? row.usagePct : null;
      const usedBytes = Math.min(capacityBytes, Math.max(0, usedRaw ?? (pct != null && pct >= 0 ? Math.round((capacityBytes * pct) / 100) : 0)));
      const lastSeen = firstTime(row);
      noteHost(host, row, lastSeen);
      const diskName = str(row.disk);
      const deviceRaw = str(row.device) ?? (fromPath?.startsWith("/dev/") ? fromPath : null) ?? diskKeyOf(diskName, null);
      volumes.push({
        host,
        mountPoint: mountPoint.slice(0, 255),
        device: deviceRaw?.slice(0, 128) ?? null,
        fsType: fsType?.slice(0, 32) ?? null,
        label: (str(row.label) ?? str(row.volume) ?? (mountPoint === "/" ? "/" : mountPoint.split("/").filter(Boolean).pop() ?? null))?.slice(0, 128) ?? null,
        container: str(row.container)?.slice(0, 64) ?? null,
        capacityBytes,
        usedBytes,
        diskName,
        diskKey: diskKeyOf(diskName, str(row.device)),
        lastSeen,
        hostname: hostNameOf(row, host),
        ip: hostIp(row),
        mac: hostMac(row),
      });
      continue;
    }
    skipped++;
  }
  const byDisk = new Map<string, TrackerDisk>();
  for (const d of disks) {
    const k = `${normHost(d.host)}:${d.diskKey}`;
    const prev = byDisk.get(k);
    if (!prev || (d.lastSeen ?? 0) >= (prev.lastSeen ?? 0)) byDisk.set(k, d);
  }
  const byVol = new Map<string, TrackerVolume>();
  for (const v of volumes) {
    const k = `${normHost(v.host)}:${v.mountPoint}`;
    const prev = byVol.get(k);
    if (!prev || (v.lastSeen ?? 0) >= (prev.lastSeen ?? 0)) byVol.set(k, v);
  }
  return { disks: [...byDisk.values()], volumes: [...byVol.values()], hosts: [...hostAcc.values()], skipped };
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
  return isStorageComputer({ attributes: item.attributes });
}

function unique(xs: Array<string | null | undefined>): string[] {
  return [...new Set(xs.filter((x): x is string => x != null && x !== ""))];
}

/** Hostname / IP / MAC / machine.id / aliases — never the Thing's display name. */
function hostMatchKeys(item: InventoryItem): { machineIds: string[]; hostnames: string[]; ips: string[]; macs: string[] } {
  const id = machineIdentity(item.attributes);
  const hostnames: string[] = [];
  const ips: string[] = [];
  const macs: string[] = [];
  const machineIds: string[] = [];
  const asHost = (raw: string | null | undefined) => {
    if (raw == null || raw === "") return;
    const ip = normalizeIp(raw);
    if (ip && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw.trim())) {
      ips.push(ip);
      return;
    }
    const n = normHost(raw);
    if (n) hostnames.push(n);
  };
  const asMac = (raw: string | null | undefined) => {
    if (raw == null || raw === "") return;
    const n = normalizeIdentityValue("mac", raw);
    if (n) macs.push(n);
  };
  if (id.machineId) {
    machineIds.push(normalizeIp(id.machineId) ?? normHost(id.machineId));
    asHost(id.machineId);
    asMac(id.machineId);
  }
  asHost(id.hostname);
  if (id.ip) {
    const ip = normalizeIp(id.ip);
    if (ip) ips.push(ip);
  }
  asMac(id.mac);
  for (const a of (id.aliases ?? "").split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
    asHost(a);
    asMac(a);
    const ip = normalizeIp(a);
    if (ip) ips.push(ip);
  }
  return { machineIds: unique(machineIds), hostnames: unique(hostnames), ips: unique(ips), macs: unique(macs) };
}

function matchHostToInventory(
  host: string,
  hint: TrackerHostIdentity | undefined,
  mapped: string | number,
  hosts: InventoryItem[],
): { item: InventoryItem | null; status: TrackerHostPlan["status"]; reason?: string } {
  if (typeof mapped === "number") {
    const item = hosts.find((h) => h.id === mapped) ?? null;
    return item ? { item, status: "matched" } : { item: null, status: "unmatched", reason: `item #${mapped}` };
  }
  const mappedHost = normHost(String(mapped));
  const mappedIp = normalizeIp(String(mapped));
  const wantHost = unique([mappedHost, hint?.hostname ? normHost(hint.hostname) : null, normHost(host)]);
  const wantIp = unique([mappedIp, hint?.ip ?? null]);
  const wantMac = unique([hint?.mac ? normalizeIdentityValue("mac", hint.mac) : null]);

  const pick = (hits: InventoryItem[]) => {
    if (hits.length === 1) return { item: hits[0], status: "matched" as const };
    if (hits.length > 1) return { item: null, status: "ambiguous" as const, reason: hits.map((h) => `#${h.id}`).join(", ") };
    return null;
  };

  const byMachineId = pick(
    hosts.filter((h) => hostMatchKeys(h).machineIds.some((k) => k === mappedHost || (mappedIp != null && k === mappedIp) || wantHost.includes(k))),
  );
  if (byMachineId) return byMachineId;

  const byHost = pick(
    hosts.filter((h) => hostMatchKeys(h).hostnames.some((k) => wantHost.includes(k))),
  );
  if (byHost) return byHost;

  if (wantIp.length) {
    const byIp = pick(
      hosts.filter((h) => hostMatchKeys(h).ips.some((k) => wantIp.includes(k))),
    );
    if (byIp) return byIp;
  }
  if (wantMac.length) {
    const byMac = pick(
      hosts.filter((h) => hostMatchKeys(h).macs.some((k) => wantMac.includes(k))),
    );
    if (byMac) return byMac;
  }
  return { item: null, status: "unmatched" };
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
  uuid: string | null;
  sizeBytes: number | null;
  itemId: number | null;
  itemName: string | null;
  match: "serial" | "uuid" | "model-size" | "create" | "inferred" | "ambiguous" | "override" | "moved" | "reattach";
  internal: boolean;
  lastSeen: number | null;
  stale: boolean;
  movedTo?: { host: string; itemId: number | null; itemName: string | null };
  candidates: Array<{ id: number; name: string }>;
};

export type TrackerHostPlan = {
  host: string;
  itemId: number | null;
  itemName: string | null;
  status: "matched" | "skipped" | "unmatched" | "ambiguous";
  reason?: string;
  hostname?: string | null;
  ip?: string | null;
  mac?: string | null;
  lastSeen?: number | null;
  disks: TrackerDiskMatch[];
  volumes: ReportVolume[];
  movedDiskKeys?: string[];
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

function blankDiskMatch(disk: TrackerDisk, match: TrackerDiskMatch["match"], extra: Partial<TrackerDiskMatch> = {}): Omit<TrackerDiskMatch, "internal"> {
  return {
    diskKey: disk.diskKey,
    name: disk.model ?? disk.diskKey,
    model: disk.model,
    serial: disk.serial,
    uuid: disk.uuid,
    sizeBytes: disk.sizeBytes,
    itemId: extra.itemId ?? null,
    itemName: extra.itemName ?? null,
    match,
    lastSeen: disk.lastSeen,
    stale: isTrackerStale(disk.lastSeen),
    movedTo: extra.movedTo,
    candidates: extra.candidates ?? [],
  };
}

function thingUuid(t: InventoryItem): string | null {
  return uuidOf(attrStr(t.attributes, "uuid") ?? attrStr(t.attributes, "disk_uuid"));
}

function thingSerial(t: InventoryItem): string | null {
  return serialOf(attrStr(t.attributes, "serial") ?? attrStr(t.attributes, "serial_number"));
}

function finishMatch(disk: TrackerDisk, t: InventoryItem, kind: "serial" | "uuid" | "model-size" | "reattach"): Omit<TrackerDiskMatch, "internal"> {
  const existing = attrStr(t.attributes, STORAGE_DISK_KEY);
  return blankDiskMatch(disk, existing && existing !== disk.diskKey ? "override" : kind, { itemId: t.id, itemName: t.name });
}

/**
 * Match a DT disk onto inventory disk Things. Serial/UUID (then model+size)
 * search every machine so a portable is reattached, never duplicated.
 */
function matchDiskToThings(disk: TrackerDisk, local: InventoryItem[], all: InventoryItem[]): Omit<TrackerDiskMatch, "internal"> {
  const pick = (hits: InventoryItem[], kind: "serial" | "uuid" | "model-size") => {
    if (hits.length === 1) {
      const t = hits[0];
      const localHit = local.some((l) => l.id === t.id);
      return finishMatch(disk, t, localHit ? kind : "reattach");
    }
    if (hits.length > 1) {
      const onlyLocal = hits.filter((t) => local.some((l) => l.id === t.id));
      if (onlyLocal.length === 1) return finishMatch(disk, onlyLocal[0], kind);
      return blankDiskMatch(disk, "ambiguous", { candidates: hits.map((t) => ({ id: t.id, name: t.name })) });
    }
    return null;
  };

  if (disk.uuid) {
    const hit = pick(
      all.filter((t) => thingUuid(t) === disk.uuid),
      "uuid",
    );
    if (hit) return hit;
  }
  if (disk.serial) {
    const hit = pick(
      all.filter((t) => thingSerial(t) === disk.serial),
      "serial",
    );
    if (hit) return hit;
  }
  const want = normModel(disk.model);
  if (want && disk.sizeBytes) {
    const hit = pick(
      all.filter((t) => {
        const hay = normModel(thingModel(t));
        if (!hay || !hay.includes(want)) return false;
        return sizeClose(num(t.attributes?.storage_gb), disk.sizeBytes);
      }),
      "model-size",
    );
    if (hit) return hit;
  }
  return blankDiskMatch(disk, "create", { candidates: local.map((t) => ({ id: t.id, name: t.name })) });
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
    measuredAt: v.lastSeen != null ? new Date(v.lastSeen) : undefined,
  }));
}

export function trackerDiskIdentity(d: { uuid?: string | null; serial?: string | null; model?: string | null; sizeBytes?: number | null }): string | null {
  if (d.uuid) return `u:${d.uuid}`;
  if (d.serial) return `s:${d.serial}`;
  const m = normModel(d.model ?? null);
  if (m && d.sizeBytes) return `m:${m}:${Math.round(d.sizeBytes / 1e9)}`;
  return null;
}

function winningSighting(disks: TrackerDisk[]): Map<string, { host: string; lastSeen: number }> {
  const best = new Map<string, { host: string; lastSeen: number }>();
  for (const d of disks) {
    const id = trackerDiskIdentity(d);
    if (!id || d.lastSeen == null) continue;
    const prev = best.get(id);
    if (!prev || d.lastSeen > prev.lastSeen) best.set(id, { host: d.host, lastSeen: d.lastSeen });
  }
  return best;
}

function diskIsMoved(disk: TrackerDisk, winning: Map<string, { host: string; lastSeen: number }>): { host: string; lastSeen: number } | null {
  const id = trackerDiskIdentity(disk);
  if (!id || disk.lastSeen == null) return null;
  const w = winning.get(id);
  if (!w || w.lastSeen <= disk.lastSeen) return null;
  if (normHost(w.host) === normHost(disk.host)) return null;
  return w;
}

/**
 * Match DT hosts to computer/NAS Things and DT disks to drive Things.
 * Does not write. A disk is `moved` when the same UUID/serial (else model+size)
 * was seen more recently on another host: those volumes stay off this machine.
 * A sole old sighting still imports, marked stale. `create` means apply will
 * insert a disk Thing; until then overview infers it from the volume's `device`.
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
  const hintByHost = new Map(parsed.hosts.map((h) => [normHost(h.host), h]));
  const winning = winningSighting(parsed.disks);

  const hostNames = [...new Set([...parsed.disks.map((d) => d.host), ...parsed.volumes.map((v) => v.host)])].sort();
  const planHosts: TrackerHostPlan[] = [];

  for (const host of hostNames) {
    const hint = hintByHost.get(normHost(host));
    const identity = {
      hostname: hint?.hostname ?? host,
      ip: hint?.ip ?? null,
      mac: hint?.mac ?? null,
      lastSeen: hint?.lastSeen ?? null,
    };
    const mapped = lookupHostMap(host, hostMap);
    if (mapped.skip) {
      planHosts.push({ host, itemId: null, itemName: null, status: "skipped", reason: "host map", ...identity, disks: [], volumes: [] });
      continue;
    }
    const found = matchHostToInventory(host, hint, mapped.mapped, hosts);
    const hostDisks = parsed.disks.filter((d) => normHost(d.host) === normHost(host));
    const hostVolsAll = parsed.volumes.filter((v) => normHost(v.host) === normHost(host) && v.usedBytes <= v.capacityBytes);
    if (!found.item) {
      planHosts.push({
        host,
        itemId: null,
        itemName: null,
        status: found.status,
        reason: found.reason,
        ...identity,
        disks: [],
        volumes: [],
      });
      continue;
    }
    const item = found.item;
    const things = disksOf(item.id);
    const movedDiskKeys: string[] = [];
    const liveVols: TrackerVolume[] = [];
    const diskPlans: TrackerDiskMatch[] = hostDisks.map((d) => {
      const vols = hostVolsAll.filter((v) => v.diskKey === d.diskKey);
      const internal = diskLooksInternal(d, vols);
      const moved = diskIsMoved(d, winning);
      if (moved) {
        movedDiskKeys.push(d.diskKey);
        const dest = planHosts.find((h) => normHost(h.host) === normHost(moved.host));
        return {
          ...blankDiskMatch(d, "moved", {
            movedTo: { host: moved.host, itemId: dest?.itemId ?? null, itemName: dest?.itemName ?? null },
          }),
          internal,
        };
      }
      const m = matchDiskToThings(d, things, disks);
      if (m.match === "create" && vols.length === 0) return { ...m, match: "inferred" as const, internal };
      liveVols.push(...vols);
      return { ...m, internal };
    });
    for (const v of hostVolsAll) {
      if (v.diskKey && movedDiskKeys.includes(v.diskKey)) continue;
      if (v.diskKey && !diskPlans.some((d) => d.diskKey === v.diskKey)) {
        diskPlans.push({
          diskKey: v.diskKey,
          name: v.diskKey,
          model: null,
          serial: null,
          uuid: null,
          sizeBytes: null,
          itemId: null,
          itemName: null,
          match: "inferred",
          internal: INTERNAL_MOUNTS.has(v.mountPoint),
          lastSeen: v.lastSeen,
          stale: isTrackerStale(v.lastSeen),
          candidates: things.map((t) => ({ id: t.id, name: t.name })),
        });
        liveVols.push(v);
      } else if (!v.diskKey) {
        liveVols.push(v);
      }
    }
    const volSeen = new Set<string>();
    const reportVols = liveVols.filter((v) => {
      const k = v.mountPoint;
      if (volSeen.has(k)) return false;
      volSeen.add(k);
      return true;
    });
    planHosts.push({
      host,
      itemId: item.id,
      itemName: item.name,
      status: "matched",
      ...identity,
      disks: diskPlans,
      volumes: volumesForReport(reportVols),
      movedDiskKeys,
    });
  }

  // Fill movedTo item ids now that every host is planned.
  const byHostName = new Map(planHosts.map((h) => [normHost(h.host), h]));
  for (const h of planHosts) {
    for (const d of h.disks) {
      if (d.match !== "moved" || !d.movedTo) continue;
      const dest = byHostName.get(normHost(d.movedTo.host));
      if (dest) d.movedTo = { host: dest.host, itemId: dest.itemId, itemName: dest.itemName };
    }
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
 * (no dirs: local collector keeps those), sets `storage.disk` when absent,
 * reattaches a portable seen on a new host, deletes leftover volumes of a disk
 * that moved away, and creates a disk Thing when DT has a disk with volumes
 * and no match.
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
          .select({ fromItemId: relations.fromItemId, toItemId: relations.toItemId, id: relations.id })
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
    if (host.movedDiskKeys && host.movedDiskKeys.length > 0) {
      await removeVolumesByDiskKeys(db, host.itemId, host.movedDiskKeys);
    }
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
      if (disk.match === "moved" || disk.match === "ambiguous" || disk.match === "inferred") continue;
      let itemId = disk.itemId;
      if (disk.match === "create" && itemId == null) {
        const attrs: Record<string, string | number> = {
          role: "storage",
          ...(disk.model ? { model: disk.model } : {}),
          ...(disk.serial ? { serial: disk.serial } : {}),
          ...(disk.uuid ? { uuid: disk.uuid } : {}),
          ...(disk.sizeBytes ? { storage_gb: Math.round(disk.sizeBytes / 1e9) } : {}),
          [STORAGE_DISK_KEY]: disk.diskKey,
        };
        const [{ id }] = await db
          .insert(items)
          .values({
            areaId: computer.areaId,
            houseId: computer.houseId,
            roomId: computer.roomId,
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
      if (itemId == null) continue;
      if (disk.match === "override") continue;
      const row = byId.get(itemId) ?? (await db.query.items.findFirst({ where: eq(items.id, itemId) }));
      if (!row) continue;
      if (disk.match === "reattach") {
        if (row.parentId != null && row.parentId !== computer.id) {
          await db.update(items).set({ parentId: disk.internal ? computer.id : null }).where(eq(items.id, itemId));
        }
        const existingRels = await db
          .select()
          .from(relations)
          .where(and(eq(relations.fromItemId, itemId), eq(relations.type, "attached-to"), eq(relations.status, "confirmed")));
        const already = existingRels.some((r) => r.toItemId === computer.id);
        for (const r of existingRels) {
          if (r.toItemId !== computer.id) await db.delete(relations).where(eq(relations.id, r.id));
        }
        if (!already && !disk.internal) {
          await db.insert(relations).values({
            fromItemId: itemId,
            toItemId: computer.id,
            type: "attached-to",
            origin: "user",
            status: "confirmed",
          });
        }
        if (disk.internal && row.parentId !== computer.id) {
          await db.update(items).set({ parentId: computer.id }).where(eq(items.id, itemId));
        }
      }
      const { next, changed } = mergeAttrs(row.attributes, {
        [STORAGE_DISK_KEY]: disk.diskKey,
        ...(disk.serial ? { serial: disk.serial } : {}),
        ...(disk.model ? { model: disk.model } : {}),
        ...(disk.uuid ? { uuid: disk.uuid } : {}),
      });
      if (changed.length === 0 && disk.match !== "reattach") continue;
      if (changed.length > 0) {
        await db.update(items).set({ attributes: next }).where(eq(items.id, itemId));
        applied.diskLinks++;
        await logEvent({
          entityType: "item",
          entityId: itemId,
          action: "storage.disk",
          actor: "system",
          summary: `${row.name}: ${changed.join(", ")}`,
        });
      } else if (disk.match === "reattach") {
        applied.diskLinks++;
      }
    }
  }
  return { ...plan, dry: false, applied };
}
