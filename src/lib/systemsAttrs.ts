/**
 * Attribute convention for the Systems mindmap. Other bots can fill these
 * without a schema change. Existing Computer Lab keys stay as they are.
 *
 * Machine (role laptop/desktop/server/sbc/nas). Peripherals are never
 * machines, even with lab.ref: peripheral, keyboard, mouse, monitor, phone,
 * tablet, patch panel, cable, accessory.
 * Network gear (switch, router, ap, network) is its own node kind, not a machine.
 * No role: only if it looks like a machine (ip, hostname, mac, os, cpu, ram,
 * storage_gb, a storage volume, or a machine role). lab.ref alone is not enough.
 *
 * Services (around a machine), any of:
 *   services    JSON array of { name, kind?, status?, port?, url? }
 *               or a comma/newline list of names
 *   docker / containers   list of container names (kind docker).
 *               Collectors write this with services.report (not the Systems
 *               view itself). A daily claudemux fleet HTML page can feed the
 *               importer script; Systems never fetches that URL.
 *   units / systemd       list of unit names (kind systemd)
 *   launchd               list of launchd job names (kind launchd)
 *   svc.<name>            value = status, port, or URL
 *   child Things with role service or software (parentId = the machine)
 *
 * kind is node | docker | systemd | launchd | other (guessed from the name
 * when omitted).
 *
 * Web access (ports / pages / URLs / PWAs), any of:
 *   ports    JSON [{ port, proto?, path?, label?, url? }] or "80,443" or "host:8080"
 *   urls / url / web / pwa / apps / pages / websites    JSON array or comma-separated URLs
 *               Fleet importer writes web as [{ label, ports, urls, status }] — one
 *               leaf per service, not per port.
 *   node     list of Node processes (kind node); a value that looks like a URL is a web node
 * A port/url already named on a service is not duplicated as a web node.
 * Child Things: role container/docker → container; role web/pwa/website/app → web.
 *
 * Disks: storage.overview volumes, plus child Things with role storage.
 *
 * Rating (1–5 stars), attribute `rating`. Fallback from importance:
 *   kern=5, ondersteunend=3, proef=2, afvoeren=1. Default 3.
 */
export const IMPORTANCE = ["kern", "ondersteunend", "proef", "afvoeren"] as const;
export type Importance = (typeof IMPORTANCE)[number];

export const MACHINE_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas"]);
export const LAB_AREA_SLUGS = new Set(["computers", "network"]);
export const SERVICE_ROLES = new Set(["service", "software"]);
export const CONTAINER_ROLES = new Set(["container", "docker"]);
export const WEB_ROLES = new Set(["web", "pwa", "website", "app"]);
const SKIP_ROLES = new Set(["storage", "service", "software", "meter", "part"]);
const PERIPHERAL_ROLES = new Set([
  "peripheral",
  "keyboard",
  "mouse",
  "monitor",
  "phone",
  "tablet",
  "patchpanel",
  "cable",
  "accessory",
]);
const NETWORK_ROLES = new Set(["switch", "router", "ap", "network", "accesspoint"]);

const MACHINE_SIGNAL_KEYS = [
  "ip",
  "ip_address",
  "hostname",
  "host",
  "mac",
  "os",
  "cpu",
  "ram",
  "ram_gb",
  "storage_gb",
  "storage_free_gb",
] as const;

