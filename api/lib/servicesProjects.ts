/** Claude Code / Grok / Hermes / OpenClaw project rows on a machine. */

export const PROJECT_KINDS = ["claude", "grok", "hermes", "openclaw"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_KIND_COLOR: Record<string, string> = {
  claude: "#d97706",
  grok: "#38bdf8",
  hermes: "#a855f7",
  openclaw: "#14b8a6",
};

export type ProjectRec = {
  name: string;
  kind?: string;
  status?: string;
  tokens?: number;
  size?: number;
  updatedAt?: string;
  minutes?: number;
  url?: string;
  path?: string;
};

export type DatabaseRec = {
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

export type ProjectsHost = {
  host: string;
  ip?: string | null;
  projects: ProjectRec[];
};

function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function str(x: unknown): string | null {
  if (x == null) return null;
  const s = String(x).trim();
  return s ? s : null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };

function decode(s: string): string {
  return s
    .replace(/&([a-z]+);/gi, (all, name: string) => NAMED[name.toLowerCase()] ?? all)
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      const n = Number.parseInt(h, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&#(\d+);/g, (_, d: string) => {
      const n = Number(d);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    });
}

function innerText(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

/** Map a label / path / kind cell onto one of the four fleet agents. */
export function detectProjectKind(s: string): ProjectKind | null {
  const n = s.toLowerCase();
  if (/\bopenclaw\b|\bclawdy\b|\bclawd(?:bot)?\b/.test(n)) return "openclaw";
  if (/\bhermes\b/.test(n)) return "hermes";
  if (/\bgrok(?:bot|build)?\b/.test(n)) return "grok";
  if (/\bclaude(?:-?code)?\b/.test(n)) return "claude";
  return null;
}

export function normalizeProjectKind(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const known = detectProjectKind(s);
  if (known) return known;
  const t = s.trim().toLowerCase();
  return t && t.length <= 32 ? t : undefined;
}

export function parseTokenCount(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  const s = String(raw).trim().toLowerCase().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*(k|m|b|million|thousand)?\s*(tok(?:ens)?)?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  const mul = unit === "k" || unit === "thousand" ? 1e3 : unit === "m" || unit === "million" ? 1e6 : unit === "b" ? 1e9 : 1;
  return n * mul;
}

export function parseSizeBytes(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  const s = String(raw).trim().toLowerCase().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (m[2] ?? "b").toLowerCase();
  const mul =
    unit === "kib" || unit === "kb"
      ? 1024
      : unit === "mib" || unit === "mb"
        ? 1024 ** 2
        : unit === "gib" || unit === "gb"
          ? 1024 ** 3
          : unit === "tib" || unit === "tb"
            ? 1024 ** 4
            : 1;
  return n * mul;
}

export function parseMinutes(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (m[2] ?? "min").toLowerCase();
  if (unit.startsWith("h")) return n * 60;
  if (unit.startsWith("d")) return n * 1440;
  return n;
}

const REL_AGO = /^(?:about\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?)\s+ago$/i;

/** Milliseconds since epoch, or null when the cell is empty / unparseable. */
export function parseWhenMs(raw: string | undefined | null, now = Date.now()): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^now|just now|today$/i.test(s)) return now;
  if (/^yesterday$/i.test(s)) return now - 86400000;
  const rel = s.match(REL_AGO);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const ms =
      u.startsWith("s")
        ? n * 1000
        : u.startsWith("m") && !u.startsWith("mo")
          ? n * 60000
          : u.startsWith("h")
            ? n * 3600000
            : u.startsWith("d")
              ? n * 86400000
              : u.startsWith("w")
                ? n * 7 * 86400000
                : n * 30 * 86400000;
    return now - ms;
  }
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const iso = Date.parse(s);
  return Number.isFinite(iso) ? iso : null;
}

export function daysSince(raw: string | undefined | null, now = Date.now()): number | null {
  const ms = parseWhenMs(raw, now);
  if (ms == null) return null;
  return (now - ms) / 86400000;
}

