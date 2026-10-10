#!/usr/bin/env -S node --experimental-strip-types
// Snapshot this machine's running Docker/OrbStack containers onto a device
// Thing via services.report. Default is a dry run; pass --apply to write.
// Merges into `containers` and does not send `web`, so fleet services stay.
//   node --experimental-strip-types scripts/services-report-local.ts
//   node --experimental-strip-types scripts/services-report-local.ts --item 51 --apply --base http://10.50.0.102:3001
// Docker PATH includes ~/.orbstack/bin.
import "dotenv/config";
import { execFileSync } from "child_process";
import os from "os";
import { dockerPathEnv, enrichDockerContainers, parseDockerPs } from "../api/lib/servicesDocker.ts";
import { matchMachine, type MachineHint } from "../api/lib/servicesFleet.ts";

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
const itemArg = args.item === true || args.item == null ? null : Number(args.item);

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

const env = dockerPathEnv();
let text: string;
try {
  text = execFileSync("docker", ["ps", "--size", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Size}}"], {
    encoding: "utf8",
    env,
  });
} catch (e) {
  const err = e as { message?: string };
  console.error(`docker ps failed: ${err.message || e} (PATH includes ~/.orbstack/bin)`);
  process.exit(1);
}

function dockerJson(args: string[]): unknown {
  try {
    const raw = execFileSync("docker", args, { encoding: "utf8", env }).trim();
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

const parsed = parseDockerPs(text);
const ids = execFileSync("docker", ["ps", "-q"], { encoding: "utf8", env }).trim().split(/\s+/).filter(Boolean);
const inspect = ids.length ? dockerJson(["inspect", "--size", ...ids]) ?? dockerJson(["inspect", ...ids]) : null;
const images = [...new Set(parsed.map((c) => c.image).filter(Boolean))] as string[];
const imageInspect = images.length ? dockerJson(["image", "inspect", ...images]) : null;
let dfText = "";
try {
  dfText = execFileSync("docker", ["system", "df", "-v"], { encoding: "utf8", env });
} catch {
  dfText = "";
}

const containers = enrichDockerContainers(parsed, inspect, imageInspect, dfText);
if (!containers.length) {
  console.error("no running docker containers found");
  process.exit(1);
}

type ItemRow = { id: number; name: string; attributes?: Record<string, string | number> | null };
const items = ((await trpc("items.listAll", { houseId: null })) as ItemRow[] | undefined) ?? [];
const machines: MachineHint[] = items.map((it) => ({
  id: it.id,
  name: it.name,
  hostname: it.attributes?.hostname != null ? String(it.attributes.hostname) : null,
  host: it.attributes?.host != null ? String(it.attributes.host) : null,
  ip: it.attributes?.ip != null ? String(it.attributes.ip) : it.attributes?.ip_address != null ? String(it.attributes.ip_address) : null,
}));

const hostName = os.hostname().replace(/\.local$/, "");
const pinned = itemArg != null && Number.isInteger(itemArg) ? machines.find((m) => m.id === itemArg) ?? { id: itemArg, name: `#${itemArg}` } : null;
const matched =
  pinned ??
  matchMachine({ host: hostName }, machines) ??
  matchMachine({ host: "macmini-m4" }, machines);

const plan = {
  dry: !apply,
  source: "local-docker",
  host: hostName,
  containers: containers.length,
  containerNames: containers.map((c) => c.name),
  items: containers,
  matched: matched ? { itemId: matched.id, name: matched.name } : null,
};

if (!matched) {
  console.log(JSON.stringify(plan, null, 2));
  console.error(`unmatched docker host ${hostName} (pass --item)`);
  process.exit(1);
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2));
  console.error("dry run (pass --apply to write services.report; web is not sent, fleet services stay)");
  process.exit(0);
}

const result = (await trpc(
  "services.report",
  { itemId: matched.id, source: "local-docker", merge: true, containers },
  "POST",
)) as { containers: number };
console.log(`${matched.name} (#${matched.id}): merged ${result.containers} container(s) from local docker`);
