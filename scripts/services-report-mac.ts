#!/usr/bin/env -S node --experimental-strip-types
// Snapshot this Mac's user LaunchAgents, leftover listen ports, Mini
// databases and Caddy routes onto a device Thing via services.report.
// Dry by default; merge-only. Called from services-report-local.ts on darwin
// (or --mac). Standalone:
//   node --experimental-strip-types scripts/services-report-mac.ts
//   node --experimental-strip-types scripts/services-report-mac.ts --item 51 --apply --base http://10.50.0.102:3001
// Commands: id -u; plutil -convert xml1 -o - -- <plist>; launchctl list;
// launchctl print gui/<uid>/<label> (LaunchAgents + prefix labels);
// ps -axo pid=,ppid=; lsof -nP -iTCP -sTCP:LISTEN;
// find <allowlist roots> -maxdepth 4 -name '*.db' 2>/dev/null;
// ipconfig getifaddr en0/en1; command -v caddy;
// caddy adapt --config <Caddyfile> --adapter caddyfile.
// MySQL size uses mysql2 + information_schema from DATABASE_URL (never printed).
// HOMEBASE_MAC=0 / --no-mac skips this collector.
import "dotenv/config";
import { execFileSync } from "child_process";
import { readdirSync, readFileSync, statSync } from "fs";
import os from "os";
import path from "path";
import {
  LAUNCHD_LABEL_RE,
  MAC_MINI_HOST,
  MAC_MINI_IP,
  MAC_MINI_ITEM_ID,
  assembleMacReport,
  keepLaunchdJob,
  keepSqlitePath,
  parseCaddyAdapt,
  parseCaddyfile,
  parseLaunchctlList,
  parseLaunchctlPrintDetails,
  parseLaunchdPlist,
  parseLsofListen,
  parseMysqlUrlPublic,
  parsePsPidPpid,
  postgresFromDocker,
  prefixLaunchdLabels,
  sqliteAllowRoots,
  macCollectorEnabled,
  type CaddyRoute,
  type LaunchdJob,
  type LaunchdRuntime,
  type ListenRow,
  type SqliteFile,
} from "./collectors/services/servicesMac.ts";
import type { DatabaseRecIn, ServiceRecIn, WebRecIn } from "../api/lib/services.ts";
import type { DockerContainer } from "./collectors/services/servicesDocker.ts";

const EXEC_MS = 8_000;
const FIND_BUDGET_MS = 8_000;
const FIND_EACH_MS = 3_000;

function run(cmd: string, args: string[], timeout = EXEC_MS, quietErr = false): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      stdio: quietErr ? ["ignore", "pipe", "ignore"] : undefined,
    });
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    if (typeof err.stdout === "string" && err.stdout) return err.stdout;
    return "";
  }
}

function tracked(commands: string[], cmd: string, args: string[], timeout = EXEC_MS, quietErr = false): string {
  commands.push(quietErr ? `${[cmd, ...args].join(" ")} 2>/dev/null` : [cmd, ...args].join(" "));
  return run(cmd, args, timeout, quietErr);
}

export type MacLiveInput = {
  hostIp?: string;
  home?: string;
  dockerContainers?: DockerContainer[];
  databaseUrl?: string | null;
};

export type MacLiveResult = {
  services: ServiceRecIn[];
  web: WebRecIn[];
  databases: DatabaseRecIn[];
  loopbackNotes: string[];
  commands: string[];
  hostIp: string;
};

const CADDY_CANDIDATES = (home: string, root: string): string[] => [
  path.join(home, "Caddyfile"),
  "/opt/homebrew/etc/caddy/Caddyfile",
  "/usr/local/etc/caddy/Caddyfile",
  path.join(root, "Caddyfile"),
  "/Volumes/T7/declutter/Caddyfile",
];

function detectHostIp(commands: string[], fallback: string): string {
  for (const iface of ["en0", "en1", "bridge100"]) {
    const ip = tracked(commands, "ipconfig", ["getifaddr", iface]).trim();
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) && !ip.startsWith("127.")) return ip;
  }
  return fallback;
}

function readPlist(file: string, commands: string[]): LaunchdJob | null {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (text.includes("<plist") || text.includes("<key>Label</key>") || /^\s*Label\s*=>/m.test(text)) {
    return parseLaunchdPlist(text, file);
  }
  text = tracked(commands, "plutil", ["-convert", "xml1", "-o", "-", "--", file]);
  return parseLaunchdPlist(text, file);
}

