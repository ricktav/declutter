import { pickReachHost, rewriteLocalHostUrl } from "./serviceUrls.ts";
import {
  dbMergeKey,
  looksLikeProjectDir,
  mergeProjectRecords,
  normalizeProjectKind,
  parseDatabasesList,
  parseProjectsList,
  parseSizeBytes,
  parseTokenCount,
  projectMergeKey,
  type DatabaseRec,
  type ProjectRec,
} from "./servicesProjects.ts";

/** Parse a claudemux (or similar) fleet HTML/JSON snapshot into per-host container lists. */

export type FleetContainer = {
  name: string;
  status?: string;
  image?: string;
  port?: number;
  url?: string;
};

export type FleetWeb = {
  label: string;
  url?: string;
  port?: number;
  urls?: string[];
  ports?: number[];
  status?: string;
};

export type FleetHost = {
  host: string;
  ip?: string | null;
  containers: FleetContainer[];
  node: FleetContainer[];
  web: FleetWeb[];
  databases: DatabaseRec[];
  projects: ProjectRec[];
};

export type { DatabaseRec, ProjectRec };

export type MachineHint = {
  id: number;
  name: string;
  hostname?: string | null;
  host?: string | null;
  ip?: string | null;
  /** LAN Police / fleet short name (`mbp`). Comma list allowed. */
  hostAlias?: string | null;
  aliases?: string | null;
};

export type SkippedProjectTable = {
  host: string;
  reason: string;
  headers: string[];
  sample: string[];
};

function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function str(x: unknown): string | null {
  if (x == null) return null;
  const s = String(x).trim();
  return s ? s : null;
}

