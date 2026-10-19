/**
 * Taxonomy: one definition of "what kind of Thing is this", shared by the API,
 * the Workbench (`@db/taxonomy`) and scripts. Pure: no imports.
 *
 * - `attributes.type`: the most specific Type from TYPE_TREE. Ancestors are
 *   derived from the tree, never stored. Without `type`, the Type comes from
 *   `role` (derivedType).
 * - `attributes.tags`: comma-separated, lower case. `brand` counts as a tag.
 * - `attributes.kind` is NOT a Type: Systems uses it for a service runtime.
 *
 * The machine rule (role sets, machine-signal keys, isMachineItem) moved here
 * from src/lib/systemsAttrs.ts so Systems and the schematic share one
 * definition of "computer"; systemsAttrs re-exports these names.
 */

// ---------------------------------------------------------------------------
// Attributes helpers

export type Attrs = Record<string, string | number> | null | undefined;
type LooseAttrs = Record<string, unknown> | null | undefined;

export function attrStr(attrs: LooseAttrs, key: string): string | null {
  const v = attrs?.[key];
  if (v == null || v === "") return null;
  return String(v);
}

// ---------------------------------------------------------------------------
// Roles and the machine rule (formerly in src/lib/systemsAttrs.ts)

export const MACHINE_ROLES = new Set(["laptop", "desktop", "server", "sbc", "nas"]);
export const LAB_AREA_SLUGS = new Set(["computers", "network"]);
export const SKIP_ROLES = new Set(["storage", "service", "software", "meter", "part"]);
export const PERIPHERAL_ROLES = new Set([
  "peripheral",
  "keyboard",
  "mouse",
  "monitor",
  "phone",
  "tablet",
  "patchpanel",
  "cable",
  "accessory",
]);
export const NETWORK_ROLES = new Set(["switch", "router", "ap", "network", "accesspoint"]);

export const MACHINE_SIGNAL_KEYS = [
  "ip",
  "ip_address",
  "hostname",
  "host",
  "mac",
  "os",
  "cpu",
  "ram",
  "ram_gb",
  "storage_gb",
  "storage_free_gb",
] as const;

