import {
  guessServiceKind,
  hubRadius,
  volumeRadius,
  volumeSizeScale,
  usedHeatColor,
  isMachineItem,
  isNetworkItem,
  isOtherComputersItem,
  parseImportance,
  parseRating,
  parseDatabases,
  parseGuests,
  parseProjects,
  parseServices,
  parseWeb,
  SERVICE_ROLES,
  CONTAINER_ROLES,
  WEB_ROLES,
  type Attrs,
  type DatabaseRec,
  type GuestRec,
  type Importance,
  type ProjectRec,
  type Rating,
  type ServiceRec,
  type WebRec,
} from "@/lib/systemsAttrs";
import { pickReachHost, rewriteLocalHostUrl, statusTone, type StatusTone } from "../../api/lib/serviceUrls";
import {
  PROJECT_KIND_COLOR,
  fmtAgo,
  fmtMinutes,
  fmtTokens,
  inferProjectStatus,
  projectFade,
} from "../../api/lib/servicesProjects";

export const KIND_COLOR: Record<string, string> = {
  center: "#ff6b35",
  machine: "#ff8c5a",
  network: "#00cec9",
  other: "#636e72",
  service: "#6c5ce7",
  web: "#4A90E2",
  vm: "#fdcb6e",
  lxc: "#74b9ff",
  database: "#e17055",
  project: "#d97706",
  disk: "#00b894",
  volume: "#55efc4",
  runtime: "#ff6b35",
};

export const KIND_LABEL: Record<string, string> = {
  machine: "Machines",
  network: "Network",
  other: "Other",
  service: "Services",
  web: "Web / PWA",
  vm: "VMs",
  lxc: "LXC",
  database: "Databases",
  project: "Projects",
  disk: "Disks",
  volume: "Volumes",
};

export type ItemScope = "machines" | "network" | "all";
export type HubType = "machine" | "network" | "other";

const MAX_SVC = 48;
const MAX_WEB = 24;
const MAX_DISK = 16;

export type GraphItem = {
  id: number;
  name: string;
  parentId: number | null;
  areaSlug: string | null;
  areaName: string | null;
  houseId: number | null;
  houseName: string | null;
  status: string;
  attributes: Attrs;
  roomName: string | null;
};

export type GraphVolume = {
  id: number;
  itemId: number;
  mountPoint: string;
  label: string | null;
  usedBytes: number;
  capacityBytes: number;
  dataRole: string | null;
  dirCount: number;
};

export type GraphComputer = {
  id: number;
  name: string;
  kind: string;
  volumes: GraphVolume[];
  drives: { id: number; name: string; volumes: GraphVolume[] }[];
  attached: { id: number; name: string; volumes: GraphVolume[] }[];
};

export type NodeType = "center" | "machine" | "network" | "other" | "service" | "web" | "vm" | "lxc" | "database" | "project" | "disk" | "volume";

export type GraphNode = {
  id: string;
  type: NodeType;
  label: string;
  radius: number;
  color: string;
  dimmed: boolean;
  /** Templates: even fainter than a stopped guest. */
  faint?: boolean;
  /** 0–1 fill fade for stale coding-agent projects. */
  fade?: number;
  tone?: StatusTone;
  itemId?: number;
  volumeId?: number;
  importance?: Importance | null;
  rating?: Rating;
  kind?: string;
  tags: string[];
  lines: { k: string; v: string }[];
  href?: string;
  usedPct?: number | null;
};

export type GraphLink = {
  source: string;
  target: string;
  strength: number;
  cross?: boolean;
  /** Disk → volume: shorter distance, stronger spring. */
  tight?: boolean;
};

export type BuiltGraph = {
  nodes: GraphNode[];
  links: GraphLink[];
  runtimes: string[];
  legend: { type: string; label: string; color: string; count: number }[];
};

