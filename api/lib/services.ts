import { eq } from "drizzle-orm";
import { items } from "@db/schema";
import type { getDb } from "../queries/connection";
import { pickReachHost, rewriteLocalHostUrl } from "./serviceUrls.ts";
import { dbMergeKey, isProjectSourceLabel, looksLikeProjectDir, mergeProjectRecords, projectMergeKey } from "./servicesProjects.ts";

type Db = ReturnType<typeof getDb>;

/** Same machine roles Systems treats as hubs that can run containers. */
export const SERVICE_MACHINE_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas"]);

export class ServicesReportError extends Error {}

export type MountRecIn = {
  source: string;
  dest: string;
  type?: string;
  size?: number;
};

export type DiskRecIn = {
  name: string;
  sizeGb?: number;
  storage?: string;
};

export type ServiceRecIn = {
  name: string;
  status?: string;
  image?: string;
  port?: number;
  ports?: number[];
  url?: string;
  size?: number;
  imageSize?: number;
  layers?: number;
  created?: string;
  mounts?: MountRecIn[];
};

export type WebRecIn = {
  label: string;
  url?: string;
  port?: number;
  urls?: string[];
  ports?: number[];
  status?: string;
};

export type GuestRecIn = {
  vmid: number;
  name: string;
  status?: string;
  memMb?: number;
  diskGb?: number;
  usedGb?: number;
  template?: boolean;
  disks?: DiskRecIn[];
  mounts?: MountRecIn[];
  ip?: string;
  hostname?: string;
  url?: string;
  ports?: number[];
};

export type DatabaseRecIn = {
  name: string;
  engine?: string;
  status?: string;
  port?: number;
  size?: number;
  url?: string;
  target?: string;
  detail?: string;
  checked?: string;
};

export type ProjectRecIn = {
  name: string;
  kind?: string;
  /** Transcript / history origin — not the agent. */
  source?: string;
  status?: string;
  tokens?: number;
  size?: number;
  updatedAt?: string;
  minutes?: number;
  url?: string;
  path?: string;
};

export type ServicesReportInput = {
  itemId: number;
  source: string;
  merge?: boolean;
  containers?: ServiceRecIn[];
  node?: ServiceRecIn[];
  web?: WebRecIn[];
  vms?: GuestRecIn[];
  lxc?: GuestRecIn[];
  databases?: DatabaseRecIn[];
  projects?: ProjectRecIn[];
};

function compactMounts(list: MountRecIn[] | undefined): MountRecIn[] | undefined {
  if (!list?.length) return undefined;
  const out: MountRecIn[] = [];
  for (const m of list) {
    const source = String(m.source ?? "").trim().slice(0, 255);
    const dest = String(m.dest ?? "").trim().slice(0, 255);
    if (!source && !dest) continue;
    const rec: MountRecIn = { source: source || dest, dest: dest || source };
    if (m.type) rec.type = String(m.type).slice(0, 32);
    if (m.size != null && m.size > 0) rec.size = m.size;
    out.push(rec);
    if (out.length >= 32) break;
  }
  return out.length ? out : undefined;
}

function compactService(s: ServiceRecIn, reach: string | null): Record<string, unknown> {
  const ports = [...(s.ports ?? []), ...(s.port != null ? [s.port] : [])].filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
  const o: Record<string, unknown> = { name: s.name };
  if (s.status) o.status = s.status;
  if (s.image) o.image = s.image;
  if (ports[0] != null) o.port = ports[0];
  if (ports.length > 1) o.ports = ports;
  if (s.url) o.url = rewriteLocalHostUrl(s.url, reach);
  if (s.size != null && s.size > 0) o.size = s.size;
  if (s.imageSize != null && s.imageSize > 0) o.imageSize = s.imageSize;
  if (s.layers != null && s.layers > 0) o.layers = s.layers;
  if (s.created) o.created = s.created.slice(0, 32);
  const mounts = compactMounts(s.mounts);
  if (mounts) o.mounts = mounts;
  return o;
}

function compactWeb(w: WebRecIn): Record<string, string | number | string[] | number[]> {
  const ports = [...(w.ports ?? []), ...(w.port != null ? [w.port] : [])].filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
  const urls: string[] = [];
  const seenU = new Set<string>();
  for (const u of [...(w.urls ?? []), ...(w.url ? [w.url] : [])]) {
    const k = u.toLowerCase();
    if (!u || seenU.has(k)) continue;
    seenU.add(k);
    urls.push(u);
  }
  const o: Record<string, string | number | string[] | number[]> = { label: w.label };
  if (urls[0]) o.url = urls[0];
  if (ports[0] != null) o.port = ports[0];
  if (urls.length) o.urls = urls;
  if (ports.length) o.ports = ports;
  if (w.status) o.status = w.status;
  return o;
}

function compactWebAt(w: WebRecIn, reach: string | null): Record<string, string | number | string[] | number[]> {
  return compactWeb({
    ...w,
    url: w.url ? rewriteLocalHostUrl(w.url, reach) : w.url,
    urls: w.urls?.map((u) => rewriteLocalHostUrl(u, reach)),
  });
}

