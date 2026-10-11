/** Parse Mini launchd / lsof / Caddy / sqlite / MySQL snapshots for services.report. */

import type { DatabaseRecIn, ServiceRecIn, WebRecIn } from "./services.ts";

export type LaunchdJob = {
  label: string;
  program?: string;
  cwd?: string;
  plistPath?: string;
};

export type LaunchdRuntime = {
  state?: string;
  pid?: number;
  lastExit?: number;
};

export type ListenRow = {
  pid: number;
  command: string;
  port: number;
  address: string;
};

export type CaddyRoute = {
  host: string;
  port?: number;
};

export type SqliteFile = {
  path: string;
  size: number;
};

const KEEP_LABEL = /^(nl\.ricktav\.|nl\.homebase\.)/i;
const DOCKER_CMD = /^(docker|com\.docker|docker-proxy|vpnkit|orbstack|qemu-system)/i;
const LOOPBACK = /^(127\.0\.0\.1|::1|\[::1\]|localhost)$/i;
const WILDCARD = /^(\*|0\.0\.0\.0|::|\[::\])$/i;

export function isLoopbackAddr(addr: string): boolean {
  const a = String(addr ?? "").trim().toLowerCase();
  if (!a) return false;
  if (WILDCARD.test(a)) return false;
  if (LOOPBACK.test(a)) return true;
  if (a.startsWith("127.")) return true;
  return false;
}

/** Keep user LaunchAgents with our prefixes, or any other job that has a Program. */
export function keepLaunchdJob(job: LaunchdJob): boolean {
  const label = String(job.label ?? "").trim();
  if (!label) return false;
  if (KEEP_LABEL.test(label)) return true;
  return Boolean(job.program);
}

function plistStringAfter(xml: string, key: string): string | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "i");
  const m = xml.match(re);
  return m ? decodePlist(m[1].trim()) : undefined;
}

function plistFirstArrayString(xml: string, key: string): string | undefined {
  const re = new RegExp(`<key>${key}</key>\\s*<array>\\s*<string>([^<]*)</string>`, "i");
  const m = xml.match(re);
  return m ? decodePlist(m[1].trim()) : undefined;
}

function decodePlist(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** XML plist (or `plutil -convert xml1`) → label / Program / WorkingDirectory. */
export function parseLaunchdPlistXml(xml: string, plistPath?: string): LaunchdJob | null {
  const text = String(xml ?? "");
  const label = plistStringAfter(text, "Label");
  if (!label) return null;
  const program = plistStringAfter(text, "Program") || plistFirstArrayString(text, "ProgramArguments");
  const cwd = plistStringAfter(text, "WorkingDirectory");
  const job: LaunchdJob = { label: label.slice(0, 128), ...(plistPath ? { plistPath } : {}) };
  if (program) job.program = program.slice(0, 255);
  if (cwd) job.cwd = cwd.slice(0, 255);
  return job;
}

/** `plutil -p` dump → same fields. */
export function parseLaunchdPlistDump(text: string, plistPath?: string): LaunchdJob | null {
  const s = String(text ?? "");
  const label = s.match(/^\s*Label\s*=>\s*"([^"]+)"/m)?.[1];
  if (!label) return parseLaunchdPlistXml(s, plistPath);
  const program =
    s.match(/^\s*Program\s*=>\s*"([^"]+)"/m)?.[1] ??
    s.match(/ProgramArguments\s*=>\s*\(\s*"([^"]+)"/s)?.[1];
  const cwd = s.match(/^\s*WorkingDirectory\s*=>\s*"([^"]+)"/m)?.[1];
  const job: LaunchdJob = { label: label.slice(0, 128), ...(plistPath ? { plistPath } : {}) };
  if (program) job.program = program.slice(0, 255);
  if (cwd) job.cwd = cwd.slice(0, 255);
  return job;
}

export function parseLaunchdPlist(text: string, plistPath?: string): LaunchdJob | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (t.startsWith("{") || /^\s*Label\s*=>/m.test(t)) return parseLaunchdPlistDump(t, plistPath);
  return parseLaunchdPlistXml(t, plistPath);
}

