#!/usr/bin/env -S node --experimental-strip-types
// Import Claude Code / Grok / Hermes / OpenClaw project rows onto machine Things.
// Default is a dry run; pass --apply to write. Merges into `projects` only.
//   node --experimental-strip-types scripts/services-report-projects.ts
//   node --experimental-strip-types scripts/services-report-projects.ts --url http://10.50.0.10/projects/
//   node --experimental-strip-types scripts/services-report-projects.ts --file ./projects.html --apply
import "dotenv/config";
import { readFileSync } from "fs";
import { matchMachine, type MachineHint } from "../api/lib/servicesFleet.ts";
import { parseProjectsDocument } from "../api/lib/servicesProjects.ts";

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
    ? "http://10.50.0.10/projects/"
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
  const body = (await res.json().catch(() => ({}))) as { result?: { data?: { json?: unknown } | unknown } };
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
    console.error(`projects fetch failed: HTTP ${res.status} ${url}`);
    process.exit(1);
  }
  text = await res.text();
}

const hosts = parseProjectsDocument(text);
if (hosts.length === 0) {
  console.error("no hosts with Claude Code / agent projects found.");
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
  projects: (typeof hosts)[0]["projects"];
}> = [];
const unmatched: Array<{ host: string; projects: number }> = [];

for (const h of hosts) {
  const m = matchMachine({ host: h.host, ip: h.ip }, machines);
  if (!m) {
    unmatched.push({ host: h.host, projects: h.projects.length });
    continue;
  }
  matched.push({ itemId: m.id, name: m.name, host: h.host, projects: h.projects });
}

const plan = {
  dry: !apply,
  source: url ?? file,
  matched: matched.map((row) => ({
    itemId: row.itemId,
    name: row.name,
    host: row.host,
    projects: row.projects.length,
    names: row.projects.map((p) => p.name),
  })),
  unmatched,
};

if (!apply) {
  console.log(JSON.stringify(plan, null, 2));
  console.error("dry run (pass --apply to write services.report)");
  process.exit(0);
}

let ok = 0;
for (const row of matched) {
  await trpc(
    "services.report",
    { itemId: row.itemId, source: "projects", merge: true, projects: row.projects },
    "POST",
  );
  ok += 1;
  console.log(`${row.name} (#${row.itemId}): ${row.projects.length} project(s) from ${row.host}`);
}
if (unmatched.length) console.error(`unmatched hosts: ${unmatched.map((u) => u.host).join(", ")}`);
console.log(`reported ${ok} machine(s) to ${base}`);
