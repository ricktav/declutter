/**
 * Collectors attach volumes to the computer item and put the kernel name in
 * `device` (/dev/sda2, disk7s1). Disk Things (role storage) are separate.
 * This module groups those volumes by physical disk and links them to Things.
 */

export const STORAGE_DISK_KEY = "storage.disk";

/**
 * Known kernel disk → inventory disk when the collector has no serial on the
 * volume row. Mini USB NVMe (disk9, SNVS1000GB, ~1TB) is Thing "Ugreen NVME 1TB".
 */
export const SEEDED_DISK_LINKS: Array<{
  diskKey: string;
  serial?: string;
  nameIncludes?: string;
  modelIncludes?: string;
  sizeBytes?: number;
}> = [{ diskKey: "disk9", serial: "SNVS1000GB", nameIncludes: "ugreen", modelIncludes: "ugreen", sizeBytes: 1e12 }];

/** Calendar age for the "last seen" badge. Never a reason to skip the only sighting. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type DiskMeasure = "measured" | "no-collector" | "unlinked" | "duplicate";

export type DiskLinkCandidate = { id: number; name: string } | { diskKey: string; name: string };

type Attrs = Record<string, string | number> | null | undefined;

export type DiskVolume = {
  id: number;
  itemId: number;
  mountPoint: string;
  label: string | null;
  device: string | null;
  container: string | null;
  capacityBytes: number;
  usedBytes: number;
  measuredAt?: Date;
};

export type DiskThing = {
  id: number;
  name: string;
  attributes: Attrs;
};

/**
 * Whole-disk identity from a volume's kernel name and optional APFS container.
 * sda2 → sda, nvme0n1p2 → nvme0n1, disk7s1 → disk7, container disk9 → disk9.
 */
