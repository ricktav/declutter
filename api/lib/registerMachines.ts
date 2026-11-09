/**
 * Import the machine register (Data Tracker `GET /api/machines` on
 * 10.50.0.10:8888) onto HomeBase's computer Things.
 *
 * The register knows every machine by hardware: serial, UUID, model, its
 * network cards (MAC + IP) and the names it goes by. HomeBase used to get
 * those typed in by hand, and collectors matched on hostnames that drift.
 * This module matches a register machine to a Thing by `serial` first, then
 * `machine.id`, then a network card's MAC (hardware too), and only then by hostname or IP
 * (weak: applied only when asked), and fills `serial`, `uuid`, `model`,
 * `machine.id`, `hostname`, `aliases`, `ip`, `mac` and `macs` so the hostname-based collectors keep matching
 * without anyone typing. It never creates, archives or renames a Thing; a
 * register machine without a Thing and a Thing without a machine are listed
 * for Rick. Dry by default.
 */
import { eq } from "drizzle-orm";
import { items } from "@db/schema";
import { MACHINE_ROLES, normRole } from "@db/taxonomy";
import type { getDb } from "../queries/connection";
import { logEvent } from "./events";
import { normalizeIdentityValue } from "./identityAttrs";
import { stampIpRefresh } from "./ipRefresh";
import { normalizeIp, normHost } from "./hostNames";
import { serialOf, uuidOf } from "./storageDisks";

type Db = ReturnType<typeof getDb>;

export class RegisterImportError extends Error {}

export const REGISTER_SOURCE = "register";
/** Comma lists in attributes are capped by items.patchAttributes' 500-character value limit. */
const MAX_ATTR = 500;

export type RegisterDevice = { ip: string | null; mac: string | null; name: string | null; staticIp: boolean };

export type RegisterMachine = {
  id: number;
  canonical: string;
  model: string | null;
  serial: string | null;
  uuid: string | null;
  lifecycle: string | null;
  aliases: string[];
  devices: RegisterDevice[];
  liveIps: string[];
  reservedIps: string[];
  fleetHosts: string[];
  lastSeen: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => s != null) : []);

/** Accepts the `/api/machines` body (`{ machines: [...] }`) or a bare array. */
export function parseRegisterMachines(payload: unknown): RegisterMachine[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { machines?: unknown }).machines)
      ? ((payload as { machines: unknown[] }).machines)
      : null;
  if (!list) throw new RegisterImportError("Expected { machines: [...] } from /api/machines.");
  const out: RegisterMachine[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const canonical = str(m.canonical);
    const id = typeof m.id === "number" ? m.id : Number(m.id);
    if (!canonical || !Number.isFinite(id)) continue;
    const devices: RegisterDevice[] = Array.isArray(m.devices)
      ? m.devices
          .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
          .map((d) => ({
            ip: normalizeIp(str(d.ip)),
            mac: str(d.mac)?.toLowerCase() ?? null,
            name: str(d.name),
            staticIp: d.static_ip === 1 || d.static_ip === true,
          }))
      : [];
    const status = m.status && typeof m.status === "object" ? (m.status as Record<string, unknown>) : {};
    const fleet = Array.isArray(m.fleet) ? m.fleet : [];
    out.push({
      id,
      canonical,
      model: str(m.model),
      serial: str(m.hw_serial),
      uuid: str(m.hw_uuid),
      lifecycle: str(m.lifecycle),
      aliases: strList(m.aliases),
      devices,
      liveIps: strList(status.live_ips).map((s) => normalizeIp(s)).filter((s): s is string => s != null),
      reservedIps: strList(status.reserved_ips).map((s) => normalizeIp(s)).filter((s): s is string => s != null),
      fleetHosts: fleet
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .flatMap((f) => [str(f.hostname), ...strList(f.aliases)])
        .filter((s): s is string => s != null),
      lastSeen: str(status.last_seen),
    });
  }
  return out;
}

export type MachineItem = {
  id: number;
  name: string;
  status: string;
  attributes: Record<string, string | number> | null;
};

