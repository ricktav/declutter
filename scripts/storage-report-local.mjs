#!/usr/bin/env node
// Measure this machine's boot volume (df) and its biggest top-level directories
// (du), and post one storage.report for one device item.
// Default scope: the boot container only (the APFS container that holds "/" on
// macOS, the filesystem of "/" on Linux): on a Mac "/" (sealed system) plus
// /System/Volumes/Data (label "Data"), without VM, Preboot and Update. Everything else (/Volumes/*, simulator runtimes, disk
// images, Time Machine volumes, other containers) is reported only when named with
// --only, and an external drive is reported against its own item.
// One volume per APFS volume: each reports its own use (df "Used") and the capacity
// of its container (diskN), which it shares with the other volumes of that container;
// naming one mount with --only reports every volume of its container. Each volume
// lists its own directories: "/" none when Data is reported (du would only follow its
// firmlinks into Data), Data /Users, /Applications, ...
// (printed without the /System/Volumes/Data prefix).
//   node scripts/storage-report-local.mjs --item 205            # this Mac is item 205: its boot container
//   node scripts/storage-report-local.mjs --item 205 --dry      # print the report, post nothing
//   node scripts/storage-report-local.mjs --item <drive item id> --only /Volumes/T7   # an external drive (T7 and TM-T7 when they share a container), against its own item
//   --base http://localhost:3001 (default)   --dirs 15 (top directories per volume, 1-100)
//   --only /,/Volumes/T7   (mount points to report instead of the boot container; each brings the other volumes of its container)
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
// macOS: /dev/diskNsM mounts are APFS volumes of container diskN; each reports its own
// "Used" and the container's blocks as capacity. Linux and other devices: no container,
// use = blocks - available (reserved blocks count as used).
const darwin = process.platform === "darwin";
const lines = execFileSync("df", ["-kP"], { encoding: "utf8" }).trim().split("\n").slice(1);
const rows = [];
for (const line of lines) {
  const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/);
  if (!m) continue;
  const [, device, blocks, used, avail, mountPoint] = m;
  // the Data volume holds the user's files: the one /System mount we report
  const local = device.startsWith("/dev/") && (mountPoint === "/System/Volumes/Data" || !/^\/(System(\/|$)|private\/var\/vm|dev(\/|$))/.test(mountPoint));
  const container = darwin ? device.match(/^\/dev\/(disk\d+)s\d+/)?.[1] || null : null;
  rows.push({
    device: device.replace(/^\/dev\//, ""),
    container,
    mountPoint,
    local,
    capacityBytes: Number(blocks) * 1024,
    usedBytes: (container ? Number(used) : Number(blocks) - Number(avail)) * 1024,
  });
}
// a "container" whose mounts disagree on size is plain partitions of one disk, not APFS: no shared capacity
const sizes = new Map();
for (const r of rows) if (r.container) sizes.set(r.container, [...(sizes.get(r.container) ?? []), r.capacityBytes]);
for (const r of rows) if (r.container && new Set(sizes.get(r.container)).size > 1) r.container = null;

const byMount = (a, b) => (a.mountPoint === "/" ? -1 : b.mountPoint === "/" ? 1 : a.mountPoint.localeCompare(b.mountPoint));
const keyOf = (r) => r.container || r.mountPoint;
// default: the boot container; --only: the containers of the named mounts
const scope = new Set(only ? rows.filter((r) => only.includes(r.mountPoint)).map(keyOf) : rows.filter((r) => r.mountPoint === "/").map(keyOf));
const volumes = rows
  // a named mount always; its container's other volumes only when local (Data yes; VM, Preboot, Update, snapshots no)
  .filter((r) => scope.has(keyOf(r)) && (r.local || (only && only.includes(r.mountPoint))))
  .sort(byMount)
  .map((r) => ({
    device: r.device.slice(0, 128),
    container: r.container,
    mountPoint: r.mountPoint,
    label: path.basename(r.mountPoint).slice(0, 128) || null,
    capacityBytes: r.capacityBytes,
    usedBytes: Math.min(r.usedBytes, r.capacityBytes),
    // every volume measures its own root; "/" (sealed system) has few or no directories of its own, Data holds /Users, /Applications, ...
    root: r.mountPoint,
  }));
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

// On a Mac, du from "/" follows the firmlinks into the Data volume (/Users, /Applications)
// and counts /System/Volumes/Data under /System: every directory it finds is Data's or
// counted twice. When Data is in this report, "/" gets no directories; Data carries them.
const dataReported = volumes.some((v) => v.mountPoint === "/System/Volumes/Data");
for (const v of volumes) {
  if (v.mountPoint === "/" && dataReported) { v.dirs = []; delete v.root; continue; }
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
