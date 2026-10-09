#!/usr/bin/env -S node --experimental-strip-types
// Snapshot Proxmox VMs and LXC onto the hypervisor's HomeBase Thing.
// Default is a dry run; pass --apply to write. Does not send containers/web.
//   node --experimental-strip-types scripts/services-report-proxmox.ts
//   node --experimental-strip-types scripts/services-report-proxmox.ts --ssh root@10.50.0.155 --apply
import "dotenv/config";
import { execFileSync } from "child_process";
import { matchPveMachine, parseProxmoxInventory, type PveMachineHint } from "../api/lib/servicesProxmox.ts";

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

let resourcesJson: unknown;
let pctList: string | undefined;
let qmList: string | undefined;
try {
  const raw = ssh(["pvesh", "get", "/cluster/resources", "--output-format", "json"]);
  resourcesJson = JSON.parse(raw) as unknown;
} catch {
  resourcesJson = undefined;
}
if (resourcesJson == null) {
  try {
    pctList = ssh(["pct", "list"]);
  } catch (e) {
    console.error(`pct list failed: ${(e as Error).message || e}`);
  }
  try {
    qmList = ssh(["qm", "list"]);
  } catch (e) {
    console.error(`qm list failed: ${(e as Error).message || e}`);
  }
}

const { vms, lxc } = parseProxmoxInventory({ resourcesJson, pctList, qmList });
if (!vms.length && !lxc.length) {
  console.error("no VMs or LXC found on Proxmox (pvesh / pct list / qm list)");
  process.exit(1);
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
const plan = {
  dry: !apply,
  source: "proxmox",
  ssh: sshTarget,
  via: resourcesJson != null ? "pvesh" : "pct/qm",
  vms: vms.length,
  lxc: lxc.length,
  vmNames: vms.map((g) => `${g.vmid} ${g.name} ${g.status}${g.template ? " template" : ""}`),
  lxcNames: lxc.map((g) => `${g.vmid} ${g.name} ${g.status}`),
  items: { vms, lxc },
  matched: matched ? { itemId: matched.id, name: matched.name } : null,
};

if (!matched) {
  console.log(JSON.stringify(plan, null, 2));
  console.error("unmatched Proxmox host (need hostname pve, IP 10.50.0.155, or name containing proxmox)");
  process.exit(1);
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2));
  console.error("dry run (pass --apply to write services.report; containers/web are not sent)");
  process.exit(0);
}

const result = (await trpc(
  "services.report",
  { itemId: matched.id, source: "proxmox", vms, lxc },
  "POST",
)) as { vms: number; lxc: number };
console.log(`${matched.name} (#${matched.id}): ${result.vms} VM(s), ${result.lxc} LXC from ${sshTarget}`);