/** 1 = fresh, down toward 0.25 as the project goes stale. Active stays 1. */
export function projectFade(status?: string, updatedAt?: string, now = Date.now()): number {
  if (/^(active|running|ok|live)$/i.test(status ?? "")) return 1;
  const days = daysSince(updatedAt, now);
  if (days == null) return /stale|idle|old|inactive/i.test(status ?? "") ? 0.4 : 1;
  if (days <= 1) return 1;
  if (days <= 7) return 0.75;
  if (days <= 30) return 0.5;
  if (days <= 90) return 0.35;
  return 0.25;
}

export function inferProjectStatus(status?: string, updatedAt?: string, now = Date.now()): string {
  if (status && status.trim()) return status.trim();
  const days = daysSince(updatedAt, now);
  if (days == null) return "";
  if (days <= 1) return "active";
  if (days <= 14) return "idle";
  return "stale";
}

export function fmtTokens(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || !(n > 0)) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 10e9 ? 0 : 1)}B tok`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 10e6 ? 0 : 1)}M tok`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 10e3 ? 0 : 1)}k tok`;
  return `${Math.round(n)} tok`;
}

export function fmtMinutes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || !(n > 0)) return "";
  if (n >= 1440) return `${Math.round((n / 1440) * 10) / 10} d`;
  if (n >= 60) return `${Math.round((n / 60) * 10) / 10} h`;
  return `${Math.round(n)} min`;
}

/** `/Users/…`, `~/src/foo`, `.claude/projects/bar` — not a URL. */
export function looksLikeProjectDir(s: string): boolean {
  const t = s.trim();
  if (!t || t.length < 2 || /^https?:\/\//i.test(t)) return false;
  if (/^~(\/|$)/.test(t) || /^\/[\w.~-]/.test(t) || /^[A-Za-z]:[\\/]/.test(t)) return true;
  if ((t.includes("/") || t.includes("\\")) && !/\s/.test(t) && t.length <= 255) return true;
  return false;
}

export function normProjectPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/** Same engine + label + target is one database (two sqlite files can share a label). */
export function dbMergeKey(d: { name?: string; engine?: string; target?: string }): string {
  return `${String(d.engine ?? "").toLowerCase()}:${String(d.name ?? "").toLowerCase()}:${String(d.target ?? "").toLowerCase()}`;
}

/** Same machine + same path is one project, even when kind/name differ. */
export function projectMergeKey(p: { name?: string; path?: string; kind?: string }): string {
  const named = String(p.name ?? "").trim();
  const raw = String(p.path ?? "").trim() || (looksLikeProjectDir(named) ? named : "");
  if (raw) return `p:${normProjectPath(raw).toLowerCase()}`;
  return `n:${String(p.kind ?? "").toLowerCase()}:${named.toLowerCase()}`;
}

function preferKind(a?: string, b?: string): string | undefined {
  const pick = (k?: string) => {
    const t = String(k ?? "").trim().toLowerCase();
    return t && t !== "unknown" ? t : "";
  };
  return pick(b) || pick(a) || String(b || a || "").trim() || undefined;
}

function newerStamp(a?: string, b?: string): string | undefined {
  const am = parseWhenMs(a ?? "");
  const bm = parseWhenMs(b ?? "");
  if (am != null && bm != null) return bm >= am ? b : a;
  return b || a || undefined;
}

function maxNum(a: unknown, b: unknown): number | undefined {
  const an = typeof a === "number" && Number.isFinite(a) && a > 0 ? a : undefined;
  const bn = typeof b === "number" && Number.isFinite(b) && b > 0 ? b : undefined;
  if (an == null) return bn;
  if (bn == null) return an;
  return Math.max(an, bn);
}

/** Prefer tokens / newer updatedAt / a known kind when two collectors hit one path. */
export function mergeProjectRecords(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const nameA = String(a.name ?? "").trim();
  const nameB = String(b.name ?? "").trim();
  const pathA = String(a.path ?? "").trim() || (looksLikeProjectDir(nameA) ? nameA : "");
  const pathB = String(b.path ?? "").trim() || (looksLikeProjectDir(nameB) ? nameB : "");
  const path = pathA.length >= pathB.length ? pathA : pathB;
  const display = [nameA, nameB].filter(Boolean).sort((x, y) => {
    const xd = looksLikeProjectDir(x) ? 1 : 0;
    const yd = looksLikeProjectDir(y) ? 1 : 0;
    if (xd !== yd) return xd - yd;
    return x.length - y.length;
  })[0];
  const tokens = maxNum(a.tokens, b.tokens);
  const size = maxNum(a.size, b.size);
  const minutes = maxNum(a.minutes, b.minutes);
  const updatedAt = newerStamp(a.updatedAt != null ? String(a.updatedAt) : undefined, b.updatedAt != null ? String(b.updatedAt) : undefined);
  const kind = preferKind(a.kind != null ? String(a.kind) : undefined, b.kind != null ? String(b.kind) : undefined);
  const status = String(b.status ?? a.status ?? "").trim();
  const url = String(b.url ?? a.url ?? "").trim();
  const o: Record<string, unknown> = { ...a, ...b, name: (display || path).slice(0, 128) };
  if (kind) o.kind = kind;
  if (status) o.status = status;
  else delete o.status;
  if (tokens != null) o.tokens = tokens;
  if (size != null) o.size = size;
  if (minutes != null) o.minutes = minutes;
  if (updatedAt) o.updatedAt = updatedAt;
  if (path) o.path = path.slice(0, 255);
  if (url) o.url = url;
  return o;
}

export function fmtAgo(updatedAt?: string, now = Date.now()): string {
  const days = daysSince(updatedAt, now);
  if (days == null) return updatedAt?.trim() ?? "";
  if (days < 0.04) return "now";
  if (days < 1) {
    const h = days * 24;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
    return `${Math.round(h)}h ago`;
  }
  if (days < 14) return `${Math.round(days)}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function asProject(x: unknown, fallbackKind?: string): ProjectRec | null {
  if (typeof x === "string" || typeof x === "number") {
    const name = String(x).trim();
    if (!name) return null;
    const kind = normalizeProjectKind(fallbackKind) ?? detectProjectKind(name) ?? fallbackKind;
    return { name, ...(kind ? { kind } : {}) };
  }
  const o = asRecord(x);
  if (!o) return null;
  const name = str(o.name ?? o.project ?? o.path ?? o.label ?? o.id);
  if (!name) return null;
  const kind = normalizeProjectKind(str(o.kind ?? o.agent ?? o.source ?? o.runtime) ?? "") ?? detectProjectKind(name) ?? fallbackKind;
  const status = str(o.status ?? o.state);
  const tokens = parseTokenCount(o.tokens ?? o.token ?? o.usage);
  const size = parseSizeBytes(o.size ?? o.bytes ?? o.projectSize);
  const updatedAt = str(o.updatedAt ?? o.updated ?? o.last ?? o.seen ?? o.activity ?? o.time);
  const minutes = parseMinutes(o.minutes ?? o.duration ?? o.hours);
  const url = str(o.url);
  const path = str(o.path ?? o.dir ?? o.directory) ?? (looksLikeProjectDir(name) ? name : null);
  return {
    name,
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(tokens != null ? { tokens } : {}),
    ...(size != null && size > 0 ? { size } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(minutes != null && minutes > 0 ? { minutes } : {}),
    ...(url ? { url } : {}),
    ...(path ? { path: path.slice(0, 255) } : {}),
  };
}

function asDatabase(x: unknown): DatabaseRec | null {
  if (typeof x === "string" || typeof x === "number") {
    const name = String(x).trim();
    return name ? { name } : null;
  }
  const o = asRecord(x);
  if (!o) return null;
  const name = str(o.name ?? o.label ?? o.db ?? o.database ?? o.schema);
  if (!name) return null;
  const engine = str(o.engine ?? o.type ?? o.kind);
  const status = str(o.status ?? o.state);
  const portRaw = o.port;
  const portN = typeof portRaw === "number" ? portRaw : Number(portRaw);
  const port = Number.isInteger(portN) && portN > 0 && portN <= 65535 ? portN : undefined;
  const size = parseSizeBytes(o.size ?? o.bytes);
  const target = str(o.target);
  const url = str(o.url) ?? (target && /^https?:\/\//i.test(target) ? target : null);
  const detail = str(o.detail);
  const checked = str(o.checked);
  return {
    name,
    ...(engine ? { engine } : {}),
    ...(status ? { status } : {}),
    ...(port != null ? { port } : {}),
    ...(size != null && size > 0 ? { size } : {}),
    ...(url ? { url } : {}),
    ...(target ? { target } : {}),
    ...(detail ? { detail } : {}),
    ...(checked ? { checked } : {}),
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
  return str(o.host ?? o.hostname ?? o.machine ?? o.name);
}

function looksLikeIp(s: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s.trim());
}

function normalizeIp(s: string | null | undefined): string | null {
  if (s == null) return null;
  const m = String(s).trim().match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : null;
}

function uniqProjects(xs: ProjectRec[]): ProjectRec[] {
  const map = new Map<string, ProjectRec>();
  for (const p of xs) {
    const k = projectMergeKey(p);
    const prev = map.get(k);
    map.set(k, prev ? (mergeProjectRecords(prev, p) as ProjectRec) : p);
  }
  return [...map.values()];
}

function pushHost(out: ProjectsHost[], host: string, projects: ProjectRec[], ip?: string | null) {
  const next = uniqProjects(projects);
  if (!next.length) return;
  const prev = out.find((h) => h.host.toLowerCase() === host.toLowerCase());
  if (prev) {
    prev.projects = uniqProjects([...prev.projects, ...next]);
    if (!prev.ip && ip) prev.ip = ip;
    return;
  }
  out.push({ host, ip: ip ?? null, projects: next });
}

function walk(x: unknown, out: ProjectsHost[], depth: number, fallbackKind?: string) {
  if (depth > 6 || x == null) return;
  if (Array.isArray(x)) {
    const rows = x.map((el) => asProject(el, fallbackKind)).filter((p): p is ProjectRec => p != null);
    const withHost = x
      .map((el) => {
        const o = asRecord(el);
        const host = o ? hostNameOf(o) : null;
        const p = asProject(el, fallbackKind);
        return host && p && host.toLowerCase() !== p.name.toLowerCase() ? { host, ip: o ? str(o.ip) : null, p } : null;
      })
      .filter((r): r is { host: string; ip: string | null; p: ProjectRec } => r != null);
    if (withHost.length && withHost.length === rows.length) {
      for (const r of withHost) pushHost(out, r.host, [r.p], r.ip);
      return;
    }
    for (const el of x) walk(el, out, depth + 1, fallbackKind);
    return;
  }
  const o = asRecord(x);
  if (!o) return;
  const host = hostNameOf(o);
  const lists = [
    ...listOf(o.projects),
    ...listOf(o.agents),
    ...listOf(o.claude),
    ...listOf(o["claude-code"]),
  ]
    .map((el) => asProject(el, fallbackKind ?? "claude"))
    .filter((p): p is ProjectRec => p != null);
  if (host && lists.length && lists.every((p) => p.name.toLowerCase() !== host.toLowerCase())) {
    pushHost(out, host, lists, str(o.ip ?? o.address));
  }
  for (const [k, v] of Object.entries(o)) {
    if (["projects", "agents", "claude", "claude-code"].includes(k)) continue;
    if (Array.isArray(v) || (v && typeof v === "object")) walk(v, out, depth + 1, fallbackKind);
  }
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
  return blobs;
}

function classList(tag: string): string {
  const m = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
  return m ? ` ${m[1].toLowerCase()} ` : " ";
}

function hasClass(tag: string, name: string): boolean {
  return classList(tag).includes(` ${name.toLowerCase()} `);
}

function headerIndex(headers: string[], ...names: string[]): number {
  for (const name of names) {
    const i = headers.findIndex((h) => h === name || h.startsWith(`${name} `));
    if (i >= 0) return i;
  }
  return -1;
}

function isContainerProjectsTable(html: string): boolean {
  return /class=["'][^"']*\bpd-k\b/i.test(html) || /class=["'][^"']*\bcname\b/i.test(html);
}

function isProjectsTable(open: string, body: string): boolean {
  if (isContainerProjectsTable(body)) return false;
  if (
    hasClass(open, "claude-projects") ||
    hasClass(open, "projects-table") ||
    hasClass(open, "cc-projects") ||
    hasClass(open, "agents-table")
  ) {
    return true;
  }
  const first = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)][0]?.[1] ?? "";
  const headers = [...first.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => innerText(c[1]).toLowerCase());
  return headers.some((h) => /token|updated|kind|agent|project/.test(h)) && !headers.includes("container");
}

function rowsFromTable(body: string): { headers: string[]; rows: string[][] } {
  const trs = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => r[1]);
  const cells = (row: string) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => innerText(c[1]));
  if (!trs.length) return { headers: [], rows: [] };
  const first = cells(trs[0]).map((h) => h.toLowerCase());
  const hasHeader = first.some((h) => /project|name|host|token|updated|kind|agent|path/.test(h));
  return { headers: hasHeader ? first : [], rows: (hasHeader ? trs.slice(1) : trs).map(cells) };
}

