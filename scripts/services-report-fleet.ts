#!/usr/bin/env -S node --experimental-strip-types
// Import a daily claudemux (or similar) fleet snapshot into Systems without
// making the view fetch that page. Matches hostnames / IPs to machine Things
// and posts services.report per host.
//   node --experimental-strip-types scripts/services-report-fleet.ts --dry
//   node --experimental-strip-types scripts/services-report-fleet.ts --url http://10.50.0.10/claudemux-fleet.html
//   node --experimental-strip-types scripts/services-report-fleet.ts --file ./fleet.html --dry
//   --base http://localhost:3001 (default)
// Reads APP_TOKEN from .env when the server has one.
import "dotenv/config";
import { readFileSync } from "fs";
import { matchMachine, parseFleetDocument, type MachineHint } from "../api/lib/servicesFleet.ts";

const argv = process.argv.slice(2);
const args: Record<string, string | true> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  args[key] = !next || next.startsWith("--") ? true : next;
}

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

const hosts = parseFleetDocument(text);
if (hosts.length === 0) {
  console.error("no hosts with containers/node/web found in the fleet document (JSON blob or host/container table).");
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

const plan: Array<{
  itemId: number;
  name: string;
  host: string;
  containers: typeof hosts[0]["containers"];
  node?: typeof hosts[0]["node"];
  web?: typeof hosts[0]["web"];
}> = [];
const unmatched: string[] = [];
for (const h of hosts) {
  const m = matchMachine(h.host, machines);
  if (!m) {
    unmatched.push(h.host);
    continue;
  }
  plan.push({
    itemId: m.id,
    name: m.name,
    host: h.host,
    containers: h.containers,
    node: h.node.length ? h.node : undefined,
    web: h.web.length ? h.web : undefined,
  });
}

if (args.dry) {
  console.log(JSON.stringify({ url: url ?? file, matched: plan, unmatched }, null, 2));
  process.exit(0);
}

let ok = 0;
for (const row of plan) {
  const report = {
    itemId: row.itemId,
    source: "fleet",
    containers: row.containers,
    ...(row.node ? { node: row.node } : {}),
    ...(row.web ? { web: row.web } : {}),
  };
  await trpc("services.report", report, "POST");
  ok += 1;
  console.log(`${row.name} (#${row.itemId}): ${row.containers.length} container(s) from ${row.host}`);
}
if (unmatched.length) console.error(`unmatched hosts: ${unmatched.join(", ")}`);
console.log(`reported ${ok} machine(s) to ${base}`);
