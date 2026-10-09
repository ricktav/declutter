#!/usr/bin/env node
// Snapshot this machine's running Docker containers (and published ports) onto
// one device Thing via services.report. Systems reads the `containers` attribute.
//   node scripts/services-report-local.mjs --item 205
//   node scripts/services-report-local.mjs --item 205 --dry
//   --base http://localhost:3001 (default)
// Reads APP_TOKEN from .env when the server has one. Needs `docker`.
import "dotenv/config";
import { execFileSync } from "child_process";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((p) => p.length),
);
const itemId = Number(args.item);
if (!Number.isInteger(itemId)) {
  console.error("usage: --item <device item id> [--base url] [--dry]");
  process.exit(2);
}
const base = (args.base || "http://localhost:3001").replace(/\/$/, "");

let lines;
try {
  lines = execFileSync("docker", ["ps", "--format", "{{json .}}"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
} catch (e) {
  console.error(`docker ps failed: ${e?.message || e}`);
  process.exit(1);
}

function portOf(ports) {
  const m = String(ports ?? "").match(/:(\d{2,5})->/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

const containers = lines.map((line) => {
  const o = JSON.parse(line);
  const name = String(o.Names ?? o.names ?? "").replace(/^\//, "").split(",")[0].trim();
  const rec = { name: name || String(o.ID ?? o.Id ?? "").slice(0, 12) };
  const status = String(o.State ?? o.Status ?? "").trim();
  const image = String(o.Image ?? "").trim();
  const port = portOf(o.Ports);
  if (status) rec.status = status.slice(0, 32);
  if (image) rec.image = image.slice(0, 128);
  if (port) rec.port = port;
  return rec;
}).filter((c) => c.name);

const report = { itemId, source: "local-docker", containers };
if (args.dry) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const headers = { "content-type": "application/json", ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}) };
let res, body;
try {
  res = await fetch(`${base}/api/trpc/services.report`, { method: "POST", headers, body: JSON.stringify({ json: report }) });
} catch (e) {
  console.error(`services.report failed: cannot reach ${base} (${e?.cause?.code || e?.message || e})`);
  process.exit(1);
}
try {
  body = await res.json();
} catch {
  console.error(`services.report failed: HTTP ${res.status}, response is not JSON`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`services.report failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`reported ${body.result.data.json.containers} container(s) for item ${itemId} to ${base}`);