/** `launchctl print gui/<uid>/<label>` → state, pid, last exit. */
export function parseLaunchctlPrint(text: string): LaunchdRuntime {
  const s = String(text ?? "");
  const state = s.match(/^\s*state\s*=\s*(\S+)/m)?.[1];
  const pidRaw = s.match(/^\s*pid\s*=\s*(\d+)/m)?.[1];
  const exitRaw =
    s.match(/^\s*last exit code\s*=\s*(-?\d+)/m)?.[1] ??
    s.match(/^\s*last exit status\s*=\s*(-?\d+)/m)?.[1] ??
    s.match(/^\s*last exit code\s*=\s*\(never exited\)/m)?.[1];
  const out: LaunchdRuntime = {};
  if (state) out.state = state.slice(0, 32);
  if (pidRaw) out.pid = Number(pidRaw);
  if (exitRaw != null && exitRaw !== "") {
    const n = Number(exitRaw);
    if (Number.isFinite(n)) out.lastExit = n;
  }
  return out;
}

export function launchdIsRunning(rt: LaunchdRuntime): boolean {
  if (rt.pid != null && rt.pid > 0 && !/^(exited|idle|waiting|not\s*running|pending)$/i.test(rt.state ?? "")) {
    if (!rt.state || /running|active|spawned/i.test(rt.state)) return true;
  }
  return /^(running|active)$/i.test(rt.state ?? "");
}

/**
 * running+listening → ok; running no port → warn; last exit != 0 → error;
 * loaded not running → stopped (grey).
 */
export function launchdStatus(rt: LaunchdRuntime, ports: number[]): string {
  const running = launchdIsRunning(rt);
  if (running && ports.length) return "ok";
  if (running) return "warn";
  if (rt.lastExit != null && rt.lastExit !== 0) return "error";
  return "stopped";
}

/** `lsof -nP -iTCP -sTCP:LISTEN` rows. */
export function parseLsofListen(text: string): ListenRow[] {
  const out: ListenRow[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim() || /^COMMAND\b/i.test(line)) continue;
    const m = line.match(/^(\S+)\s+(\d+)\b.*\bTCP\s+(\S+)/i);
    if (!m) continue;
    const name = m[3].replace(/\s*\(LISTEN\)\s*$/i, "");
    const parsed = splitListenName(name);
    if (!parsed) continue;
    out.push({ pid: Number(m[2]), command: m[1].slice(0, 64), port: parsed.port, address: parsed.address });
  }
  return out;
}