function fmtGb(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(0)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

function attr(it: GraphItem, key: string): string | null {
  const v = it.attributes?.[key];
  if (v == null || v === "") return null;
  return String(v);
}

function machineLines(it: GraphItem): { k: string; v: string }[] {
  const rows: { k: string; v: string }[] = [];
  const role = attr(it, "role");
  const imp = parseImportance(it.attributes);
  if (role) rows.push({ k: "role", v: role });
  if (imp) rows.push({ k: "importance", v: imp });
  const ip = attr(it, "ip") ?? attr(it, "ip_address");
  const host = attr(it, "hostname") ?? attr(it, "host");
  if (host) rows.push({ k: "hostname", v: host });
  if (ip) rows.push({ k: "ip", v: ip });
  const os = attr(it, "os");
  if (os) rows.push({ k: "os", v: os });
  const gb = attr(it, "storage_gb");
  const free = attr(it, "storage_free_gb");
  if (gb) rows.push({ k: "storage", v: free ? `${gb} GB (${free} free)` : `${gb} GB` });
  if (it.roomName) rows.push({ k: "place", v: it.roomName });
  if (it.houseName) rows.push({ k: "house", v: it.houseName });
  const rating = parseRating(it.attributes);
  rows.push({ k: "rating", v: `${rating}/5` });
  return rows;
}

function servicesOf(m: GraphItem, kids: GraphItem[]): ServiceRec[] {
  const fromKids: ServiceRec[] = kids
    .filter((c) => {
      const role = attr(c, "role") ?? "";
      return SERVICE_ROLES.has(role) || CONTAINER_ROLES.has(role);
    })
    .map((c) => {
      const role = attr(c, "role") ?? "";
      const portRaw = attr(c, "port");
      const portN = portRaw != null ? Number(portRaw) : NaN;
      return {
        name: c.name,
        kind: CONTAINER_ROLES.has(role) ? "docker" : (attr(c, "kind") ?? guessServiceKind(c.name)),
        status: attr(c, "status") ?? undefined,
        port: Number.isFinite(portN) && portN > 0 ? portN : undefined,
        url: attr(c, "url") ?? undefined,
        itemId: c.id,
      };
    });
  const seen = new Set<string>();
  const out: ServiceRec[] = [];
  for (const s of [...parseServices(m.attributes), ...fromKids]) {
    const k = s.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function webKey(w: WebRec): string {
  return (w.url ?? w.urls?.[0] ?? `${w.port ?? w.ports?.[0] ?? ""}:${w.label}`).toLowerCase();
}

function webPorts(w: WebRec): number[] {
  const raw = [...(w.ports ?? []), ...(w.port != null ? [w.port] : [])];
  return raw.filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
}

function webUrls(w: WebRec, reach?: string | null): string[] {
  const raw = [...(w.urls ?? []), ...(w.url ? [w.url] : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of raw) {
    const rewritten = rewriteLocalHostUrl(u, reach);
    const k = rewritten.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(rewritten);
  }
  return out;
}

function reachOf(it: GraphItem): string | null {
  return pickReachHost(attr(it, "ip") ?? attr(it, "ip_address"), attr(it, "hostname") ?? attr(it, "host"));
}

function webOf(m: GraphItem, kids: GraphItem[]): WebRec[] {
  const fromKids: WebRec[] = kids
    .filter((c) => WEB_ROLES.has(attr(c, "role") ?? ""))
    .map((c) => {
      const portRaw = attr(c, "port");
      const portN = portRaw != null ? Number(portRaw) : NaN;
      return {
        label: c.name,
        url: attr(c, "url") ?? undefined,
        port: Number.isFinite(portN) && portN > 0 ? portN : undefined,
      };
    });
  const seen = new Set<string>();
  const out: WebRec[] = [];
  for (const w of [...parseWeb(m.attributes), ...fromKids]) {
    const k = webKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

function volumesForMachine(c: GraphComputer | undefined): GraphVolume[] {
  if (!c) return [];
  const out = [...c.volumes];
  for (const d of c.drives) out.push(...d.volumes);
  for (const d of c.attached) out.push(...d.volumes);
  return out;
}

function volumeNode(v: GraphVolume, radius: number, scale: number): GraphNode {
  const usedPct = v.capacityBytes > 0 ? Math.round((v.usedBytes / v.capacityBytes) * 100) : null;
  return {
    id: `vol:${v.id}`,
    type: "volume",
    label: (v.label || v.mountPoint).slice(0, 28),
    radius,
    color: usedHeatColor(KIND_COLOR.volume, usedPct),
    dimmed: false,
    itemId: v.itemId,
    volumeId: v.id,
    usedPct,
    tags: [v.dataRole ?? "volume", usedPct != null ? `${usedPct}%` : "", `${scale}/10`].filter(Boolean),
    lines: [
      { k: "mount", v: v.mountPoint },
      { k: "used", v: `${fmtGb(v.usedBytes)} / ${fmtGb(v.capacityBytes)}` },
      { k: "size", v: `${scale}/10` },
      ...(usedPct != null ? [{ k: "full", v: `${usedPct}%` }] : []),
      ...(v.dataRole ? [{ k: "role", v: v.dataRole }] : []),
      ...(v.dirCount ? [{ k: "dirs", v: String(v.dirCount) }] : []),
    ],
    href: `/storage?volume=${v.id}&item=${v.itemId}`,
  };
}

function diskNode(d: { id: number; name: string; attributes?: Attrs }): GraphNode {
  const a = d.attributes;
  const str = (k: string) => {
    const v = a?.[k];
    return v == null || v === "" ? null : String(v);
  };
  const gb = str("storage_gb");
  const free = str("storage_free_gb");
  const mount = str("mount_point");
  const driveType = str("drive_type");
  const gbN = gb != null ? Number(gb) : NaN;
  const freeN = free != null ? Number(free) : NaN;
  const usedPct =
    Number.isFinite(gbN) && gbN > 0 && Number.isFinite(freeN) ? Math.round(((gbN - freeN) / gbN) * 100) : null;
  return {
    id: `disk:i${d.id}`,
    type: "disk",
    label: d.name.slice(0, 28),
    radius: 7,
    color: usedHeatColor(KIND_COLOR.disk, usedPct),
    dimmed: false,
    itemId: d.id,
    usedPct,
    tags: [driveType ?? "drive", usedPct != null ? `${usedPct}%` : ""].filter(Boolean),
    lines: [
      ...(mount ? [{ k: "mount", v: mount }] : []),
      ...(gb ? [{ k: "storage", v: free ? `${gb} GB (${free} free)` : `${gb} GB` }] : []),
      ...(usedPct != null ? [{ k: "full", v: `${usedPct}%` }] : []),
    ],
    href: `/items/${d.id}`,
  };
}

const MAX_VOL = 12;

function attachStorage(
  hubId: string,
  machineId: number,
  vols: GraphVolume[],
  childDisks: GraphItem[],
  nodes: GraphNode[],
  links: GraphLink[],
  counts: Record<string, number>,
  radiusFor: (v: GraphVolume) => { r: number; scale: number },
) {
  const volsByItem = new Map<number, GraphVolume[]>();
  for (const v of vols) {
    const list = volsByItem.get(v.itemId) ?? [];
    list.push(v);
    volsByItem.set(v.itemId, list);
  }
  const childById = new Map(childDisks.map((d) => [d.id, d]));
  const ids = new Set<number>([...volsByItem.keys(), ...childById.keys()]);
  let disks = 0;
  for (const itemId of ids) {
    if (disks >= MAX_DISK) break;
    const itemVols = (volsByItem.get(itemId) ?? []).slice(0, MAX_VOL);
    if (itemId === machineId) {
      for (const v of itemVols) {
        const leaf = volumeNode(v, radiusFor(v).r, radiusFor(v).scale);
        nodes.push(leaf);
        counts.volume = (counts.volume ?? 0) + 1;
        links.push({ source: hubId, target: leaf.id, strength: 0.7, tight: true });
      }
      continue;
    }
    const child = childById.get(itemId);
    const disk = diskNode(child ?? { id: itemId, name: itemVols[0]?.label || itemVols[0]?.mountPoint || `disk ${itemId}` });
    nodes.push(disk);
    counts.disk = (counts.disk ?? 0) + 1;
    disks += 1;
    links.push({ source: hubId, target: disk.id, strength: 0.3 });
    for (const v of itemVols) {
      const leaf = volumeNode(v, radiusFor(v).r, radiusFor(v).scale);
      nodes.push(leaf);
      counts.volume = (counts.volume ?? 0) + 1;
      links.push({ source: disk.id, target: leaf.id, strength: 0.7, tight: true });
    }
  }
}

function serviceNode(machineId: number, s: ServiceRec, i: number, reach?: string | null): GraphNode {
  const itemId = s.itemId ?? machineId;
  const url = s.url ? rewriteLocalHostUrl(s.url, reach) : undefined;
  const tone = statusTone(s.status);
  return {
    id: `svc:${machineId}:${i}:${s.name}`,
    type: "service",
    label: s.name.slice(0, 28),
    radius: 6,
    color: KIND_COLOR.service,
    dimmed: tone === "dim",
    tone,
    itemId,
    kind: s.kind,
    tags: [s.kind, s.status, s.port != null ? `:${s.port}` : ""].filter(Boolean) as string[],
    lines: [
      { k: "kind", v: s.kind },
      ...(s.status ? [{ k: "status", v: s.status }] : []),
      ...(s.port != null ? [{ k: "port", v: String(s.port) }] : []),
      ...(url ? [{ k: "url", v: url }] : []),
    ],
    href: `/items/${itemId}`,
  };
}

function webNode(machineId: number, w: WebRec, i: number, reach?: string | null): GraphNode {
  const ports = webPorts(w);
  const urls = webUrls(w, reach);
  const tone = statusTone(w.status);
  return {
    id: `web:${machineId}:${i}:${w.label}`,
    type: "web",
    label: w.label.slice(0, 28),
    radius: 5,
    color: KIND_COLOR.web,
    dimmed: tone === "dim",
    tone,
    itemId: machineId,
    tags: [
      ...(w.status ? [w.status] : []),
      ...(ports.length ? ports.map((p) => `:${p}`) : urls.length ? ["url"] : []),
    ],
    lines: [
      ...(w.status ? [{ k: "status", v: w.status }] : []),
      ...(ports.length ? [{ k: "ports", v: ports.join(", ") }] : []),
      ...urls.map((u) => ({ k: "url", v: u })),
    ],
    href: urls[0],
  };
}

function portChildNodes(parent: GraphNode, w: WebRec, reach?: string | null): { nodes: GraphNode[]; links: GraphLink[] } {
  const ports = webPorts(w);
  if (ports.length < 2) return { nodes: [], links: [] };
  const urls = webUrls(w, reach);
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  for (const p of ports) {
    const url = urls.find((u) => {
      try {
        const n = Number(new URL(u).port);
        return n === p;
      } catch {
        return u.includes(`:${p}`);
      }
    });
    nodes.push({
      id: `${parent.id}:p:${p}`,
      type: "web",
      label: `:${p}`,
      radius: 3.5,
      color: KIND_COLOR.web,
      dimmed: false,
      itemId: parent.itemId,
      tags: [`:${p}`],
      lines: [{ k: "port", v: String(p) }, ...(url ? [{ k: "url", v: url }] : [])],
      href: url,
    });
    links.push({ source: parent.id, target: `${parent.id}:p:${p}`, strength: 0.5, tight: true });
  }
  return { nodes, links };
}

function shouldExpandPorts(parentId: string, expandId: string | null | undefined): boolean {
  if (!expandId) return false;
  return expandId === parentId || expandId.startsWith(`${parentId}:p:`);
}

const MAX_GUEST = 48;

function guestsOf(m: GraphItem, key: "vms" | "lxc"): GuestRec[] {
  return parseGuests(m.attributes, key);
}

function guestNode(machineId: number, kind: "vm" | "lxc", g: GuestRec): GraphNode {
  const running = /^running$/i.test(g.status);
  const faint = g.template === true;
  const tone = faint ? "dim" : statusTone(g.status);
  return {
    id: `${kind}:${machineId}:${g.vmid}`,
    type: kind,
    label: g.name.slice(0, 28),
    radius: faint ? 4 : 6,
    color: KIND_COLOR[kind],
    dimmed: !running || faint,
    faint,
    tone,
    itemId: machineId,
    kind,
    tags: [
      kind,
      g.status,
      g.template ? "template" : "",
      g.vmid != null ? `#${g.vmid}` : "",
    ].filter(Boolean),
    lines: [
      { k: "vmid", v: String(g.vmid) },
      { k: "status", v: g.status },
      ...(g.memMb != null ? [{ k: "mem", v: `${g.memMb} MB` }] : []),
      ...(g.diskGb != null && g.diskGb > 0 ? [{ k: "disk", v: `${g.diskGb} GB` }] : []),
      ...(g.template ? [{ k: "template", v: "yes" }] : []),
    ],
    href: `/items/${machineId}`,
  };
}

function attachGuests(
  hubId: string,
  machineId: number,
  vms: GuestRec[],
  lxc: GuestRec[],
  nodes: GraphNode[],
  links: GraphLink[],
  counts: Record<string, number>,
) {
  for (const g of vms.slice(0, MAX_GUEST)) {
    const leaf = guestNode(machineId, "vm", g);
    nodes.push(leaf);
    counts.vm = (counts.vm ?? 0) + 1;
    links.push({ source: hubId, target: leaf.id, strength: 0.3 });
  }
  for (const g of lxc.slice(0, MAX_GUEST)) {
    const leaf = guestNode(machineId, "lxc", g);
    nodes.push(leaf);
    counts.lxc = (counts.lxc ?? 0) + 1;
    links.push({ source: hubId, target: leaf.id, strength: 0.3 });
  }
}

function databasesOf(m: GraphItem): DatabaseRec[] {
  return parseDatabases(m.attributes);
}

function projectsOf(m: GraphItem): ProjectRec[] {
  return parseProjects(m.attributes);
}

function databaseNode(machineId: number, d: DatabaseRec, i: number): GraphNode {
  const status = d.status ?? "";
  const tone = status ? statusTone(status) : undefined;
  return {
    id: `db:${machineId}:${d.name}:${i}`,
    type: "database",
    label: d.name.slice(0, 28),
    radius: 6,
    color: KIND_COLOR.database,
    dimmed: tone === "dim" || tone === "error",
    tone,
    itemId: machineId,
    kind: d.engine ?? "database",
    tags: ["database", d.engine ?? "", status].filter(Boolean),
    lines: [
      ...(d.engine ? [{ k: "engine", v: d.engine }] : []),
      ...(status ? [{ k: "status", v: status }] : []),
      ...(d.port != null ? [{ k: "port", v: String(d.port) }] : []),
      ...(d.size != null && d.size > 0 ? [{ k: "size", v: d.size >= 1024 ? fmtGb(d.size) : String(d.size) }] : []),
    ],
    href: d.url ?? `/items/${machineId}`,
  };
}

function projectRadius(p: ProjectRec): number {
  const tokens = p.tokens ?? 0;
  if (tokens >= 1e6) return 10;
  if (tokens >= 1e5) return 8;
  if (tokens >= 1e4) return 7;
  if (p.size && p.size > 50 * 1024 * 1024) return 8;
  return 6;
}

function projectNode(machineId: number, p: ProjectRec, i: number): GraphNode {
  const status = inferProjectStatus(p.status, p.updatedAt);
  const fade = projectFade(status, p.updatedAt);
  const kind = (p.kind ?? "").toLowerCase();
  const color = PROJECT_KIND_COLOR[kind] ?? KIND_COLOR.project;
  const active = /^(active|running|ok|live)$/i.test(status);
  return {
    id: `proj:${machineId}:${kind}:${p.name}:${i}`,
    type: "project",
    label: p.name.slice(0, 28),
    radius: projectRadius(p),
    color,
    dimmed: !active && fade < 0.7,
    faint: fade < 0.4,
    fade,
    tone: active ? "ok" : fade < 0.6 ? "dim" : statusTone(status),
    itemId: machineId,
    kind: kind || "project",
    tags: ["project", kind, status].filter(Boolean),
    lines: [
      ...(kind ? [{ k: "kind", v: kind }] : []),
      ...(status ? [{ k: "status", v: status }] : []),
      ...(p.tokens != null && p.tokens > 0 ? [{ k: "tokens", v: fmtTokens(p.tokens) }] : []),
      ...(p.size != null && p.size > 0 ? [{ k: "size", v: fmtGb(p.size) }] : []),
      ...(p.minutes != null && p.minutes > 0 ? [{ k: "time", v: fmtMinutes(p.minutes) }] : []),
      ...(p.updatedAt ? [{ k: "updated", v: fmtAgo(p.updatedAt) }] : []),
    ],
    href: p.url ?? `/items/${machineId}`,
  };
}

function attachLists(
  hubId: string,
  machineId: number,
  databases: DatabaseRec[],
  projects: ProjectRec[],
  nodes: GraphNode[],
  links: GraphLink[],
  counts: Record<string, number>,
) {
  for (const [i, d] of databases.slice(0, MAX_GUEST).entries()) {
    const leaf = databaseNode(machineId, d, i);
    nodes.push(leaf);
    counts.database = (counts.database ?? 0) + 1;
    links.push({ source: hubId, target: leaf.id, strength: 0.3 });
  }
  for (const [i, p] of projects.slice(0, MAX_GUEST).entries()) {
    const leaf = projectNode(machineId, p, i);
    nodes.push(leaf);
    counts.project = (counts.project ?? 0) + 1;
    links.push({ source: hubId, target: leaf.id, strength: 0.3 });
  }
}

export function collectRuntimes(
  items: GraphItem[],
  childrenByParent: Map<number, GraphItem[]>,
  volumeIds: Set<number>,
): string[] {
  const counts = new Map<string, number>();
  let web = 0;
  let vms = 0;
  let lxc = 0;
  let databases = 0;
  let projects = 0;
  for (const it of items) {
    if (!isMachineItem({ ...it, hasVolumes: volumeIds.has(it.id) })) continue;
    const kids = childrenByParent.get(it.id) ?? [];
    for (const s of servicesOf(it, kids)) {
      counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
    }
    web += webOf(it, kids).length;
    vms += guestsOf(it, "vms").length;
    lxc += guestsOf(it, "lxc").length;
    databases += databasesOf(it).length;
    projects += projectsOf(it).length;
  }
  const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  if (web > 0 && !kinds.includes("web")) kinds.push("web");
  if (vms > 0 && !kinds.includes("vms")) kinds.push("vms");
  if (lxc > 0 && !kinds.includes("lxc")) kinds.push("lxc");
  if (databases > 0 && !kinds.includes("databases")) kinds.push("databases");
  if (projects > 0 && !kinds.includes("projects")) kinds.push("projects");
  return kinds;
}

export function classifyHub(it: GraphItem, volumeIds: Set<number>): HubType | null {
  const flagged = { ...it, hasVolumes: volumeIds.has(it.id) };
  if (isMachineItem(flagged)) return "machine";
  if (isNetworkItem(flagged)) return "network";
  if (isOtherComputersItem(flagged)) return "other";
  return null;
}

function hubAllowed(type: HubType, scope: ItemScope): boolean {
  if (type === "machine") return true;
  if (type === "network") return scope === "network" || scope === "all";
  return scope === "all";
}

function hubNodeId(type: HubType, id: number): string {
  return `${type === "machine" ? "m" : type === "network" ? "n" : "o"}:${id}`;
}

function makeHubNode(it: GraphItem, type: HubType, subnodes: number): GraphNode {
  const imp = parseImportance(it.attributes);
  const rating = parseRating(it.attributes);
  const radius = hubRadius(subnodes, rating);
  return {
    id: hubNodeId(type, it.id),
    type,
    label: it.name.slice(0, 32),
    radius,
    color: KIND_COLOR[type],
    dimmed: imp === "afvoeren" || rating === 1,
    itemId: it.id,
    importance: imp,
    rating,
    tags: [attr(it, "role"), imp, `${rating}★`].filter(Boolean) as string[],
    lines: machineLines(it),
    href: `/items/${it.id}`,
  };
}

function hubSubnodes(m: GraphItem, kids: GraphItem[], computer: GraphComputer | undefined): number {
  const services = servicesOf(m, kids);
  const web = webOf(m, kids);
  const childDisks = kids.filter((c) => attr(c, "role") === "storage");
  const vols = volumesForMachine(computer);
  const diskIds = new Set([...vols.map((v) => v.itemId), ...childDisks.map((d) => d.id)].filter((id) => id !== m.id));
  return (
    services.length +
    web.length +
    guestsOf(m, "vms").length +
    guestsOf(m, "lxc").length +
    databasesOf(m).length +
    projectsOf(m).length +
    diskIds.size +
    vols.length
  );
}

function unusedWeb(services: ServiceRec[], web: WebRec[]): WebRec[] {
  const used = new Set<string>();
  for (const s of services) {
    if (s.url) used.add(s.url.toLowerCase());
    if (s.port != null) used.add(`:${s.port}`);
  }
  return web.filter((w) => {
    if (used.has(webKey(w))) return false;
    if (webUrls(w).some((u) => used.has(u.toLowerCase()))) return false;
    if (webPorts(w).some((p) => used.has(`:${p}`))) return false;
    return true;
  });
}

export function buildSystemsGraph(opts: {
  items: GraphItem[];
  computers: GraphComputer[];
  view: "systems" | "services";
  runtime: string | null;
  centerLabel: string;
  relations?: { fromItemId: number; toItemId: number }[];
  scope?: ItemScope;
  volumeItemIds?: Iterable<number>;
  minRating?: Rating;
  focusItemId?: number | null;
  /** When a web leaf is selected (or one of its port children), attach port child nodes. */
  expandNodeId?: string | null;
}): BuiltGraph {
  const { items, computers, view, runtime, relations } = opts;
  const scope = opts.scope ?? "machines";
  const minRating = opts.minRating ?? 1;
  const focusItemId = opts.focusItemId ?? null;
  const expandNodeId = opts.expandNodeId ?? null;
  const volumeIds = new Set(opts.volumeItemIds ?? []);
  const childrenByParent = new Map<number, GraphItem[]>();
  for (const it of items) {
    if (it.parentId == null) continue;
    const list = childrenByParent.get(it.parentId) ?? [];
    list.push(it);
    childrenByParent.set(it.parentId, list);
  }
  const computersById = new Map(computers.map((c) => [c.id, c]));
  const runtimes = collectRuntimes(items, childrenByParent, volumeIds);
  let hubs: { it: GraphItem; type: HubType }[] = [];
  for (const it of items) {
    const type = classifyHub(it, volumeIds);
    if (!type || !hubAllowed(type, scope)) continue;
    hubs.push({ it, type });
  }
  if (focusItemId != null) {
    const ids = new Set<number>([focusItemId]);
    for (const r of relations ?? []) {
      if (r.fromItemId === focusItemId) ids.add(r.toItemId);
      if (r.toItemId === focusItemId) ids.add(r.fromItemId);
    }
    hubs = hubs.filter((h) => ids.has(h.it.id));
  }
  hubs = hubs.filter((h) => (focusItemId != null && h.it.id === focusItemId) || parseRating(h.it.attributes) >= minRating);
  const focusName =
    focusItemId != null
      ? (hubs.find((h) => h.it.id === focusItemId)?.it.name ?? items.find((i) => i.id === focusItemId)?.name ?? null)
      : null;
  const centerLabel = focusName ?? opts.centerLabel;

  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const counts: Record<string, number> = { machine: 0, network: 0, other: 0, service: 0, web: 0, vm: 0, lxc: 0, database: 0, project: 0, disk: 0, volume: 0 };

  if (view === "services") {
    const kind = runtime;
    const machines = hubs.filter((h) => h.type === "machine");
    const matching = (m: GraphItem) => {
      const kids = childrenByParent.get(m.id) ?? [];
      const all = servicesOf(m, kids);
      const webs = webOf(m, kids);
      const vms = guestsOf(m, "vms");
      const lxc = guestsOf(m, "lxc");
      const databases = databasesOf(m);
      const projects = projectsOf(m);
      if (kind === "web") return { services: [] as ServiceRec[], web: webs, vms: [] as GuestRec[], lxc: [] as GuestRec[], databases: [] as DatabaseRec[], projects: [] as ProjectRec[] };
      if (kind === "vms") return { services: [] as ServiceRec[], web: [] as WebRec[], vms, lxc: [] as GuestRec[], databases: [] as DatabaseRec[], projects: [] as ProjectRec[] };
      if (kind === "lxc") return { services: [] as ServiceRec[], web: [] as WebRec[], vms: [] as GuestRec[], lxc, databases: [] as DatabaseRec[], projects: [] as ProjectRec[] };
      if (kind === "databases") return { services: [] as ServiceRec[], web: [] as WebRec[], vms: [] as GuestRec[], lxc: [] as GuestRec[], databases, projects: [] as ProjectRec[] };
      if (kind === "projects") return { services: [] as ServiceRec[], web: [] as WebRec[], vms: [] as GuestRec[], lxc: [] as GuestRec[], databases: [] as DatabaseRec[], projects };
      if (kind) return { services: all.filter((s) => s.kind === kind), web: [] as WebRec[], vms: [] as GuestRec[], lxc: [] as GuestRec[], databases: [] as DatabaseRec[], projects: [] as ProjectRec[] };
      return { services: all, web: unusedWeb(all, webs), vms, lxc, databases, projects };
    };
    const totalLeaves = machines.reduce((s, h) => {
      const m = matching(h.it);
      return s + m.services.length + m.web.length + m.vms.length + m.lxc.length + m.databases.length + m.projects.length;
    }, 0);
    const runtimeLabel =
      kind === "web"
        ? "Web / PWA"
        : kind === "docker"
          ? "containers"
          : kind === "vms"
            ? "VMs"
            : kind === "lxc"
              ? "LXC"
              : kind === "databases"
                ? "Databases"
                : kind === "projects"
                  ? "Projects"
                  : kind ?? "Services";
    nodes.push({
      id: "__center__",
      type: "center",
      label: runtimeLabel,
      radius: Math.max(22, Math.min(40, hubRadius(Math.max(machines.length, totalLeaves), 4))),
      color: KIND_COLOR.runtime,
      dimmed: false,
      tags: ["runtime"],
      lines: [{ k: "runtime", v: kind ?? "all" }, { k: "machines", v: String(machines.length) }],
    });
    // Always draw machines (first ring), even when this runtime has no processes
    // on them — otherwise live data with empty service attributes looks like
    // "no computers in this house".
    for (const { it: m } of machines) {
      const { services, web, vms, lxc, databases, projects } = matching(m);
      const reach = reachOf(m);
      const n = makeHubNode(m, "machine", services.length + web.length + vms.length + lxc.length + databases.length + projects.length);
      nodes.push(n);
      counts.machine += 1;
      links.push({ source: "__center__", target: n.id, strength: 0.8 });
      services.slice(0, MAX_SVC).forEach((s, i) => {
        const leaf = serviceNode(m.id, s, i, reach);
        nodes.push(leaf);
        counts.service += 1;
        links.push({ source: n.id, target: leaf.id, strength: 0.3 });
      });
      web.slice(0, MAX_WEB).forEach((w, i) => {
        const leaf = webNode(m.id, w, i, reach);
        nodes.push(leaf);
        counts.web += 1;
        links.push({ source: n.id, target: leaf.id, strength: 0.3 });
        if (shouldExpandPorts(leaf.id, expandNodeId)) {
          const extra = portChildNodes(leaf, w, reach);
          nodes.push(...extra.nodes);
          links.push(...extra.links);
        }
      });
      attachGuests(n.id, m.id, vms, lxc, nodes, links, counts);
      attachLists(n.id, m.id, databases, projects, nodes, links, counts);
    }
  } else {
    const hubCount = hubs.length;
    nodes.push({
      id: "__center__",
      type: "center",
      label: centerLabel,
      radius: Math.max(22, Math.min(40, hubRadius(hubCount, 4))),
      color: KIND_COLOR.center,
      dimmed: false,
      tags: [],
      lines: [],
    });
    const hubIdByItem = new Map<number, string>();
    const shownVols = hubs.flatMap(({ it: m }) => volumesForMachine(computersById.get(m.id)));
    const caps = shownVols.map((v) => v.capacityBytes).filter((b) => b > 0);
    const minCap = caps.length ? Math.min(...caps) : 0;
    const maxCap = caps.length ? Math.max(...caps) : 0;
    const radiusFor = (v: GraphVolume) => ({
      r: volumeRadius(v.capacityBytes, minCap, maxCap),
      scale: volumeSizeScale(v.capacityBytes, maxCap),
    });
    for (const { it: m, type } of hubs) {
      const kids = childrenByParent.get(m.id) ?? [];
      const n = makeHubNode(m, type, hubSubnodes(m, kids, computersById.get(m.id)));
      nodes.push(n);
      counts[type] = (counts[type] ?? 0) + 1;
      hubIdByItem.set(m.id, n.id);
      links.push({ source: "__center__", target: n.id, strength: 0.8 });

      const childDisks = kids.filter((c) => attr(c, "role") === "storage");
      const services = servicesOf(m, kids);
      const web = unusedWeb(services, webOf(m, kids));
      const reach = reachOf(m);
      attachGuests(n.id, m.id, guestsOf(m, "vms"), guestsOf(m, "lxc"), nodes, links, counts);
      attachLists(n.id, m.id, databasesOf(m), projectsOf(m), nodes, links, counts);
      for (const [i, s] of services.slice(0, MAX_SVC).entries()) {
        const leaf = serviceNode(m.id, s, i, reach);
        nodes.push(leaf);
        counts.service = (counts.service ?? 0) + 1;
        links.push({ source: n.id, target: leaf.id, strength: 0.3 });
      }
      for (const [i, w] of web.slice(0, MAX_WEB).entries()) {
        const leaf = webNode(m.id, w, i, reach);
        nodes.push(leaf);
        counts.web = (counts.web ?? 0) + 1;
        links.push({ source: n.id, target: leaf.id, strength: 0.3 });
        if (shouldExpandPorts(leaf.id, expandNodeId)) {
          const extra = portChildNodes(leaf, w, reach);
          nodes.push(...extra.nodes);
          links.push(...extra.links);
        }
      }
      attachStorage(n.id, m.id, volumesForMachine(computersById.get(m.id)), childDisks, nodes, links, counts, radiusFor);
    }
    const seenCross = new Set<string>();
    for (const r of relations ?? []) {
      const a = hubIdByItem.get(r.fromItemId);
      const b = hubIdByItem.get(r.toItemId);
      if (!a || !b || a === b) continue;
      const key = [a, b].sort().join("|");
      if (seenCross.has(key)) continue;
      seenCross.add(key);
      links.push({ source: a, target: b, strength: 0.05, cross: true });
    }
  }

  const legend = (["machine", "network", "other", "service", "web", "vm", "lxc", "database", "project", "disk", "volume"] as const)
    .filter((t) => (counts[t] ?? 0) > 0)
    .map((t) => ({ type: t, label: KIND_LABEL[t], color: KIND_COLOR[t], count: counts[t] }));

  return { nodes, links, runtimes, legend };
}
