#!/usr/bin/env -S node --experimental-strip-types
// Snapshot this machine onto a device Thing via services.report.
// Docker/OrbStack containers always (when docker works). On darwin or --mac,
// also LaunchAgents, leftover listen ports, Mini databases and Caddy.
// HOMEBASE_MAC=0 or --no-mac skips the Mac extras.
// Default is a dry run; pass --apply to write. Always merge-only: omitted
// keys stay (fleet web / databases are not replaced).
//   node --experimental-strip-types scripts/services-report-local.ts
//   node --experimental-strip-types scripts/services-report-local.ts --item 51 --apply --base http://10.50.0.102:3001
// Docker PATH includes ~/.orbstack/bin. Mac extras: scripts/services-report-mac.ts.
import "dotenv/config";
import { execFileSync } from "child_process";
import os from "os";
import { dockerPathEnv, enrichDockerContainers, parseDockerPs } from "./collectors/services/servicesDocker.ts";
import { machineHintFromItem, matchMachine } from "./collectors/services/servicesFleet.ts";
import { MAC_MINI_HOST, MAC_MINI_IP, MAC_MINI_ITEM_ID, macCollectorEnabled } from "./collectors/services/servicesMac.ts";
import { collectMacLive } from "./services-report-mac.ts";

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
const wantMac = macCollectorEnabled({
  platform: process.platform,
  env: process.env,
  flag: args.mac,
  noMac: args["no-mac"] === true,
});
const base = String(args.base || "http://localhost:3001").replace(/\/$/, "");
const itemArg = args.item === true || args.item == null ? null : Number(args.item);
const hostIpArg = typeof args["host-ip"] === "string" ? args["host-ip"] : undefined;

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
let containers: ReturnType<typeof enrichDockerContainers> = [];
let dockerError: string | null = null;
try {
  const text = execFileSync("docker", ["ps", "--size", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}\t{{.Size}}"], {
    encoding: "utf8",
    env,
  });
  function dockerJson(dargs: string[]): unknown {
    try {
      const raw = execFileSync("docker", dargs, { encoding: "utf8", env }).trim();
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
  containers = enrichDockerContainers(parsed, inspect, imageInspect, dfText);
} catch (e) {
  const err = e as { message?: string };
  dockerError = err.message || String(e);
}

const mac = wantMac
  ? await collectMacLive({
      hostIp: hostIpArg,
      dockerContainers: containers,
      databaseUrl: process.env.DATABASE_URL ?? null,
    })
  : null;

if (!containers.length && !mac?.services.length && !mac?.web.length && !mac?.databases.length) {
  console.error(dockerError ? `docker ps failed: ${dockerError} (PATH includes ~/.orbstack/bin)` : "no local containers, launchd jobs, listeners or databases found");
  process.exit(1);
}

type ItemRow = { id: number; name: string; attributes?: Record<string, string | number> | null };
const items = ((await trpc("items.listAll", { houseId: null })) as ItemRow[] | undefined) ?? [];
const machines = items.map(machineHintFromItem);

const hostName = os.hostname().replace(/\.local$/, "");
const pinned = itemArg != null && Number.isInteger(itemArg) ? machines.find((m) => m.id === itemArg) ?? { id: itemArg, name: `#${itemArg}` } : null;
const matched =
  pinned ??
  matchMachine({ host: hostName }, machines) ??
  matchMachine({ host: MAC_MINI_HOST }, machines) ??
  (wantMac ? { id: MAC_MINI_ITEM_ID, name: MAC_MINI_HOST } : null);

const plan = {
  dry: !apply,
  source: mac ? "local" : "local-docker",
  host: hostName,
  hostIp: mac?.hostIp ?? hostIpArg ?? (wantMac ? MAC_MINI_IP : undefined),
  containers: containers.length,
  containerNames: containers.map((c) => c.name),
  services: mac?.services.length ?? 0,
  web: mac?.web.length ?? 0,
  databases: mac?.databases.length ?? 0,
  commands: mac?.commands ?? [],
  loopback: mac?.loopbackNotes ?? [],
  items: {
    containers,
    services: mac?.services ?? [],
    web: mac?.web ?? [],
    databases: mac?.databases ?? [],
  },
  matched: matched ? { itemId: matched.id, name: matched.name } : null,
  dockerError,
};

if (!matched) {
  console.log(JSON.stringify(plan, null, 2));
  console.error(`unmatched docker host ${hostName} (pass --item)`);
  process.exit(1);
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2));
  console.error("dry run (pass --apply to write services.report; merge-only; omitted keys stay)");
  if (mac?.loopbackNotes.length) console.error(`loopback listeners (not sent): ${mac.loopbackNotes.join("; ")}`);
  process.exit(0);
}

const payload: Record<string, unknown> = {
  itemId: matched.id,
  source: plan.source,
  merge: true,
};
if (containers.length) payload.containers = containers;
if (mac?.services.length) payload.services = mac.services;
if (mac?.web.length) payload.web = mac.web;
if (mac?.databases.length) payload.databases = mac.databases;

const result = (await trpc("services.report", payload, "POST")) as {
  containers: number;
  services?: number;
  web?: number;
  databases?: number;
};
console.log(
  `${matched.name} (#${matched.id}): merged ${result.containers} container(s)` +
    (result.services != null ? `, ${result.services} service(s)` : "") +
    (result.web != null ? `, ${result.web} web` : "") +
    (result.databases != null ? `, ${result.databases} database(s)` : "") +
    " from local",
);
