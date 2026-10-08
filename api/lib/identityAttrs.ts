/** Identity attributes that should be unique per house. Soft warning only. */
export type IdentityKind = "serial" | "mac" | "ip" | "hostname";

export const IDENTITY_KIND_LABELS: Record<IdentityKind, string> = {
  serial: "Serial number",
  mac: "MAC address",
  ip: "IP address",
  hostname: "Hostname",
};

const KEY_TO_KIND: Record<string, IdentityKind> = {
  serial: "serial",
  serial_number: "serial",
  mac: "mac",
  mac_address: "mac",
  ip: "ip",
  ip_address: "ip",
  hostname: "hostname",
  host: "hostname",
};

export function identityKind(key: string): IdentityKind | null {
  return KEY_TO_KIND[key.trim().toLowerCase()] ?? null;
}

/** Trim + case-fold; MAC also drops separators so AA:BB:… matches aabb…. */
export function normalizeIdentityValue(kind: IdentityKind, raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (kind === "mac") return s.toLowerCase().replace(/[^0-9a-f]/g, "");
  return s.toLowerCase();
}

export type IdentityEntry = {
  kind: IdentityKind;
  key: string;
  value: string;
  normalized: string;
};

export function identityEntries(attrs: Record<string, unknown> | null | undefined): IdentityEntry[] {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return [];
  const out: IdentityEntry[] = [];
  for (const [rawKey, rawVal] of Object.entries(attrs)) {
    const kind = identityKind(rawKey);
    if (!kind) continue;
    const value = rawVal == null ? "" : String(rawVal);
    const normalized = normalizeIdentityValue(kind, value);
    if (!normalized) continue;
    out.push({ kind, key: rawKey.trim(), value, normalized });
  }
  return out;
}

/** Most common IPv4 /24 prefix (`10.50.0.`), so a new IP only needs the last octet. */
export function commonIpv4Prefix(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const m = raw.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) continue;
    const prefix = `${m[1]}.${m[2]}.${m[3]}.`;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [prefix, count] of counts) {
    if (count > n || (count === n && best != null && prefix.localeCompare(best) < 0)) {
      best = prefix;
      n = count;
    }
  }
  return best;
}