export function splitListenName(name: string): { address: string; port: number } | null {
  const s = String(name ?? "").trim();
  const v6 = s.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  if (v6) {
    const port = Number(v6[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { address: v6[1], port };
  }
  const v4 = s.match(/^(.*):(\d{1,5})$/);
  if (!v4) return null;
  const port = Number(v4[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { address: v4[1] || "*", port };
}

/** `ps -axo pid=,ppid=` → child pid lists (parent → children). */
export function parsePsPidPpid(text: string): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!pid) continue;
    const list = kids.get(ppid) ?? [];
    list.push(pid);
    kids.set(ppid, list);
  }
  return kids;
}

export function descendantPids(root: number, kids: Map<number, number[]>, limit = 64): number[] {
  if (!root) return [];
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const q = [root];
  while (q.length && out.length < limit) {
    const p = q.shift()!;
    for (const c of kids.get(p) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      q.push(c);
    }
  }
  return out;
}

export function portsForPids(listeners: ListenRow[], pids: Iterable<number>): ListenRow[] {
  const set = new Set([...pids].filter((n) => n > 0));
  return listeners.filter((l) => set.has(l.pid));
}

export function uniquePorts(rows: ListenRow[], loopbackOnly = false): number[] {
  const seen = new Set<number>();
  for (const r of rows) {
    const loop = isLoopbackAddr(r.address);
    if (loopbackOnly ? !loop : loop) continue;
    seen.add(r.port);
  }
  return [...seen].sort((a, b) => a - b);
}

export function loopbackOnlyPorts(rows: ListenRow[]): number[] {
  const publicPorts = new Set(uniquePorts(rows, false));
  return uniquePorts(rows, true).filter((p) => !publicPorts.has(p));
}

export function isDockerCommand(command: string): boolean {
  return DOCKER_CMD.test(String(command ?? "").trim());
}

/** Host / database from a MySQL URL. Never returns user or password. */
export function parseMysqlUrlPublic(raw: string): { host: string; port?: number; database: string } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const proto = u.protocol.replace(/:$/, "").toLowerCase();
    if (proto && proto !== "mysql" && proto !== "mysql2") return null;
    const database = decodeURIComponent(u.pathname.replace(/^\//, "").split("/")[0] ?? "").trim();
    const host = u.hostname.trim();
    if (!host || !database) return null;
    const port = u.port ? Number(u.port) : undefined;
    return { host: host.slice(0, 128), ...(port && Number.isInteger(port) ? { port } : {}), database: database.slice(0, 64) };
  } catch {
    return null;
  }
}

const T7_DATA = /^\/Volumes\/T7\/[^/]+\/data\//i;
const SQLITE_SKIP = /\/(node_modules|Library\/Caches|\.Trash|Library\/Containers|\.git|Library\/Application Support)\//i;

export function keepSqlitePath(path: string, home = ""): { keep: boolean; reason?: string } {
  const p = String(path ?? "").trim();
  if (!p.toLowerCase().endsWith(".db")) return { keep: false, reason: "not-db" };
  if (SQLITE_SKIP.test(p)) return { keep: false, reason: "skip-dir" };
  if (T7_DATA.test(p)) return { keep: true };
  if (home && (p === home || p.startsWith(`${home}/`))) return { keep: true };
  if (p.startsWith("/Volumes/T7/")) return { keep: false, reason: "not-t7-data" };
  return { keep: true };
}

export function sqliteRec(file: SqliteFile): DatabaseRecIn {
  const base = file.path.split("/").pop() || file.path;
  const name = base.replace(/\.db$/i, "").slice(0, 64) || "sqlite";
  const rec: DatabaseRecIn = {
    name,
    engine: "sqlite",
    target: file.path.slice(0, 255),
    status: "ok",
  };
  if (file.size > 0) rec.size = file.size;
  return rec;
}

export function postgresFromDocker(containers: Array<{
  name: string;
  image?: string;
  status?: string;
  port?: number;
  ports?: number[];
  mounts?: Array<{ size?: number; dest?: string; source?: string }>;
}>): DatabaseRecIn[] {
  const out: DatabaseRecIn[] = [];
  for (const c of containers) {
    const image = String(c.image ?? "");
    if (!/postgres/i.test(image) && !/postgres/i.test(c.name)) continue;
    const ports = [...(c.ports ?? []), ...(c.port != null ? [c.port] : [])].filter((n, i, a) => a.indexOf(n) === i);
    const size = (c.mounts ?? []).reduce((n, m) => n + (m.size && m.size > 0 ? m.size : 0), 0);
    const rec: DatabaseRecIn = {
      name: c.name.slice(0, 64),
      engine: "postgres",
      status: c.status || "ok",
      target: (ports[0] != null ? `localhost:${ports[0]}` : c.name).slice(0, 255),
    };
    if (ports[0] != null) rec.port = ports[0];
    if (size > 0) rec.size = size;
    if (image) rec.detail = image.slice(0, 255);
    out.push(rec);
  }
  return out;
}

/** Caddyfile: `host { reverse_proxy 127.0.0.1:3001 }` */
export function parseCaddyfile(text: string): CaddyRoute[] {
  const out: CaddyRoute[] = [];
  const seen = new Set<string>();
  const blocks = String(text ?? "").split(/(?<=\})\s*/);
  for (const block of blocks) {
    const head = block.match(/^\s*([^\s{#]+(?:\s+[^\s{#]+)*)\s*\{/m);
    if (!head) continue;
    const hosts = head[1]
      .split(/\s+/)
      .map((h) => h.replace(/:\d+$/, "").replace(/^https?:\/\//, ""))
      .filter((h) => h && !h.startsWith(":") && !/^(handle|route|@|http)$/i.test(h));
    const ports = new Set<number>();
    for (const m of block.matchAll(/reverse_proxy\s+[^\n{]*?:(\d{2,5})/gi)) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0 && n <= 65535) ports.add(n);
    }
    for (const host of hosts) {
      if (!ports.size) {
        const k = host.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ host: host.slice(0, 128) });
        continue;
      }
      for (const port of ports) {
        const k = `${host.toLowerCase()}|${port}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ host: host.slice(0, 128), port });
      }
    }
  }
  return out;
}

function asRec(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

/** `caddy adapt` JSON → public host + upstream port. */
export function parseCaddyAdapt(json: unknown): CaddyRoute[] {
  const root = asRec(json);
  if (!root) return [];
  const apps = asRec(root.apps);
  const http = asRec(apps?.http);
  const servers = asRec(http?.servers);
  if (!servers) return [];
  const out: CaddyRoute[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, hosts: string[]) => {
    const o = asRec(node);
    if (!o) return;
    const match = Array.isArray(o.match) ? o.match : [];
    let nextHosts = hosts;
    for (const m of match) {
      const mo = asRec(m);
      const raw = mo && Array.isArray(mo.host) ? mo.host.map((h) => String(h)) : [];
      if (raw.length) nextHosts = raw;
    }
    if (o.handler === "reverse_proxy") {
      const ups = Array.isArray(o.upstreams) ? o.upstreams : [];
      for (const u of ups) {
        const uo = asRec(u);
        const dial = String(uo?.dial ?? "");
        const port = Number(dial.match(/:(\d{2,5})\s*$/)?.[1]);
        for (const host of nextHosts.length ? nextHosts : [""]) {
          const h = host.replace(/^https?:\/\//, "").replace(/:\d+$/, "").slice(0, 128);
          if (!h) continue;
          const k = `${h.toLowerCase()}|${Number.isInteger(port) ? port : ""}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ host: h, ...(Number.isInteger(port) && port > 0 ? { port } : {}) });
        }
      }
    }
    const kids = [...(Array.isArray(o.handle) ? o.handle : []), ...(Array.isArray(o.routes) ? o.routes : [])];
    for (const c of kids) walk(c, nextHosts);
  };
  for (const srv of Object.values(servers)) {
    const so = asRec(srv);
    if (!so || !Array.isArray(so.routes)) continue;
    for (const r of so.routes) walk(r, []);
  }
  return out;
}

