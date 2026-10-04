#!/usr/bin/env node
// Measure this machine's mounted volumes (df) and the biggest top-level
// directories of each (du), and post one storage.report for one device item.
//   node scripts/storage-report-local.mjs --item 205            # this Mac is item 205
//   node scripts/storage-report-local.mjs --item 205 --dry      # print the report, post nothing
//   --base http://localhost:3001 (default)   --dirs 15 (top directories per volume)
//   --only /,/Volumes/T7                      (mount points to include; default: all local disks)
// Reads APP_TOKEN from .env when the server has one. macOS and Linux (df -k, du -xsk).
import "dotenv/config";
import { execFileSync } from "child_process";
import { readdirSync, statSync } from "fs";
import path from "path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((p) => p.length));
const itemId = Number(args.item);
if (!Number.isInteger(itemId)) { console.error("usage: --item <device item id> [--base url] [--dirs n] [--only a,b] [--dry]"); process.exit(2); }
const base = (args.base || "http://localhost:3001").replace(/\/$/, "");
const topN = Number(args.dirs || 15);
const only = args.only ? String(args.only).split(",") : null;

// df -k: Filesystem 1024-blocks Used Available Capacity [iused ifree %iused] Mounted on
const lines = execFileSync("df", ["-kP"], { encoding: "utf8" }).trim().split("\n").slice(1);
const volumes = [];
for (const line of lines) {
  const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/);
  if (!m) continue;
  const [, device, blocks, used, , mountPoint] = m;
  const local = device.startsWith("/dev/") && !/^\/(System|private\/var\/vm|dev)/.test(mountPoint) && !mountPoint.startsWith("/System/Volumes");
  if (!local && !only) continue;
  if (only && !only.includes(mountPoint)) continue;
  volumes.push({ device: device.replace(/^\/dev\//, ""), mountPoint, capacityBytes: Number(blocks) * 1024, usedBytes: Number(used) * 1024 });
}
if (volumes.length === 0) { console.error("no local volumes found (use --only to name mount points)"); process.exit(1); }

function topDirs(mountPoint) {
  let names;
  try { names = readdirSync(mountPoint); } catch { return []; }
  const sizes = [];
  for (const name of names) {
    const p = path.join(mountPoint, name);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    if (name.startsWith(".") && name !== ".Trashes") continue;
    try {
      const out = execFileSync("du", ["-xsk", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const kb = Number(out.split("\t")[0]);
      if (Number.isFinite(kb)) sizes.push({ path: p, bytes: kb * 1024 });
    } catch { /* unreadable: skip */ }
  }
  return sizes.sort((a, b) => b.bytes - a.bytes).slice(0, topN);
}

for (const v of volumes) {
  process.stderr.write(`measuring ${v.mountPoint} …\n`);
  v.dirs = topDirs(v.mountPoint);
  v.label = path.basename(v.mountPoint) || null;
}
const report = { itemId, source: "local-script", volumes };
if (args.dry) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const headers = { "content-type": "application/json", ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}) };
const res = await fetch(`${base}/api/trpc/storage.report`, { method: "POST", headers, body: JSON.stringify({ json: report }) });
const body = await res.json();
if (!res.ok) { console.error(`storage.report failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`); process.exit(1); }
console.log(`reported ${body.result.data.json.volumes} volume(s), ${body.result.data.json.dirs} directories for item ${itemId} to ${base}`);
