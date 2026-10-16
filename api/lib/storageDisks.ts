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

export type DiskMeasure = "measured" | "no-collector" | "unlinked" | "duplicate" | "remote";

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
  fsType?: string | null;
  uuid?: string | null;
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
/** Trim, collapse slashes, drop a trailing slash except for root. */
export function normalizeMountPoint(mp: string): string {
  const s = mp.trim().replace(/\/{2,}/g, "/");
  if (s === "" || s === "/") return "/";
  return s.replace(/\/+$/, "") || "/";
}

/** Kernel name as stored on a volume (`/dev/disk7s1` → `disk7s1`), slice kept. */
export function normalizeVolumeDevice(device?: string | null): string | null {
  if (device == null || device === "") return null;
  const d = String(device).trim().replace(/^\/dev\//, "").toLowerCase();
  return d || null;
}

function volumeMeasuredMs(measuredAt?: Date | string | null): number {
  if (measuredAt == null) return 0;
  const t = measuredAt instanceof Date ? measuredAt.getTime() : new Date(measuredAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function looksLikeUuidToken(s: string): boolean {
  const n = s.replace(/[{}-]/g, "");
  return n.length >= 8 && n.length <= 32 && /^[0-9a-f]+$/i.test(n);
}

function volumeLeaf(mp: string): string {
  const m = normalizeMountPoint(mp);
  if (m === "/") return "/";
  return (m.split("/").filter(Boolean).pop() ?? m).toLowerCase();
}

function volumeUuid(v: { uuid?: string | null; mountPoint?: string; label?: string | null }): string | null {
  const direct = uuidOf(v.uuid);
  if (direct) return direct;
  const leaf = volumeLeaf(v.mountPoint ?? "");
  if (looksLikeUuidToken(leaf)) return uuidOf(leaf);
  if (v.label && looksLikeUuidToken(v.label.trim())) return uuidOf(v.label.trim());
  return null;
}

function sizeCloseBytes(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null || !(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) / Math.max(a, b) <= 0.2;
}

export type VolumeIdentity = {
  mountPoint: string;
  label?: string | null;
  device?: string | null;
  container?: string | null;
  uuid?: string | null;
  capacityBytes?: number;
};

/** Mount used as a second name for a filesystem, not a distinct POSIX path. */
export function isAliasMount(mp: string): boolean {
  const n = normalizeMountPoint(mp);
  if (looksLikeUuidToken(n) || looksLikeUuidToken(volumeLeaf(n))) return true;
  return n !== "/" && !n.includes("/");
}

/**
 * Same filesystem: equal mount, shared UUID, or label vs path
 * (`NVMe` ↔ `/media/rick/NVMe`). Same kernel device alone is not enough —
 * APFS `/` and `/System/Volumes/Data` share disk3s5. A UUID-looking mount on
 * the same slice is the tracker path-as-UUID case (Kingston `/` + F28675…).
 */
export function sameVolume(a: VolumeIdentity, b: VolumeIdentity): boolean {
  const mpA = normalizeMountPoint(a.mountPoint);
  const mpB = normalizeMountPoint(b.mountPoint);
  if (mpA === mpB) return true;
  const uuidA = volumeUuid(a);
  const uuidB = volumeUuid(b);
  if (uuidA && uuidB && uuidA === uuidB) return true;
  const devA = normalizeVolumeDevice(a.device);
  const devB = normalizeVolumeDevice(b.device);
  // One side is a UUID-looking mount (tracker path-as-UUID). Same slice is the
  // same filesystem; disagreeing slices (sda1 vs sda2) are two partitions.
  // Missing device still matches when size is close (Kingston `/` + F28675…).
  if ((uuidA || uuidB) && !(uuidA && uuidB && uuidA !== uuidB)) {
    if (devA && devB && devA !== devB) return false;
    if (devA && devB) return true;
    if (sizeCloseBytes(a.capacityBytes, b.capacityBytes)) return true;
  }
  const labelA = (a.label ?? "").trim().toLowerCase();
  const labelB = (b.label ?? "").trim().toLowerCase();
  const leafA = volumeLeaf(mpA);
  const leafB = volumeLeaf(mpB);
  const cross =
    (labelA !== "" && (labelA === leafB || normalizeMountPoint(a.label ?? "") === mpB)) ||
    (labelB !== "" && (labelB === leafA || normalizeMountPoint(b.label ?? "") === mpA)) ||
    (leafA !== "/" && leafA === leafB);
  if (!cross) return false;
  if (devA && devB && physicalDiskKey(devA, null) === physicalDiskKey(devB, null)) return true;
  return sizeCloseBytes(a.capacityBytes, b.capacityBytes);
}

/** Two rows in a dedupe group are safe to collapse: same path, or one is a UUID/label alias. */
export function volumeDedupeIsSafe(keep: VolumeIdentity, drop: VolumeIdentity): boolean {
  if (normalizeMountPoint(keep.mountPoint) === normalizeMountPoint(drop.mountPoint)) return true;
  if (!sameVolume(keep, drop)) return false;
  return isAliasMount(keep.mountPoint) || isAliasMount(drop.mountPoint);
}

const APFS_DATA_MOUNT = "/System/Volumes/Data";

/** macOS firmlink: Data is the same APFS volume as `/`. Show `/` only. */
export function hideApfsRootTwin<V extends VolumeIdentity>(volumes: V[]): V[] {
  const rootKeys = new Set<string>();
  let anyRoot = false;
  for (const v of volumes) {
    if (normalizeMountPoint(v.mountPoint) !== "/") continue;
    anyRoot = true;
    const key = physicalDiskKey(v.device, v.container);
    if (key) rootKeys.add(key);
  }
  if (!anyRoot) return volumes;
  return volumes.filter((v) => {
    if (normalizeMountPoint(v.mountPoint) !== APFS_DATA_MOUNT) return true;
    const key = physicalDiskKey(v.device, v.container);
    if (key) return !rootKeys.has(key);
    return false;
  });
}

function pickFreshestVolume<V extends { id: number; measuredAt?: Date | string | null }>(group: V[]): V {
  return group.reduce((a, b) => {
    const atA = volumeMeasuredMs(a.measuredAt);
    const atB = volumeMeasuredMs(b.measuredAt);
    if (atB !== atA) return atB > atA ? b : a;
    return b.id > a.id ? b : a;
  });
}

/** One row per filesystem: latest `measuredAt`, then highest id. */
export function dedupeVolumesByMountPoint<V extends VolumeIdentity & { id: number; measuredAt?: Date | string | null }>(volumes: V[]): V[] {
  const groups: V[][] = [];
  for (const v of volumes) {
    const hit = groups.find((g) => sameVolume(g[0], v));
    if (hit) hit.push(v);
    else groups.push([v]);
  }
  const out = hideApfsRootTwin(groups.map(pickFreshestVolume));
  out.sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
  return out;
}

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

const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smb", "smbfs", "fuse.sshfs", "fuse.rclone", "fuse.davfs", "9p", "afs"]);

/** NFS/CIFS/FTP-style mounts are not a local disk of this machine. */
export function isNetworkVolume(v: { fsType?: string | null; device?: string | null; mountPoint?: string | null; label?: string | null }): boolean {
  const fs = (v.fsType ?? "").toLowerCase();
  if (NETWORK_FS.has(fs) || (fs.startsWith("fuse.") && fs !== "fuse.apfs")) return true;
  const dev = (v.device ?? "").toLowerCase();
  if (/^(\/\/|smb:|nfs:|ftp:|sftp:)/.test(dev) || /^\/\/|^smb:/.test((v.mountPoint ?? "").toLowerCase())) return true;
  const name = `${v.label ?? ""} ${v.mountPoint ?? ""}`.toLowerCase();
  return /network share|backupftp/.test(name);
}

export function isNetworkDisk(d: {
  name: string;
  attributes?: Attrs;
  volumes?: Array<{ fsType?: string | null; device?: string | null; mountPoint?: string | null; label?: string | null }>;
}): boolean {
  if (/network share|backupftp/i.test(d.name)) return true;
  const mp = attrStr(d.attributes, "mount_point") ?? attrStr(d.attributes, "path");
  if (mp && isNetworkVolume({ mountPoint: mp, device: attrStr(d.attributes, "device"), fsType: attrStr(d.attributes, "fs_type") })) return true;
  const vols = d.volumes ?? [];
  return vols.length > 0 && vols.every(isNetworkVolume);
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
    const mine = dedupeVolumesByMountPoint([...own, ...linked]);
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
    volumes: dedupeVolumesByMountPoint(groups.get(key) ?? []),
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

/**
 * Import-created disk Things (no parent / attached-to) that belong on this
 * computer: `storage.disk` pin, or unique size + volume leaf in the Thing name.
 */
export function claimMachineDisks<V extends DiskVolume, D extends DiskThing>(computerVolumes: V[], loose: D[]): D[] {
  if (loose.length === 0 || computerVolumes.length === 0) return [];
  const groups = groupVolumesByDisk(computerVolumes);
  const claimed: D[] = [];
  const taken = new Set<string>();
  for (const d of loose) {
    const decl = declaredDisk(d.attributes);
    if (decl && groups.has(decl) && !taken.has(decl)) {
      claimed.push(d);
      taken.add(decl);
    }
  }
  for (const d of loose) {
    if (claimed.some((c) => c.id === d.id)) continue;
    const gb = num(d.attributes?.storage_gb);
    const name = d.name.toLowerCase();
    const hits: string[] = [];
    for (const [key, vols] of groups) {
      if (taken.has(key)) continue;
      if (!sizeClose(gb, groupCapacity(vols))) continue;
      const leaves = vols.flatMap((v) => [v.label, volumeLeaf(v.mountPoint)].filter((s): s is string => !!s && s !== "/")).map((s) => s.toLowerCase());
      if (leaves.some((leaf) => leaf.length >= 4 && name.includes(leaf))) hits.push(key);
    }
    if (hits.length === 1) {
      claimed.push(d);
      taken.add(hits[0]);
    }
  }
  return claimed;
}

const GENERIC_VOLUME_LABELS = new Set(["/", "/boot", "/boot/efi", "/system/volumes/data", "macintosh hd", "data", "root"]);
const GENERIC_NAME_TOKENS = new Set([
  "hdd",
  "ssd",
  "nvme",
  "disk",
  "usb",
  "generic",
  "network",
  "share",
  "drive",
  "storage",
  "internal",
  "external",
  "volume",
  "media",
  "blue",
  "black",
  "green",
  "portable",
  "attached",
  "system",
  "data",
  "root",
  "boot",
]);

function distinctiveVolumeLabels(volumes: Array<{ label?: string | null; mountPoint?: string | null }>): string[] {
  return volumes
    .map((v) => (v.label || v.mountPoint || "").trim().toLowerCase())
    .filter((s) => s && !GENERIC_VOLUME_LABELS.has(s));
}

function distinctiveNameTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !GENERIC_NAME_TOKENS.has(t) && !/^\d+$/.test(t) && !/^\d+[tgm]b$/.test(t)),
    ),
  ];
}