export type MatchBy = "serial" | "machine.id" | "hostname" | "ip" | "mac";
/** Hardware (serial, a network card's MAC) or Rick's own `machine.id`: safe unattended. Hostname and IP move around. */
const STRONG: ReadonlySet<MatchBy> = new Set<MatchBy>(["serial", "machine.id", "mac"]);
const MATCH_ORDER: MatchBy[] = ["serial", "machine.id", "mac", "hostname", "ip"];

export type RegisterPlanRow = {
  machine: { id: number; canonical: string; model: string | null; serial: string | null; lifecycle: string | null };
  itemId: number | null;
  itemName: string | null;
  matchedBy: MatchBy | null;
  /** serial, machine.id or MAC: safe to apply unattended. Weak rows (hostname, IP) need `acceptWeak`. */
  strong: boolean;
  /** Attribute writes this row would make (only keys that change). */
  set: Record<string, string>;
  /** A value HomeBase has that disagrees with the register; the row is not applied. */
  conflicts: Array<{ key: string; have: string; want: string }>;
  /** Why the row does nothing (no Thing, lifecycle, ambiguous). */
  skipped: string | null;
};

export type RegisterPlan = {
  rows: RegisterPlanRow[];
  unmatchedItems: Array<{ id: number; name: string }>;
  counts: { machines: number; matched: number; strong: number; weak: number; conflicts: number; noThing: number; unmatchedItems: number };
};

const attrStr = (a: Record<string, string | number> | null, key: string): string | null => {
  const v = a?.[key];
  return v == null || v === "" ? null : String(v);
};

export function isMachineThing(it: MachineItem): boolean {
  return it.status === "active" && MACHINE_ROLES.has(normRole(attrStr(it.attributes, "role") ?? ""));
}

/** Every name the register knows the machine by, normalised like the collectors do. */
export function registerHostKeys(m: RegisterMachine): string[] {
  return [m.canonical, ...m.aliases, ...m.fleetHosts, ...m.devices.map((d) => d.name ?? "")]
    .filter(Boolean)
    .map((s) => normHost(s))
    .filter(Boolean);
}

function registerIps(m: RegisterMachine): string[] {
  return [...new Set([...m.liveIps, ...m.reservedIps, ...m.devices.map((d) => d.ip).filter((s): s is string => s != null)])];
}

/** Every network card the register knows, lower case with colons. */
export function registerMacs(m: RegisterMachine): string[] {
  return [...new Set(m.devices.map((d) => d.mac).filter((s): s is string => s != null))];
}

/** The IP a Thing should show: live first, then a static reservation, then the first card. */
export function preferredIp(m: RegisterMachine): string | null {
  return m.liveIps[0] ?? m.devices.find((d) => d.staticIp && d.ip)?.ip ?? m.devices.find((d) => d.ip)?.ip ?? m.reservedIps[0] ?? null;
}

function splitList(v: string | null): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinCapped(values: string[]): string {
  let out = "";
  for (const v of values) {
    const next = out ? `${out},${v}` : v;
    if (next.length > MAX_ATTR) break;
    out = next;
  }
  return out;
}

/** Which attribute of `it` matches `m`, strongest first. */
export function matchKey(it: MachineItem, m: RegisterMachine): MatchBy | null {
  const a = it.attributes;
  const serial = serialOf(attrStr(a, "serial") ?? attrStr(a, "serial_number"));
  if (serial && m.serial && serial === serialOf(m.serial)) return "serial";
  const keys = new Set(registerHostKeys(m));
  const mid = attrStr(a, "machine.id");
  if (mid && keys.has(normHost(mid))) return "machine.id";
  const macs = new Set(registerMacs(m).map((s) => normalizeIdentityValue("mac", s)));
  for (const k of ["mac", "mac_address", "macs"]) {
    for (const mac of splitList(attrStr(a, k))) {
      if (macs.has(normalizeIdentityValue("mac", mac))) return "mac";
    }
  }
  for (const k of ["hostname", "host"]) {
    const h = attrStr(a, k);
    if (h && keys.has(normHost(h))) return "hostname";
  }
  const ips = new Set(registerIps(m));
  for (const k of ["ip", "ip_address"]) {
    const ip = normalizeIp(attrStr(a, k));
    if (ip && ips.has(ip)) return "ip";
  }
  return null;
}