function publicUrl(host: string): string {
  const h = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${h}/`.slice(0, 255);
}

function lanUrl(ip: string, port: number): string {
  return (port === 80 ? `http://${ip}/` : `http://${ip}:${port}/`).slice(0, 255);
}

function applyCaddy(web: WebRecIn[], routes: CaddyRoute[]): void {
  for (const r of routes) {
    const matches = r.port != null ? web.filter((w) => (w.ports ?? []).includes(r.port!) || w.port === r.port) : [];
    if (matches.length) {
      for (const w of matches) {
        w.public = true;
        w.host = r.host.slice(0, 128);
        const u = publicUrl(r.host);
        w.urls = [...(w.urls ?? []), ...(w.url ? [w.url] : []), u].filter((x, i, a) => a.indexOf(x) === i);
        if (!w.url) w.url = u;
      }
      continue;
    }
    web.push({
      label: r.host.slice(0, 64),
      url: publicUrl(r.host),
      urls: [publicUrl(r.host)],
      ...(r.port != null ? { port: r.port, ports: [r.port] } : {}),
      status: "ok",
      public: true,
      host: r.host.slice(0, 128),
    });
  }
}

export type MacAssembleInput = {
  jobs: Array<LaunchdJob & LaunchdRuntime>;
  listeners: ListenRow[];
  children: Map<number, number[]>;
  hostIp: string;
  dockerPorts?: number[];
  sqlite?: SqliteFile[];
  postgres?: DatabaseRecIn[];
  mysql?: DatabaseRecIn | null;
  caddy?: CaddyRoute[];
};

