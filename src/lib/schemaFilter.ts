/**
 * Room-page Schema view: the filter state, its URL query form
 * (`?schema=1&types=…&tags=…&topics=…&flagged=1&decision=…`), a localStorage
 * mirror (`workbench.schema.filter`) and the predicate the schematic uses.
 *
 * Semantics: OR within a facet, AND across facets; an empty facet matches
 * everything. Type is a subtree test (`matchesTaxonomy`), so "computer"
 * includes iMac, Mac mini, Raspberry Pi and NAS in any Topic.
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { SCHEMA_PRESETS, TYPE_LABELS, isTypeNode, OTHER_TYPE, matchesTaxonomy } from "@db/taxonomy";

export type SchemaPin = inferRouterOutputs<AppRouter>["pins"]["listForRoom"][number];

/** "none" = no decision yet. */
export const DECISION_FILTERS = ["keep", "sell", "donate", "toss", "later", "none"] as const;
export type DecisionFilter = (typeof DECISION_FILTERS)[number];

export type SchemaFilter = {
  types: string[];
  tags: string[];
  topics: number[];
  flagged: boolean;
  decision: DecisionFilter | null;
};

export const EMPTY_SCHEMA_FILTER: SchemaFilter = { types: [], tags: [], topics: [], flagged: false, decision: null };

export const SCHEMA_FILTER_STORAGE_KEY = "workbench.schema.filter";

/** URL keys the filter owns (besides `schema` itself). */
const FILTER_KEYS = ["types", "tags", "topics", "flagged", "decision"] as const;

function list(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function normalize(f: Partial<SchemaFilter> | null | undefined): SchemaFilter {
  const types = (Array.isArray(f?.types) ? f.types : [])
    .map((t) => String(t).toLowerCase())
    .filter((t, i, a) => (t === OTHER_TYPE || isTypeNode(t)) && a.indexOf(t) === i);
  const tags = (Array.isArray(f?.tags) ? f.tags : [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t, i, a) => t && a.indexOf(t) === i);
  const topics = (Array.isArray(f?.topics) ? f.topics : [])
    .map(Number)
    .filter((n, i, a) => Number.isInteger(n) && n > 0 && a.indexOf(n) === i);
  const decision = DECISION_FILTERS.includes(f?.decision as DecisionFilter) ? (f!.decision as DecisionFilter) : null;
  return { types, tags, topics, flagged: f?.flagged === true, decision };
}

export function isEmptyFilter(f: SchemaFilter): boolean {
  return !f.types.length && !f.tags.length && !f.topics.length && !f.flagged && f.decision == null;
}

/** True when the URL carries any filter key (an explicit filter, even an empty one is not). */
export function hasFilterParams(params: URLSearchParams): boolean {
  return FILTER_KEYS.some((k) => params.has(k));
}

export function parseSchemaFilter(params: URLSearchParams): SchemaFilter {
  return normalize({
    types: list(params.get("types")),
    tags: list(params.get("tags")),
    topics: list(params.get("topics")).map(Number),
    flagged: params.get("flagged") === "1",
    decision: (params.get("decision") as DecisionFilter | null) ?? null,
  });
}

/** A copy of `params` with the filter keys replaced by `f` (empty facets removed). */
export function withSchemaFilter(params: URLSearchParams, f: SchemaFilter): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const k of FILTER_KEYS) next.delete(k);
  if (f.types.length) next.set("types", f.types.join(","));
  if (f.tags.length) next.set("tags", f.tags.join(","));
  if (f.topics.length) next.set("topics", f.topics.join(","));
  if (f.flagged) next.set("flagged", "1");
  if (f.decision) next.set("decision", f.decision);
  return next;
}

/** A copy of `params` without the Schema view's keys. */
export function withoutSchema(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("schema");
  next.delete("points");
  for (const k of FILTER_KEYS) next.delete(k);
  return next;
}

export function loadStoredSchemaFilter(): SchemaFilter | null {
  try {
    const raw = localStorage.getItem(SCHEMA_FILTER_STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw) as Partial<SchemaFilter>) : null;
  } catch {
    return null;
  }
}

export function storeSchemaFilter(f: SchemaFilter): void {
  try {
    localStorage.setItem(SCHEMA_FILTER_STORAGE_KEY, JSON.stringify(f));
  } catch {
    /* private mode or blocked storage: the URL still carries the filter */
  }
}

/** The preset whose Types equal the filter's (and nothing else is set), "everything" for an empty filter. */
export function activePreset(f: SchemaFilter): string | null {
  if (isEmptyFilter(f)) return "everything";
  if (f.tags.length || f.topics.length || f.flagged || f.decision) return null;
  const key = [...f.types].sort().join(",");
  return SCHEMA_PRESETS.find((p) => [...p.types].sort().join(",") === key)?.id ?? null;
}

/** Does this pin pass the filter? OR within a facet, AND across facets. */
export function pinMatches(pin: SchemaPin, f: SchemaFilter): boolean {
  const item = pin.item;
  if (f.flagged && !pin.flagged) return false;
  if (f.topics.length && (item == null || !f.topics.includes(item.areaId))) return false;
  if (f.decision) {
    const d = item?.decision ?? null;
    if (f.decision === "none" ? d != null : d !== f.decision) return false;
  }
  if (f.types.length || f.tags.length) {
    // the Thing's own Type and tags as derived by the API (attributes.type / role, tags + brand)
    const attrs: Record<string, unknown> = { type: item?.type ?? "", tags: (item?.tags ?? []).join(",") };
    if (!matchesTaxonomy(attrs, { types: f.types, tags: f.tags })) return false;
  }
  return true;
}

/** A pin has a frame when it carries a width and a height. */
export function isFramed(pin: { wPct: number | null; hPct: number | null }): boolean {
  return pin.wPct != null && pin.hPct != null && pin.wPct > 0 && pin.hPct > 0;
}

/** Name and Type (or role) a block and its card show. */
export function pinTitle(pin: SchemaPin): string {
  return pin.item?.name ?? pin.itemName ?? (pin.label || "Untitled");
}

export function pinTypeLabel(pin: SchemaPin): string | null {
  const t = pin.item?.type;
  if (t) return TYPE_LABELS[t] ?? t;
  return pin.item?.role ?? null;
}

/** The pins of one Photo the schematic draws: framed blocks, plus unframed points when `showPoints`. */
export function visibleSchemaPins(pins: SchemaPin[], filter: SchemaFilter, showPoints: boolean): SchemaPin[] {
  return pins.filter((p) => pinMatches(p, filter) && (showPoints || isFramed(p)));
}
