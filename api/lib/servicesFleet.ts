import { pickReachHost, rewriteLocalHostUrl } from "./serviceUrls.ts";

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
};

export type MachineHint = {
  id: number;
  name: string;
  hostname?: string | null;
  host?: string | null;
  ip?: string | null;
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

function pickLists(o: Record<string, unknown>): Pick<FleetHost, "containers" | "node" | "web"> {
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
  const seen = new Set<string>();
  const uniq = (xs: FleetContainer[]) =>
    xs.filter((c) => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return { containers: uniq(containers), node: uniq(node), web };
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

function rewriteHostLists(
  lists: Pick<FleetHost, "containers" | "node" | "web">,
  host: string,
  ip?: string | null,
): Pick<FleetHost, "containers" | "node" | "web"> {
  const reach = pickReachHost(ip, host);
  if (!reach) return lists;
  return {
    containers: lists.containers.map((c) => rewriteContainerUrl(c, reach)),
    node: lists.node.map((c) => rewriteContainerUrl(c, reach)),
    web: lists.web.map((w) => rewriteWebUrls(w, reach)),
  };
}

function pushHost(out: FleetHost[], host: string, lists: Pick<FleetHost, "containers" | "node" | "web">, ip?: string | null) {
  const next = rewriteHostLists(lists, host, ip);
  if (!next.containers.length && !next.node.length && !next.web.length) return;
  const prev = out.find((h) => normHost(h.host) === normHost(host));
  if (prev) {
    prev.containers.push(...next.containers);
    prev.node.push(...next.node);
    prev.web = groupWebServices([...prev.web, ...next.web]);
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
  if (host && (lists.containers.length || lists.node.length || lists.web.length)) {
    pushHost(out, host, lists, str(o.ip ?? o.address));
  }
  for (const [k, v] of Object.entries(o)) {
    if (["containers", "docker", "services", "compose", "node", "nodes", "web", "pwa", "urls", "pages"].includes(k)) continue;
    if (Array.isArray(v) || (v && typeof v === "object")) {
      const nested = asRecord(v);
      if (nested && !hostNameOf(nested) && (pickLists(nested).containers.length || pickLists(nested).node.length)) {
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

function stripSkippedTables(html: string): string {
  return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const open = table.match(/<table\b[^>]*>/i)?.[0] ?? "";
    if (hasClass(open, "databases-table") || hasClass(open, "timers")) return "";
    // services tables are `class="mtx services-table"` — keep those
    if (hasClass(open, "mtx") && !hasClass(open, "services-table")) return "";
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

export type ParsedFleet = { hosts: FleetHost[]; skippedUnreachable: string[] };

/** Claudemux daily HTML: one `<section class="host">` per machine. */
export function parseClaudemuxHosts(html: string): ParsedFleet {
  const hosts: FleetHost[] = [];
  const skippedUnreachable: string[] = [];
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
    if (!containers.length && !web.length) {
      hosts.push({ host, ip, containers: [], node: [], web: [] });
      continue;
    }
    pushHost(hosts, host, { containers, node: [], web }, ip);
  }
  return { hosts, skippedUnreachable };
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
    return parseClaudemuxHosts(text).hosts.filter((h) => h.containers.length || h.node.length || h.web.length);
  }
  const out: FleetHost[] = [];
  for (const blob of extractJsonBlobs(text)) walk(blob, out, 0);
  for (const h of out) h.containers = uniqByName(h.containers);
  return out.filter((h) => h.containers.length || h.node.length || h.web.length);
}

export function parseFleetDocumentWithMeta(text: string): ParsedFleet {
  if (/<section\b[^>]*class=["'][^"']*\bhost\b/i.test(text)) {
    const parsed = parseClaudemuxHosts(text);
    return {
      hosts: parsed.hosts.filter((h) => h.containers.length || h.node.length || h.web.length),
      skippedUnreachable: parsed.skippedUnreachable,
    };
  }
  return { hosts: parseFleetDocument(text), skippedUnreachable: [] };
}

export function normHost(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/\.(lan|home|internal)$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Match a fleet host to an inventory machine. Hostname / host / name are
 * exact (after stripping .local). IP is exact equality only, and only used
 * when hostname did not match — so 10.50.0.102 never hits 10.50.0.10, and
 * "docker" never hits dockermac-1.
 */
export function matchMachine(
  target: string | { host: string; ip?: string | null },
  machines: MachineHint[],
): MachineHint | null {
  const t = typeof target === "string" ? { host: target, ip: looksLikeIp(target) ? target : null } : target;
  const hostNorm = looksLikeIp(t.host) ? "" : normHost(t.host);
  if (hostNorm) {
    for (const m of machines) {
      const keys = [m.hostname, m.host, m.name].filter(Boolean).map((x) => normHost(String(x)));
      if (keys.includes(hostNorm)) return m;
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