function compactDatabase(d: DatabaseRecIn, reach: string | null): Record<string, unknown> {
  const o: Record<string, unknown> = { name: d.name.slice(0, 64) };
  if (d.engine) o.engine = d.engine.slice(0, 32);
  if (d.status) o.status = d.status;
  if (d.port != null) o.port = d.port;
  if (d.size != null && d.size > 0) o.size = d.size;
  if (d.url) o.url = rewriteLocalHostUrl(d.url, reach);
  if (d.target) o.target = d.target.slice(0, 255);
  if (d.detail) o.detail = d.detail.slice(0, 255);
  if (d.checked) o.checked = d.checked.slice(0, 40);
  return o;
}

function compactProject(p: ProjectRecIn, reach: string | null): Record<string, unknown> {
  const o: Record<string, unknown> = { name: p.name.slice(0, 128) };
  const kindRaw = (p.kind ?? "").trim();
  const sourceRaw = (p.source ?? "").trim();
  const source = sourceRaw || (isProjectSourceLabel(kindRaw) ? kindRaw.toLowerCase() : "");
  const kind = kindRaw && !isProjectSourceLabel(kindRaw) ? kindRaw : "";
  if (kind) o.kind = kind.slice(0, 32);
  if (source) o.source = source.slice(0, 32);
  if (p.status) o.status = p.status;
  if (p.tokens != null && p.tokens > 0) o.tokens = p.tokens;
  if (p.size != null && p.size > 0) o.size = p.size;
  if (p.updatedAt) o.updatedAt = p.updatedAt.slice(0, 40);
  if (p.minutes != null && p.minutes > 0) o.minutes = p.minutes;
  if (p.url) o.url = rewriteLocalHostUrl(p.url, reach);
  const path = (p.path || (looksLikeProjectDir(p.name) ? p.name : "")).trim();
  if (path) o.path = path.slice(0, 255);
  return o;
}

