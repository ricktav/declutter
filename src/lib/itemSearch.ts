/**
 * Text a person can find a Thing by, from the item row itself plus the
 * Place it sits in. No extra index: callers already hold the row.
 *
 * Lives under src/ so the Workbench can import it. A file under api/ is
 * served as /api/… and the dev server treats that as an API route.
 *
 * status and verificationStatus match only as a whole word. They are short
 * enums on every row ("active", "confirmed"), so a one-letter search must
 * not hit every Thing through them. Decision stays in the free-text haystack
 * (keep, sell, donate, toss, later).
 */
export interface ItemSearchable {
  name: string;
  description?: string | null;
  status?: string | null;
  verificationStatus?: string | null;
  decision?: string | null;
  attributes?: unknown;
  /** The item's Place, when it has one. */
  room?: { name?: string | null; floor?: string | null } | null;
  /** Topic name. Not stored on the item; lists already show it and search it. */
  areaName?: string | null;
}

function pushScalar(parts: string[], value: unknown) {
  if (typeof value === "string") {
    const s = value.trim();
    if (s) parts.push(s);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    parts.push(String(value));
    return;
  }
  if (typeof value === "boolean") parts.push(value ? "true" : "false");
}

/** Attribute keys and values, including workflow keys and nested JSON. */
function collectAttributes(value: unknown, parts: string[], depth: number) {
  if (value == null || depth > 6) return;
  if (typeof value !== "object") {
    pushScalar(parts, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectAttributes(entry, parts, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const k = key.trim();
    if (k) parts.push(k);
    collectAttributes(entry, parts, depth + 1);
  }
}

export function itemSearchParts(item: ItemSearchable): string[] {
  const parts: string[] = [];
  pushScalar(parts, item.name);
  pushScalar(parts, item.description);
  pushScalar(parts, item.decision);
  pushScalar(parts, item.room?.name);
  pushScalar(parts, item.room?.floor);
  pushScalar(parts, item.areaName);
  collectAttributes(item.attributes, parts, 0);
  return parts;
}

export function itemMatchesQuery(item: ItemSearchable, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = itemSearchParts(item).join("\n").toLowerCase();
  const whole = new Set(
    [item.status, item.verificationStatus]
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim().toLowerCase()),
  );
  return terms.every((term) => hay.includes(term) || whole.has(term));
}