function collectJobs(home: string, commands: string[]): Array<LaunchdJob & LaunchdRuntime> {
  const uid = tracked(commands, "id", ["-u"]).trim() || String(os.userInfo().uid);
  const byLabel = new Map<string, LaunchdJob & LaunchdRuntime>();
  const dir = path.join(home, "Library/LaunchAgents");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".plist")).map((f) => path.join(dir, f));
  } catch {
    files = [];
  }
  for (const file of files) {
    const job = readPlist(file, commands);
    if (!job || !keepLaunchdJob(job)) continue;
    const printed = tracked(commands, "launchctl", ["print", `gui/${uid}/${job.label}`]);
    const extra = printed.trim() ? parseLaunchctlPrintDetails(printed, job.label) : null;
    byLabel.set(job.label, {
      ...job,
      ...extra,
      program: job.program || extra?.program,
      cwd: job.cwd || extra?.cwd,
      plistPath: job.plistPath || extra?.plistPath,
    });
  }
  const listed = parseLaunchctlList(tracked(commands, "launchctl", ["list"]));
  for (const label of prefixLaunchdLabels(listed)) {
    if (byLabel.has(label)) continue;
    const printed = tracked(commands, "launchctl", ["print", `gui/${uid}/${label}`]);
    const extra = printed.trim() ? parseLaunchctlPrintDetails(printed, label) : { label };
    if (!LAUNCHD_LABEL_RE.test(extra.label)) continue;
    byLabel.set(extra.label, extra);
  }
  return [...byLabel.values()];
}

function existsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function collectSqlite(home: string, commands: string[], extraRoots: string[] = []): SqliteFile[] {
  const roots = sqliteAllowRoots(home, extraRoots).filter(existsDir);
  const raw: string[] = [];
  const deadline = Date.now() + FIND_BUDGET_MS;
  for (const root of roots) {
    const left = deadline - Date.now();
    if (left < 200) break;
    const text = tracked(
      commands,
      "find",
      [root, "-maxdepth", "4", "-type", "f", "-name", "*.db"],
      Math.min(FIND_EACH_MS, left),
      true,
    );
    for (const line of text.split(/\r?\n/)) {
      const p = line.trim();
      if (p) raw.push(p);
    }
  }
  const seen = new Set<string>();
  const out: SqliteFile[] = [];
  for (const p of raw) {
    if (seen.has(p) || !keepSqlitePath(p, home, extraRoots).keep) continue;
    seen.add(p);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      out.push({ path: p, size: st.size });
    } catch {
      /* skip unreadable */
    }
    if (out.length >= 64) break;
  }
  return out;
}