export type MacAssembleResult = {
  services: ServiceRecIn[];
  web: WebRecIn[];
  databases: DatabaseRecIn[];
  loopbackNotes: string[];
};

/** Build merge-only services / web / databases rows from Mini snapshots. */
export function assembleMacReport(input: MacAssembleInput): MacAssembleResult {
  const hostIp = String(input.hostIp || "10.50.0.102").trim() || "10.50.0.102";
  const dockerPorts = new Set(input.dockerPorts ?? []);
  const ownedPids = new Set<number>();
  const services: ServiceRecIn[] = [];
  const web: WebRecIn[] = [];
  const loopbackNotes: string[] = [];

  for (const job of input.jobs) {
    if (!keepLaunchdJob(job)) continue;
    const tree = [job.pid, ...descendantPids(job.pid ?? 0, input.children)].filter((n): n is number => n != null && n > 0);
    for (const p of tree) ownedPids.add(p);
    const listens = portsForPids(input.listeners, tree);
    const ports = uniquePorts(listens, false);
    const loop = loopbackOnlyPorts(listens);
    const status = launchdStatus(job, ports);
    const rec: ServiceRecIn = { name: job.label.slice(0, 64), status };
    if (job.program) rec.image = job.program.slice(0, 128);
    if (job.cwd) rec.cwd = job.cwd.slice(0, 255);
    if (ports[0] != null) rec.port = ports[0];
    if (ports.length > 1) rec.ports = ports;
    if (ports[0] != null) rec.url = lanUrl(hostIp, ports[0]);
    services.push(rec);
    if (ports.length) {
      web.push({
        label: job.label.slice(0, 64),
        url: lanUrl(hostIp, ports[0]),
        port: ports[0],
        ports,
        urls: ports.map((p) => lanUrl(hostIp, p)),
        status,
      });
    }
    if (loop.length) {
      loopbackNotes.push(`${job.label} loopback :${loop.join(",:")}`);
    }
  }

  const byPid = new Map<number, ListenRow[]>();
  for (const row of input.listeners) {
    const list = byPid.get(row.pid) ?? [];
    list.push(row);
    byPid.set(row.pid, list);
  }

  for (const [pid, rows] of byPid) {
    if (ownedPids.has(pid)) continue;
    const cmd = rows[0]?.command ?? "listen";
    if (isDockerCommand(cmd)) continue;
    const ports = uniquePorts(rows, false).filter((p) => !dockerPorts.has(p));
    const loop = loopbackOnlyPorts(rows);
    if (loop.length) loopbackNotes.push(`${cmd}#${pid} loopback :${loop.join(",:")}`);
    if (!ports.length) continue;
    const label = `${cmd}:${ports[0]}`.slice(0, 64);
    web.push({
      label,
      url: lanUrl(hostIp, ports[0]),
      port: ports[0],
      ports,
      urls: ports.map((p) => lanUrl(hostIp, p)),
      status: "ok",
    });
  }

  if (input.caddy?.length) applyCaddy(web, input.caddy);

  const databases: DatabaseRecIn[] = [];
  if (input.mysql) databases.push(input.mysql);
  for (const p of input.postgres ?? []) databases.push(p);
  for (const f of input.sqlite ?? []) databases.push(sqliteRec(f));

  return {
    services: services.slice(0, 200),
    web: web.slice(0, 100),
    databases: databases.slice(0, 100),
    loopbackNotes,
  };
}

export const MAC_MINI_ITEM_ID = 51;
export const MAC_MINI_HOST = "macmini-m4";
export const MAC_MINI_IP = "10.50.0.102";
