import { eq } from "drizzle-orm";
import { items } from "@db/schema";
import type { getDb } from "../queries/connection";

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

export type ServicesReportInput = {
  itemId: number;
  source: string;
  containers?: ServiceRecIn[];
  node?: ServiceRecIn[];
  web?: WebRecIn[];
};

function compactService(s: ServiceRecIn): Record<string, string | number> {
  const o: Record<string, string | number> = { name: s.name };
  if (s.status) o.status = s.status;
  if (s.image) o.image = s.image;
  if (s.port != null) o.port = s.port;
  if (s.url) o.url = s.url;
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

function setJsonList(attrs: Record<string, string | number>, key: string, list: unknown[] | undefined): void {
  if (list === undefined) return;
  if (list.length === 0) {
    delete attrs[key];
    return;
  }
  attrs[key] = JSON.stringify(list);
}

/**
 * Snapshot of processes on a machine. Replaces the keys that were sent
 * (`containers`, `node`, `web`); omitted keys stay. Empty arrays clear that key.
 * No schema change: Systems already reads these attributes.
 */
export async function applyServicesReport(db: Db, input: ServicesReportInput): Promise<{ containers: number; node: number; web: number }> {
  const item = await db.query.items.findFirst({ where: eq(items.id, input.itemId) });
  if (!item) throw new ServicesReportError("Item not found.");
  if (item.status === "archived") throw new ServicesReportError("Item is archived.");
  const role = String(item.attributes?.role ?? "").trim().toLowerCase();
  if (!SERVICE_MACHINE_ROLES.has(role)) {
    throw new ServicesReportError("Item is not a machine (role laptop/desktop/server/sbc/nas).");
  }
  if (input.containers === undefined && input.node === undefined && input.web === undefined) {
    throw new ServicesReportError("Report a containers, node or web list.");
  }
  const next: Record<string, string | number> = { ...(item.attributes ?? {}) };
  setJsonList(next, "containers", input.containers?.map(compactService));
  setJsonList(next, "node", input.node?.map(compactService));
  setJsonList(next, "web", input.web?.map(compactWeb));
  await db.update(items).set({ attributes: next }).where(eq(items.id, input.itemId));
  return {
    containers: input.containers?.length ?? 0,
    node: input.node?.length ?? 0,
    web: input.web?.length ?? 0,
  };
}
