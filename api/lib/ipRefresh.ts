import { identityEntries } from "./identityAttrs";

/**
 * When a Thing's IP last changed.
 *
 * The event log is not that clock. `items.update` logs the whole attributes
 * map whenever any attribute is saved, so an "updated" event that still
 * contains `ip` is not an IP write. `items.patchAttributes` logs keys whose
 * values changed, but the payload is the whole request and can carry an
 * unchanged `ip`. `inbox.acceptMany` merges triage attributes and writes no
 * event for that merge. Nothing else stores the time of the IP write, so
 * the workflow key below (ISO-8601) is set when the normalized IP set
 * changes and kept when it does not. A client-supplied value is ignored.
 */
export const IP_REFRESHED_AT = "ip.refreshed_at";

/** Green-dot window: strictly under 24 hours. */
export const IP_REFRESH_MS = 24 * 60 * 60 * 1000;

type Attrs = Record<string, string | number> | null | undefined;

function ipSet(attrs: Attrs): string[] {
  return identityEntries(attrs)
    .filter((e) => e.kind === "ip")
    .map((e) => e.normalized)
    .sort();
}

function sameIps(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Copy `after`, drop any client `ip.refreshed_at`, then stamp now when the
 * normalized IP set differs from `before`. An unchanged set keeps the
 * previous stamp. No IP left means no stamp.
 */
export function stampIpRefresh(before: Attrs, after: Attrs, now: Date = new Date()): Record<string, string | number> | null {
  const next: Record<string, string | number> = { ...(after ?? {}) };
  delete next[IP_REFRESHED_AT];
  if (ipSet(next).length === 0) return Object.keys(next).length > 0 ? next : null;
  if (!sameIps(ipSet(before), ipSet(next))) {
    next[IP_REFRESHED_AT] = now.toISOString();
  } else {
    const prev = before?.[IP_REFRESHED_AT];
    if (typeof prev === "string" && prev.trim()) next[IP_REFRESHED_AT] = prev;
  }
  return next;
}

export function ipRefreshedAt(attrs: Record<string, unknown> | null | undefined): string | null {
  const v = attrs?.[IP_REFRESHED_AT];
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s || null;
}

/** True only when `stamp` parses and is strictly younger than 24 hours. */
export function isIpRecent(stamp: string | null | undefined, now: Date = new Date(), windowMs = IP_REFRESH_MS): boolean {
  if (!stamp) return false;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < windowMs;
}