export function normRole(role: string): string {
  return role.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function roleKey(attrs: Attrs): string {
  return normRole(attrStr(attrs, "role") ?? "");
}

export function isPeripheralRole(role: string): boolean {
  return PERIPHERAL_ROLES.has(normRole(role));
}

export function isNetworkRole(role: string): boolean {
  return NETWORK_ROLES.has(normRole(role));
}

export function hasMachineSignal(attrs: Attrs, hasVolumes = false): boolean {
  if (hasVolumes) return true;
  for (const k of MACHINE_SIGNAL_KEYS) {
    if (attrStr(attrs, k)) return true;
  }
  return false;
}

function isSkippedBase(it: { attributes: Attrs; parentId?: number | null; status?: string }): boolean {
  if (it.status === "archived") return true;
  if (attrStr(it.attributes, "lab.exclude") === "yes") return true;
  if (it.parentId != null) return true;
  return false;
}

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
  ports?: number[];
  urls?: string[];
  status?: string;
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

export type Rating = 1 | 2 | 3 | 4 | 5;

const IMP_RATING: Record<Importance, Rating> = {
  kern: 5,
  ondersteunend: 3,
  proef: 2,
  afvoeren: 1,
};

/** 1–5 from `rating`, else importance, else 3. */
export function parseRating(attrs: Attrs): Rating {
  const raw = attrs?.rating;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n as Rating;
  const imp = parseImportance(attrs);
  if (imp) return IMP_RATING[imp];
  return 3;
}

/** Hub size: subnode count (services + disks + ports + volumes) times rating. */
export function hubRadius(subnodes: number, rating: Rating): number {
  const MIN = 12;
  const MAX = 36;
  const byCount = MIN + Math.sqrt(Math.max(0, subnodes)) * 5.5;
  const g = 0.72 + (rating / 5) * 0.48;
  return Math.round(Math.max(MIN, Math.min(MAX, byCount * g)));
}

/** 1–10 by linear share of the largest volume (12 TB vs 4 TB → 10 vs 3). */
export function volumeSizeScale(capacityBytes: number, maxCapacity: number): number {
  if (!(capacityBytes > 0) || !(maxCapacity > 0)) return 1;
  return Math.max(1, Math.min(10, Math.round((capacityBytes / maxCapacity) * 10)));
}

/** Pixel radius from the 1–10 scale: 6 at 1, 24 at 10, so a 12 TB blob reads as huge. */
export function volumeRadius(capacityBytes: number, _minCapacity: number, maxCapacity: number): number {
  const scale = volumeSizeScale(capacityBytes, maxCapacity);
  return Math.round(6 + ((scale - 1) / 9) * 18);
}

/** Orange → red fill once a disk/volume is 80%+ full. Below that, keep the kind colour. */
export function usedHeatColor(base: string, usedPct: number | null | undefined): string {
  if (usedPct == null || usedPct < 80) return base;
  const t = Math.max(0, Math.min(1, (usedPct - 80) / 20));
  const a = [255, 159, 67];
  const b = [220, 53, 34];
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

export function isMachineItem(it: {
  attributes: Attrs;
  areaSlug?: string | null;
  parentId?: number | null;
  status?: string;
  hasVolumes?: boolean;
}): boolean {
  if (isSkippedBase(it)) return false;
  const role = roleKey(it.attributes);
  if (isPeripheralRole(role) || isNetworkRole(role) || SKIP_ROLES.has(role)) return false;
  if (MACHINE_ROLES.has(role)) return true;
  if (!role) return hasMachineSignal(it.attributes, it.hasVolumes === true);
  return false;
}

export function isNetworkItem(it: {
  attributes: Attrs;
  parentId?: number | null;
  status?: string;
}): boolean {
  if (isSkippedBase(it)) return false;
  const role = roleKey(it.attributes);
  if (isPeripheralRole(role)) return false;
  return isNetworkRole(role);
}

/** Top-level Computers/Network Things that are not machines, network gear, or peripherals. */
export function isOtherComputersItem(it: {
  attributes: Attrs;
  areaSlug?: string | null;
  parentId?: number | null;
  status?: string;
  hasVolumes?: boolean;
}): boolean {
  if (isSkippedBase(it)) return false;
  const role = roleKey(it.attributes);
  if (isPeripheralRole(role) || SKIP_ROLES.has(role)) return false;
  if (isMachineItem(it) || isNetworkItem(it)) return false;
  return LAB_AREA_SLUGS.has(it.areaSlug ?? "");
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
  for (const x of parseJsonOrList(attrs?.node)) {
    if (typeof x === "string" && /^https?:\/\//i.test(x.trim())) continue;
    add(asService(x, "node"));
  }
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

function flattenUnknown(x: unknown): unknown[] {
  if (x == null || x === "") return [];
  if (Array.isArray(x)) return x.flatMap(flattenUnknown);
  return [x];
}

function numList(v: unknown): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const x of flattenUnknown(v)) {
    const n = num(x);
    if (n == null || n <= 0 || n > 65535 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function strList(v: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of flattenUnknown(v)) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function asWeb(x: unknown): WebRec | null {
  if (typeof x === "number") return { label: `:${x}`, port: x, ports: [x] };
  if (typeof x === "string") {
    const s = x.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return { label: s.replace(/^https?:\/\//i, "").slice(0, 40), url: s, urls: [s] };
    const m = s.match(/^(?:([\w.-]+):)?(\d{2,5})(\/.*)?$/);
    if (m) {
      const port = Number(m[2]);
      const host = m[1] ?? "";
      const path = m[3] ?? "";
      return { label: host ? `${host}:${port}${path}` : `:${port}${path}`, port, ports: [port] };
    }
    return { label: s };
  }
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const ports = numList([o.port, o.ports]).sort((a, b) => a - b);
  const urls = strList([o.url, o.urls]);
  const status = o.status != null ? String(o.status) : undefined;
  const path = o.path != null ? String(o.path) : "";
  const label = String(o.label ?? o.name ?? (ports[0] != null ? `:${ports[0]}${path}` : urls[0] ?? "")).trim();
  if (!label) return null;
  return {
    label,
    port: ports[0],
    url: urls[0],
    ...(ports.length ? { ports } : {}),
    ...(urls.length ? { urls } : {}),
    ...(status ? { status } : {}),
  };
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
  for (const key of ["urls", "url", "web", "pwa", "apps", "pages", "websites", "website"] as const) {
    for (const x of parseJsonOrList(attrs?.[key])) add(asWeb(x));
  }
  for (const x of parseJsonOrList(attrs?.node)) {
    if (typeof x === "string" && /^https?:\/\//i.test(x.trim())) add(asWeb(x));
  }
  return out;
}

export function machineRadius(importance: Importance | null): number {
  if (importance === "kern") return hubRadius(4, 5);
  if (importance === "proef") return hubRadius(1, 2);
  return hubRadius(2, 3);
}
