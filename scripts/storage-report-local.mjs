#!/usr/bin/env node
// Measure this machine's physical disks (df, plus diskutil on macOS) and their
// biggest top-level directories (du), and post one storage.report for one
// computer item. Volumes stay on that item; HomeBase groups them onto disk
// Things by the `device` field (sda2 → sda, disk9s1 → disk9).
// Default: every local physical disk. Skip simulator runtimes, Time Machine
// snapshots, APFS system-internal volumes (VM, Preboot, Update, Recovery),
// tmpfs/overlay, and loop/snap devices. --boot restores the old boot-container
// only. --only names mount points (each brings the other volumes of its APFS
// container / disk).
// On the Mini this finds disk3 (internal), disk7 (T7, TM-T7) and disk9
// (ExtNVMe, NVMe, Time Machine — inventory "Ugreen NVME 1TB" #213, serial
// SNVS1000GB, attached to Mac mini M4 #51). Data Tracker only covers the boot disk.
// One volume per APFS volume: each reports its own use (df "Used") and the
// capacity of its container (diskN). "/" gets no directories when Data is in
// the report (du would follow firmlinks into Data).
//   node scripts/storage-report-local.mjs --item 51
//   node scripts/storage-report-local.mjs --item 51 --dry
//   node scripts/storage-report-local.mjs --item 51 --boot
//   node scripts/storage-report-local.mjs --item <drive> --only /Volumes/T7
//   --base http://localhost:3001 (default)   --dirs 15 (1-100)
// Starred fleet (SSH from the Mini): scripts/storage-report-starred.ts
// Reads APP_TOKEN from .env when the server has one. macOS and Linux.
import "dotenv/config";
import { execFileSync } from "child_process";
import { readdirSync, statSync } from "fs";
import path from "path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((p) => p.length));
const itemId = Number(args.item);
if (!Number.isInteger(itemId)) { console.error("usage: --item <device item id> [--base url] [--dirs n] [--only a,b] [--boot] [--dry]"); process.exit(2); }
const base = (args.base || process.env.HOMEBASE_BASE || "http://localhost:3001").replace(/\/$/, "");
const dirsArg = Number.parseInt(String(args.dirs ?? ""), 10);
const topN = Number.isNaN(dirsArg) ? 15 : Math.min(100, Math.max(1, dirsArg));
const only = args.only ? String(args.only).split(",") : null;
const bootOnly = !!args.boot && !only;

const SKIP_FS = new Set(["tmpfs", "devtmpfs", "overlay", "squashfs", "ramfs", "proc", "sysfs", "cgroup", "cgroup2", "nsfs", "autofs", "devfs", "efivarfs", "tracefs", "securityfs", "pstore", "bpf", "debugfs", "hugetlbfs", "mqueue", "fusectl", "rpc_pipefs", "binfmt_misc"]);

function skipMount(mp) {
  if (mp === "/" || mp === "/System/Volumes/Data") return false;
  if (/^\/(System(\/|$)|private\/var\/vm|dev(\/|$))/.test(mp)) return true;
  if (mp.includes("CoreSimulator")) return true;
  if (/com\.apple\.TimeMachine|\.timemachine|localsnapshots/i.test(mp)) return true;
  if (/^\/(proc|sys|run|snap)(\/|$)/.test(mp)) return true;
  return false;
}

// df -k: Filesystem [Type] 1024-blocks Used Available Capacity Mounted on
// macOS: /dev/diskNsM mounts are APFS volumes of container diskN; each reports
// its own "Used" and the container's blocks as capacity. Linux: no container,
// use = blocks - available (reserved blocks count as used).
const darwin = process.platform === "darwin";
const dfArgs = darwin ? ["-kP"] : ["-kPT"];
const lines = execFileSync("df", dfArgs, { encoding: "utf8" }).trim().split("\n").slice(1);
const rows = [];
for (const line of lines) {
  const m = darwin
    ? line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/)
    : line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/);
  if (!m) continue;
  const device = darwin ? m[1] : m[1];
  const fsType = darwin ? null : m[2];
  const blocks = Number(darwin ? m[2] : m[3]);
  const used = Number(darwin ? m[3] : m[4]);
  const avail = Number(darwin ? m[4] : m[5]);
  const mountPoint = darwin ? m[5] : m[6];
  if (fsType && SKIP_FS.has(fsType.toLowerCase())) continue;
  if (!device.startsWith("/dev/")) continue;
  if (/^\/dev\/loop/.test(device)) continue;
  if (skipMount(mountPoint)) continue;
  const container = darwin ? device.match(/^\/dev\/(disk\d+)s\d+/)?.[1] || null : null;
  rows.push({
    device: device.replace(/^\/dev\//, ""),
    container,
    fsType,
    mountPoint,
    local: true,
    capacityBytes: blocks * 1024,
    usedBytes: (container ? used : blocks - avail) * 1024,
  });
}