export function normRole(role: string): string {
  return role.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function roleKey(attrs: LooseAttrs): string {
  return normRole(attrStr(attrs, "role") ?? "");
}

export function isPeripheralRole(role: string): boolean {
  return PERIPHERAL_ROLES.has(normRole(role));
}

export function isNetworkRole(role: string): boolean {
  return NETWORK_ROLES.has(normRole(role));
}

export function hasMachineSignal(attrs: LooseAttrs, hasVolumes = false): boolean {
  if (hasVolumes) return true;
  for (const k of MACHINE_SIGNAL_KEYS) {
    if (attrStr(attrs, k)) return true;
  }
  return false;
}

function isSkippedBase(it: { attributes: Attrs; parentId?: number | null; status?: string }): boolean {
  if (it.status === "archived") return true;
  if (attrStr(it.attributes, "lab.exclude") === "yes") return true;
  if (it.parentId != null) return true;
  return false;
}

export function isMachineItem(it: {
  attributes: Attrs;
  areaSlug?: string | null;
  parentId?: number | null;
  status?: string;
  hasVolumes?: boolean;
}): boolean {
  if (isSkippedBase(it)) return false;
  const role = roleKey(it.attributes);
  if (isPeripheralRole(role) || isNetworkRole(role) || SKIP_ROLES.has(role)) return false;
  if (MACHINE_ROLES.has(role)) return true;
  if (!role) return hasMachineSignal(it.attributes, it.hasVolumes === true);
  return false;
}

export function isNetworkItem(it: {
  attributes: Attrs;
  parentId?: number | null;
  status?: string;
}): boolean {
  if (isSkippedBase(it)) return false;
  const role = roleKey(it.attributes);
  if (isPeripheralRole(role)) return false;
  return isNetworkRole(role);
}

/** Top-level Computers/Network Things that are not machines, network gear, or peripherals. */
export function isOtherComputersItem(it: {
  attributes: Attrs;
  areaSlug?: string | null;
  parentId?: number | null;
  status?: string;
  hasVolumes?: boolean;
}): boolean {
  if (isSkippedBase(it)) return false;
  const role = roleKey(it.attributes);
  if (isPeripheralRole(role) || SKIP_ROLES.has(role)) return false;
  if (isMachineItem(it) || isNetworkItem(it)) return false;
  return LAB_AREA_SLUGS.has(it.areaSlug ?? "");
}

// ---------------------------------------------------------------------------
// Type tree

/** child → parent; roots have null. */
export const TYPE_TREE: Record<string, string | null> = {
  computer: null,
  desktop: "computer",
  imac: "desktop",
  "mac-mini": "desktop",
  tower: "desktop",
  laptop: "computer",
  macbook: "laptop",
  server: "computer",
  sbc: "computer",
  "raspberry-pi": "sbc",
  nas: "computer",
  display: null,
  monitor: "display",
  projector: "display",
  tv: "display",
  input: null,
  keyboard: "input",
  mouse: "input",
  storage: null,
  drive: "storage",
  network: null,
  switch: "network",
  "patch-panel": "network",
  meter: null,
  phone: null,
};

export const TYPE_LABELS: Record<string, string> = {
  computer: "Computer",
  desktop: "Desktop",
  imac: "iMac",
  "mac-mini": "Mac mini",
  tower: "Tower",
  laptop: "Laptop",
  macbook: "MacBook",
  server: "Server",
  sbc: "Single-board computer",
  "raspberry-pi": "Raspberry Pi",
  nas: "NAS",
  display: "Display",
  monitor: "Monitor",
  projector: "Projector",
  tv: "TV",
  input: "Input device",
  keyboard: "Keyboard",
  mouse: "Mouse",
  storage: "Storage",
  drive: "Drive",
  network: "Network",
  switch: "Switch",
  "patch-panel": "Patch panel",
  meter: "Meter",
  phone: "Phone",
};

/** Own keys only, so inherited names ("constructor", "toString") are never Types. */
export function isTypeNode(type: string | null | undefined): type is string {
  return type != null && Object.hasOwn(TYPE_TREE, type);
}

function parentOf(type: string): string | null {
  return isTypeNode(type) ? TYPE_TREE[type] : null;
}

/** Parent, grandparent, … up to the root; [] for a root or an unknown Type. */
export function ancestorsOf(type: string): string[] {
  const out: string[] = [];
  let p = parentOf(type);
  while (p != null && !out.includes(p)) {
    out.push(p);
    p = parentOf(p);
  }
  return out;
}

/** True when `type` is `node` or lies in its subtree; both must be tree nodes. */
export function isUnder(type: string | null, node: string): boolean {
  if (!isTypeNode(type) || !isTypeNode(node)) return false;
  return type === node || ancestorsOf(type).includes(node);
}

/** Normalized role → Type, for Things without `attributes.type`. */
const ROLE_TYPES: Record<string, string> = {
  desktop: "desktop",
  laptop: "laptop",
  server: "server",
  sbc: "sbc",
  nas: "nas",
  monitor: "monitor",
  display: "display",
  projector: "projector",
  tv: "tv",
  keyboard: "keyboard",
  mouse: "mouse",
  storage: "storage",
  drive: "drive",
  switch: "switch",
  patchpanel: "patch-panel",
  router: "network",
  ap: "network",
  accesspoint: "network",
  network: "network",
  meter: "meter",
  phone: "phone",
};

/**
 * The Thing's Type: `attributes.type` when it is a tree node, else mapped from
 * `role`, else an unknown stored `type` as written (lower case), else null.
 */
export function derivedType(attrs: Record<string, unknown>): string | null {
  const stored = attrStr(attrs, "type")?.trim().toLowerCase() || null;
  if (isTypeNode(stored)) return stored;
  const role = roleKey(attrs);
  if (Object.hasOwn(ROLE_TYPES, role)) return ROLE_TYPES[role];
  return stored;
}

function normTag(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, "-");
}

