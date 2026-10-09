/**
 * Attribute convention for the Systems mindmap. Other bots can fill these
 * without a schema change. Existing Computer Lab keys stay as they are.
 *
 * Machine (a Thing in topic Computers / Network, or role laptop/desktop/
 * server/sbc/nas, or a Lab-fed item with lab.ref):
 *   importance  kern | ondersteunend | proef | afvoeren
 *   role, ip, hostname, os, cpu, ram_gb, storage_gb, storage_free_gb
 *
 * Services (around a machine), any of:
 *   services    JSON array of { name, kind?, status?, port?, url? }
 *               or a comma/newline list of names
 *   docker / containers   list of container names (kind docker)
 *   units / systemd       list of unit names (kind systemd)
 *   launchd               list of launchd job names (kind launchd)
 *   svc.<name>            value = status, port, or URL
 *   child Things with role service or software (parentId = the machine)
 *
 * kind is node | docker | systemd | launchd | other (guessed from the name
 * when omitted).
 *
 * Web access (ports / pages / URLs), any of:
 *   ports    JSON [{ port, proto?, path?, label?, url? }] or "80,443" or "host:8080"
 *   urls / url / web    JSON array or comma-separated URLs
 * A port/url already named on a service is not duplicated as a web node.
 *
 * Disks: storage.overview volumes, plus child Things with role storage.
 */
export const IMPORTANCE = ["kern", "ondersteunend", "proef", "afvoeren"] as const;
export type Importance = (typeof IMPORTANCE)[number];

export const MACHINE_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas"]);
export const LAB_AREA_SLUGS = new Set(["computers", "network"]);
export const SERVICE_ROLES = new Set(["service", "software"]);

export type Attrs = Record<string, string | number> | null | undefined;

export type ServiceRec = {
  name: string;
  kind: string;
  status?: string;
  port?: number;
  url?: string;
  /** Child Thing id when this row came from a role=service/software item. */
  itemId?: number;
};

export type WebRec = {
  label: string;
  port?: number;
  url?: string;
};

export function attrStr(attrs: Attrs, key: string): string | null {
  const v = attrs?.[key];
  if (v == null || v === "") return null;
  return String(v);
}

export function parseImportance(attrs: Attrs): Importance | null {
  const v = attrStr(attrs, "importance")?.trim().toLowerCase();
  if (v && (IMPORTANCE as readonly string[]).includes(v)) return v as Importance;
  return null;
}

export function isMachineItem(it: {
  attributes: Attrs;
  areaSlug?: string | null;
  parentId?: number | null;
  status?: string;
}): boolean {
  if (it.status === "archived") return false;
  if (attrStr(it.attributes, "lab.exclude") === "yes") return false;
  if (it.parentId != null) return false;
  const role = attrStr(it.attributes, "role") ?? "";
  if (role === "storage" || role === "service" || role === "software" || role === "meter" || role === "part") return false;
  if (MACHINE_ROLES.has(role)) return true;
  if (attrStr(it.attributes, "lab.ref")) return LAB_AREA_SLUGS.has(it.areaSlug ?? "") || MACHINE_ROLES.has(role) || !role;
  return LAB_AREA_SLUGS.has(it.areaSlug ?? "") && role !== "peripheral";
}

function parseJsonOrList(raw: unknown): unknown[] {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "number") return [raw];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const v = JSON.parse(s) as unknown;
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") return [v];
    } catch {
      /* fall through to split */
    }
  }
  return s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
}

function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function guessServiceKind(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("docker") || n.startsWith("container:") || n.includes("compose")) return "docker";
  if (n.endsWith(".service") || n.endsWith(".timer") || n.endsWith(".socket")) return "systemd";
  if (n.includes("launchd") || n.endsWith(".plist")) return "launchd";
  if (n.includes("node") || n.endsWith(".js") || n === "npm" || n === "pnpm") return "node";
  return "other";
}

function asService(x: unknown, fallbackKind?: string): ServiceRec | null {
  if (typeof x === "string" || typeof x === "number") {
    const name = String(x).trim();
    if (!name) return null;
    return { name, kind: fallbackKind ?? guessServiceKind(name) };
  }
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const name = String(o.name ?? o.unit ?? o.container ?? o.id ?? "").trim();
  if (!name) return null;
  const url = o.url != null ? String(o.url) : undefined;
  return {
    name,
    kind: String(o.kind ?? o.runtime ?? fallbackKind ?? guessServiceKind(name)),
    status: o.status != null ? String(o.status) : undefined,
    port: num(o.port),
    url,
  };
}

export function parseServices(attrs: Attrs): ServiceRec[] {
  const out: ServiceRec[] = [];
  const seen = new Set<string>();
  const add = (s: ServiceRec | null) => {
    if (!s) return;
    const k = s.name.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  for (const x of parseJsonOrList(attrs?.services)) add(asService(x));
  for (const x of parseJsonOrList(attrs?.docker)) add(asService(x, "docker"));
  for (const x of parseJsonOrList(attrs?.containers)) add(asService(x, "docker"));
  for (const x of parseJsonOrList(attrs?.units)) add(asService(x, "systemd"));
  for (const x of parseJsonOrList(attrs?.systemd)) add(asService(x, "systemd"));
  for (const x of parseJsonOrList(attrs?.launchd)) add(asService(x, "launchd"));
  for (const [key, val] of Object.entries(attrs ?? {})) {
    if (!key.startsWith("svc.") || key.length < 5) continue;
    const name = key.slice(4);
    const v = String(val);
    const port = num(v);
    const url = /^https?:\/\//i.test(v) ? v : undefined;
    add({
      name,
      kind: guessServiceKind(name),
      status: port == null && !url ? v : undefined,
      port,
      url,
    });
  }
  return out;
}

function asWeb(x: unknown): WebRec | null {
  if (typeof x === "number") return { label: `:${x}`, port: x };
  if (typeof x === "string") {
    const s = x.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return { label: s.replace(/^https?:\/\//i, "").slice(0, 40), url: s };
    const m = s.match(/^(?:([\w.-]+):)?(\d{2,5})(\/.*)?$/);
    if (m) {
      const port = Number(m[2]);
      const host = m[1] ?? "";
      const path = m[3] ?? "";
      return { label: host ? `${host}:${port}${path}` : `:${port}${path}`, port };
    }
    return { label: s };
  }
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const port = num(o.port);
  const url = o.url != null ? String(o.url) : undefined;
  const path = o.path != null ? String(o.path) : "";
  const label = String(o.label ?? o.name ?? (port != null ? `:${port}${path}` : url ?? "")).trim();
  if (!label) return null;
  return { label, port, url };
}

export function parseWeb(attrs: Attrs): WebRec[] {
  const out: WebRec[] = [];
  const seen = new Set<string>();
  const add = (w: WebRec | null) => {
    if (!w) return;
    const k = (w.url ?? w.label).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(w);
  };
  for (const x of parseJsonOrList(attrs?.ports)) add(asWeb(x));
  for (const key of ["urls", "url", "web"] as const) {
    for (const x of parseJsonOrList(attrs?.[key])) add(asWeb(x));
  }
  return out;
}

export function machineRadius(importance: Importance | null): number {
  if (importance === "kern") return 22;
  if (importance === "proef") return 12;
  return 16;
}
