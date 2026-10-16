#!/usr/bin/env node
// Pull Data Tracker GET /api/sources (type=file) into HomeBase storage.report.
// Tracker already has Machine → Disk → Volume. This import matches hosts by
// hostname (with a small override map for duplicates) and disks by serial,
// then model+size; unmatched disks become Things (or stay inferred).
// Volumes stay on the computer item so existing storage.report callers keep
// working. No biggest-folder data here: run storage-report-local.mjs on the
// Mini for externals + du.
// Dry unless --apply.
//   node scripts/storage-import-data-tracker.mjs
//   node scripts/storage-import-data-tracker.mjs --apply
//   node scripts/storage-import-data-tracker.mjs --file api/test/fixtures/data-tracker-sources.json
//   DATA_TRACKER_URL=http://10.50.0.142:3477 HOMEBASE_BASE=http://localhost:3001 \
//     node scripts/storage-import-data-tracker.mjs --apply
import "dotenv/config";
import { readFileSync } from "fs";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  args[key] = !next || next.startsWith("--") ? true : next;
}

const apply = args.apply === true && args.dry !== true;
const base = String(args.base || process.env.HOMEBASE_BASE || "http://localhost:3001").replace(/\/$/, "");
const tracker = String(args.url || process.env.DATA_TRACKER_URL || "http://10.50.0.142:3477").replace(/\/$/, "");
const file = typeof args.file === "string" ? args.file : null;

const headers = {
  "content-type": "application/json",
  ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}),
};

async function trpc(path, input) {
  const res = await fetch(`${base}/api/trpc/${path}`, { method: "POST", headers, body: JSON.stringify({ json: input }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  const data = body.result?.data;
  if (data && typeof data === "object" && "json" in data) return data.json;
  return data;
}

let sources;
if (file) {
  sources = JSON.parse(readFileSync(file, "utf8"));
} else {
  const url = `${tracker}/api/sources`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    console.error(`data-tracker fetch failed: cannot reach ${url} (${e?.cause?.code || e?.message || e})`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`data-tracker fetch failed: HTTP ${res.status} ${url}`);
    process.exit(1);
  }
  sources = await res.json();
}

const plan = await trpc("storage.importSources", { sources, dry: !apply });
const line = (h) => {
  const disks = h.disks.map((d) => `${d.diskKey}:${d.match}${d.itemId != null ? `#${d.itemId}` : ""}`).join(",") || "-";
  return `${h.host} → ${h.status}${h.itemId != null ? ` ${h.itemName}#${h.itemId}` : ""}${h.reason ? ` (${h.reason})` : ""} · ${h.volumes.length} vol · ${disks}`;
};
console.log(JSON.stringify({ dry: plan.dry, applied: plan.applied, skippedSources: plan.skippedSources, hosts: plan.hosts.map(line) }, null, 2));
if (!apply) console.error("dry run: pass --apply to write storage.report and disk links");