/** `attributes.tags` split on commas plus `brand`, lower case (spaces → "-"), de-duplicated. */
export function tagsOf(attrs: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    const n = normTag(t);
    if (n && !out.includes(n)) out.push(n);
  };
  for (const t of (attrStr(attrs, "tags") ?? "").split(",")) add(t);
  const brand = attrStr(attrs, "brand");
  if (brand) add(brand);
  return out;
}

/** Room-page Schema presets: Type-tree nodes, each meaning its whole subtree. */
export const SCHEMA_PRESETS: Array<{ id: string; label: string; types: string[] }> = [
  { id: "computers", label: "Computers", types: ["computer"] },
  { id: "computers-displays-storage", label: "Computers & displays & storage", types: ["computer", "display", "storage"] },
];

/** The `types` filter token for Things without a known Type (none, or an unknown stored `type`). */
export const OTHER_TYPE = "other";

/**
 * Type and Tags facets: Type matches when the Thing's Type is under any chosen
 * node, or the Thing has no known Type and OTHER_TYPE ("other") is chosen; Tags match when the Thing has any chosen tag (OR within a facet); both
 * facets must match (AND across). An empty facet matches everything.
 */
export function matchesTaxonomy(
  attrs: Record<string, unknown>,
  filter: { types?: string[]; tags?: string[] },
): boolean {
  const types = filter.types ?? [];
  if (types.length > 0) {
    const t = derivedType(attrs);
    const ok = types.some((n) => (n === OTHER_TYPE ? !isTypeNode(t) : isUnder(t, n)));
    if (!ok) return false;
  }
  const tags = (filter.tags ?? []).map(normTag).filter(Boolean);
  if (tags.length > 0) {
    const own = tagsOf(attrs);
    if (!tags.some((t) => own.includes(t))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Evidence ladder: is this Thing a computer?

export type ComputerVerdict = {
  verdict: "computer" | "suggested" | "no";
  rule: "role" | "machine-signal" | "name" | "veto" | "accessory" | "none";
  type?: string;
  tags?: string[];
};

// Word end that still allows digits ("pi4", "imac27").
const W = "(?![a-z])";
const SPECIFIC_NAME_TYPES: Array<[string, RegExp]> = [
  ["imac", new RegExp(`\\bimac${W}`)],
  ["mac-mini", new RegExp(`\\bmac\\s*-?\\s*mini${W}`)],
  ["macbook", /\bmacbook/],
  ["raspberry-pi", new RegExp(`\\braspberry|\\bpi${W}`)],
];
const GENERIC_NAME_TYPES: Array<[string, RegExp]> = [
  ["sbc", new RegExp(`\\bvolumio${W}`)],
  ["nas", new RegExp(`\\bnas${W}`)],
  ["laptop", new RegExp(`\\blaptops?${W}`)],
  ["desktop", new RegExp(`\\bdesktops?${W}`)],
  ["server", new RegExp(`\\bservers?${W}`)],
];
const ACCESSORY_RE =
  /\b(adapter|stand|charger|chassis|panel|sleeve|pouch|case|cable|power|brick|dock|mouse|keyboard|monitor|drive|ssd|hdd|nvme|ram)(s|es|ing)?\b/;
const TAG_RULES: Array<[string, RegExp]> = [
  ["apple", new RegExp(`\\bapple${W}|\\bimac${W}|\\bmac\\s*-?\\s*mini${W}|\\bmacbook|\\bmac\\s*(pro|studio)${W}`)],
  ["raspberry-pi", new RegExp(`\\braspberry|\\bpi${W}`)],
  ["hp", new RegExp(`\\bhp${W}|\\bhewlett`)],
  ["dell", new RegExp(`\\bdell${W}`)],
];

function nameText(item: { name: string; attributes: Record<string, unknown> }): string {
  return [item.name, attrStr(item.attributes, "model")].filter(Boolean).join(" ").toLowerCase();
}

/** The one specific Type the text names (imac, mac-mini, macbook, raspberry-pi), or null when none or several. */
function specificTypeFrom(text: string): string | null {
  const hits = SPECIFIC_NAME_TYPES.filter(([, re]) => re.test(text)).map(([t]) => t);
  return hits.length === 1 ? hits[0] : null;
}

function anyTypeFrom(text: string): string | null {
  const specific = specificTypeFrom(text);
  if (specific) return specific;
  if (SPECIFIC_NAME_TYPES.some(([, re]) => re.test(text))) return "computer"; // several specific hits: ambiguous
  for (const [t, re] of GENERIC_NAME_TYPES) if (re.test(text)) return t;
  return null;
}

function machineTags(text: string, attrs: Record<string, unknown>): string[] {
  const out = tagsOf(attrs);
  const brand = (attrStr(attrs, "brand") ?? "").toLowerCase();
  for (const [tag, re] of TAG_RULES) {
    if ((re.test(text) || re.test(brand)) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Evidence ladder:
 * 1. role in MACHINE_ROLES → computer ("role"); type = role, or the specific
 *    Type the name names when it is under that role.
 * 2. no role and machine-signal evidence (MACHINE_SIGNAL_KEYS or a storage
 *    volume, exactly as isMachineItem counts it) → computer ("machine-signal");
 *    another role outside PERIPHERAL ∪ NETWORK ∪ SKIP with that evidence →
 *    suggested ("machine-signal").
 * 3. name/model names a computer → suggested ("name"), unless an explicit
 *    non-computer role vetoes it ("veto") or an accessory word is in the name
 *    ("accessory"). Otherwise "none".
 * `tags` is the full tag list to keep: the Thing's own tags plus apple /
 * raspberry-pi / hp / dell from the name or brand.
 *
 * It judges the Thing only: it does NOT apply isMachineItem's exclusions
 * (archived, `lab.exclude = yes`, a `parentId`). "computer" equals
 * isMachineItem only for active, top-level, non-excluded Things; callers
 * (the backfill) filter those themselves.
 * Known false positive of the name step: `\bpi` also matches "Pi-hole" (a
 * service name), which then comes out "suggested", never "computer".
 */
export function judgeComputer(item: {
  name: string;
  attributes: Record<string, unknown>;
  hasVolumes?: boolean;
}): ComputerVerdict {
  const attrs = item.attributes ?? {};
  const role = roleKey(attrs);
  const text = nameText(item);
  const accessory = ACCESSORY_RE.test(text);

  if (MACHINE_ROLES.has(role)) {
    const specific = accessory ? null : specificTypeFrom(text);
    const type = specific && isUnder(specific, role) ? specific : role;
    return { verdict: "computer", rule: "role", type, tags: machineTags(text, attrs) };
  }

  const vetoRole = isPeripheralRole(role) || isNetworkRole(role) || SKIP_ROLES.has(role);
  if (!vetoRole && hasMachineSignal(attrs, item.hasVolumes === true)) {
    const type = (accessory ? null : anyTypeFrom(text)) ?? "computer";
    return { verdict: role ? "suggested" : "computer", rule: "machine-signal", type, tags: machineTags(text, attrs) };
  }

  const named = anyTypeFrom(text);
  if (!named) return { verdict: "no", rule: "none" };
  if (role) return { verdict: "no", rule: "veto" };
  if (accessory) return { verdict: "no", rule: "accessory" };
  return { verdict: "suggested", rule: "name", type: named, tags: machineTags(text, attrs) };
}