function compactGuest(g: GuestRecIn): Record<string, unknown> {
  const o: Record<string, unknown> = { vmid: g.vmid, name: g.name };
  if (g.status) o.status = g.status;
  if (g.memMb != null) o.memMb = g.memMb;
  if (g.diskGb != null && g.diskGb > 0) o.diskGb = g.diskGb;
  if (g.usedGb != null && g.usedGb > 0) o.usedGb = g.usedGb;
  if (g.template) o.template = 1;
  const disks = (g.disks ?? []).filter((d) => d.name && d.sizeGb != null && d.sizeGb > 0).slice(0, 16);
  if (disks.length) o.disks = disks;
  const mounts = compactMounts(g.mounts);
  if (mounts) o.mounts = mounts;
  if (g.ip) o.ip = String(g.ip).slice(0, 64);
  if (g.hostname) o.hostname = String(g.hostname).slice(0, 64);
  if (g.url) o.url = String(g.url).slice(0, 255);
  const ports = [...(g.ports ?? [])].filter((n, i, a) => Number.isInteger(n) && n > 0 && n <= 65535 && a.indexOf(n) === i);
  if (ports[0] != null) o.port = ports[0];
  if (ports.length) o.ports = ports;
  return o;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const v = JSON.parse(s) as unknown;
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mergeByKey<T extends Record<string, unknown>>(
  existing: T[],
  incoming: T[],
  keyOf: (x: T) => string,
  combine?: (a: T, b: T) => T,
): T[] {
  const map = new Map<string, T>();
  for (const x of existing) {
    const k = keyOf(x);
    if (k) map.set(k, x);
  }
  for (const x of incoming) {
    const k = keyOf(x);
    if (!k) continue;
    const prev = map.get(k);
    map.set(k, prev ? (combine ? combine(prev, x) : { ...prev, ...x }) : x);
  }
  return [...map.values()];
}

function asObj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function existingServices(raw: unknown): Record<string, unknown>[] {
  return parseJsonArray(raw)
    .map((x) => {
      if (typeof x === "string" || typeof x === "number") return { name: String(x) };
      const o = asObj(x);
      const name = o ? String(o.name ?? "").trim() : "";
      return name ? o : null;
    })
    .filter((x): x is Record<string, unknown> => x != null);
}

function existingWeb(raw: unknown): Record<string, string | number | string[] | number[]>[] {
  return parseJsonArray(raw)
    .map((x) => {
      const o = asObj(x);
      const label = o ? String(o.label ?? o.name ?? "").trim() : "";
      return label ? (o as Record<string, string | number | string[] | number[]>) : null;
    })
    .filter((x): x is Record<string, string | number | string[] | number[]> => x != null);
}

function existingNamed(raw: unknown, keys: string[]): Record<string, unknown>[] {
  return parseJsonArray(raw)
    .map((x) => {
      if (typeof x === "string" || typeof x === "number") return { name: String(x) };
      const o = asObj(x);
      if (!o) return null;
      const name = keys.map((k) => String(o[k] ?? "").trim()).find(Boolean) ?? "";
      return name ? o : null;
    })
    .filter((x): x is Record<string, unknown> => x != null);
}

function existingGuests(raw: unknown): Record<string, unknown>[] {
  return parseJsonArray(raw)
    .map((x) => {
      const o = asObj(x);
      if (!o) return null;
      const vmid = Number(o.vmid);
      return Number.isInteger(vmid) ? o : null;
    })
    .filter((x): x is Record<string, unknown> => x != null);
}

function setJsonList(attrs: Record<string, string | number>, key: string, list: unknown[] | undefined): void {
  if (list === undefined) return;
  if (list.length === 0) {
    delete attrs[key];
    return;
  }
  attrs[key] = JSON.stringify(list);
}

function applyList<T>(
  attrs: Record<string, string | number>,
  key: string,
  incoming: T[] | undefined,
  merge: boolean,
  compact: (x: T) => Record<string, unknown>,
  existing: (raw: unknown) => Record<string, unknown>[],
  keyOf: (x: Record<string, unknown>) => string,
  combine?: (a: Record<string, unknown>, b: Record<string, unknown>) => Record<string, unknown>,
): number {
  if (incoming === undefined) return 0;
  if (merge) {
    if (incoming.length === 0) return existing(attrs[key]).length;
    const merged = mergeByKey(existing(attrs[key]), incoming.map(compact), keyOf, combine);
    setJsonList(attrs, key, merged);
    return merged.length;
  }
  setJsonList(attrs, key, incoming.map(compact));
  return incoming.length;
}

export type ServicesReportResult = {
  containers: number;
  node: number;
  web: number;
  vms: number;
  lxc: number;
  databases: number;
  projects: number;
};

/**
 * Snapshot of processes / guests / databases / coding-agent projects on a
 * machine. Replaces the keys that were sent unless `merge` is set (then
 * incoming rows upsert by name / label / vmid / engine+name+target / path
 * and omitted-from-incoming rows stay). Projects on the same path keep the
 * richer tokens / updatedAt. Omitted keys stay. Empty arrays clear that key
 * unless `merge` (empty + merge leaves the key).
 */
export async function applyServicesReport(db: Db, input: ServicesReportInput): Promise<ServicesReportResult> {
  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new ServicesReportError("Item not found.");
  if (item.status === "archived") throw new ServicesReportError("Item is archived.");
  const role = String(item.attributes?.role ?? "").trim().toLowerCase();
  if (!SERVICE_MACHINE_ROLES.has(role)) {
    throw new ServicesReportError("Item is not a machine (role laptop/desktop/server/sbc/nas).");
  }
  if (
    input.containers === undefined &&
    input.node === undefined &&
    input.web === undefined &&
    input.vms === undefined &&
    input.lxc === undefined &&
    input.databases === undefined &&
    input.projects === undefined
  ) {
    throw new ServicesReportError("Report a containers, node, web, vms, lxc, databases or projects list.");
  }
  const next: Record<string, string | number> = { ...(item.attributes ?? {}) };
  const merge = input.merge === true;
  const reach = pickReachHost(
    item.attributes?.ip != null ? String(item.attributes.ip) : item.attributes?.ip_address != null ? String(item.attributes.ip_address) : null,
    item.attributes?.hostname != null ? String(item.attributes.hostname) : item.attributes?.host != null ? String(item.attributes.host) : null,
  );
  const containers = applyList(next, "containers", input.containers, merge, (s) => compactService(s, reach), existingServices, (x) => String(x.name ?? "").toLowerCase());
  const node = applyList(next, "node", input.node, merge, (s) => compactService(s, reach), existingServices, (x) => String(x.name ?? "").toLowerCase());
  const web = applyList(next, "web", input.web, merge, (w) => compactWebAt(w, reach), existingWeb, (x) => String(x.label ?? x.name ?? "").toLowerCase());
  const vms = applyList(next, "vms", input.vms, merge, compactGuest, existingGuests, (x) => String(x.vmid ?? ""));
  const lxc = applyList(next, "lxc", input.lxc, merge, compactGuest, existingGuests, (x) => String(x.vmid ?? ""));
  const databases = applyList(
    next,
    "databases",
    input.databases,
    merge,
    (d) => compactDatabase(d, reach),
    (raw) => existingNamed(raw, ["name", "label", "db", "database"]),
    (x) => dbMergeKey({ name: String(x.name ?? x.label ?? x.db ?? ""), engine: x.engine != null ? String(x.engine) : undefined, target: x.target != null ? String(x.target) : undefined }),
  );
  const projects = applyList(
    next,
    "projects",
    input.projects,
    merge,
    (p) => compactProject(p, reach),
    (raw) => existingNamed(raw, ["name", "project", "path", "label"]),
    (x) => projectMergeKey({ name: String(x.name ?? x.project ?? ""), path: x.path != null ? String(x.path) : undefined, kind: x.kind != null ? String(x.kind) : undefined }),
    mergeProjectRecords,
  );
  await db.update(items).set({ attributes: next }).where(eq(items.id, input.itemId));
  return { containers, node, web, vms, lxc, databases, projects };
}
