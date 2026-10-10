/** Parse Proxmox `pvesh` JSON or `pct list` / `qm list` text into guest records. */

export type ProxmoxDisk = { name: string; sizeGb?: number; storage?: string };
export type ProxmoxMount = { source: string; dest: string; type?: string; size?: number };

export type ProxmoxGuest = {
  vmid: number;
  name: string;
  status: string;
  memMb?: number;
  diskGb?: number;
  usedGb?: number;
  template?: boolean;
  disks?: ProxmoxDisk[];
  mounts?: ProxmoxMount[];
  /** Cluster node, used by the collector to fetch config. Not stored. */
  node?: string;
};

function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function num(x: unknown): number | undefined {
  if (x == null || x === "") return undefined;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function guestStatus(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === "running" || s === "started") return "running";
  if (s === "stopped" || s === "shutdown" || s === "offline") return "stopped";
  return raw.trim().slice(0, 32) || "stopped";
}

function bytesToMb(bytes: number | undefined): number | undefined {
  if (bytes == null || !(bytes >= 0)) return undefined;
  return Math.round(bytes / (1024 * 1024));
}

function bytesToGb(bytes: number | undefined): number | undefined {
  if (bytes == null || !(bytes >= 0)) return undefined;
  const gb = bytes / (1024 * 1024 * 1024);
  return Math.round(gb * 10) / 10;
}

function looksTemplate(name: string, flag?: unknown): boolean {
  if (flag === true || flag === 1 || flag === "1") return true;
  return /^template\b/i.test(name.trim()) || /\btemplate\b/i.test(name);
}

function compactGuest(g: ProxmoxGuest): ProxmoxGuest {
  const rec: ProxmoxGuest = { vmid: g.vmid, name: g.name.slice(0, 64), status: g.status };
  if (g.memMb != null) rec.memMb = g.memMb;
  if (g.diskGb != null && g.diskGb > 0) rec.diskGb = g.diskGb;
  if (g.usedGb != null && g.usedGb > 0) rec.usedGb = g.usedGb;
  if (g.template) rec.template = true;
  if (g.disks?.length) rec.disks = g.disks.filter((d) => d.sizeGb != null && d.sizeGb > 0).slice(0, 16);
  if (g.mounts?.length) rec.mounts = g.mounts.slice(0, 32);
  if (g.node) rec.node = g.node;
  return rec;
}

function fromResource(o: Record<string, unknown>): ProxmoxGuest | null {
  const vmid = num(o.vmid ?? o.VMID);
  if (vmid == null || vmid < 0 || !Number.isInteger(vmid)) return null;
  const name = String(o.name ?? o.Name ?? o.vmid ?? "").trim() || String(vmid);
  const status = guestStatus(String(o.status ?? o.Status ?? "stopped"));
  const memMb = num(o.memMb) ?? bytesToMb(num(o.maxmem) ?? num(o.mem));
  const diskGb = num(o.diskGb) ?? bytesToGb(num(o.maxdisk));
  const usedGb = num(o.usedGb) ?? bytesToGb(num(o.disk));
  const node = String(o.node ?? "").trim() || undefined;
  return compactGuest({
    vmid,
    name,
    status,
    memMb,
    diskGb,
    usedGb: usedGb != null && usedGb > 0 ? usedGb : undefined,
    template: looksTemplate(name, o.template),
    node,
  });
}

/** `pvesh get /cluster/resources --output-format json` (array, or `{ data: [] }`). */
export function parsePveResources(json: unknown): { vms: ProxmoxGuest[]; lxc: ProxmoxGuest[] } {
  const root = Array.isArray(json) ? json : asRecord(json)?.data;
  const rows = Array.isArray(root) ? root : [];
  const vms: ProxmoxGuest[] = [];
  const lxc: ProxmoxGuest[] = [];
  const seenVm = new Set<number>();
  const seenLx = new Set<number>();
  for (const row of rows) {
    const o = asRecord(row);
    if (!o) continue;
    const type = String(o.type ?? "").toLowerCase();
    if (type === "qemu" || type === "openvz") {
      const g = fromResource(o);
      if (g && !seenVm.has(g.vmid)) {
        seenVm.add(g.vmid);
        vms.push(g);
      }
    } else if (type === "lxc") {
      const g = fromResource(o);
      if (g && !seenLx.has(g.vmid)) {
        seenLx.add(g.vmid);
        lxc.push(g);
      }
    }
  }
  vms.sort((a, b) => a.vmid - b.vmid);
  lxc.sort((a, b) => a.vmid - b.vmid);
  return { vms, lxc };
}

/** `pct list` text. */
export function parsePctList(text: string): ProxmoxGuest[] {
  const out: ProxmoxGuest[] = [];
  const seen = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^vmid\b/i.test(t) || /^---/.test(t)) continue;
    const m = t.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const vmid = Number(m[1]);
    const status = guestStatus(m[2]);
    const rest = m[3].trim().split(/\s+/);
    const name = (rest[rest.length - 1] || String(vmid)).trim();
    if (seen.has(vmid)) continue;
    seen.add(vmid);
    out.push(compactGuest({ vmid, name, status, template: looksTemplate(name) }));
  }
  return out.sort((a, b) => a.vmid - b.vmid);
}