function volumeLeafTokens(volumes: Array<{ label?: string | null; mountPoint: string }>): string[] {
  const out = new Set<string>();
  for (const v of volumes) {
    const label = (v.label ?? "").trim().toLowerCase();
    if (label && !GENERIC_VOLUME_LABELS.has(label) && !/^(data|root|efi)$/i.test(label)) out.add(label);
    const leaf = volumeLeaf(v.mountPoint);
    if (leaf && leaf !== "/" && !GENERIC_VOLUME_LABELS.has(leaf) && !/^(data|root|efi)$/i.test(leaf)) out.add(leaf);
  }
  return [...out];
}

export type TwinKeySets = { hard: string[]; names: string[] };

/** Serial/UUID/volume-leaf+GB (hard) and name/model tokens+GB (names, union only onto a hard key). */
export function machineTwinKeys(d: {
  name: string;
  capacityBytes?: number | null;
  serial?: string | null;
  uuid?: string | null;
  attributes?: Attrs;
  volumes: Array<{ label?: string | null; mountPoint: string }>;
}): TwinKeySets {
  const hard: string[] = [];
  const names: string[] = [];
  const uuid = uuidOf(d.uuid ?? attrStr(d.attributes, "uuid") ?? attrStr(d.attributes, "disk_uuid"));
  if (uuid) hard.push(`u:${uuid}`);
  const serial = serialOf(d.serial ?? attrStr(d.attributes, "serial") ?? attrStr(d.attributes, "serial_number"));
  if (serial) hard.push(`s:${serial}`);
  const gb = d.capacityBytes != null && d.capacityBytes > 0 ? Math.round(d.capacityBytes / 1e9) : null;
  if (gb != null) {
    for (const leaf of volumeLeafTokens(d.volumes)) hard.push(`v:${leaf}:${gb}`);
    const model = attrStr(d.attributes, "model") ?? "";
    for (const tok of distinctiveNameTokens(`${d.name} ${model}`)) names.push(`v:${tok}:${gb}`);
  }
  return { hard, names };
}

/** Union-find: share a hard key, or a name token that another member carries as a hard (volume) key. */
export function clusterByTwinKeys<T>(items: T[], keysOf: (item: T) => TwinKeySets): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pa] = pb;
  };
  const byHard = new Map<string, number[]>();
  const nameHits: Array<{ i: number; key: string }> = [];
  items.forEach((item, i) => {
    const { hard, names } = keysOf(item);
    for (const k of hard) byHard.set(k, [...(byHard.get(k) ?? []), i]);
    for (const k of names) nameHits.push({ i, key: k });
  });
  for (const idxs of byHard.values()) {
    for (let j = 1; j < idxs.length; j++) union(idxs[0], idxs[j]);
  }
  for (const hit of nameHits) {
    const hardIdxs = byHard.get(hit.key);
    if (!hardIdxs) continue;
    for (const j of hardIdxs) union(hit.i, j);
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  return [...groups.values()];
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