/** The attribute writes for a matched pair, and the disagreements that block them. */
export function attributePatch(it: MachineItem, m: RegisterMachine): { set: Record<string, string>; conflicts: RegisterPlanRow["conflicts"] } {
  const a = it.attributes;
  const set: Record<string, string> = {};
  const conflicts: RegisterPlanRow["conflicts"] = [];
  const want = (key: string, value: string | null, opts: { onlyWhenEmpty?: boolean; same?: (have: string, want: string) => boolean } = {}) => {
    if (!value) return;
    const have = attrStr(a, key);
    if (have == null) {
      set[key] = value;
      return;
    }
    const same = opts.same ?? ((h, w) => h.trim().toLowerCase() === w.trim().toLowerCase());
    if (same(have, value)) return;
    if (opts.onlyWhenEmpty) return;
    conflicts.push({ key, have, want: value });
  };

  want("serial", m.serial, { same: (h, w) => serialOf(h) === serialOf(w) });
  want("uuid", m.uuid?.toLowerCase() ?? null, { same: (h, w) => uuidOf(h) === uuidOf(w) });
  want("model", m.model, { onlyWhenEmpty: true });
  want("hostname", m.canonical, { onlyWhenEmpty: true });
  // machine.id is the collectors' preferred key; any register name for this machine is fine
  const mid = attrStr(a, "machine.id");
  const keys = new Set(registerHostKeys(m));
  if (mid == null) set["machine.id"] = m.canonical;
  else if (!keys.has(normHost(mid))) conflicts.push({ key: "machine.id", have: mid, want: m.canonical });

  const hostname = (set.hostname ?? attrStr(a, "hostname") ?? "").toLowerCase();
  const aliases = [...splitList(attrStr(a, "aliases")), m.canonical, ...m.aliases, ...m.fleetHosts]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== hostname && !/^\d+\.\d+\.\d+\.\d+$/.test(s));
  const merged = joinCapped([...new Set(aliases)]);
  if (merged && merged !== (attrStr(a, "aliases") ?? "")) set.aliases = merged;

  // the register's live IP is fresher than anything typed; the stamp marks it
  const ip = preferredIp(m);
  if (ip && normalizeIp(attrStr(a, "ip")) !== ip) set.ip = ip;
  const mac = m.devices.find((d) => d.ip === ip && d.mac)?.mac ?? m.devices.find((d) => d.mac)?.mac ?? null;
  want("mac", mac, { onlyWhenEmpty: true, same: (h, w) => normalizeIdentityValue("mac", h) === normalizeIdentityValue("mac", w) });
  // every card, so the next run (and a machine without a serial) matches on hardware
  const haveMacs = splitList(attrStr(a, "macs")).map((s) => s.toLowerCase());
  const allMacs = joinCapped([...new Set([...haveMacs, ...registerMacs(m)])]);
  if (allMacs && allMacs !== (attrStr(a, "macs") ?? "").toLowerCase()) set.macs = allMacs;
  return { set, conflicts };
}