/** `qm list` text. */
export function parseQmList(text: string): ProxmoxGuest[] {
  const out: ProxmoxGuest[] = [];
  const seen = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^vmid\b/i.test(t)) continue;
    const m = t.match(/^(\d+)\s+(\S+)\s+(running|stopped|paused)\s*(.*)$/i);
    if (!m) continue;
    const vmid = Number(m[1]);
    const name = m[2];
    const status = guestStatus(m[3]);
    const nums = (m[4] ?? "").trim().match(/[\d.]+/g) ?? [];
    const memMb = nums[0] != null ? Number(nums[0]) : undefined;
    const diskGb = nums.length > 1 ? Number(nums[nums.length - 1]) : undefined;
    if (seen.has(vmid)) continue;
    seen.add(vmid);
    out.push(
      compactGuest({
        vmid,
        name,
        status,
        memMb: Number.isFinite(memMb) ? memMb : undefined,
        diskGb: Number.isFinite(diskGb) ? diskGb : undefined,
        template: looksTemplate(name),
      }),
    );
  }
  return out.sort((a, b) => a.vmid - b.vmid);
}

export type PveMachineHint = {
  id: number;
  name: string;
  hostname?: string | null;
  host?: string | null;
  ip?: string | null;
};

/** hostname `pve`, IP `10.50.0.155`, or name containing "proxmox". */
export function matchPveMachine(machines: PveMachineHint[]): PveMachineHint | null {
  const ipOf = (s: string | null | undefined) => {
    const m = String(s ?? "").match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
    return m ? m[1] : null;
  };
  const norm = (s: string) => s.trim().toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9]+/g, "");
  for (const m of machines) {
    const keys = [m.hostname, m.host].filter(Boolean).map((x) => norm(String(x)));
    if (keys.includes("pve")) return m;
  }
  for (const m of machines) {
    if (ipOf(m.ip) === "10.50.0.155") return m;
  }
  for (const m of machines) {
    if (/\bproxmox\b/i.test(m.name) || /\bproxmox\b/i.test(String(m.hostname ?? "")) || /\bproxmox\b/i.test(String(m.host ?? ""))) {
      return m;
    }
  }
  return null;
}

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const TIB = 1024 * 1024 * 1024 * 1024;

/** Proxmox size suffixes are binary (K/M/G/T = KiB/MiB/GiB/TiB). */
function parsePveSizeBytes(raw: string): number | undefined {
  const m = String(raw).trim().match(/^([\d.]+)\s*([KMGT])?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const u = (m[2] ?? "G").toUpperCase();
  const mul = u === "T" ? TIB : u === "G" ? GIB : u === "M" ? MIB : u === "K" ? KIB : GIB;
  const bytes = n * mul;
  if (!(bytes > 0) || !Number.isFinite(bytes)) return undefined;
  return Math.round(bytes);
}

function bytesToSizeGb(bytes: number): number | undefined {
  const gb = bytes / GIB;
  if (!(gb > 0)) return undefined;
  if (gb < 0.01) return Math.round(gb * 10000) / 10000;
  if (gb < 1) return Math.round(gb * 1000) / 1000;
  return Math.round(gb * 10) / 10;
}

function storageOf(vol: string): string | undefined {
  const v = vol.trim();
  if (!v || v === "none" || v.startsWith("/")) return undefined;
  const i = v.indexOf(":");
  if (i <= 0) return undefined;
  return v.slice(0, i).slice(0, 64);
}

const DISK_KEY = /^(scsi|sata|virtio|ide|efidisk|tpmstate)\d+$/i;
const MP_KEY = /^mp\d+$/i;
const CONFIG_KEY = /^(memory|rootfs|(scsi|sata|virtio|ide|efidisk|tpmstate|mp)\d+)$/i;

function isCdromOrNone(val: string): boolean {
  return /(?:^|,)media=cdrom(?:,|$)/i.test(val) || /^none(?:$|,)/i.test(val);
}

function sizeFromVolBytes(val: string): number | undefined {
  const m = val.match(/(?:^|,)size=([\d.]+[KMGT]?)/i);
  return m ? parsePveSizeBytes(m[1]) : undefined;
}

function sizeFromVol(val: string): number | undefined {
  const bytes = sizeFromVolBytes(val);
  return bytes != null ? bytesToSizeGb(bytes) : undefined;
}

function configRecord(raw: unknown): Record<string, unknown> | null {
  const o = asRecord(raw);
  if (!o) return null;
  const inner = asRecord(o.data);
  if (inner) {
    const topHas = Object.keys(o).some((k) => CONFIG_KEY.test(k));
    const innerHas = Object.keys(inner).some((k) => CONFIG_KEY.test(k));
    if (!topHas && innerHas) return inner;
  }
  return o;
}

/** `pvesh` config JSON, `qm config` / `pct config` text. QEMU disk keys → disks; LXC rootfs+mpN → mounts. */
export function parsePveGuestConfig(
  raw: unknown,
  kind: "qemu" | "lxc" = "qemu",
): Pick<ProxmoxGuest, "disks" | "mounts" | "memMb"> {
  const lines: string[] = [];
  if (typeof raw === "string") {
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) lines.push(t);
    }
  } else {
    const o = configRecord(raw);
    if (o) {
      for (const [k, v] of Object.entries(o)) {
        if (v != null && v !== "") lines.push(`${k}: ${v}`);
      }
    }
  }
  const disks: ProxmoxDisk[] = [];
  const mounts: ProxmoxMount[] = [];
  let memMb: number | undefined;
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (/^memory$/i.test(key)) {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) memMb = n;
      continue;
    }
    if (kind === "qemu" && DISK_KEY.test(key)) {
      if (isCdromOrNone(val)) continue;
      const sizeGb = sizeFromVol(val);
      if (sizeGb == null || !(sizeGb > 0)) continue;
      const vol = val.split(",")[0]?.trim() || key;
      const storage = storageOf(vol);
      disks.push({ name: key.slice(0, 64), sizeGb, ...(storage ? { storage } : {}) });
      continue;
    }
    if (kind === "lxc" && key === "rootfs") {
      if (isCdromOrNone(val)) continue;
      const bytes = sizeFromVolBytes(val);
      const vol = val.split(",")[0]?.trim() || key;
      mounts.push({
        source: vol.slice(0, 255),
        dest: "/",
        type: "rootfs",
        ...(bytes ? { size: bytes } : {}),
      });
      continue;
    }
    if (kind === "lxc" && MP_KEY.test(key)) {
      const destM = val.match(/(?:^|,)mp=([^,]+)/i);
      const bytes = sizeFromVolBytes(val);
      const source = val.split(",")[0]?.trim() ?? key;
      const dest = destM?.[1]?.trim() || source;
      mounts.push({
        source: source.slice(0, 255),
        dest: dest.slice(0, 255),
        type: "mp",
        ...(bytes ? { size: bytes } : {}),
      });
    }
  }
  return {
    ...(disks.length ? { disks } : {}),
    ...(mounts.length ? { mounts } : {}),
    ...(memMb != null ? { memMb } : {}),
  };
}

