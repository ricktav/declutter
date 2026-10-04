#!/usr/bin/env node
// Measure this machine's mounted volumes (df) and the biggest top-level
// directories of each (du), and post one storage.report for one device item.
// One volume per APFS container (mounts sharing diskN merge: label "A + B"); use is
// container-level (capacity minus available); on macOS "/" lists the Data volume's
// directories (/Users, /Applications, ...).
//   node scripts/storage-report-local.mjs --item 205            # this Mac is item 205
//   node scripts/storage-report-local.mjs --item 205 --dry      # print the report, post nothing
//   --base http://localhost:3001 (default)   --dirs 15 (top directories per volume)
//   --only /,/Volumes/T7                      (mount points to include; matches a container's first mount or any member mount; default: all local disks)
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
// Use is container-level: (blocks - available), so APFS volumes that share one
// container are not under-counted. One reported volume per APFS container
// (/dev/diskNsM mounts with the same diskN); other devices stay one volume per mount.
const lines = execFileSync("df", ["-kP"], { encoding: "utf8" }).trim().split("\n").slice(1);
const rows = [];
for (const line of lines) {
  const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/);
  if (!m) continue;
  const [, device, blocks, , avail, mountPoint] = m;
  const local = device.startsWith("/dev/") && !/^\/(System|private\/var\/vm|dev)/.test(mountPoint) && !mountPoint.startsWith("/System/Volumes");
  rows.push({ device, container: device.match(/^\/dev\/(disk\d+)s\d+/)?.[1] || null, mountPoint, local, capacityBytes: Number(blocks) * 1024, usedBytes: (Number(blocks) - Number(avail)) * 1024 });
}
const dataMount = rows.find((r) => r.mountPoint === "/System/Volumes/Data");
const byMount = (a, b) => (a.mountPoint === "/" ? -1 : b.mountPoint === "/" ? 1 : a.mountPoint.localeCompare(b.mountPoint));
const groups = new Map();
for (const r of rows.filter((r) => r.local || (only && only.includes(r.mountPoint))).sort(byMount)) {
  const key = r.container || r.mountPoint;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const volumes = [];
for (const [key, members] of groups) {
  if (only && !members.some((r) => only.includes(r.mountPoint))) continue;
  const first = members[0];
  const names = members.map((r) => path.basename(r.mountPoint)).filter(Boolean);
  volumes.push({
    device: first.container || first.device.replace(/^\/dev\//, ""),
    mountPoint: first.mountPoint,
    label: names.length ? names.join(" + ") : null,
    capacityBytes: first.capacityBytes,
    usedBytes: first.usedBytes,
    // du -x stops at APFS firmlinks: measure the Data volume of this container instead of the sealed system volume
    root: first.mountPoint === "/" && dataMount && dataMount.container === key ? dataMount.mountPoint : first.mountPoint,
  });
}
if (volumes.length === 0) { console.error("no local volumes found (use --only to name mount points)"); process.exit(1); }

function topDirs(root) {
  let names;
  try { names = readdirSync(root); } catch { return []; }
  const sizes = [];
  for (const name of names) {
    const p = path.join(root, name);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    if (name.startsWith(".") && name !== ".Trashes") continue;
    try {
      const out = execFileSync("du", ["-xsk", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const kb = Number(out.split("\t")[0]);
      if (Number.isFinite(kb)) sizes.push({ path: root === "/System/Volumes/Data" ? "/" + name : p, bytes: kb * 1024 });
    } catch { /* unreadable: skip */ }
  }
  return sizes.sort((a, b) => b.bytes - a.bytes).slice(0, topN);
}

for (const v of volumes) {
  process.stderr.write(`measuring ${v.root} …\n`);
  v.dirs = topDirs(v.root);
  delete v.root;
}
const report = { itemId, source: "local-script", volumes };
if (args.dry) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const headers = { "content-type": "application/json", ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}) };
const res = await fetch(`${base}/api/trpc/storage.report`, { method: "POST", headers, body: JSON.stringify({ json: report }) });
const body = await res.json();
if (!res.ok) { console.error(`storage.report failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`); process.exit(1); }
console.log(`reported ${body.result.data.json.volumes} volume(s), ${body.result.data.json.dirs} directories for item ${itemId} to ${base}`);
