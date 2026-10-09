/** Parse Proxmox `pvesh` JSON or `pct list` / `qm list` text into guest records. */

export type ProxmoxGuest = {
  vmid: number;
  name: string;
  status: string;
  memMb?: number;
  diskGb?: number;
  template?: boolean;
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
  if (g.diskGb != null) rec.diskGb = g.diskGb;
  if (g.template) rec.template = true;
  return rec;
}

function fromResource(o: Record<string, unknown>): ProxmoxGuest | null {
  const vmid = num(o.vmid ?? o.VMID);
  if (vmid == null || vmid < 0 || !Number.isInteger(vmid)) return null;
  const name = String(o.name ?? o.Name ?? o.vmid ?? "").trim() || String(vmid);
  const status = guestStatus(String(o.status ?? o.Status ?? "stopped"));
  const memMb = num(o.memMb) ?? bytesToMb(num(o.maxmem) ?? num(o.mem));
  const diskGb = num(o.diskGb) ?? bytesToGb(num(o.maxdisk) ?? num(o.disk));
  return compactGuest({
    vmid,
    name,
    status,
    memMb,
    diskGb,
    template: looksTemplate(name, o.template),
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

export function parseProxmoxInventory(input: { resourcesJson?: unknown; pctList?: string; qmList?: string }): {
  vms: ProxmoxGuest[];
  lxc: ProxmoxGuest[];
} {
  if (input.resourcesJson != null) {
    const parsed = parsePveResources(input.resourcesJson);
    if (parsed.vms.length || parsed.lxc.length) return parsed;
  }
  return {
    vms: input.qmList ? parseQmList(input.qmList) : [],
    lxc: input.pctList ? parsePctList(input.pctList) : [],
  };
}