export function physicalDiskKey(device?: string | null, container?: string | null): string | null {
  const c = container?.trim().replace(/^\/dev\//, "");
  if (c) return c;
  if (device == null) return null;
  const d = String(device).trim().replace(/^\/dev\//, "");
  if (!d) return null;
  const apfs = d.match(/^(disk\d+)/i);
  if (apfs) return apfs[1].toLowerCase();
  const nvme = d.match(/^(nvme\d+n\d+)/i);
  if (nvme) return nvme[1].toLowerCase();
  const mmc = d.match(/^(mmcblk\d+)/i);
  if (mmc) return mmc[1].toLowerCase();
  const scsi = d.match(/^([hsv]d[a-z]+|[svx]vd[a-z]+)/i);
  if (scsi) return scsi[1].toLowerCase();
  return d.toLowerCase();
}

function attrStr(attrs: Attrs, key: string): string | null {
  const v = attrs?.[key];
  if (v == null || v === "") return null;
  return String(v);
}

export function serialOf(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = String(v).trim().replace(/\s+/g, "");
  if (!n) return null;
  if (/^(unknown|none|n\/?a|null|-|0)$/i.test(n)) return null;
  return n.toUpperCase();
}

export function uuidOf(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = String(v).trim().replace(/[{}]/g, "").toLowerCase();
  if (!n || /^(unknown|none|n\/?a|null|-|0)$/i.test(n)) return null;
  const hex = n.replace(/-/g, "");
  if (hex.length < 8 || !/^[0-9a-f-]+$/i.test(n)) return null;
  return n;
}

function normModel(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return n || null;
}

function num(v: string | number | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function declaredDisk(attrs: Attrs): string | null {
  const explicit = attrStr(attrs, STORAGE_DISK_KEY);
  if (explicit) return physicalDiskKey(explicit, explicit) ?? explicit.toLowerCase();
  const dev = attrStr(attrs, "device");
  if (dev) return physicalDiskKey(dev, null);
  return null;
}

function sizeClose(storageGb: number | null, capacityBytes: number): boolean {
  if (storageGb == null || !(capacityBytes > 0)) return false;
  return Math.abs(storageGb * 1e9 - capacityBytes) / capacityBytes <= 0.2;
}

function containerCapacities(volumes: DiskVolume[]): Map<string, number> {
  const best = new Map<string, { capacity: number; at: number }>();
  for (const v of volumes) {
    const key = v.container ?? `vol:${v.id}`;
    const at = v.measuredAt?.getTime() ?? 0;
    const prev = best.get(key);
    if (!prev || at > prev.at || (at === prev.at && v.capacityBytes > prev.capacity)) best.set(key, { capacity: v.capacityBytes, at });
  }
  return new Map([...best].map(([k, b]) => [k, b.capacity]));
}

function groupCapacity(volumes: DiskVolume[]): number {
  let total = 0;
  for (const c of containerCapacities(volumes).values()) total += c;
  return total;
}

export function groupVolumesByDisk<V extends DiskVolume>(volumes: V[]): Map<string, V[]> {
  const groups = new Map<string, V[]>();
  for (const v of volumes) {
    const key = physicalDiskKey(v.device, v.container) ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return groups;
}

function groupLabel(key: string, volumes: DiskVolume[]): string {
  if (key !== "unknown") return key;
  return volumes[0]?.label || volumes[0]?.mountPoint || "disk";
}

function claimUnique(pairs: Array<{ driveId: number; key: string }>, assigned: Map<number, string>, taken: Set<string>) {
  const byKey = new Map<string, number[]>();
  const byDrive = new Map<number, string[]>();
  for (const p of pairs) {
    if (assigned.has(p.driveId) || taken.has(p.key)) continue;
    byKey.set(p.key, [...(byKey.get(p.key) ?? []), p.driveId]);
    byDrive.set(p.driveId, [...(byDrive.get(p.driveId) ?? []), p.key]);
  }
  for (const [key, driveIds] of byKey) {
    const unique = [...new Set(driveIds)].filter((id) => (byDrive.get(id) ?? []).length === 1);
    if (unique.length !== 1) continue;
    assigned.set(unique[0], key);
    taken.add(key);
  }
}

/** A `storage.disk` pin wins even when another drive also claims that key. */
function claimFirst(pairs: Array<{ driveId: number; key: string }>, assigned: Map<number, string>, taken: Set<string>) {
  for (const p of pairs) {
    if (assigned.has(p.driveId) || taken.has(p.key)) continue;
    assigned.set(p.driveId, p.key);
    taken.add(p.key);
  }
}

export type LinkedComputerDisks<V extends DiskVolume> = {
  /** Volumes to draw on each disk Thing (own rows plus computer rows linked by device). */
  volumesByDrive: Map<number, V[]>;
  measureByDrive: Map<number, DiskMeasure>;
  diskKeyByDrive: Map<number, string | null>;
  candidatesByDrive: Map<number, DiskLinkCandidate[]>;
  inferred: Array<{ diskKey: string; name: string; volumes: V[]; candidates: DiskLinkCandidate[] }>;
};

/**
 * Put computer-attached volumes onto disk Things when the kernel name (or a
 * `storage.disk` override, mount, or unique size) matches. Leftover groups
 * become inferred disks so an unlisted sdb still draws. Ambiguous matches
 * stay unlinked for the UI picker.
 */
export function linkComputerDisks<V extends DiskVolume>(computerVolumes: V[], drives: DiskThing[], driveVolumes: Map<number, V[]>): LinkedComputerDisks<V> {
  const groups = groupVolumesByDisk(computerVolumes);
  const assigned = new Map<number, string>();
  const taken = new Set<string>();
  const mountsOf = (key: string) => new Set((groups.get(key) ?? []).map((v) => v.mountPoint));

  const explicit: Array<{ driveId: number; key: string }> = [];
  const byMount: Array<{ driveId: number; key: string }> = [];
  const byDevice: Array<{ driveId: number; key: string }> = [];
  for (const d of drives) {
    const decl = declaredDisk(d.attributes);
    const mount = attrStr(d.attributes, "mount_point");
    for (const key of groups.keys()) {
      if (decl && decl === key) explicit.push({ driveId: d.id, key });
      if (mount && mountsOf(key).has(mount)) byMount.push({ driveId: d.id, key });
      const fromDev = attrStr(d.attributes, "device");
      if (fromDev && physicalDiskKey(fromDev, null) === key && !attrStr(d.attributes, STORAGE_DISK_KEY)) {
        byDevice.push({ driveId: d.id, key });
      }
    }
  }
  const seeded: Array<{ driveId: number; key: string }> = [];
  for (const d of drives) {
    const key = seededDiskKey(d, groups);
    if (key) seeded.push({ driveId: d.id, key });
  }
  claimFirst(explicit, assigned, taken);
  claimFirst(seeded, assigned, taken);
  claimUnique(byMount, assigned, taken);
  claimUnique(byDevice, assigned, taken);

  const sizePairs: Array<{ driveId: number; key: string }> = [];
  for (const d of drives) {
    if (assigned.has(d.id)) continue;
    const gb = num(d.attributes?.storage_gb);
    const hits: string[] = [];
    for (const [key, vols] of groups) {
      if (taken.has(key)) continue;
      if (sizeClose(gb, groupCapacity(vols))) hits.push(key);
    }
    if (hits.length === 1) sizePairs.push({ driveId: d.id, key: hits[0] });
  }
  claimUnique(sizePairs, assigned, taken);

  const volumesByDrive = new Map<number, V[]>();
  const measureByDrive = new Map<number, DiskMeasure>();
  const diskKeyByDrive = new Map<number, string | null>();
  const candidatesByDrive = new Map<number, DiskLinkCandidate[]>();

  const unmatchedKeys = [...groups.keys()].filter((k) => !taken.has(k));
  const unmatchedDrives = drives.filter((d) => !assigned.has(d.id) && (driveVolumes.get(d.id) ?? []).length === 0);
  const computerHasVolumes = computerVolumes.length > 0;

  for (const d of drives) {
    const own = driveVolumes.get(d.id) ?? [];
    const key = assigned.get(d.id) ?? null;
    const linked = key ? (groups.get(key) ?? []) : [];
    const mine = [...own, ...linked];
    volumesByDrive.set(d.id, mine);
    diskKeyByDrive.set(d.id, key);
    if (mine.length > 0) {
      measureByDrive.set(d.id, "measured");
      candidatesByDrive.set(d.id, []);
      continue;
    }
    if (!computerHasVolumes) {
      measureByDrive.set(d.id, "no-collector");
      candidatesByDrive.set(d.id, []);
      continue;
    }
    const siblingMeasured = drives.some((o) => o.id !== d.id && o.name === d.name && (volumesByDrive.get(o.id) ?? []).length > 0);
    measureByDrive.set(d.id, siblingMeasured ? "duplicate" : "unlinked");
    candidatesByDrive.set(
      d.id,
      unmatchedKeys.map((k) => ({ diskKey: k, name: `${groupLabel(k, groups.get(k) ?? [])} · ${groups.get(k)?.[0]?.mountPoint ?? ""}`.trim() })),
    );
  }

  const inferred = unmatchedKeys.map((key) => ({
    diskKey: key,
    name: groupLabel(key, groups.get(key) ?? []),
    volumes: groups.get(key) ?? [],
    candidates: unmatchedDrives.map((d) => ({ id: d.id, name: d.name })),
  }));

  return { volumesByDrive, measureByDrive, diskKeyByDrive, candidatesByDrive, inferred };
}

function seedMatchesThing(disk: DiskThing, seed: (typeof SEEDED_DISK_LINKS)[number], vols: DiskVolume[]): boolean {
  const serial = serialOf(attrStr(disk.attributes, "serial") ?? attrStr(disk.attributes, "serial_number"));
  if (seed.serial && serial && serialOf(seed.serial) === serial) return true;
  const name = disk.name.toLowerCase();
  const model = (attrStr(disk.attributes, "model") ?? "").toLowerCase();
  const textOk =
    (seed.nameIncludes != null && name.includes(seed.nameIncludes)) ||
    (seed.modelIncludes != null && (model.includes(seed.modelIncludes) || name.includes(seed.modelIncludes)));
  if (!textOk) return false;
  const cap = vols.length ? groupCapacity(vols) : seed.sizeBytes ?? 0;
  const gb = num(disk.attributes?.storage_gb);
  if (gb != null && sizeClose(gb, cap)) return true;
  if (seed.sizeBytes && sizeClose(seed.sizeBytes / 1e9, cap)) return true;
  return false;
}

function seededDiskKey<V extends DiskVolume>(disk: DiskThing, groups: Map<string, V[]>): string | null {
  for (const seed of SEEDED_DISK_LINKS) {
    const vols = groups.get(seed.diskKey);
    if (!vols || vols.length === 0) continue;
    if (seedMatchesThing(disk, seed, vols)) return seed.diskKey;
  }
  return null;
}

/**
 * Loose (unattached) disk Things that belong on this computer: a seeded pin
 * (Mini disk9 → Ugreen NVME) or a unique serial/model+size against its volume groups.
 */
export function claimLooseDisks<V extends DiskVolume, D extends DiskThing>(computerVolumes: V[], loose: D[]): D[] {
  if (loose.length === 0 || computerVolumes.length === 0) return [];
  const groups = groupVolumesByDisk(computerVolumes);
  const claimed: D[] = [];
  const taken = new Set<string>();
  for (const d of loose) {
    const seedKey = seededDiskKey(d, groups);
    if (seedKey && !taken.has(seedKey)) {
      claimed.push(d);
      taken.add(seedKey);
      continue;
    }
    const serial = serialOf(attrStr(d.attributes, "serial") ?? attrStr(d.attributes, "serial_number"));
    if (serial) {
      for (const seed of SEEDED_DISK_LINKS) {
        if (seed.serial && serialOf(seed.serial) === serial && groups.has(seed.diskKey) && !taken.has(seed.diskKey)) {
          claimed.push(d);
          taken.add(seed.diskKey);
          break;
        }
      }
    }
  }
  return claimed;
}

const GENERIC_VOLUME_LABELS = new Set(["/", "/boot", "/boot/efi", "/system/volumes/data", "macintosh hd", "data", "root"]);

function distinctiveVolumeLabels(volumes: Array<{ label?: string | null; mountPoint?: string | null }>): string[] {
  return volumes
    .map((v) => (v.label || v.mountPoint || "").trim().toLowerCase())
    .filter((s) => s && !GENERIC_VOLUME_LABELS.has(s));
}

/** Identity used to hide a disk at an old machine when a newer sighting exists elsewhere. */
export function diskSightingKey(d: {
  name: string;
  inferred?: boolean;
  parentId?: number | null;
  capacityBytes?: number | null;
  serial?: string | null;
  uuid?: string | null;
  attributes?: Attrs;
  volumes: Array<{ label?: string | null; mountPoint?: string; capacityBytes: number }>;
}): string | null {
  const uuid = uuidOf(d.uuid ?? attrStr(d.attributes, "uuid") ?? attrStr(d.attributes, "disk_uuid"));
  if (uuid) return `u:${uuid}`;
  const serial = serialOf(d.serial ?? attrStr(d.attributes, "serial") ?? attrStr(d.attributes, "serial_number"));
  if (serial) return `s:${serial}`;
  const portable = d.inferred || d.parentId == null;
  if (!portable) return null;
  const labels = distinctiveVolumeLabels(d.volumes).sort();
  const cap = d.capacityBytes ?? (d.volumes.length ? groupCapacity(d.volumes as DiskVolume[]) : 0);
  const gb = cap > 0 ? Math.round(cap / 1e9) : null;
  if (labels.length > 0 && gb != null) return `v:${labels.join(",")}:${gb}`;
  const model = normModel(attrStr(d.attributes, "model") ?? d.name);
  if (model && gb != null && !/^(disk\d+|[hsv]d[a-z]+|nvme\d+n\d+|mmcblk\d+|md\d+|unknown)$/i.test(d.name)) {
    return `m:${model}:${gb}`;
  }
  return null;
}

export function newestMeasuredAt(volumes: Array<{ measuredAt?: Date | string | null }>): number | null {
  let best: number | null = null;
  for (const v of volumes) {
    if (v.measuredAt == null) continue;
    const t = v.measuredAt instanceof Date ? v.measuredAt.getTime() : new Date(v.measuredAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (best == null || t > best) best = t;
  }
  return best;
}

/** "last seen 12 Sep" (year only when it isn't this one). */
export function formatLastSeen(at: Date | string | number, now = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return "last seen unknown";
  const day = d.getDate();
  const mon = d.toLocaleString("en-GB", { month: "short" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear ? `last seen ${day} ${mon}` : `last seen ${day} ${mon} ${d.getFullYear()}`;
}