// On a Mac, keep volumes of physical disks (and the APFS containers they
// synthesise). Disk images, simulator runtimes and other virtual devices drop
// out. Linux already filtered to /dev and skipped loop/snap.
function darwinPhysicalAllow() {
  if (!darwin) return null;
  const identifiers = (blob) => {
    const ids = new Set();
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (typeof n.DeviceIdentifier === "string") ids.add(n.DeviceIdentifier);
      if (Array.isArray(n.Partitions)) n.Partitions.forEach(walk);
      if (Array.isArray(n.APFSVolumes)) n.APFSVolumes.forEach(walk);
      if (Array.isArray(n.APFSPhysicalStores)) n.APFSPhysicalStores.forEach(walk);
    };
    for (const n of blob.AllDisksAndPartitions ?? []) walk(n);
    for (const d of blob.AllDisks ?? []) if (typeof d === "string") ids.add(d);
    return ids;
  };
  const plistJson = (args) => {
    const xml = execFileSync("diskutil", args, { encoding: "utf8" });
    return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { encoding: "utf8", input: xml }));
  };
  try {
    const physical = identifiers(plistJson(["list", "-plist", "physical"]));
    if (physical.size === 0) return null;
    const allow = new Set(physical);
    try {
      const all = plistJson(["list", "-plist"]);
      for (const n of all.AllDisksAndPartitions ?? []) {
        const stores = n.APFSPhysicalStores;
        if (!Array.isArray(stores)) continue;
        const storeIds = stores.map((s) => s?.DeviceIdentifier).filter(Boolean);
        if (storeIds.some((id) => physical.has(id) || [...physical].some((p) => String(id).startsWith(p)))) {
          if (n.DeviceIdentifier) allow.add(n.DeviceIdentifier);
          for (const v of n.APFSVolumes ?? []) if (v?.DeviceIdentifier) allow.add(v.DeviceIdentifier);
        }
      }
    } catch { /* containers stay unknown: physical whole disks still match diskNsM */ }
    return allow;
  } catch {
    return null;
  }
}
const physicalAllow = darwinPhysicalAllow();
if (physicalAllow) {
  const keep = (dev) => {
    if (physicalAllow.has(dev)) return true;
    const whole = dev.match(/^(disk\d+)/)?.[1];
    return whole ? physicalAllow.has(whole) : false;
  };
  for (let i = rows.length - 1; i >= 0; i--) if (!keep(rows[i].device) && !keep(rows[i].container || "")) rows.splice(i, 1);
}

// a "container" whose mounts disagree on size is plain partitions of one disk, not APFS: no shared capacity
const sizes = new Map();
for (const r of rows) if (r.container) sizes.set(r.container, [...(sizes.get(r.container) ?? []), r.capacityBytes]);
for (const r of rows) if (r.container && new Set(sizes.get(r.container)).size > 1) r.container = null;

const byMount = (a, b) => (a.mountPoint === "/" ? -1 : b.mountPoint === "/" ? 1 : a.mountPoint.localeCompare(b.mountPoint));
const keyOf = (r) => r.container || r.device.replace(/s\d+$/, "") || r.mountPoint;
const picked = only
  ? rows.filter((r) => only.includes(r.mountPoint))
  : bootOnly
    ? rows.filter((r) => r.mountPoint === "/")
    : rows;
const scope = new Set(picked.map(keyOf));
const volumes = rows
  .filter((r) => scope.has(keyOf(r)) && (r.local || (only && only.includes(r.mountPoint))))
  .sort(byMount)
  .slice(0, 64)
  .map((r) => ({
    device: r.device.slice(0, 128),
    container: r.container,
    fsType: r.fsType,
    mountPoint: r.mountPoint,
    label: path.basename(r.mountPoint).slice(0, 128) || null,
    capacityBytes: r.capacityBytes,
    usedBytes: Math.min(r.usedBytes, r.capacityBytes),
    root: r.mountPoint,
  }));
if (volumes.length === 0) { console.error(only ? `no mounted volume matches --only ${only.join(",")}` : "no physical disks found"); process.exit(1); }

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