function diskGbFromConfig(
  extra: Pick<ProxmoxGuest, "disks" | "mounts">,
  kind: "qemu" | "lxc",
): number | undefined {
  if (kind === "lxc") {
    const root = extra.mounts?.find((m) => m.type === "rootfs");
    if (root?.size != null && root.size > 0) return bytesToSizeGb(root.size);
    return undefined;
  }
  const sum = extra.disks?.reduce((s, d) => s + (d.sizeGb ?? 0), 0) ?? 0;
  return sum > 0 ? Math.round(sum * 10) / 10 : undefined;
}

/** Merge one guest's pvesh/qm/pct config onto the cluster-resource row. */
export function applyPveGuestConfig(g: ProxmoxGuest, raw: unknown, kind: "qemu" | "lxc"): ProxmoxGuest {
  const extra = parsePveGuestConfig(raw, kind);
  const diskGb = diskGbFromConfig(extra, kind);
  return compactGuest({
    ...g,
    ...extra,
    diskGb: diskGb ?? g.diskGb,
    memMb: extra.memMb ?? g.memMb,
  });
}

/** Multiplexed `=== 100 ===\n...config` blocks from one SSH. */
export function parsePveConfigBlocks(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let cur: number | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur != null) out.set(cur, buf.join("\n"));
    buf = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^===\s*(\d+)\s*===$/);
    if (m) {
      flush();
      cur = Number(m[1]);
      continue;
    }
    if (cur != null) buf.push(line);
  }
  flush();
  return out;
}

export function enrichProxmoxGuests(
  guests: ProxmoxGuest[],
  configs: Map<number, string>,
  kind: "qemu" | "lxc" = "qemu",
): ProxmoxGuest[] {
  return guests.map((g) => {
    const raw = configs.get(g.vmid);
    if (!raw) return g;
    return applyPveGuestConfig(g, raw, kind);
  });
}

export function parseProxmoxInventory(input: {
  resourcesJson?: unknown;
  pctList?: string;
  qmList?: string;
  qmConfigs?: string;
  pctConfigs?: string;
}): {
  vms: ProxmoxGuest[];
  lxc: ProxmoxGuest[];
} {
  let vms: ProxmoxGuest[] = [];
  let lxc: ProxmoxGuest[] = [];
  if (input.resourcesJson != null) {
    const parsed = parsePveResources(input.resourcesJson);
    vms = parsed.vms;
    lxc = parsed.lxc;
  }
  if (!vms.length && input.qmList) vms = parseQmList(input.qmList);
  if (!lxc.length && input.pctList) lxc = parsePctList(input.pctList);
  if (input.qmConfigs) vms = enrichProxmoxGuests(vms, parsePveConfigBlocks(input.qmConfigs), "qemu");
  if (input.pctConfigs) lxc = enrichProxmoxGuests(lxc, parsePveConfigBlocks(input.pctConfigs), "lxc");
  return { vms, lxc };
}