function collectCaddy(home: string, jobs: LaunchdJob[], commands: string[]): CaddyRoute[] {
  const which = tracked(commands, "/bin/bash", ["-lc", "command -v caddy"]).trim().split(/\s+/)[0];
  const bin = which && !which.includes("not found") ? which : "";
  const fromJobs = jobs
    .flatMap((j) => [j.program, j.plistPath])
    .filter((p): p is string => Boolean(p && /caddy/i.test(p)));
  const paths = [...CADDY_CANDIDATES(home, process.cwd()), ...fromJobs.filter((p) => /Caddyfile/i.test(p))];
  let file = "";
  for (const p of paths) {
    try {
      if (statSync(p).isFile()) {
        file = p;
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!file) return [];
  if (bin) {
    const adapted = tracked(commands, bin, ["adapt", "--config", file, "--adapter", "caddyfile"]);
    if (adapted.trim().startsWith("{")) {
      try {
        const routes = parseCaddyAdapt(JSON.parse(adapted) as unknown);
        if (routes.length) return routes;
      } catch {
        /* fall through to text */
      }
    }
  }
  try {
    return parseCaddyfile(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

async function mysqlFromEnv(url: string | null | undefined): Promise<DatabaseRecIn | null> {
  const pub = parseMysqlUrlPublic(url ?? "");
  if (!pub) return null;
  const rec: DatabaseRecIn = {
    name: pub.database,
    engine: "mysql",
    target: pub.port ? `${pub.host}:${pub.port}` : pub.host,
    status: "warn",
    detail: "HomeBase DATABASE_URL",
    checked: new Date().toISOString().slice(0, 10),
  };
  if (pub.port) rec.port = pub.port;
  if (!url) return rec;
  try {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({ uri: url, connectTimeout: 4000 });
    try {
      const [rows] = (await conn.query(
        "SELECT SUM(data_length + index_length) AS size FROM information_schema.tables WHERE table_schema = ?",
        [pub.database],
      )) as unknown as [Array<{ size?: number | string | null }>];
      const size = Number(rows?.[0]?.size);
      if (Number.isFinite(size) && size > 0) rec.size = size;
      rec.status = "ok";
    } finally {
      await conn.end();
    }
  } catch {
    rec.status = "warn";
    rec.detail = "HomeBase MySQL (size unavailable)";
  }
  return rec;
}

export async function collectMacLive(input: MacLiveInput = {}): Promise<MacLiveResult> {
  const commands: string[] = [];
  const home = input.home || os.homedir();
  const hostIp = input.hostIp || detectHostIp(commands, MAC_MINI_IP);
  const jobs = collectJobs(home, commands);
  const ps = tracked(commands, "ps", ["-axo", "pid=,ppid="]);
  const lsof = tracked(commands, "lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  const listeners: ListenRow[] = parseLsofListen(lsof);
  const children = parsePsPidPpid(ps);
  const dockerPorts = (input.dockerContainers ?? []).flatMap((c) => [...(c.ports ?? []), ...(c.port != null ? [c.port] : [])]);
  const postgres = postgresFromDocker(input.dockerContainers ?? []);
  const extraRoots = jobs.map((j) => j.cwd).filter((p): p is string => Boolean(p));
  const sqlite = collectSqlite(home, commands, extraRoots);
  const caddy = collectCaddy(home, jobs, commands);
  const mysql = await mysqlFromEnv(input.databaseUrl ?? process.env.DATABASE_URL ?? null);
  const denyExtra = String(process.env.HOMEBASE_MAC_LISTEN_DENY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const assembled = assembleMacReport({
    jobs,
    listeners,
    children,
    hostIp,
    dockerPorts,
    sqlite,
    postgres,
    mysql,
    caddy,
    listenDeny: denyExtra,
  });
  return { ...assembled, commands, hostIp };
}

function isMain(): boolean {
  const here = process.argv[1] ?? "";
  return /(^|\/)services-report-mac\.ts$/.test(here);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    args[key] = !next || next.startsWith("--") ? true : next;
  }
  if (
    !macCollectorEnabled({
      platform: process.platform,
      env: process.env,
      flag: args.mac,
      noMac: args["no-mac"] === true,
    })
  ) {
    console.error("mac collector disabled (HOMEBASE_MAC=0 or --no-mac)");
    process.exit(0);
  }
  const apply = args.apply === true && args.dry !== true;
  const base = String(args.base || "http://localhost:3001").replace(/\/$/, "");
  const itemArg = args.item === true || args.item == null ? null : Number(args.item);
  const hostIpArg = typeof args["host-ip"] === "string" ? args["host-ip"] : undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}),
  };
  const mac = await collectMacLive({ hostIp: hostIpArg, databaseUrl: process.env.DATABASE_URL ?? null });
  const plan = {
    dry: !apply,
    source: "local",
    host: os.hostname().replace(/\.local$/, ""),
    hostIp: mac.hostIp,
    commands: mac.commands,
    loopback: mac.loopbackNotes,
    services: mac.services.length,
    web: mac.web.length,
    databases: mac.databases.length,
    items: { services: mac.services, web: mac.web, databases: mac.databases },
    matched: itemArg != null && Number.isInteger(itemArg) ? { itemId: itemArg } : { itemId: MAC_MINI_ITEM_ID, name: MAC_MINI_HOST },
  };
  if (!apply) {
    console.log(JSON.stringify(plan, null, 2));
    console.error("dry run (pass --apply to write services.report; merge-only)");
    if (mac.loopbackNotes.length) console.error(`loopback listeners (not sent): ${mac.loopbackNotes.join("; ")}`);
    process.exit(0);
  }
  const itemId = plan.matched.itemId;
  const body = {
    itemId,
    source: "local",
    merge: true,
    ...(mac.services.length ? { services: mac.services } : {}),
    ...(mac.web.length ? { web: mac.web } : {}),
    ...(mac.databases.length ? { databases: mac.databases } : {}),
  };
  const u = `${base}/api/trpc/services.report`;
  const res = await fetch(u, { method: "POST", headers, body: JSON.stringify({ json: body }) });
  const json = (await res.json().catch(() => ({}))) as { result?: { data?: { json?: unknown } } };
  if (!res.ok) throw new Error(`services.report HTTP ${res.status}`);
  console.log(JSON.stringify(json.result?.data?.json ?? json, null, 2));
}
