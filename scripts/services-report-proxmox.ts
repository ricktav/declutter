#!/usr/bin/env -S node --experimental-strip-types
// Snapshot Proxmox VMs and LXC onto the hypervisor's HomeBase Thing.
// Default is a dry run; pass --apply to write. Sends web (GUI :8006 + guest HTTP).
//   node --experimental-strip-types scripts/services-report-proxmox.ts
//   node --experimental-strip-types scripts/services-report-proxmox.ts --ssh root@10.50.0.155 --apply
import "dotenv/config";
import { execFileSync } from "child_process";
import {
  applyPveGuestConfig,
  matchPveMachine,
  parseProxmoxInventory,
  proxmoxHostWeb,
  type ProxmoxGuest,
  type PveMachineHint,
} from "../api/lib/servicesProxmox.ts";

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
const sshTarget = typeof args.ssh === "string" ? args.ssh : "root@10.50.0.155";

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

function ssh(command: string[]): string {
  return execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshTarget, ...command], {
    encoding: "utf8",
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let resourcesJson: unknown;
let pctList: string | undefined;
let qmList: string | undefined;
try {
  const raw = ssh(["pvesh", "get", "/cluster/resources", "--output-format", "json"]);
  resourcesJson = JSON.parse(raw) as unknown;
} catch (e) {
  console.error(`pvesh /cluster/resources failed: ${errMsg(e)}`);
  resourcesJson = undefined;
}
if (resourcesJson == null) {
  try {
    pctList = ssh(["pct", "list"]);
  } catch (e) {
    console.error(`pct list failed: ${errMsg(e)}`);
  }
  try {
    qmList = ssh(["qm", "list"]);
  } catch (e) {
    console.error(`qm list failed: ${errMsg(e)}`);
  }
}

const listed = parseProxmoxInventory({ resourcesJson, pctList, qmList });
if (!listed.vms.length && !listed.lxc.length) {
  console.error("no VMs or LXC found on Proxmox (pvesh / pct list / qm list)");
  process.exit(1);
}

function fetchGuestConfig(kind: "qemu" | "lxc", guest: ProxmoxGuest): unknown {
  const node = guest.node || "pve";
  const path = `/nodes/${node}/${kind}/${guest.vmid}/config`;
  const raw = ssh(["pvesh", "get", path, "--output-format", "json"]);
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(`invalid JSON from ${path}: ${errMsg(e)}`);
  }
}

function enrichFromPvesh(guests: ProxmoxGuest[], kind: "qemu" | "lxc"): { guests: ProxmoxGuest[]; ok: number; failed: number } {
  let ok = 0;
  let failed = 0;
  const out = guests.map((g) => {
    const node = g.node || "pve";
    try {
      const cfg = fetchGuestConfig(kind, g);
      const next = applyPveGuestConfig(g, cfg, kind);
      ok += 1;
      return next;
    } catch (e) {
      console.error(`pvesh ${kind} ${g.vmid} on ${node}: ${errMsg(e)}`);
      failed += 1;
      return g;
    }
  });
  return { guests: out, ok, failed };
}

const vmCfg = enrichFromPvesh(listed.vms, "qemu");
const lxcCfg = enrichFromPvesh(listed.lxc, "lxc");
const vms = vmCfg.guests;
const lxc = lxcCfg.guests;
const configOk = vmCfg.ok + lxcCfg.ok;
const configFailed = vmCfg.failed + lxcCfg.failed;
if (configFailed && !configOk) {
  console.error(`config reads failed for all ${configFailed} guest(s)`);
  process.exit(1);
}
if (configFailed) {
  console.error(`config reads failed for ${configFailed} of ${configOk + configFailed} guest(s)`);
}

type ItemRow = { id: number; name: string; attributes?: Record<string, string | number> | null };
const items = ((await trpc("items.listAll", { houseId: null })) as ItemRow[] | undefined) ?? [];
const machines: PveMachineHint[] = items.map((it) => ({
  id: it.id,
  name: it.name,
  hostname: it.attributes?.hostname != null ? String(it.attributes.hostname) : null,
  host: it.attributes?.host != null ? String(it.attributes.host) : null,
  ip: it.attributes?.ip != null ? String(it.attributes.ip) : it.attributes?.ip_address != null ? String(it.attributes.ip_address) : null,
}));

const matched = matchPveMachine(machines);
const hostIp = matched?.ip ?? sshTarget.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1] ?? null;
const gui = proxmoxHostWeb(hostIp);
const web = [
  ...(gui ? [gui] : []),
  ...[...lxc, ...vms]
    .filter((g) => g.url)
    .map((g) => ({
      label: g.name,
      url: g.url!,
      ...(g.ports?.[0] != null ? { port: g.ports[0], ports: g.ports } : {}),
      ...(g.status ? { status: g.status } : {}),
    })),
];
const plan = {
  dry: !apply,
  source: "proxmox",
  ssh: sshTarget,
  via: resourcesJson != null ? "pvesh" : "pct/qm",
  vms: vms.length,
  lxc: lxc.length,
  web: web.length,
  vmNames: vms.map((g) => `${g.vmid} ${g.name} ${g.status}${g.ip ? ` ${g.ip}` : ""}${g.template ? " template" : ""}`),
  lxcNames: lxc.map((g) => `${g.vmid} ${g.name} ${g.status}${g.ip ? ` ${g.ip}` : ""}`),
  webLabels: web.map((w) => w.label),
  items: { vms, lxc, web },
  matched: matched ? { itemId: matched.id, name: matched.name } : null,
};

if (!matched) {
  console.log(JSON.stringify(plan, null, 2));
  console.error("unmatched Proxmox host (need hostname pve, IP 10.50.0.155, or name containing proxmox)");
  process.exit(1);
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2));
  console.error("dry run (pass --apply to write services.report)");
  process.exit(0);
}

const result = (await trpc(
  "services.report",
  { itemId: matched.id, source: "proxmox", vms, lxc, web },
  "POST",
)) as { vms: number; lxc: number; web: number };
console.log(`${matched.name} (#${matched.id}): ${result.vms} VM(s), ${result.lxc} LXC, ${result.web} web from ${sshTarget}`);
