import path from "path";
import { normalizeIp, normHost } from "./servicesFleet";
import { isStorageComputer, machineIdentity, storageViewFlags, type ReportVolume } from "./storage";

/** Same skip list as scripts/storage-report-local.mjs, plus network fs on Linux df -T. */
export const SKIP_FS = new Set([
  "tmpfs",
  "devtmpfs",
  "overlay",
  "squashfs",
  "ramfs",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "nsfs",
  "autofs",
  "devfs",
  "efivarfs",
  "tracefs",
  "securityfs",
  "pstore",
  "bpf",
  "debugfs",
  "hugetlbfs",
  "mqueue",
  "fusectl",
  "rpc_pipefs",
  "binfmt_misc",
  "nfs",
  "nfs4",
  "cifs",
  "smbfs",
  "afpfs",
  "fuse.sshfs",
  "fuse.rclone",
]);

export type StarredMachine = {
  id: number;
  name: string;
  hostname: string | null;
  ip: string | null;
  machineId: string | null;
  aliases: string | null;
  identityOptions: string[];
};

export type ThisHost = { hostname: string; ips: string[] };

export type StarredDirPlan = {
  itemId: number;
  name: string;
  via: "local" | "ssh" | "skip";
  sshUser?: string;
  sshHost?: string;
  reason?: string;
};

export type DfRow = {
  device: string;
  fsType: string | null;
  container: string | null;
  mountPoint: string;
  capacityBytes: number;
  usedBytes: number;
};

const MAC_RE = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

export function skipMount(mp: string): boolean {
  if (mp === "/" || mp === "/System/Volumes/Data") return false;
  if (/^\/(System(\/|$)|private\/var\/vm|dev(\/|$))/.test(mp)) return true;
  if (mp.includes("CoreSimulator")) return true;
  if (/com\.apple\.TimeMachine|\.timemachine|localsnapshots/i.test(mp)) return true;
  if (/^\/(proc|sys|run|snap)(\/|$)/.test(mp)) return true;
  return false;
}

export function skipFs(fsType: string | null): boolean {
  return fsType != null && SKIP_FS.has(fsType.toLowerCase());
}

/** A MAC is never an SSH target. */
export function looksLikeMac(s: string): boolean {
  return MAC_RE.test(s.trim());
}