export function planRegisterImport(allItems: MachineItem[], machines: RegisterMachine[]): RegisterPlan {
  const candidates = allItems.filter(isMachineThing);
  const taken = new Set<number>();
  const rows: RegisterPlanRow[] = [];
  const isGone = (m: RegisterMachine) => !!m.lifecycle && /^(weg|gone|retired|afgevoerd)$/i.test(m.lifecycle);
  const pending = new Map<number, RegisterMachine>(machines.filter((m) => !isGone(m)).map((m) => [m.id, m]));

  const baseRow = (m: RegisterMachine): RegisterPlanRow => ({
    machine: { id: m.id, canonical: m.canonical, model: m.model, serial: m.serial, lifecycle: m.lifecycle },
    itemId: null,
    itemName: null,
    matchedBy: null,
    strong: false,
    set: {},
    conflicts: [],
    skipped: null,
  });

  // strong keys first across every machine, so a weak hostname hit can never steal a Thing whose serial names another machine
  for (const pass of ["strong", "weak"] as const) {
    for (const m of [...pending.values()]) {
      const hits = candidates
        .filter((it) => !taken.has(it.id))
        .map((it) => ({ it, by: matchKey(it, m) }))
        .filter((h): h is { it: MachineItem; by: MatchBy } => h.by != null && (pass === "strong") === STRONG.has(h.by));
      if (hits.length === 0) continue;
      const row = baseRow(m);
      pending.delete(m.id);
      hits.sort((x, y) => MATCH_ORDER.indexOf(x.by) - MATCH_ORDER.indexOf(y.by));
      const best = hits[0];
      const rivals = hits.filter((h) => h.by === best.by);
      if (rivals.length > 1) {
        row.skipped = `ambiguous: ${best.by} matches ${rivals.map((h) => `#${h.it.id} ${h.it.name}`).join(", ")}`;
        rows.push(row);
        continue;
      }
      row.itemId = best.it.id;
      row.itemName = best.it.name;
      row.matchedBy = best.by;
      row.strong = STRONG.has(best.by);
      taken.add(best.it.id);
      const patch = attributePatch(best.it, m);
      row.set = patch.set;
      row.conflicts = patch.conflicts;
      rows.push(row);
    }
  }
  for (const m of pending.values()) {
    const row = baseRow(m);
    row.skipped = "no Thing matches";
    rows.push(row);
  }
  // a machine the register has written off never claims a Thing
  for (const m of machines.filter(isGone)) {
    const row = baseRow(m);
    row.skipped = `lifecycle ${m.lifecycle}`;
    rows.push(row);
  }
  rows.sort((a, b) => a.machine.canonical.localeCompare(b.machine.canonical));
  const unmatchedItems = candidates.filter((it) => !taken.has(it.id)).map((it) => ({ id: it.id, name: it.name }));
  const matched = rows.filter((r) => r.itemId != null && !r.skipped);
  return {
    rows,
    unmatchedItems,
    counts: {
      machines: machines.length,
      matched: matched.length,
      strong: matched.filter((r) => r.strong).length,
      weak: matched.filter((r) => !r.strong).length,
      conflicts: matched.filter((r) => r.conflicts.length > 0).length,
      noThing: rows.filter((r) => r.itemId == null).length,
      unmatchedItems: unmatchedItems.length,
    },
  };
}

export type RegisterImportResult = RegisterPlan & {
  dry: boolean;
  applied: Array<{ itemId: number; keys: string[] }>;
};

/**
 * Plan, and unless `dry`, write the rows that are safe: matched, no conflict,
 * strong (or weak with `acceptWeak`). Writes go through the same merge as
 * `items.patchAttributes` (IP refresh stamp, one `updated` event per Thing).
 */
export async function applyRegisterImport(
  db: Db,
  input: { machines: unknown; dry?: boolean; acceptWeak?: boolean },
): Promise<RegisterImportResult> {
  const machines = parseRegisterMachines(input.machines);
  const rows = await db
    .select({ id: items.id, name: items.name, status: items.status, attributes: items.attributes })
    .from(items)
    .where(eq(items.status, "active"));
  const plan = planRegisterImport(rows as MachineItem[], machines);
  const dry = input.dry !== false;
  const applied: RegisterImportResult["applied"] = [];
  if (!dry) {
    for (const row of plan.rows) {
      if (row.itemId == null || row.skipped || row.conflicts.length > 0) continue;
      if (!row.strong && !input.acceptWeak) continue;
      const keys = Object.keys(row.set);
      if (keys.length === 0) continue;
      const item = rows.find((r) => r.id === row.itemId)!;
      const next: Record<string, string | number> = { ...(item.attributes ?? {}), ...row.set };
      const stamped = stampIpRefresh(item.attributes, next);
      await db.update(items).set({ attributes: stamped }).where(eq(items.id, row.itemId));
      await logEvent({
        entityType: "item",
        entityId: row.itemId,
        action: "updated",
        actor: "system",
        summary: `Register import (${row.machine.canonical}, by ${row.matchedBy}): ${keys.map((k) => `${k} = ${row.set[k]}`).join(", ")}`,
        payload: { source: REGISTER_SOURCE, machineId: row.machine.id, matchedBy: row.matchedBy, set: row.set },
      });
      applied.push({ itemId: row.itemId, keys });
    }
  }
  return { ...plan, dry, applied };
}
