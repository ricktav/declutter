import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import type { ItemDecision, TriageSuggestion } from "@db/schema";

type Out = inferRouterOutputs<AppRouter>;
export type FlowItem = Out["items"]["listAll"][number];
export type FlowCapture = Out["inbox"]["list"][number];
export type FlowArea = Out["areas"]["list"][number];
export type FlowLocation = Out["rooms"]["list"][number];
export type Place = { roomId: number | null };

export const DECISIONS: { key: ItemDecision; label: string; color: string }[] = [
  { key: "keep", label: "Keep", color: "#2F7A45" },
  { key: "sell", label: "Sell", color: "#9E6A08" },
  { key: "donate", label: "Donate", color: "#2D689B" },
  { key: "toss", label: "Toss", color: "#AD432B" },
  { key: "later", label: "Later", color: "#6E7563" },
];
export const decisionMeta = (d: ItemDecision | null | undefined) => DECISIONS.find((x) => x.key === d) ?? null;

// a "Later" thing comes back into Act's queue after a week
const LATER_DAYS = 7;

/** A rejected detection is not a real thing - it never shows up for sorting or deciding. */
export const isReal = (it: FlowItem) => it.verificationStatus !== "rejected";
export const needsCheck = (it: FlowItem) => it.status === "active" && it.verificationStatus === "detected";
export const isUnplaced = (it: FlowItem) =>
  it.status === "active" && isReal(it) && !needsCheck(it) && it.roomId == null;
export const needsDecision = (it: FlowItem) => {
  if (it.status !== "active" || !isReal(it) || needsCheck(it)) return false;
  if (it.decision == null) return true;
  if (it.decision !== "later" || !it.decidedAt) return false;
  return Date.now() - new Date(it.decidedAt).getTime() > LATER_DAYS * 86_400_000;
};
export const isDecided = (it: FlowItem) => it.decision != null && it.decision !== "later";

// Selling and donating keep their state in attributes with a prefix, so it
// reads as workflow and never as a description of the thing.
export const SELL_KEYS = {
  askPrice: "sell.ask_price", // whole euros
  channel: "sell.channel",
  listedAt: "sell.listed_at", // local date
  soldPrice: "sell.sold_price", // whole euros
  soldAt: "sell.sold_at", // local date
};
export const LIST_TITLE: Record<string, string> = { sell: "Sell list", donate: "Donate box", toss: "Toss run" };
export const SELL_CHANNELS = ["Marktplaats", "Vinted", "eBay", "Facebook", "Other"];
export const DONATE_TO = "donate.to";

const EUR = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
export const euro = (n: number) => EUR.format(n);
export const num = (v: string | number | undefined | null) => {
  const n = typeof v === "number" ? v : v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Header-pill style label: "Keuken · ground". Empty when there is no such room. */
export function placeLabel(roomId: number | null, rooms: FlowLocation[] | undefined): string {
  const r = roomId != null ? rooms?.find((x) => x.id === roomId) : undefined;
  if (!r) return "";
  return r.floor ? `${r.name} · ${r.floor}` : r.name;
}

export function usableSuggestion(c: FlowCapture): TriageSuggestion | null {
  const s = c.suggestion as TriageSuggestion | null;
  return s && Array.isArray(s.items) ? s : null;
}

export const isGeojsonKey = (key: string | null | undefined) => !!key && /\.(geo)?json$/i.test(key);

// Where each capture was snapped from ("You are in ..." at the time), so a
// room sprint files its snaps into that room without asking again. Kept on
// this device only: the capture table has no place column, and this is a
// default for a later question, not a fact worth storing.
const SNAP_PLACE_KEY = "flow.snapPlace";
export function getSnapPlace(captureId: number): Place | null {
  try {
    const all = JSON.parse(localStorage.getItem(SNAP_PLACE_KEY) ?? "{}") as Record<string, Place>;
    const p = all[String(captureId)];
    // entries saved before rooms had ids carry text, not a room id - ignore them
    return p && typeof p.roomId === "number" ? { roomId: p.roomId } : null;
  } catch {
    return null;
  }
}
export function setSnapPlace(captureId: number, place: Place) {
  try {
    const all = JSON.parse(localStorage.getItem(SNAP_PLACE_KEY) ?? "{}") as Record<string, Place>;
    all[String(captureId)] = place;
    localStorage.setItem(SNAP_PLACE_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable - the Sort card just falls back to "here"
  }
}