export function starredMachinesFromItems(
  items: Array<{ id: number; name: string; attributes?: Record<string, string | number> | null }>,
): StarredMachine[] {
  const out: StarredMachine[] = [];
  for (const it of items) {
    const attrs = it.attributes ?? null;
    if (!isStorageComputer({ attributes: attrs })) continue;
    if (!storageViewFlags(attrs).starred) continue;
    const id = machineIdentity(attrs);
    out.push({
      id: it.id,
      name: it.name,
      hostname: id.hostname,
      ip: id.ip,
      machineId: id.machineId,
      aliases: id.aliases,
      identityOptions: id.identityOptions,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function isThisMachine(machine: StarredMachine, local: ThisHost): boolean {
  const localHost = normHost(local.hostname);
  const localIps = new Set(local.ips.map((ip) => normalizeIp(ip)).filter((x): x is string => x != null));
  for (const raw of machine.identityOptions) {
    const ip = normalizeIp(raw);
    if (ip && localIps.has(ip)) return true;
    if (!looksLikeMac(raw) && normHost(raw) === localHost) return true;
  }
  return false;
}

/** Prefer a LAN IP; else hostname (not a MAC). `.local` is the caller's job when SSH fails. */
export function pickSshHost(machine: StarredMachine): string | null {
  const ip = normalizeIp(machine.ip) ?? (machine.machineId ? normalizeIp(machine.machineId) : null);
  if (ip) return ip;
  for (const raw of [machine.hostname, machine.machineId, ...(machine.aliases ? machine.aliases.split(/[,;]/) : [])]) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s || looksLikeMac(s) || normalizeIp(s)) continue;
    if (normHost(s)) return s.replace(/\.local$/i, "");
  }
  return null;
}

export function planStarredDirReports(
  machines: StarredMachine[],
  local: ThisHost,
  opts?: { sshUser?: string; itemId?: number },
): StarredDirPlan[] {
  const sshUser = opts?.sshUser?.trim() || undefined;
  const only = opts?.itemId;
  const rows: StarredDirPlan[] = [];
  for (const m of machines) {
    if (only != null && m.id !== only) continue;
    if (isThisMachine(m, local)) {
      rows.push({ itemId: m.id, name: m.name, via: "local" });
      continue;
    }
    const sshHost = pickSshHost(m);
    if (!sshHost) {
      rows.push({ itemId: m.id, name: m.name, via: "skip", reason: "no hostname or IP to SSH" });
      continue;
    }
    rows.push({ itemId: m.id, name: m.name, via: "ssh", sshUser, sshHost });
  }
  return rows;
}

export function parseDfTable(text: string, darwin: boolean): DfRow[] {
  const rows: DfRow[] = [];
  for (const line of text.trim().split("\n").slice(1)) {
    const m = darwin
      ? line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/)
      : line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/);
    if (!m) continue;
    const deviceRaw = m[1];
    const fsType = darwin ? null : m[2];
    const blocks = Number(darwin ? m[2] : m[3]);
    const used = Number(darwin ? m[3] : m[4]);
    const avail = Number(darwin ? m[4] : m[5]);
    const mountPoint = darwin ? m[5] : m[6];
    if (skipFs(fsType)) continue;
    if (!deviceRaw.startsWith("/dev/")) continue;
    if (/^\/dev\/loop/.test(deviceRaw)) continue;
    if (skipMount(mountPoint)) continue;
    const device = deviceRaw.replace(/^\/dev\//, "");
    const container = darwin ? device.match(/^(disk\d+)s\d+/)?.[1] ?? null : null;
    rows.push({
      device,
      fsType,
      container,
      mountPoint,
      capacityBytes: blocks * 1024,
      usedBytes: (container ? used : blocks - avail) * 1024,
    });
  }
  return splitDisagreeingContainers(rows);
}

function splitDisagreeingContainers<T extends { container?: string | null; capacityBytes: number }>(rows: T[]): T[] {
  const sizes = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.container) continue;
    sizes.set(r.container, [...(sizes.get(r.container) ?? []), r.capacityBytes]);
  }
  return rows.map((r) => {
    if (!r.container) return r;
    if (new Set(sizes.get(r.container)).size > 1) return { ...r, container: null };
    return r;
  });
}

function dashNull(s: string | undefined): string | null {
  if (s == null || s === "" || s === "-") return null;
  return s;
}

/**
 * TSV from scripts/storage-measure-remote.sh.
 * VOL <mount> <device|-> <fs|-> <container|-> <capacityBytes> <usedBytes>
 * DIR <mount> <path> <bytes>
 */
export function parseMeasureTsv(text: string, topN = 15): ReportVolume[] {
  const n = Math.min(100, Math.max(1, topN));
  const byMount = new Map<string, ReportVolume>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    const kind = parts[0];
    if (kind === "VOL" && parts.length >= 7) {
      const mountPoint = parts[1];
      if (!mountPoint || skipMount(mountPoint)) continue;
      const capacityBytes = Number(parts[5]);
      const usedBytes = Number(parts[6]);
      if (!Number.isFinite(capacityBytes) || !Number.isFinite(usedBytes) || capacityBytes < 0 || usedBytes < 0) continue;
      byMount.set(mountPoint, {
        mountPoint,
        device: dashNull(parts[2]),
        fsType: dashNull(parts[3]),
        container: dashNull(parts[4]),
        label: path.posix.basename(mountPoint).slice(0, 128) || null,
        capacityBytes,
        usedBytes: Math.min(usedBytes, capacityBytes),
        dirs: [],
      });
      continue;
    }
    if (kind === "DIR" && parts.length >= 4) {
      const mountPoint = parts[1];
      const dirPath = parts[2];
      const bytes = Number(parts[3]);
      const vol = byMount.get(mountPoint);
      if (!vol || !dirPath || !Number.isFinite(bytes) || bytes < 0) continue;
      (vol.dirs ??= []).push({ path: dirPath.slice(0, 512), bytes });
    }
  }
  const dataReported = [...byMount.keys()].includes("/System/Volumes/Data");
  const volumes = [...byMount.values()].slice(0, 64);
  for (const v of volumes) {
    if (v.mountPoint === "/" && dataReported) {
      v.dirs = [];
      continue;
    }
    v.dirs = (v.dirs ?? []).sort((a, b) => b.bytes - a.bytes).slice(0, n);
  }
  return splitDisagreeingContainers(volumes);
}