function projectFromCols(headers: string[], cols: string[], fallbackKind?: string): ProjectRec | null {
  const idx = (...names: string[]) => headerIndex(headers, ...names);
  const name = (idx("project", "name", "path", "label", "directory") >= 0 ? cols[idx("project", "name", "path", "label", "directory")] : cols[0]) ?? "";
  if (!name) return null;
  const kindRaw = idx("kind", "agent", "source") >= 0 ? cols[idx("kind", "agent", "source")] : "";
  const status = idx("status", "state") >= 0 ? cols[idx("status", "state")] : "";
  const tokens = parseTokenCount(idx("tokens", "token", "usage") >= 0 ? cols[idx("tokens", "token", "usage")] : "");
  const size = parseSizeBytes(idx("size", "bytes", "disk") >= 0 ? cols[idx("size", "bytes", "disk")] : "");
  const updatedAt = idx("updated", "last", "seen", "activity", "time") >= 0 ? cols[idx("updated", "last", "seen", "activity", "time")] : "";
  const minutes = parseMinutes(idx("duration", "minutes", "hours") >= 0 ? cols[idx("duration", "minutes", "hours")] : "");
  const url = idx("url", "href") >= 0 ? cols[idx("url", "href")] : "";
  const pathCol = idx("path", "dir", "directory", "folder") >= 0 ? cols[idx("path", "dir", "directory", "folder")] : "";
  const path = (pathCol && looksLikeProjectDir(pathCol) ? pathCol : looksLikeProjectDir(name) ? name : "") || undefined;
  const kind = normalizeProjectKind(kindRaw) ?? detectProjectKind(name) ?? fallbackKind;
  return asProject(
    {
      name,
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(tokens != null ? { tokens } : {}),
      ...(size != null ? { size } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(minutes != null ? { minutes } : {}),
      ...(url ? { url } : {}),
      ...(path ? { path } : {}),
    },
    fallbackKind,
  );
}

function parseHtmlProjects(html: string): ProjectsHost[] {
  const out: ProjectsHost[] = [];
  const sections = [...html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)];
  if (sections.length && sections.some((m) => hasClass(`<section${m[1]}>`, "host"))) {
    for (const m of sections) {
      if (!hasClass(`<section${m[1]}>`, "host")) continue;
      const section = m[2];
      const hname = section.match(/<span\b[^>]*class=["'][^"']*\bhname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
      const host = innerText(hname?.[1] ?? "") || innerText(section.match(/<(?:h1|h2|h3)\b[^>]*>([\s\S]*?)<\/h[123]>/i)?.[1] ?? "");
      if (!host) continue;
      const ip = normalizeIp(section);
      const projects: ProjectRec[] = [];
      for (const tm of section.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
        const open = `<table${tm[1]}>`;
        if (!isProjectsTable(open, tm[2])) continue;
        const { headers, rows } = rowsFromTable(tm[2]);
        for (const cols of rows) {
          const p = projectFromCols(headers, cols, "claude");
          if (p) projects.push(p);
        }
      }
      for (const card of section.matchAll(/<(?:article|div)\b([^>]*)>([\s\S]*?)<\/(?:article|div)>/gi)) {
        const open = card[1];
        const name = open.match(/\bdata-(?:project|name)=["']([^"']+)["']/i)?.[1];
        if (!name) continue;
        const tokens = parseTokenCount(open.match(/\bdata-tokens=["']([^"']+)["']/i)?.[1]);
        const updatedAt = open.match(/\bdata-(?:updated|seen)=["']([^"']+)["']/i)?.[1];
        const status = open.match(/\bdata-status=["']([^"']+)["']/i)?.[1];
        const kind = open.match(/\bdata-kind=["']([^"']+)["']/i)?.[1];
        const p = asProject({ name, tokens, updatedAt, status, kind }, "claude");
        if (p) projects.push(p);
      }
      pushHost(out, host, projects, ip);
    }
    if (out.length) return out;
  }

  for (const tm of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
    const open = `<table${tm[1]}>`;
    if (!isProjectsTable(open, tm[2])) continue;
    const { headers, rows } = rowsFromTable(tm[2]);
    const hostIdx = headerIndex(headers, "host", "hostname", "machine");
    if (hostIdx < 0) continue;
    for (const cols of rows) {
      const host = cols[hostIdx] ?? "";
      if (!host || looksLikeIp(host) === false && /^host-\d+$/i.test(host)) continue;
      const p = projectFromCols(headers, cols, "claude");
      if (!p || p.name.toLowerCase() === host.toLowerCase()) continue;
      pushHost(out, host, [p], looksLikeIp(host) ? host : null);
    }
  }

  for (const card of html.matchAll(/<(?:article|div)\b([^>]*data-(?:project|name)=[^>]*)>([\s\S]*?)<\/(?:article|div)>/gi)) {
    const open = card[1];
    const host = open.match(/\bdata-host=["']([^"']+)["']/i)?.[1];
    const name = open.match(/\bdata-(?:project|name)=["']([^"']+)["']/i)?.[1];
    if (!host || !name) continue;
    const tokens = parseTokenCount(open.match(/\bdata-tokens=["']([^"']+)["']/i)?.[1]);
    const updatedAt = open.match(/\bdata-(?:updated|seen)=["']([^"']+)["']/i)?.[1];
    const status = open.match(/\bdata-status=["']([^"']+)["']/i)?.[1];
    const kind = open.match(/\bdata-kind=["']([^"']+)["']/i)?.[1];
    const size = parseSizeBytes(open.match(/\bdata-size=["']([^"']+)["']/i)?.[1]);
    const p = asProject({ name, tokens, updatedAt, status, kind, size }, "claude");
    if (p) pushHost(out, host, [p]);
  }
  return out;
}

/** Parse a Claude Code /projects/ page (HTML or JSON) into per-host project lists. */
export function parseProjectsDocument(text: string, fallbackKind = "claude"): ProjectsHost[] {
  const out: ProjectsHost[] = [];
  for (const blob of extractJsonBlobs(text)) walk(blob, out, 0, fallbackKind);
  if (out.length) return out;
  return parseHtmlProjects(text);
}

export function projectsFromLabels(
  rows: Array<{ label: string; url?: string; status?: string }>,
): ProjectRec[] {
  const out: ProjectRec[] = [];
  for (const r of rows) {
    const kind = detectProjectKind(r.label);
    if (!kind) continue;
    out.push({
      name: r.label,
      kind,
      ...(r.status ? { status: r.status } : {}),
      ...(r.url ? { url: r.url } : {}),
    });
  }
  return uniqProjects(out);
}

export function parseDatabasesList(raw: unknown): DatabaseRec[] {
  return listOf(raw)
    .map(asDatabase)
    .filter((d): d is DatabaseRec => d != null);
}

export function countProjectsByKind(projects: Array<{ kind?: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of projects) {
    const k = String(p.kind ?? "unknown").trim().toLowerCase() || "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function parseProjectsList(raw: unknown, fallbackKind?: string): ProjectRec[] {
  return uniqProjects(
    listOf(raw)
      .map((x) => asProject(x, fallbackKind))
      .filter((p): p is ProjectRec => p != null),
  );
}

export { asProject, asDatabase };
