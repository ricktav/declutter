import { eq } from "drizzle-orm";
import { items } from "@db/schema";
import type { getDb } from "../queries/connection";
import { pickReachHost, rewriteLocalHostUrl } from "./serviceUrls";

type Db = ReturnType<typeof getDb>;

/** Same machine roles Systems treats as hubs that can run containers. */
export const SERVICE_MACHINE_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas"]);

export class ServicesReportError extends Error {}

export type ServiceRecIn = {
  name: string;
  status?: string;
  image?: string;
  port?: number;
  url?: string;
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
  template?: boolean;
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
};

function compactService(s: ServiceRecIn, reach: string | null): Record<string, string | number> {
  const o: Record<string, string | number> = { name: s.name };
  if (s.status) o.status = s.status;
  if (s.image) o.image = s.image;
  if (s.port != null) o.port = s.port;
  if (s.url) o.url = rewriteLocalHostUrl(s.url, reach);
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

function compactGuest(g: GuestRecIn): Record<string, string | number> {
  const o: Record<string, string | number> = { vmid: g.vmid, name: g.name };
  if (g.status) o.status = g.status;
  if (g.memMb != null) o.memMb = g.memMb;
  if (g.diskGb != null && g.diskGb > 0) o.diskGb = g.diskGb;
  if (g.template) o.template = 1;
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

function mergeByKey<T extends Record<string, unknown>>(existing: T[], incoming: T[], keyOf: (x: T) => string): T[] {
  const map = new Map<string, T>();
  for (const x of existing) {
    const k = keyOf(x);
    if (k) map.set(k, x);
  }
  for (const x of incoming) {
    const k = keyOf(x);
    if (!k) continue;
    map.set(k, { ...map.get(k), ...x });
  }
  return [...map.values()];
}

function asObj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function existingServices(raw: unknown): Record<string, string | number>[] {
  return parseJsonArray(raw)
    .map((x) => {
      if (typeof x === "string" || typeof x === "number") return { name: String(x) };
      const o = asObj(x);
      const name = o ? String(o.name ?? "").trim() : "";
      return name ? (o as Record<string, string | number>) : null;
    })
    .filter((x): x is Record<string, string | number> => x != null);
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

function existingGuests(raw: unknown): Record<string, string | number>[] {
  return parseJsonArray(raw)
    .map((x) => {
      const o = asObj(x);
      if (!o) return null;
      const vmid = Number(o.vmid);
      return Number.isInteger(vmid) ? (o as Record<string, string | number>) : null;
    })
    .filter((x): x is Record<string, string | number> => x != null);
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
): number {
  if (incoming === undefined) return 0;
  if (merge) {
    if (incoming.length === 0) return existing(attrs[key]).length;
    const merged = mergeByKey(existing(attrs[key]), incoming.map(compact), keyOf);
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
};

/**
 * Snapshot of processes / guests on a machine. Replaces the keys that were
 * sent unless `merge` is set (then incoming rows upsert by name / label / vmid
 * and omitted-from-incoming rows stay). Omitted keys stay. Empty arrays clear
 * that key unless `merge` (empty + merge leaves the key).
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
    input.lxc === undefined
  ) {
    throw new ServicesReportError("Report a containers, node, web, vms or lxc list.");
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
  await db.update(items).set({ attributes: next }).where(eq(items.id, input.itemId));
  return { containers, node, web, vms, lxc };
}
