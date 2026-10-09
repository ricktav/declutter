#!/usr/bin/env -S node --experimental-strip-types
// Import a daily claudemux fleet snapshot into Systems without making the view
// fetch that page. Default is a dry run (nothing written); pass --apply to post.
//   node --experimental-strip-types scripts/services-report-fleet.ts
//   node --experimental-strip-types scripts/services-report-fleet.ts --url http://10.50.0.10/claudemux-fleet.html
//   node --experimental-strip-types scripts/services-report-fleet.ts --file ./fleet.html
//   node --experimental-strip-types scripts/services-report-fleet.ts --apply --base http://10.50.0.102:3001
// Reads APP_TOKEN from .env when the server has one.
import "dotenv/config";
import { readFileSync } from "fs";
import { matchMachine, parseFleetDocumentWithMeta, type MachineHint } from "../api/lib/servicesFleet.ts";

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
const base = String(args.base || "http://localhost:3001").replace(/\/$/, "");
const file = typeof args.file === "string" ? args.file : null;
const url =
  args.url === true || (!args.url && !file)
    ? "http://10.50.0.10/claudemux-fleet.html"
    : typeof args.url === "string"
      ? args.url
      : null;

const headers: Record<string, string> = {
  "content-type": "application/json",
  ...(process.env.APP_TOKEN ? { authorization: `Bearer ${process.env.APP_TOKEN}` } : {}),
};

async function trpc(path: string, input: unknown, method: "GET" | "POST" = "GET"): Promise<unknown> {
  const u =
    method === "GET"
      ? `${base}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input ?? {} }))}`
      : `${base}/api/trpc/${path}`;
  const res = await fetch(u, method === "GET" ? { headers } : { method: "POST", headers, body: JSON.stringify({ json: input }) });
  const body = (await res.json().catch(() => ({}))) as {
    result?: { data?: { json?: unknown } | unknown };
  };
  if (!res.ok) throw new Error(`${path} HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  const data = body.result?.data;
  if (data && typeof data === "object" && "json" in data) return (data as { json: unknown }).json;
  return data;
}

let text: string;
if (file) {
  text = readFileSync(file, "utf8");
} else {
  const res = await fetch(url!, { headers: { accept: "text/html, application/json;q=0.9, */*;q=0.8" } });
  if (!res.ok) {
    console.error(`fleet fetch failed: HTTP ${res.status} ${url}`);
    process.exit(1);
  }
  text = await res.text();
}

const { hosts, skippedUnreachable } = parseFleetDocumentWithMeta(text);
if (hosts.length === 0) {
  console.error("no reachable hosts with containers or services found (need section.host + tr.pdrow / services-table).");
  process.exit(1);
}

type ItemRow = {
  id: number;
  name: string;
  attributes?: Record<string, string | number> | null;
};
const items = ((await trpc("items.listAll", { houseId: null })) as ItemRow[] | undefined) ?? [];
const machines: MachineHint[] = items.map((it) => ({
  id: it.id,
  name: it.name,
  hostname: it.attributes?.hostname != null ? String(it.attributes.hostname) : null,
  host: it.attributes?.host != null ? String(it.attributes.host) : null,
  ip: it.attributes?.ip != null ? String(it.attributes.ip) : it.attributes?.ip_address != null ? String(it.attributes.ip_address) : null,
}));

const matched: Array<{
  itemId: number;
  name: string;
  host: string;
  ip: string | null;
  match: "hostname" | "ip";
  containers: (typeof hosts)[0]["containers"];
  web: (typeof hosts)[0]["web"];
}> = [];
const unmatched: Array<{ host: string; ip: string | null; containers: number; web: number }> = [];

for (const h of hosts) {
  const m = matchMachine({ host: h.host, ip: h.ip }, machines);
  if (!m) {
    unmatched.push({ host: h.host, ip: h.ip ?? null, containers: h.containers.length, web: h.web.length });
    continue;
  }
  const hostNorm = h.host.trim().toLowerCase().replace(/\.local$/, "");
  const hostKeys = [m.hostname, m.host, m.name].filter(Boolean).map((x) => String(x).trim().toLowerCase().replace(/\.local$/, ""));
  const byHost = hostKeys.some((k) => k.replace(/[^a-z0-9]+/g, "") === hostNorm.replace(/[^a-z0-9]+/g, ""));
  matched.push({
    itemId: m.id,
    name: m.name,
    host: h.host,
    ip: h.ip ?? null,
    match: byHost ? "hostname" : "ip",
    containers: h.containers,
    web: h.web,
  });
}

const plan = {
  dry: !apply,
  source: url ?? file,
  matched: matched.map((row) => ({
    itemId: row.itemId,
    name: row.name,
    host: row.host,
    ip: row.ip,
    match: row.match,
    containers: row.containers.length,
    web: row.web.length,
    containerNames: row.containers.map((c) => c.name),
    serviceLabels: row.web.map((w) => w.label),
  })),
  unmatched,
  skippedUnreachable,
};

if (!apply) {
  console.log(JSON.stringify(plan, null, 2));
  console.error("dry run (pass --apply to write services.report)");
  process.exit(0);
}

let ok = 0;
for (const row of matched) {
  const report = {
    itemId: row.itemId,
    source: "fleet",
    containers: row.containers,
    web: row.web,
  };
  await trpc("services.report", report, "POST");
  ok += 1;
  console.log(`${row.name} (#${row.itemId}): ${row.containers.length} container(s), ${row.web.length} service(s) from ${row.host}`);
}
if (unmatched.length) console.error(`unmatched hosts: ${unmatched.map((u) => u.host).join(", ")}`);
if (skippedUnreachable.length) console.error(`skipped unreachable: ${skippedUnreachable.join(", ")}`);
console.log(`reported ${ok} machine(s) to ${base}`);
