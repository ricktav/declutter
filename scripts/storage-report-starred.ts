#!/usr/bin/env -S node --experimental-strip-types
// Fill biggest folders on every starred Storage machine. `du` has to run on
// that host: this host uses storage-report-local.mjs (diskutil + df + du);
// the others get an SSH of storage-measure-remote.sh (df + du, no Node).
// Dry unless --apply. From the Mini:
//   node --experimental-strip-types scripts/storage-report-starred.ts
//   node --experimental-strip-types scripts/storage-report-starred.ts --apply
//   node --experimental-strip-types scripts/storage-report-starred.ts --apply --item 211
//   --base http://127.0.0.1:3001   --dirs 15   --user ricktav   --timeout 600
// HOMEBASE_SSH_USER / HOMEBASE_BASE / APP_TOKEN as usual. A machine with no
// hostname or IP is skipped. Launchd: scripts/launchd/nl.homebase.storage-report-starred.plist
import "dotenv/config";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeIp } from "../api/lib/servicesFleet.ts";
import {
  parseMeasureTsv,
  planStarredDirReports,
  starredMachinesFromItems,
  type StarredDirPlan,
  type ThisHost,
} from "../api/lib/storageMeasure.ts";

const argv = process.argv.slice(2);
const args: Record<string, string | true> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  args[key] = !next || next.startsWith("--") ? true : next;
}

const apply = args.apply === true && args.dry !== true;
const base = String(args.base || process.env.HOMEBASE_BASE || "http://localhost:3001").replace(/\/$/, "");
const dirsArg = Number.parseInt(String(args.dirs ?? ""), 10);
const topN = Number.isNaN(dirsArg) ? 15 : Math.min(100, Math.max(1, dirsArg));
const itemArg = args.item === true || args.item == null ? null : Number(args.item);
const itemId = itemArg != null && Number.isInteger(itemArg) ? itemArg : undefined;
const sshUser = String(args.user || process.env.HOMEBASE_SSH_USER || os.userInfo().username);
const timeoutSec = Number.parseInt(String(args.timeout ?? process.env.HOMEBASE_STEP_TIMEOUT ?? ""), 10);
const timeoutMs = (Number.isNaN(timeoutSec) ? 600 : Math.max(30, timeoutSec)) * 1000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remoteScript = readFileSync(path.join(root, "scripts/storage-measure-remote.sh"), "utf8");
const localScript = path.join(root, "scripts/storage-report-local.mjs");

const headers: Record<string, string> = {
  "content-type": "application/json",
  ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}),
};

async function trpc(proc: string, input: unknown, method: "GET" | "POST"): Promise<unknown> {
  const u =
    method === "GET"
      ? `${base}/api/trpc/${proc}?input=${encodeURIComponent(JSON.stringify({ json: input ?? {} }))}`
      : `${base}/api/trpc/${proc}`;
  const res = await fetch(u, method === "GET" ? { headers } : { method: "POST", headers, body: JSON.stringify({ json: input }) });
  const body = (await res.json().catch(() => ({}))) as { result?: { data?: { json?: unknown } | unknown }; error?: { message?: string } };
  if (!res.ok) throw new Error(`${proc} HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  const data = body.result?.data;
  if (data && typeof data === "object" && "json" in data) return (data as { json: unknown }).json;
  return data;
}

function thisHost(): ThisHost {
  const ips: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      const ip = normalizeIp(info.address);
      if (ip) ips.push(ip);
    }
  }
  return { hostname: os.hostname(), ips };
}

function sshCandidates(host: string): string[] {
  if (normalizeIp(host)) return [host];
  const baseHost = host.replace(/\.local$/i, "");
  return baseHost === host ? [host] : [baseHost, host];
}

function sshOnce(user: string, target: string): ReturnType<typeof parseMeasureTsv> {
  const stdout = execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", `${user}@${target}`, "sh", "-s", "--", "--dirs", String(topN)],
    { encoding: "utf8", input: remoteScript, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] },
  );
  const volumes = parseMeasureTsv(stdout, topN);
  if (volumes.length === 0) throw new Error("no physical disks found");
  return volumes;
}

function sshMeasure(plan: StarredDirPlan): ReturnType<typeof parseMeasureTsv> {
  const host = plan.sshHost!;
  const user = plan.sshUser || sshUser;
  const targets = [
    ...sshCandidates(host),
    ...(host.includes(".") || normalizeIp(host) ? [] : [`${host}.local`]),
  ];
  let lastErr: Error | null = null;
  for (const target of [...new Set(targets)]) {
    try {
      return sshOnce(user, target);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("ssh failed");
}

function localMeasure(item: number): void {
  execFileSync(
    process.execPath,
    [localScript, "--item", String(item), "--base", base, "--dirs", String(topN)],
    { encoding: "utf8", stdio: "inherit", timeout: timeoutMs, env: process.env },
  );
}

type ItemRow = { id: number; name: string; attributes?: Record<string, string | number> | null };
const items = ((await trpc("items.listAll", { houseId: null }, "GET")) as ItemRow[] | undefined) ?? [];
const starred = starredMachinesFromItems(items);
if (starred.length === 0) {
  console.error("no starred machines (star them on Storage)");
  process.exit(1);
}
const plan = planStarredDirReports(starred, thisHost(), { sshUser, itemId });
if (plan.length === 0) {
  console.error(`item ${itemId} is not a starred machine`);
  process.exit(1);
}

const line = (p: StarredDirPlan) => {
  if (p.via === "local") return `${p.name}#${p.itemId} local`;
  if (p.via === "ssh") return `${p.name}#${p.itemId} ssh ${p.sshUser}@${p.sshHost}`;
  return `${p.name}#${p.itemId} skip (${p.reason})`;
};
console.log(JSON.stringify({ dry: !apply, dirs: topN, base, hosts: plan.map(line) }, null, 2));
if (!apply) {
  console.error("dry run: pass --apply to du each host and post storage.report");
  process.exit(0);
}

let fail = 0;
let ok = 0;
for (const p of plan) {
  if (p.via === "skip") {
    console.error(`skip ${p.name}#${p.itemId}: ${p.reason}`);
    continue;
  }
  try {
    if (p.via === "local") {
      localMeasure(p.itemId);
      ok++;
      continue;
    }
    console.error(`=== ${p.name}#${p.itemId} ssh ${p.sshUser}@${p.sshHost} ===`);
    const volumes = sshMeasure(p);
    const result = (await trpc(
      "storage.report",
      { itemId: p.itemId, source: "ssh-script", volumes },
      "POST",
    )) as { volumes?: number; dirs?: number };
    console.log(`reported ${result.volumes ?? volumes.length} volume(s), ${result.dirs ?? 0} directories for item ${p.itemId} to ${base}`);
    ok++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`FAILED ${p.name}#${p.itemId}: ${msg.slice(0, 400)}`);
    fail++;
  }
}
if (!ok || fail) {
  console.error(`storage-report-starred: ${ok} ok, ${fail} failed`);
  process.exit(1);
}
console.error("storage-report-starred: ok");