function portOf(x: unknown): number | undefined {
  if (x == null || x === "") return undefined;
  if (typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 65535) return x;
  const s = String(x);
  const m = s.match(/(?:[:\s,]|^)(\d{2,5})(?:\/tcp|\/udp)?(?:\s|$|,)/i);
  const n = Number(m?.[1] ?? s);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

function asContainer(x: unknown): FleetContainer | null {
  if (typeof x === "string" || typeof x === "number") {
    const name = String(x).trim().replace(/^\//, "");
    return name ? { name } : null;
  }
  const o = asRecord(x);
  if (!o) return null;
  const name = str(o.name ?? o.Names ?? o.container ?? o.id ?? o.Id)?.replace(/^\//, "");
  if (!name) return null;
  const status = str(o.status ?? o.State ?? o.Status ?? o.state);
  const image = str(o.image ?? o.Image);
  const url = str(o.url);
  const port = portOf(o.port ?? o.Ports ?? o.ports);
  return { name, ...(status ? { status } : {}), ...(image ? { image } : {}), ...(port != null ? { port } : {}), ...(url ? { url } : {}) };
}

function flattenUnknown(x: unknown): unknown[] {
  if (x == null || x === "") return [];
  if (Array.isArray(x)) return x.flatMap(flattenUnknown);
  return [x];
}

function numsOf(x: unknown): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of flattenUnknown(x)) {
    const n = portOf(v);
    if (n == null || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function strsOf(x: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of flattenUnknown(x)) {
    const s = str(v);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function asWeb(x: unknown): FleetWeb | null {
  if (typeof x === "number") return { label: `:${x}`, port: x };
  if (typeof x === "string") {
    const s = x.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return { label: s.replace(/^https?:\/\//i, "").slice(0, 40), url: s };
    return { label: s };
  }
  const o = asRecord(x);
  if (!o) return null;
  const url = str(o.url);
  const ports = numsOf([o.port, o.ports]);
  const urls = strsOf([o.url, o.urls]);
  const status = str(o.status ?? o.state);
  const label = str(o.label ?? o.name ?? (ports[0] != null ? `:${ports[0]}` : url));
  if (!label) return null;
  return {
    label,
    ...(url ? { url } : {}),
    ...(ports[0] != null ? { port: ports[0] } : {}),
    ...(urls.length ? { urls } : {}),
    ...(ports.length ? { ports } : {}),
    ...(status ? { status } : {}),
  };
}

function listOf(x: unknown): unknown[] {
  if (x == null || x === "") return [];
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    const t = x.trim();
    if (t.startsWith("[")) {
      try {
        const v = JSON.parse(t) as unknown;
        return Array.isArray(v) ? v : [v];
      } catch {
        /* split */
      }
    }
    return t.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof x === "object") return [x];
  return [x];
}

function hostNameOf(o: Record<string, unknown>): string | null {
  return str(o.host ?? o.hostname ?? o.machine ?? o.name ?? o.Name ?? o.item);
}

function pickLists(o: Record<string, unknown>): Pick<FleetHost, "containers" | "node" | "web" | "databases" | "projects"> {
  const containers = [...listOf(o.containers), ...listOf(o.docker), ...listOf(o.services), ...listOf(o.compose)]
    .map(asContainer)
    .filter((c): c is FleetContainer => c != null);
  const node = listOf(o.node ?? o.nodes ?? o.processes)
    .map(asContainer)
    .filter((c): c is FleetContainer => c != null);
  const web = groupWebServices(
    listOf(o.web ?? o.pwa ?? o.urls ?? o.pages)
      .map(asWeb)
      .filter((w): w is FleetWeb => w != null),
  );
  const databases = parseDatabasesList(o.databases ?? o.dbs);
  const projects = parseProjectsList(o.projects ?? o.agents);
  const seen = new Set<string>();
  const uniq = (xs: FleetContainer[]) =>
    xs.filter((c) => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return { containers: uniq(containers), node: uniq(node), web, databases: uniqByDb(databases), projects: uniqByProject(projects) };
}

function uniqByDb(xs: DatabaseRec[]): DatabaseRec[] {
  const seen = new Set<string>();
  return xs.filter((d) => {
    const k = dbMergeKey(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function uniqByProject(xs: ProjectRec[]): ProjectRec[] {
  const map = new Map<string, ProjectRec>();
  for (const p of xs) {
    const k = projectMergeKey(p);
    const prev = map.get(k);
    map.set(k, prev ? (mergeProjectRecords(prev, p) as ProjectRec) : p);
  }
  return [...map.values()];
}

function rewriteContainerUrl(c: FleetContainer, reach: string | null): FleetContainer {
  if (!c.url || !reach) return c;
  const url = rewriteLocalHostUrl(c.url, reach);
  return url === c.url ? c : { ...c, url };
}

function rewriteWebUrls(w: FleetWeb, reach: string | null): FleetWeb {
  if (!reach) return w;
  const url = w.url ? rewriteLocalHostUrl(w.url, reach) : undefined;
  const urls = w.urls?.map((u) => rewriteLocalHostUrl(u, reach));
  return { ...w, ...(url ? { url } : {}), ...(urls?.length ? { urls } : {}) };
}

function rewriteDatabaseUrl(d: DatabaseRec, reach: string | null): DatabaseRec {
  if (!d.url || !reach) return d;
  const url = rewriteLocalHostUrl(d.url, reach);
  return url === d.url ? d : { ...d, url };
}

function rewriteProjectUrl(p: ProjectRec, reach: string | null): ProjectRec {
  if (!p.url || !reach) return p;
  const url = rewriteLocalHostUrl(p.url, reach);
  return url === p.url ? p : { ...p, url };
}

type HostLists = Pick<FleetHost, "containers" | "node" | "web" | "databases" | "projects">;

function emptyLists(): HostLists {
  return { containers: [], node: [], web: [], databases: [], projects: [] };
}

function hostHasRows(lists: HostLists): boolean {
  return lists.containers.length + lists.node.length + lists.web.length + lists.databases.length + lists.projects.length > 0;
}

function rewriteHostLists(lists: HostLists, host: string, ip?: string | null): HostLists {
  const reach = pickReachHost(ip, host);
  if (!reach) return lists;
  return {
    containers: lists.containers.map((c) => rewriteContainerUrl(c, reach)),
    node: lists.node.map((c) => rewriteContainerUrl(c, reach)),
    web: lists.web.map((w) => rewriteWebUrls(w, reach)),
    databases: lists.databases.map((d) => rewriteDatabaseUrl(d, reach)),
    projects: lists.projects.map((p) => rewriteProjectUrl(p, reach)),
  };
}

function pushHost(out: FleetHost[], host: string, lists: HostLists, ip?: string | null) {
  const next = rewriteHostLists(lists, host, ip);
  if (!hostHasRows(next)) return;
  const prev = out.find((h) => normHost(h.host) === normHost(host));
  if (prev) {
    prev.containers.push(...next.containers);
    prev.node.push(...next.node);
    prev.web = groupWebServices([...prev.web, ...next.web]);
    prev.databases = uniqByDb([...prev.databases, ...next.databases]);
    prev.projects = uniqByProject([...prev.projects, ...next.projects]);
    if (!prev.ip && ip) prev.ip = ip;
    return;
  }
  out.push({ host, ip: ip ?? null, ...next });
}

function walk(x: unknown, out: FleetHost[], depth: number) {
  if (depth > 6 || x == null) return;
  if (Array.isArray(x)) {
    for (const el of x) walk(el, out, depth + 1);
    return;
  }
  const o = asRecord(x);
  if (!o) return;
  const host = hostNameOf(o);
  const lists = pickLists(o);
  if (host && hostHasRows(lists)) {
    pushHost(out, host, lists, str(o.ip ?? o.address));
  }
  for (const [k, v] of Object.entries(o)) {
    if (["containers", "docker", "services", "compose", "node", "nodes", "web", "pwa", "urls", "pages", "databases", "dbs", "projects", "agents"].includes(k)) continue;
    if (Array.isArray(v) || (v && typeof v === "object")) {
      const nested = asRecord(v);
      if (nested && !hostNameOf(nested) && hostHasRows(pickLists(nested))) {
        pushHost(out, k, pickLists(nested));
      } else {
        walk(v, out, depth + 1);
      }
    }
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  times: "×",
  check: "✓",
};

/** Decode named + numeric HTML entities. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&([a-z]+);/gi, (all, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? all)
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      const n = Number.parseInt(h, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&#(\d+);/g, (_, d: string) => {
      const n = Number(d);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    });
}

const MARK_ONLY = /^[\u2713\u2714\u2717\u2718\u2610\u2611\u2612\u00d7\u2715✓✔✗✘☑☐×]+$/u;

/** True when a cell is empty, a check/cross mark, or only punctuation (e.g. &ndash;). */
export function isJunkCell(s: string): boolean {
  const t = decodeEntities(s).replace(/[\s\u00a0]/g, "");
  return !t || MARK_ONLY.test(t) || /^[–—\-_.·•]+$/u.test(t);
}

function innerText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function classList(tag: string): string {
  const m = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  return m ? ` ${m[1].toLowerCase()} ` : " ";
}

function hasClass(tag: string, name: string): boolean {
  return classList(tag).includes(` ${name.toLowerCase()} `);
}

function looksLikeIp(s: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s.trim());
}

export function normalizeIp(s: string | null | undefined): string | null {
  if (s == null) return null;
  const m = String(s).trim().match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : null;
}

function uniqByName(xs: FleetContainer[]): FleetContainer[] {
  const seen = new Set<string>();
  return xs.filter((c) => {
    const k = c.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function extractClassBlocks(html: string, tag: string, className: string): string[] {
  const out: string[] = [];
  const openRe = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    if (!hasClass(`<${tag}${m[1]}>`, className)) continue;
    const start = m.index + m[0].length;
    let depth = 1;
    const nest = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "gi");
    nest.lastIndex = start;
    let n: RegExpExecArray | null;
    while ((n = nest.exec(html))) {
      if (n[0].slice(0, 2) === "</") depth -= 1;
      else depth += 1;
      if (depth === 0) {
        out.push(html.slice(start, n.index));
        break;
      }
    }
  }
  return out;
}

function isNamedProjectsTable(open: string): boolean {
  return (
    hasClass(open, "projects-table") ||
    hasClass(open, "claude-projects") ||
    hasClass(open, "cc-projects") ||
    hasClass(open, "agents-table") ||
    hasClass(open, "project-dirs") ||
    hasClass(open, "directory") ||
    hasClass(open, "directories")
  );
}

function pdKValues(html: string): string[] {
  return [...html.matchAll(/<span\b[^>]*class=["'][^"']*\bpd-k\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
    innerText(m[1]).toLowerCase(),
  );
}

function cnameValues(html: string): string[] {
  return [...html.matchAll(/<span\b[^>]*class=["'][^"']*\bcname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
    innerText(m[1]),
  );
}

/** Container `table.projects` pd-rows — not a project-directory table. */
function isContainerOnlyTable(open: string, body: string): boolean {
  if (
    hasClass(open, "directory") ||
    hasClass(open, "directories") ||
    hasClass(open, "projects-table") ||
    hasClass(open, "claude-projects") ||
    hasClass(open, "cc-projects") ||
    hasClass(open, "agents-table") ||
    hasClass(open, "project-dirs")
  ) {
    return false;
  }
  const kinds = pdKValues(body);
  if (kinds.some((k) => /^(directory|path|project|dir)$/.test(k))) return false;
  if (cnameValues(body).some((c) => looksLikeProjectDir(c))) return false;
  const { headers, rows } = tableRowCells(body);
  if (headers.some((h) => /directory|path|project|folder/.test(h)) && rows.some((cols) => cols.some((c) => looksLikeProjectDir(c)))) {
    return false;
  }
  return kinds.includes("container") || (cnameValues(body).length > 0 && kinds.every((k) => !k || k === "container" || k === "ports" || k === "image"));
}

function tableRowCells(html: string): { headers: string[]; rows: string[][] } {
  const trs = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => r[1]);
  const cells = (row: string) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => innerText(c[1]));
  if (!trs.length) return { headers: [], rows: [] };
  const first = cells(trs[0]).map((h) => h.toLowerCase());
  const hasHeader = first.some((h) => /project|name|path|dir|directory|folder|kind|agent|root|label/.test(h));
  return { headers: hasHeader ? first : [], rows: (hasHeader ? trs.slice(1) : trs).map(cells) };
}

export { looksLikeProjectDir };

function looksLikeProjectDirTable(open: string, body: string): boolean {
  if (isContainerOnlyTable(open, body)) return false;
  if (isNamedProjectsTable(open)) return true;
  if (pdKValues(body).some((k) => /^(directory|path|project|dir)$/.test(k))) return true;
  if (cnameValues(body).some((c) => looksLikeProjectDir(c))) return true;
  const caption = innerText(body.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ?? "");
  const { headers, rows } = tableRowCells(body);
  const headerJoin = `${caption} ${headers.join(" ")}`.toLowerCase();
  if (!/project|path|dir|directory|folder/.test(headerJoin)) return false;
  return rows.some((cols) => cols.some((c) => looksLikeProjectDir(c)));
}

function keepMtxTable(open: string, body: string): boolean {
  if (hasClass(open, "services-table") || hasClass(open, "databases-table")) return true;
  if (hasClass(open, "timers")) return false;
  return isNamedProjectsTable(open) || looksLikeProjectDirTable(open, body);
}

function stripSkippedTables(html: string): string {
  return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const open = table.match(/<table\b[^>]*>/i)?.[0] ?? "";
    const body = table.slice(open.length);
    if (hasClass(open, "timers")) return "";
    if (keepMtxTable(open, body)) return table;
    // services / databases / project-dir tables are `class="mtx …"` — keep those
    if (hasClass(open, "mtx")) return "";
    if (/\bdata-host\s*=/i.test(table)) return "";
    return table;
  });
}

function headerBlock(section: string): string {
  const start = section.search(/<table\b/i);
  return start >= 0 ? section.slice(0, start) : section.slice(0, 4000);
}

function usableHostName(raw: string): string | null {
  const name = innerText(raw);
  if (!name || isJunkCell(name) || /^host-\d+$/i.test(name)) return null;
  return name;
}

function headingName(header: string): string | null {
  const hname = header.match(/<span\b[^>]*class=["'][^"']*\bhname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (hname) {
    const name = usableHostName(hname[1]);
    if (name) return name;
  }
  const hhl = extractClassBlocks(header, "div", "hh-l")[0];
  if (hhl) {
    const span = hhl.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i);
    const name = usableHostName(span?.[1] ?? hhl);
    if (name) return name;
  }
  for (const re of [
    /<(?:h1|h2|h3)\b[^>]*>([\s\S]*?)<\/h[123]>/i,
    /<[^>]*class=["'][^"']*\bhostname\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
  ]) {
    const m = header.match(re);
    if (!m) continue;
    const name = usableHostName(m[1]);
    if (name) return name;
  }
  return null;
}

function parseOneContainer(block: string): FleetContainer | null {
  const k = innerText(block.match(/<span\b[^>]*class=["'][^"']*\bpd-k\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
  if (k.toLowerCase() !== "container") return null;
  const name = innerText(block.match(/<span\b[^>]*class=["'][^"']*\bcname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
  if (!name || isJunkCell(name)) return null;
  const portRaw = innerText(block.match(/<span\b[^>]*class=["'][^"']*\bport\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
  const port = portOf(portRaw);
  return { name, ...(port != null ? { port } : {}) };
}

function parsePdRows(html: string): FleetContainer[] {
  const out: FleetContainer[] = [];
  const pdRows = extractClassBlocks(html, "div", "pd-row");
  if (pdRows.length) {
    for (const block of pdRows) {
      const c = parseOneContainer(block);
      if (c) out.push(c);
    }
  } else {
    for (const m of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
      if (!hasClass(`<tr${m[1]}>`, "pdrow")) continue;
      const c = parseOneContainer(m[2]);
      if (c) out.push(c);
    }
  }
  return uniqByName(out);
}

function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.port) {
      const n = Number(u.port);
      if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
    }
  } catch {
    /* not a URL */
  }
  return portOf(url);
}

/** Strip a trailing `:443` (or `:80`) from a service label. */
export function stripPortSuffix(label: string): { name: string; port?: number } {
  const t = label.trim();
  const m = t.match(/^(.*):(\d{2,5})$/);
  if (!m) return { name: t };
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { name: t };
  return { name: m[1].trim(), port };
}

/** `caddy/caddy` → `caddy`. */
function collapseProjectPrefix(name: string): string {
  const t = name.trim().replace(/^\/+|\/+$/g, "");
  const m = t.match(/^([^/]+)\/\1$/i);
  return m ? m[1] : t;
}

const OK_STATUS = /^(ok|up|healthy|running|live|good)$/i;
const DEGRADED_STATUS = /^(degraded|warn|warning|slow|amber)$/i;

function isOkStatus(s: string): boolean {
  const t = s.trim();
  if (OK_STATUS.test(t)) return true;
  const n = Number(t);
  return Number.isInteger(n) && n >= 200 && n < 400;
}

function statusRank(s: string): number {
  if (isOkStatus(s)) return 0;
  if (DEGRADED_STATUS.test(s)) return 1;
  return 2;
}

/** ok if any row is ok/up/2xx; otherwise the worst status. */
export function aggregateStatus(statuses: string[]): string | undefined {
  const xs = statuses.map((s) => s.trim()).filter(Boolean);
  if (!xs.length) return undefined;
  if (xs.some(isOkStatus)) return "ok";
  return xs.reduce((a, b) => (statusRank(b) > statusRank(a) ? b : a));
}

function lastSeg(name: string): string {
  const i = name.lastIndexOf("/");
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

function isGenericPortName(name: string): boolean {
  return !name || /^port$/i.test(name) || /^host$/i.test(name);
}

function isUserLikeToken(name: string): boolean {
  return /^[a-z][a-z0-9]{0,16}$/i.test(name);
}

type TentativeWeb = {
  raw: FleetWeb;
  name: string;
  portFromLabel?: number;
  generic: boolean;
  userLike: boolean;
};

function analyzeWeb(w: FleetWeb): TentativeWeb {
  const { name: stripped, port: labelPort } = stripPortSuffix(w.label);
  const name = collapseProjectPrefix(stripped);
  const portFromLabel = labelPort ?? w.port ?? portFromUrl(w.url);
  const generic = isGenericPortName(name);
  const userLike = !generic && isUserLikeToken(name) && labelPort != null;
  return { raw: w, name: name || w.label, portFromLabel, generic, userLike };
}

function collectPorts(a: TentativeWeb): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (n: number | undefined) => {
    if (n == null || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  add(a.portFromLabel);
  add(a.raw.port);
  add(portFromUrl(a.raw.url));
  for (const n of a.raw.ports ?? []) add(n);
  for (const u of a.raw.urls ?? []) add(portFromUrl(u));
  return out;
}

function collectUrls(a: TentativeWeb): string[] {
  return strsOf([a.raw.url, a.raw.urls]);
}

/**
 * Merge service rows that share a base label (`caddy:443` + `caddy:80`,
 * `portal/clawdy-portal` × N, `caddy/caddy` + `caddy`) into one service with
 * `ports` / `urls` and an aggregated status. Nameless listeners (`port:18790`,
 * a one-off `rick:8768`) stay as-is and are listed last.
 */
export function groupWebServices(rows: FleetWeb[]): FleetWeb[] {
  const analyzed = rows.map(analyzeWeb);
  const nameCounts = new Map<string, number>();
  const lastCounts = new Map<string, number>();
  for (const a of analyzed) {
    if (a.generic) continue;
    const n = a.name.toLowerCase();
    nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
    const last = lastSeg(a.name);
    lastCounts.set(last, (lastCounts.get(last) ?? 0) + 1);
  }

  type Bucket = { display: string; nameless: boolean; rows: TentativeWeb[] };
  const buckets = new Map<string, Bucket>();
  for (const a of analyzed) {
    let key: string;
    let nameless: boolean;
    let display: string;
    if (a.generic) {
      key = `nameless:${a.raw.label.toLowerCase()}`;
      nameless = true;
      display = a.raw.label;
    } else {
      const n = a.name.toLowerCase();
      const last = lastSeg(a.name);
      const shared = (nameCounts.get(n) ?? 0) > 1 || (lastCounts.get(last) ?? 0) > 1;
      if (a.userLike && !shared) {
        key = `nameless:${a.raw.label.toLowerCase()}`;
        nameless = true;
        display = a.raw.label;
      } else {
        key = `named:${last}`;
        nameless = false;
        display = a.name;
      }
    }
    const b = buckets.get(key);
    if (!b) buckets.set(key, { display, nameless, rows: [a] });
    else {
      b.rows.push(a);
      if (!nameless && a.name.length > b.display.length) b.display = a.name;
    }
  }

  const named: FleetWeb[] = [];
  const nameless: FleetWeb[] = [];
  for (const b of buckets.values()) {
    const ports: number[] = [];
    const urls: string[] = [];
    const statuses: string[] = [];
    const seenP = new Set<number>();
    const seenU = new Set<string>();
    for (const a of b.rows) {
      for (const p of collectPorts(a)) {
        if (seenP.has(p)) continue;
        seenP.add(p);
        ports.push(p);
      }
      for (const u of collectUrls(a)) {
        const k = u.toLowerCase();
        if (seenU.has(k)) continue;
        seenU.add(k);
        urls.push(u);
      }
      if (a.raw.status) statuses.push(a.raw.status);
    }
    ports.sort((x, y) => x - y);
    const status = aggregateStatus(statuses);
    const rec: FleetWeb = {
      label: b.display,
      ...(urls[0] ? { url: urls[0] } : {}),
      ...(ports[0] != null ? { port: ports[0] } : {}),
      ...(urls.length ? { urls } : {}),
      ...(ports.length ? { ports } : {}),
      ...(status ? { status } : {}),
    };
    (b.nameless ? nameless : named).push(rec);
  }
  return [...named, ...nameless];
}

function parseServicesTable(html: string): FleetWeb[] {
  const out: FleetWeb[] = [];
  for (const tm of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    const open = `<table${tm[1]}>`;
    if (!hasClass(open, "services-table")) continue;
    const body = tm[2];
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => r[1]);
    if (!rows.length) continue;
    const cells = (row: string) =>
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => innerText(c[1]));
    const first = cells(rows[0]).map((h) => h.toLowerCase());
    const hasHeader = first.some((h) => /label|url|status|name/.test(h));
    const labelIdx = hasHeader ? first.findIndex((h) => h === "label" || h === "name" || h === "service") : 0;
    const urlIdx = hasHeader ? first.findIndex((h) => h === "url" || h === "href") : 1;
    const statusIdx = hasHeader ? first.findIndex((h) => h === "status" || h === "state") : 2;
    const codeIdx = hasHeader ? first.findIndex((h) => h === "code") : -1;
    const dataRows = hasHeader ? rows.slice(1) : rows;
    for (const row of dataRows) {
      const cols = cells(row);
      const label = (labelIdx >= 0 ? cols[labelIdx] : cols[0]) ?? "";
      const url = (urlIdx >= 0 ? cols[urlIdx] : cols[1]) ?? "";
      if (!label || isJunkCell(label)) continue;
      const statusRaw = statusIdx >= 0 ? cols[statusIdx] ?? "" : "";
      const codeRaw = codeIdx >= 0 ? cols[codeIdx] ?? "" : "";
      const status = !isJunkCell(statusRaw) ? statusRaw : isOkStatus(codeRaw) ? "ok" : codeRaw && !isJunkCell(codeRaw) ? codeRaw : "";
      const port = portFromUrl(url) ?? stripPortSuffix(label).port;
      out.push({
        label,
        ...(url ? { url } : {}),
        ...(port != null ? { port } : {}),
        ...(status ? { status } : {}),
      });
    }
  }
  return groupWebServices(out);
}

const DB_HEADER_WORD = /^(kind|label|target|status|detail|checked|db|name|database|engine|type|schema|path|url|port|size)$/i;

function headerCol(headers: string[], ...names: string[]): number {
  for (const name of names) {
    const i = headers.findIndex((h) => h === name || h.startsWith(`${name} `));
    if (i >= 0) return i;
  }
  return -1;
}

function isHeaderWordRow(cols: string[]): boolean {
  const nonempty = cols.map((c) => c.trim()).filter(Boolean);
  if (!nonempty.length) return false;
  return nonempty.filter((c) => DB_HEADER_WORD.test(c)).length >= Math.min(2, nonempty.length);
}

function parseDatabasesTable(html: string): DatabaseRec[] {
  const out: DatabaseRec[] = [];
  for (const tm of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    const open = `<table${tm[1]}>`;
    if (!hasClass(open, "databases-table")) continue;
    const body = tm[2];
    const rows = [...body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];
    if (!rows.length) continue;
    const cells = (row: string) =>
      [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => innerText(c[1]));
    const firstCols = cells(rows[0][2]);
    const first = firstCols.map((h) => h.toLowerCase());
    const hasHeader =
      /<th\b/i.test(rows[0][2]) ||
      first.some((h) => /^(kind|label|target|status|detail|checked|db|name|database|engine|type|schema)$/.test(h));
    const headers = hasHeader ? first : [];
    const nameIdx = hasHeader ? headerCol(headers, "label", "db", "name", "database", "schema") : -1;
    const engineIdx = hasHeader ? headerCol(headers, "kind", "engine", "type") : -1;
    const targetIdx = hasHeader ? headerCol(headers, "target", "path") : -1;
    const statusIdx = hasHeader ? headerCol(headers, "status", "state") : -1;
    const detailIdx = hasHeader ? headerCol(headers, "detail", "notes") : -1;
    const checkedIdx = hasHeader ? headerCol(headers, "checked", "last") : -1;
    const portIdx = hasHeader ? headerCol(headers, "port") : -1;
    const sizeIdx = hasHeader ? headerCol(headers, "size", "bytes") : -1;
    const urlIdx = hasHeader ? headerCol(headers, "url", "href") : -1;
    for (const row of rows) {
      if (/<th\b/i.test(row[2])) continue;
      const cols = cells(row[2]);
      if (isHeaderWordRow(cols)) continue;
      const name = ((nameIdx >= 0 ? cols[nameIdx] : cols[1] ?? cols[0]) ?? "").trim();
      if (!name || isJunkCell(name) || DB_HEADER_WORD.test(name)) continue;
      const engine = ((engineIdx >= 0 ? cols[engineIdx] : cols[0]) ?? "").trim();
      const target = ((targetIdx >= 0 ? cols[targetIdx] : cols[2] ?? "") ?? "").trim();
      const status = (statusIdx >= 0 ? cols[statusIdx] ?? "" : "").trim();
      const detail = (detailIdx >= 0 ? cols[detailIdx] ?? "" : "").trim();
      const checked = (checkedIdx >= 0 ? cols[checkedIdx] ?? "" : "").trim();
      const port = portIdx >= 0 ? portOf(cols[portIdx]) : undefined;
      const sizeRaw = sizeIdx >= 0 ? cols[sizeIdx] ?? "" : "";
      const sizeN = Number(String(sizeRaw).replace(/[^\d.]/g, ""));
      const urlCol = urlIdx >= 0 ? cols[urlIdx] ?? "" : "";
      const url = urlCol || (/^https?:\/\//i.test(target) ? target : "");
      out.push({
        name: name.slice(0, 64),
        ...(engine && !isJunkCell(engine) && !DB_HEADER_WORD.test(engine) ? { engine: engine.slice(0, 32) } : {}),
        ...(status && !isJunkCell(status) ? { status } : {}),
        ...(port != null ? { port } : {}),
        ...(Number.isFinite(sizeN) && sizeN > 0 ? { size: sizeN } : {}),
        ...(url && !isJunkCell(url) ? { url } : {}),
        ...(target && !isJunkCell(target) ? { target: target.slice(0, 255) } : {}),
        ...(detail && !isJunkCell(detail) ? { detail: detail.slice(0, 255) } : {}),
        ...(checked && !isJunkCell(checked) ? { checked: checked.slice(0, 40) } : {}),
      });
    }
  }
  return uniqByDb(out);
}

function dirBasename(path: string): string {
  const t = path.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return (i >= 0 ? t.slice(i + 1) : t).slice(0, 128) || path.slice(0, 128);
}

function pdValue(block: string): string {
  const cname = innerText(block.match(/<span\b[^>]*class=["'][^"']*\bcname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
  if (cname) return cname;
  const stripped = block.replace(/<span\b[^>]*class=["'][^"']*\bpd-k\b[^"']*["'][^>]*>[\s\S]*?<\/span>/i, "");
  return innerText(stripped);
}

function directoryPdBlocks(html: string): string[] {
  const pdRows = extractClassBlocks(html, "div", "pd-row");
  if (pdRows.length) return pdRows;
  const out: string[] = [];
  for (const m of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    if (!hasClass(`<tr${m[1]}>`, "pdrow")) continue;
    const nested = extractClassBlocks(m[2], "div", "pd-row");
    if (nested.length) out.push(...nested);
    else out.push(m[2]);
  }
  return out;
}

function parseDirectoryPdRows(html: string): ProjectRec[] {
  const out: ProjectRec[] = [];
  let cur: ProjectRec | null = null;
  const flush = () => {
    if (cur?.name) out.push(cur);
    cur = null;
  };
  for (const block of directoryPdBlocks(html)) {
    const k = innerText(block.match(/<span\b[^>]*class=["'][^"']*\bpd-k\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "").toLowerCase();
    if (k === "container" || k === "ports" || k === "image") {
      flush();
      continue;
    }
    const value = pdValue(block);
    const pathLike = looksLikeProjectDir(value);
    if (pathLike && (k === "directory" || k === "path" || k === "dir" || k === "project" || !k)) {
      flush();
      cur = { name: dirBasename(value), path: value.slice(0, 255), kind: "unknown" };
      continue;
    }
    if (!cur) continue;
    if (k === "kind" || k === "agent" || k === "source") {
      const kind = normalizeProjectKind(value) ?? value.trim().toLowerCase().slice(0, 32);
      if (kind) cur.kind = kind;
    } else if (k === "tokens" || k === "token" || k === "usage") {
      const tokens = parseTokenCount(value);
      if (tokens != null) cur.tokens = tokens;
    } else if (k === "size" || k === "bytes" || k === "disk") {
      const size = parseSizeBytes(value);
      if (size != null) cur.size = size;
    } else if (k === "updated" || k === "last" || k === "seen" || k === "activity" || k === "time") {
      if (value && !isJunkCell(value)) cur.updatedAt = value.slice(0, 40);
    } else if (k === "status" || k === "state") {
      if (value && !isJunkCell(value)) cur.status = value;
    }
  }
  flush();
  return out;
}

function parseProjectDirsTable(html: string): { projects: ProjectRec[]; skipped: Omit<SkippedProjectTable, "host">[] } {
  const projects: ProjectRec[] = [];
  const skipped: Omit<SkippedProjectTable, "host">[] = [];
  for (const tm of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    const open = `<table${tm[1]}>`;
    const body = tm[2];
    if (hasClass(open, "services-table") || hasClass(open, "databases-table") || hasClass(open, "timers")) continue;
    if (isContainerOnlyTable(open, body)) continue;
    const caption = innerText(body.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ?? "");
    const { headers, rows } = tableRowCells(body);
    const classHint = classList(open);
    const looksNamed = isNamedProjectsTable(open);
    const looksDirs = looksLikeProjectDirTable(open, body);
    const mentionsProject = /project|path|dir|directory|folder/.test(`${caption} ${headers.join(" ")} ${classHint}`);
    if (!looksNamed && !looksDirs) {
      if (mentionsProject) {
        skipped.push({
          reason: "project-looking table is not directory rows",
          headers: headers.length ? headers : caption ? [caption] : [],
          sample: (rows[0] ?? []).slice(0, 6),
        });
      }
      continue;
    }
    const before = projects.length;
    const fromPd = parseDirectoryPdRows(body);
    projects.push(...fromPd);
    if (!fromPd.length) {
      const idx = (...names: string[]) => headers.findIndex((h) => names.includes(h));
      const pathIdx = idx("path", "dir", "directory", "folder", "root");
      const nameIdx = idx("project", "name", "label");
      const kindIdx = idx("kind", "agent", "source");
      const statusIdx = idx("status", "state");
      const tokensIdx = idx("tokens", "token", "usage");
      const sizeIdx = idx("size", "bytes", "disk");
      const updatedIdx = idx("updated", "last", "seen", "activity", "time");
      for (const cols of rows) {
        if (isHeaderWordRow(cols)) continue;
        const path = (pathIdx >= 0 ? cols[pathIdx] : "") || cols.find((c) => looksLikeProjectDir(c)) || "";
        const label = (nameIdx >= 0 ? cols[nameIdx] : "") || (path ? dirBasename(path) : cols[0] ?? "");
        const rawName = (looksLikeProjectDir(path) ? path : label).trim();
        if (!rawName || isJunkCell(rawName) || DB_HEADER_WORD.test(rawName)) continue;
        if (/^https?:\/\//i.test(rawName)) continue;
        const kindRaw = kindIdx >= 0 ? cols[kindIdx] ?? "" : "";
        const kind = kindRaw && !isJunkCell(kindRaw) ? (normalizeProjectKind(kindRaw) ?? kindRaw.trim().toLowerCase().slice(0, 32)) : "unknown";
        const status = statusIdx >= 0 ? cols[statusIdx] ?? "" : "";
        const tokens = tokensIdx >= 0 ? parseTokenCount(cols[tokensIdx]) : undefined;
        const size = sizeIdx >= 0 ? parseSizeBytes(cols[sizeIdx]) : undefined;
        const updatedAt = updatedIdx >= 0 ? cols[updatedIdx] ?? "" : "";
        const pathVal = looksLikeProjectDir(path) ? path : looksLikeProjectDir(rawName) ? rawName : "";
        projects.push({
          name: (pathVal ? dirBasename(pathVal) : rawName).slice(0, 128),
          kind,
          ...(status && !isJunkCell(status) ? { status } : {}),
          ...(tokens != null ? { tokens } : {}),
          ...(size != null ? { size } : {}),
          ...(updatedAt && !isJunkCell(updatedAt) ? { updatedAt: updatedAt.slice(0, 40) } : {}),
          ...(pathVal ? { path: pathVal.slice(0, 255) } : {}),
        });
      }
    }
    if (projects.length === before) {
      skipped.push({
        reason: looksNamed ? "projects-table had no usable directory or name rows" : "directory-looking table had no paths",
        headers: headers.length ? headers : caption ? [caption] : classHint.trim() ? [classHint.trim()] : [],
        sample: (rows[0] ?? cnameValues(body).slice(0, 6)).slice(0, 6),
      });
    }
  }
  return { projects: uniqByProject(projects), skipped };
}

export type ParsedFleet = { hosts: FleetHost[]; skippedUnreachable: string[]; skippedProjectTables: SkippedProjectTable[] };

/** Claudemux daily HTML: one `<section class="host">` per machine. */
export function parseClaudemuxHosts(html: string): ParsedFleet {
  const hosts: FleetHost[] = [];
  const skippedUnreachable: string[] = [];
  const skippedProjectTables: SkippedProjectTable[] = [];
  for (const m of html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)) {
    const open = `<section${m[1]}>`;
    if (!hasClass(open, "host")) continue;
    const section = m[2];
    const header = headerBlock(section);
    if (/external routes/i.test(innerText(header))) continue;
    const host = headingName(header);
    if (!host) continue;
    if (/external routes/i.test(host)) continue;
    const unreachable =
      hasClass(open, "unreachable") || /\bunreachable\b/i.test(innerText(header)) || /\bunreachable\b/i.test(classList(open));
    if (unreachable) {
      skippedUnreachable.push(host);
      continue;
    }
    const ip = normalizeIp(header);
    const body = stripSkippedTables(section);
    const containers = parsePdRows(body);
    const web = parseServicesTable(body);
    const databases = parseDatabasesTable(body);
    const dir = parseProjectDirsTable(section);
    for (const s of dir.skipped) skippedProjectTables.push({ host, ...s });
    const projects = dir.projects;
    if (!containers.length && !web.length && !databases.length && !projects.length) {
      hosts.push({ host, ip, ...emptyLists() });
      continue;
    }
    pushHost(hosts, host, { containers, node: [], web, databases, projects }, ip);
  }
  return { hosts, skippedUnreachable, skippedProjectTables };
}

function extractJsonBlobs(text: string): unknown[] {
  const blobs: unknown[] = [];
  const tryParse = (raw: string) => {
    try {
      blobs.push(JSON.parse(raw) as unknown);
    } catch {
      /* ignore */
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) tryParse(trimmed);
  for (const m of text.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    tryParse(m[1].trim());
  }
  for (const m of text.matchAll(/(?:window\.)?(?:FLEET|fleetData|FLEET_DATA|hosts)\s*=\s*(\{[\s\S]*?\}|\[[\s\S]*?\]);/g)) {
    tryParse(m[1]);
  }
  return blobs;
}

export function parseFleetDocument(text: string): FleetHost[] {
  if (/<section\b[^>]*class=["'][^"']*\bhost\b/i.test(text)) {
    return parseClaudemuxHosts(text).hosts.filter(hostHasRows);
  }
  const out: FleetHost[] = [];
  for (const blob of extractJsonBlobs(text)) walk(blob, out, 0);
  for (const h of out) h.containers = uniqByName(h.containers);
  return out.filter(hostHasRows);
}

export function parseFleetDocumentWithMeta(text: string): ParsedFleet {
  if (/<section\b[^>]*class=["'][^"']*\bhost\b/i.test(text)) {
    const parsed = parseClaudemuxHosts(text);
    return {
      hosts: parsed.hosts.filter(hostHasRows),
      skippedUnreachable: parsed.skippedUnreachable,
      skippedProjectTables: parsed.skippedProjectTables,
    };
  }
  return { hosts: parseFleetDocument(text), skippedUnreachable: [], skippedProjectTables: [] };
}

export function normHost(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.local\b/g, "")
    .replace(/\.(lan|home|internal)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function splitAliases(raw: string | null | undefined): string[] {
  if (raw == null || raw === "") return [];
  return String(raw)
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function machineHostKeys(m: MachineHint): string[] {
  const raw = [m.hostname, m.host, m.name, ...splitAliases(m.hostAlias), ...splitAliases(m.aliases)].filter(Boolean);
  return raw.map((x) => normHost(String(x)));
}

/** Build a matcher hint from a Thing's attributes. Does not write anything. */
export function machineHintFromItem(it: {
  id: number;
  name: string;
  attributes?: Record<string, string | number> | null;
}): MachineHint {
  const a = it.attributes ?? {};
  return {
    id: it.id,
    name: it.name,
    hostname: a.hostname != null ? String(a.hostname) : null,
    host: a.host != null ? String(a.host) : null,
    ip: a.ip != null ? String(a.ip) : a.ip_address != null ? String(a.ip_address) : null,
    hostAlias: a.host_alias != null ? String(a.host_alias) : a.hostAlias != null ? String(a.hostAlias) : null,
    aliases: a.aliases != null ? String(a.aliases) : null,
  };
}

/**
 * Match a fleet / projects host to an inventory machine. Hostname, host,
 * name, `host_alias` and `aliases` are exact after stripping `.local` and
 * case. IP is exact equality only, and only used when hostname did not
 * match — so 10.50.0.102 never hits 10.50.0.10, and "docker" never hits
 * dockermac-1. `mbp` matches only when the item lists that alias.
 */
export function matchMachine(
  target: string | { host: string; ip?: string | null },
  machines: MachineHint[],
): MachineHint | null {
  const t = typeof target === "string" ? { host: target, ip: looksLikeIp(target) ? target : null } : target;
  const hostNorm = looksLikeIp(t.host) ? "" : normHost(t.host);
  if (hostNorm) {
    for (const m of machines) {
      if (machineHostKeys(m).includes(hostNorm)) return m;
    }
  }
  const ip = normalizeIp(t.ip) ?? (looksLikeIp(t.host) ? normalizeIp(t.host) : null);
  if (ip) {
    for (const m of machines) {
      if (normalizeIp(m.ip) === ip) return m;
    }
  }
  return null;
}
