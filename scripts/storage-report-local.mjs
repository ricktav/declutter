#!/usr/bin/env node
// Measure this machine's boot volume (df) and its biggest top-level directories
// (du), and post one storage.report for one device item.
// Default scope: the boot container only (the APFS container that holds "/" on
// macOS, the filesystem of "/" on Linux). Everything else (/Volumes/*, simulator
// runtimes, disk images, Time Machine volumes, other containers) is reported only
// when named with --only, and an external drive is reported against its own item.
// One volume per APFS container (mounts sharing diskN merge: label "A + B"); use is
// container-level (capacity minus available); on macOS "/" lists the Data volume's
// directories (/Users, /Applications, ...).
//   node scripts/storage-report-local.mjs --item 205            # this Mac is item 205: its boot container
//   node scripts/storage-report-local.mjs --item 205 --dry      # print the report, post nothing
//   node scripts/storage-report-local.mjs --item <drive item id> --only /Volumes/T7   # an external drive, against its own item
//   --base http://localhost:3001 (default)   --dirs 15 (top directories per volume, 1-100)
//   --only /,/Volumes/T7   (mount points to report instead of the boot container; matches a container's chosen mount or any member mount)
// Reads APP_TOKEN from .env when the server has one. macOS and Linux (df -kP, du -xsk).
import "dotenv/config";
import { execFileSync } from "child_process";
import { readdirSync, statSync } from "fs";
import path from "path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((p) => p.length));
const itemId = Number(args.item);
if (!Number.isInteger(itemId)) { console.error("usage: --item <device item id> [--base url] [--dirs n] [--only a,b] [--dry]"); process.exit(2); }
const base = (args.base || "http://localhost:3001").replace(/\/$/, "");
const dirsArg = Number.parseInt(String(args.dirs ?? ""), 10);
const topN = Number.isNaN(dirsArg) ? 15 : Math.min(100, Math.max(1, dirsArg));
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
  const local = device.startsWith("/dev/") && !/^\/(System(\/|$)|private\/var\/vm|dev(\/|$))/.test(mountPoint);
  rows.push({ device, container: device.match(/^\/dev\/(disk\d+)s\d+/)?.[1] || null, mountPoint, local, capacityBytes: Number(blocks) * 1024, usedBytes: (Number(blocks) - Number(avail)) * 1024 });
}
const dataMount = rows.find((r) => r.mountPoint === "/System/Volumes/Data");
const byMount = (a, b) => (a.mountPoint === "/" ? -1 : b.mountPoint === "/" ? 1 : a.mountPoint.localeCompare(b.mountPoint));
const rootRow = rows.find((r) => r.mountPoint === "/");
const rootKey = rootRow ? rootRow.container || rootRow.mountPoint : null;
const groups = new Map();
for (const r of rows.filter((r) => r.local || (only && only.includes(r.mountPoint))).sort(byMount)) {
  const key = r.container || r.mountPoint;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const volumes = [];
for (const [key, members] of groups) {
  // default: the boot container only; --only replaces it with the named mounts
  if (only ? !members.some((r) => only.includes(r.mountPoint)) : key !== rootKey) continue;
  const first = members[0];
  const names = members.map((r) => path.basename(r.mountPoint)).filter(Boolean);
  volumes.push({
    device: (first.container || first.device.replace(/^\/dev\//, "")).slice(0, 128),
    mountPoint: first.mountPoint,
    label: names.length ? names.join(" + ").slice(0, 128) : null,
    capacityBytes: first.capacityBytes,
    usedBytes: first.usedBytes,
    // du -x stops at APFS firmlinks: measure the Data volume of this container instead of the sealed system volume
    root: first.mountPoint === "/" && dataMount && dataMount.container === key ? dataMount.mountPoint : first.mountPoint,
  });
}
if (volumes.length === 0) { console.error(only ? `no mounted volume matches --only ${only.join(",")}` : "no boot volume found (use --only to name mount points)"); process.exit(1); }

function topDirs(root) {
  let names;
  try { names = readdirSync(root); } catch { return []; }
  const sizes = [];
  for (const name of names) {
    const p = path.join(root, name);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    if (name.startsWith(".") && name !== ".Trashes") continue;
    let out;
    try {
      out = execFileSync("du", ["-xsk", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      // du exits non-zero when some entries are unreadable but still prints the total it could measure
      out = typeof e?.stdout === "string" ? e.stdout : "";
    }
    const kb = Number.parseInt(out.split("\t")[0], 10);
    if (Number.isFinite(kb)) sizes.push({ path: root === "/System/Volumes/Data" ? "/" + name : p, bytes: kb * 1024 });
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
let res, body;
try {
  res = await fetch(`${base}/api/trpc/storage.report`, { method: "POST", headers, body: JSON.stringify({ json: report }) });
} catch (e) {
  console.error(`storage.report failed: cannot reach ${base} (${e?.cause?.code || e?.message || e})`);
  process.exit(1);
}
try {
  body = await res.json();
} catch {
  console.error(`storage.report failed: HTTP ${res.status}, response is not JSON`);
  process.exit(1);
}
if (!res.ok) { console.error(`storage.report failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`); process.exit(1); }
console.log(`reported ${body.result.data.json.volumes} volume(s), ${body.result.data.json.dirs} directories for item ${itemId} to ${base}`);
