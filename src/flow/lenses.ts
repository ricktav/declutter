import type { FlowItem } from "./data";

/**
 * Lenses: a focused view on the same items for one field of work. A lens
 * adds no tables. Its descriptive fields are plain attribute keys (they
 * describe the thing, so the Workbench shows them too); its workflow state
 * uses a "<lens>." prefix so it never collides with a description.
 */
export type LensKey = "lab";

export type LensField = {
  key: string;
  label: string;
  kind: "text" | "number" | "select";
  unit?: string;
  placeholder?: string;
};

/**
 * Device roles. The values extend the "role" options of the Workbench's
 * Computers topic (laptop … service), so both front ends read one key.
 */
export const ROLES: { value: string; label: string }[] = [
  { value: "laptop", label: "Laptop" },
  { value: "desktop", label: "Desktop" },
  { value: "server", label: "Server" },
  { value: "nas", label: "NAS" },
  { value: "storage", label: "Drive" },
  { value: "phone", label: "Phone / tablet" },
  { value: "sbc", label: "Raspberry Pi" },
  { value: "network", label: "Network" },
  { value: "peripheral", label: "Peripheral" },
  { value: "part", label: "Part" },
  { value: "software", label: "Software" },
  { value: "service", label: "Service" },
];
export const roleLabel = (v: string) => ROLES.find((r) => r.value === v)?.label ?? v;

/** Roles that can hold personal data - they need a backup, and a wipe before they go. */
const DATA_ROLES = new Set(["laptop", "desktop", "server", "nas", "storage", "phone", "sbc"]);
/** Roles that can receive another device's backup. */
const BACKUP_ROLES = new Set(["nas", "storage", "server"]);

export const LAB = {
  key: "lab" as const,
  label: "Computer lab",
  areaSlugs: ["computers", "network"],
  defaultAreaSlug: "computers",
  /** asked on the Sort card, next to the role */
  mainFields: [
    { key: "brand", label: "Brand", kind: "text", placeholder: "e.g. Dell" },
    { key: "model", label: "Model", kind: "text", placeholder: "e.g. OptiPlex 7050" },
    { key: "serial", label: "Serial number", kind: "text" },
  ] satisfies LensField[],
  moreFields: [
    { key: "os", label: "Operating system", kind: "text", placeholder: "e.g. Ubuntu 24.04" },
    { key: "cpu", label: "CPU", kind: "text" },
    { key: "ram_gb", label: "RAM", kind: "number", unit: "GB" },
    { key: "storage_gb", label: "Storage", kind: "number", unit: "GB" },
    { key: "hostname", label: "Hostname", kind: "text" },
    { key: "ip", label: "IP address", kind: "text", placeholder: "e.g. 10.50.0.x" },
    { key: "mac", label: "MAC address", kind: "text" },
  ] satisfies LensField[],
};

/** Workflow keys the lab lens owns. */
export const LAB_KEYS = {
  exclude: "lab.exclude", // "yes": the item sits in a lab topic but is not a lab thing
  backup: "lab.backup", // "none-needed": no backup wanted for this device
  dataCopied: "lab.data_copied_at", // local date: personal data copied off
  wiped: "lab.wiped_at", // local date: storage wiped or reset
};
/** relation type: fromItemId (the NAS, drive or server) backs up toItemId (the device) */
export const BACKS_UP = "backs-up";

const attr = (it: FlowItem, key: string) => it.attributes?.[key];
export const role = (it: FlowItem) => String(attr(it, "role") ?? "");
export const holdsData = (it: FlowItem) => DATA_ROLES.has(role(it));
export const isBackupTarget = (it: FlowItem) => BACKUP_ROLES.has(role(it));

export function inLab(it: FlowItem) {
  if (attr(it, LAB_KEYS.exclude) === "yes") return false;
  if (role(it)) return true;
  return !!it.areaSlug && LAB.areaSlugs.includes(it.areaSlug);
}
/** A lab thing without a role: the Sort card "What device is it?" asks for it. */
export const needsLabDetails = (it: FlowItem) => inLab(it) && !role(it);

/** A first guess for the role chip, from the name and the AI's free "type" text. Never saved without a tap. */
export function guessRole(it: FlowItem): string | null {
  const hay = `${it.name} ${attr(it, "type") ?? ""}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/laptop|macbook|notebook|thinkpad|chromebook/, "laptop"],
    [/raspberry|\bpi\b|arduino|esp32/, "sbc"],
    [/\bnas\b|synology|qnap/, "nas"],
    [/server|proxmox/, "server"],
    [/desktop|imac|all-in-one|mac mini|tower|\bpc\b/, "desktop"],
    [/phone|iphone|ipad|tablet|android/, "phone"],
    [/\bssd\b|\bhdd\b|hard ?disk|harde schijf|usb stick|sd card|external drive/, "storage"],
    [/router|switch|access point|modem|\bwifi\b|ethernet/, "network"],
    [/monitor|keyboard|mouse|printer|webcam|headset|speaker/, "peripheral"],
    [/\bram\b|dimm|cable|adapter|charger|board/, "part"],
  ];
  return rules.find(([re]) => re.test(hay))?.[1] ?? null;
}

export type Rel = { id: number; fromItemId: number; toItemId: number; type: string; status: string };

/** The backup links that point at this device. */
export const backupsOf = (it: FlowItem, backups: Rel[]) => backups.filter((r) => r.toItemId === it.id);

export function backupState(it: FlowItem, backups: Rel[]): "covered" | "none-needed" | "missing" | "n/a" {
  if (!holdsData(it)) return "n/a";
  if (backupsOf(it, backups).length > 0) return "covered";
  if (attr(it, LAB_KEYS.backup) === "none-needed") return "none-needed";
  return "missing";
}

/**
 * A data device may only leave the house after three checks. This applies
 * with the lens on or off: the risk does not depend on which screen you use.
 */
export function safetyChecks(it: FlowItem, backups: Rel[]) {
  if (!holdsData(it)) return null;
  const state = backupState(it, backups);
  return [
    { key: LAB_KEYS.backup, label: "Backed up", done: state === "covered" || state === "none-needed" },
    { key: LAB_KEYS.dataCopied, label: "Data copied off", done: !!attr(it, LAB_KEYS.dataCopied) },
    { key: LAB_KEYS.wiped, label: "Wiped or reset", done: !!attr(it, LAB_KEYS.wiped) },
  ];
}
export const safeToGo = (it: FlowItem, backups: Rel[]) => (safetyChecks(it, backups) ?? []).every((c) => c.done);

/** Today as YYYY-MM-DD in local time - a date, not a moment. */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function shortDate(iso: string | number | undefined) {
  if (!iso) return "";
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// The lens is a device preference: Rick's phone can sit in the lab while
// the desktop stays in plain Flow.
const LENS_KEY = "flow.lens";
export function getLens(): LensKey | null {
  try {
    return localStorage.getItem(LENS_KEY) === "lab" ? "lab" : null;
  } catch {
    return null;
  }
}
export function storeLens(lens: LensKey | null) {
  try {
    if (lens) localStorage.setItem(LENS_KEY, lens);
    else localStorage.removeItem(LENS_KEY);
  } catch {
    // storage unavailable - the lens resets on reload
  }
}
