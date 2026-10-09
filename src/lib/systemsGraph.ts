import {
  guessServiceKind,
  isMachineItem,
  machineRadius,
  parseImportance,
  parseServices,
  parseWeb,
  SERVICE_ROLES,
  type Attrs,
  type Importance,
  type ServiceRec,
  type WebRec,
} from "@/lib/systemsAttrs";

export const KIND_COLOR: Record<string, string> = {
  center: "#ff6b35",
  machine: "#ff8c5a",
  service: "#6c5ce7",
  web: "#4A90E2",
  disk: "#00b894",
  runtime: "#ff6b35",
};

export const KIND_LABEL: Record<string, string> = {
  machine: "Machines",
  service: "Services",
  web: "Web / ports",
  disk: "Disks",
};

const MAX_SVC = 16;
const MAX_WEB = 12;
const MAX_DISK = 16;

export type GraphItem = {
  id: number;
  name: string;
  parentId: number | null;
  areaSlug: string | null;
  areaName: string | null;
  houseId: number | null;
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

export type NodeType = "center" | "machine" | "service" | "web" | "disk";

export type GraphNode = {
  id: string;
  type: NodeType;
  label: string;
  radius: number;
  color: string;
  dimmed: boolean;
  itemId?: number;
  volumeId?: number;
  importance?: Importance | null;
  kind?: string;
  tags: string[];
  lines: { k: string; v: string }[];
  href?: string;
};

export type GraphLink = {
  source: string;
  target: string;
  strength: number;
  cross?: boolean;
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
  return rows;
}

function servicesOf(m: GraphItem, kids: GraphItem[]): ServiceRec[] {
  const fromKids: ServiceRec[] = kids
    .filter((c) => SERVICE_ROLES.has(attr(c, "role") ?? ""))
    .map((c) => {
      const portRaw = attr(c, "port");
      const portN = portRaw != null ? Number(portRaw) : NaN;
      return {
        name: c.name,
        kind: attr(c, "kind") ?? guessServiceKind(c.name),
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
  return (w.url ?? `${w.port ?? ""}:${w.label}`).toLowerCase();
}

function volumesForMachine(c: GraphComputer | undefined): GraphVolume[] {
  if (!c) return [];
  const out = [...c.volumes];
  for (const d of c.drives) out.push(...d.volumes);
  for (const d of c.attached) out.push(...d.volumes);
  return out;
}

function leafDiskNodes(vols: GraphVolume[], childDisks: GraphItem[]): GraphNode[] {
  const nodes: GraphNode[] = [];
  const seenItem = new Set<number>();
  for (const v of vols) {
    seenItem.add(v.itemId);
    const usedPct = v.capacityBytes > 0 ? Math.round((v.usedBytes / v.capacityBytes) * 100) : null;
    nodes.push({
      id: `disk:v${v.id}`,
      type: "disk",
      label: (v.label || v.mountPoint).slice(0, 28),
      radius: 7,
      color: KIND_COLOR.disk,
      dimmed: false,
      itemId: v.itemId,
      volumeId: v.id,
      tags: [v.dataRole ?? "volume", usedPct != null ? `${usedPct}%` : ""].filter(Boolean),
      lines: [
        { k: "mount", v: v.mountPoint },
        { k: "used", v: `${fmtGb(v.usedBytes)} / ${fmtGb(v.capacityBytes)}` },
        ...(v.dataRole ? [{ k: "role", v: v.dataRole }] : []),
        ...(v.dirCount ? [{ k: "dirs", v: String(v.dirCount) }] : []),
      ],
      href: `/storage?volume=${v.id}&item=${v.itemId}`,
    });
  }
  for (const d of childDisks) {
    if (seenItem.has(d.id)) continue;
    const gb = attr(d, "storage_gb");
    const free = attr(d, "storage_free_gb");
    const mount = attr(d, "mount_point");
    nodes.push({
      id: `disk:i${d.id}`,
      type: "disk",
      label: d.name.slice(0, 28),
      radius: 6,
      color: KIND_COLOR.disk,
      dimmed: false,
      itemId: d.id,
      tags: [attr(d, "drive_type") ?? "drive"].filter(Boolean),
      lines: [
        ...(mount ? [{ k: "mount", v: mount }] : []),
        ...(gb ? [{ k: "storage", v: free ? `${gb} GB (${free} free)` : `${gb} GB` }] : []),
      ],
      href: `/items/${d.id}`,
    });
  }
  return nodes;
}

function serviceNode(machineId: number, s: ServiceRec, i: number): GraphNode {
  const itemId = s.itemId ?? machineId;
  return {
    id: `svc:${machineId}:${i}:${s.name}`,
    type: "service",
    label: s.name.slice(0, 28),
    radius: 6,
    color: KIND_COLOR.service,
    dimmed: false,
    itemId,
    kind: s.kind,
    tags: [s.kind, s.status, s.port != null ? `:${s.port}` : ""].filter(Boolean) as string[],
    lines: [
      { k: "kind", v: s.kind },
      ...(s.status ? [{ k: "status", v: s.status }] : []),
      ...(s.port != null ? [{ k: "port", v: String(s.port) }] : []),
      ...(s.url ? [{ k: "url", v: s.url }] : []),
    ],
    href: `/items/${itemId}`,
  };
}

function webNode(machineId: number, w: WebRec, i: number): GraphNode {
  return {
    id: `web:${machineId}:${i}:${w.label}`,
    type: "web",
    label: w.label.slice(0, 28),
    radius: 5,
    color: KIND_COLOR.web,
    dimmed: false,
    itemId: machineId,
    tags: [w.port != null ? `:${w.port}` : "url"],
    lines: [
      ...(w.port != null ? [{ k: "port", v: String(w.port) }] : []),
      ...(w.url ? [{ k: "url", v: w.url }] : []),
    ],
    href: w.url,
  };
}

export function collectRuntimes(
  items: GraphItem[],
  childrenByParent: Map<number, GraphItem[]>,
): string[] {
  const counts = new Map<string, number>();
  for (const it of items.filter(isMachineItem)) {
    for (const s of servicesOf(it, childrenByParent.get(it.id) ?? [])) {
      counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export function buildSystemsGraph(opts: {
  items: GraphItem[];
  computers: GraphComputer[];
  view: "systems" | "services";
  runtime: string | null;
  centerLabel: string;
  relations?: { fromItemId: number; toItemId: number }[];
}): BuiltGraph {
  const { items, computers, view, runtime, centerLabel, relations } = opts;
  const childrenByParent = new Map<number, GraphItem[]>();
  for (const it of items) {
    if (it.parentId == null) continue;
    const list = childrenByParent.get(it.parentId) ?? [];
    list.push(it);
    childrenByParent.set(it.parentId, list);
  }
  const computersById = new Map(computers.map((c) => [c.id, c]));
  const machines = items.filter(isMachineItem);
  const runtimes = collectRuntimes(items, childrenByParent);

  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const counts: Record<string, number> = { machine: 0, service: 0, web: 0, disk: 0 };

  if (view === "services") {
    const kind = runtime ?? runtimes[0] ?? "node";
    nodes.push({
      id: "__center__",
      type: "center",
      label: kind,
      radius: 30,
      color: KIND_COLOR.runtime,
      dimmed: false,
      tags: ["runtime"],
      lines: [{ k: "runtime", v: kind }],
    });
    for (const m of machines) {
      const services = servicesOf(m, childrenByParent.get(m.id) ?? []).filter((s) => s.kind === kind);
      if (services.length === 0) continue;
      const imp = parseImportance(m.attributes);
      const mid = `m:${m.id}`;
      nodes.push({
        id: mid,
        type: "machine",
        label: m.name.slice(0, 32),
        radius: machineRadius(imp),
        color: KIND_COLOR.machine,
        dimmed: imp === "afvoeren",
        itemId: m.id,
        importance: imp,
        tags: [attr(m, "role"), imp].filter(Boolean) as string[],
        lines: machineLines(m),
        href: `/items/${m.id}`,
      });
      counts.machine += 1;
      links.push({ source: "__center__", target: mid, strength: 0.8 });
      services.slice(0, MAX_SVC).forEach((s, i) => {
        const n = serviceNode(m.id, s, i);
        nodes.push(n);
        counts.service += 1;
        links.push({ source: mid, target: n.id, strength: 0.3 });
      });
    }
  } else {
    nodes.push({
      id: "__center__",
      type: "center",
      label: centerLabel,
      radius: 30,
      color: KIND_COLOR.center,
      dimmed: false,
      tags: [],
      lines: [],
    });
    for (const m of machines) {
      const imp = parseImportance(m.attributes);
      const mid = `m:${m.id}`;
      nodes.push({
        id: mid,
        type: "machine",
        label: m.name.slice(0, 32),
        radius: machineRadius(imp),
        color: KIND_COLOR.machine,
        dimmed: imp === "afvoeren",
        itemId: m.id,
        importance: imp,
        tags: [attr(m, "role"), imp].filter(Boolean) as string[],
        lines: machineLines(m),
        href: `/items/${m.id}`,
      });
      counts.machine += 1;
      links.push({ source: "__center__", target: mid, strength: 0.8 });

      const kids = childrenByParent.get(m.id) ?? [];
      const childDisks = kids.filter((c) => attr(c, "role") === "storage");
      const services = servicesOf(m, kids);
      const usedWeb = new Set<string>();
      for (const s of services) {
        if (s.url) usedWeb.add(s.url.toLowerCase());
        if (s.port != null) usedWeb.add(`:${s.port}`);
      }
      const web = parseWeb(m.attributes).filter((w) => !usedWeb.has(webKey(w)) && !usedWeb.has(w.port != null ? `:${w.port}` : ""));
      const disks = leafDiskNodes(volumesForMachine(computersById.get(m.id)), childDisks);

      const leaves: GraphNode[] = [
        ...services.slice(0, MAX_SVC).map((s, i) => serviceNode(m.id, s, i)),
        ...web.slice(0, MAX_WEB).map((w, i) => webNode(m.id, w, i)),
        ...disks.slice(0, MAX_DISK),
      ];
      for (const n of leaves) {
        nodes.push(n);
        counts[n.type] = (counts[n.type] ?? 0) + 1;
        links.push({ source: mid, target: n.id, strength: 0.3 });
      }
    }
    const machineIds = new Set(machines.map((m) => m.id));
    const seenCross = new Set<string>();
    for (const r of relations ?? []) {
      if (!machineIds.has(r.fromItemId) || !machineIds.has(r.toItemId) || r.fromItemId === r.toItemId) continue;
      const key = [r.fromItemId, r.toItemId].sort((a, b) => a - b).join("|");
      if (seenCross.has(key)) continue;
      seenCross.add(key);
      links.push({ source: `m:${r.fromItemId}`, target: `m:${r.toItemId}`, strength: 0.05, cross: true });
    }
  }

  const legend = (["machine", "service", "web", "disk"] as const)
    .filter((t) => (counts[t] ?? 0) > 0)
    .map((t) => ({ type: t, label: KIND_LABEL[t], color: KIND_COLOR[t], count: counts[t] }));

  return { nodes, links, runtimes, legend };
}
