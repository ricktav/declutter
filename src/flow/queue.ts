import { useMemo } from "react";
import { useFlow } from "./context";
import { isGeojsonKey, isReal, isUnplaced, needsCheck, type FlowCapture, type FlowItem } from "./data";
import { backupState, inLab, needsLabDetails } from "./lenses";

export type Card =
  | { key: string; kind: "capture"; capture: FlowCapture }
  | { key: string; kind: "check"; item: FlowItem }
  | { key: string; kind: "lab"; item: FlowItem }
  | { key: string; kind: "backup"; item: FlowItem }
  | { key: string; kind: "place"; item: FlowItem };
export type Filter = "all" | "capture" | "check" | "lab" | "place";
export const filterOf = (c: Card): Filter => (c.kind === "backup" ? "lab" : c.kind);

/**
 * The Sort queue, shared with the tab badge. With the lab lens on, only lab
 * things get check and place cards, and two lab questions join the line:
 * "What device is it?" and "Is it backed up?".
 */
export function useSortCards(): Card[] {
  const { items, captures, backups, lens } = useFlow();
  return useMemo<Card[]>(() => {
    // photos first (the common case), notes/links next, floor scans last -
    // a scan can only be imported in the Workbench, so it must not block the line
    const rank = (x: FlowCapture) =>
      x.kind === "scan" || isGeojsonKey(x.storageKey) ? 2 : x.kind === "image" ? 0 : 1;
    const c: Card[] = captures
      .filter((x) => x.status === "pending")
      .sort((a, b) => rank(a) - rank(b))
      .map((capture) => ({ key: `c${capture.id}`, kind: "capture", capture }));
    const lab = lens === "lab";
    const scoped = lab ? items.filter(inLab) : items;
    const k: Card[] = scoped.filter(needsCheck).map((item) => ({ key: `k${item.id}`, kind: "check", item }));
    const ready = scoped.filter((it) => lab && it.status === "active" && isReal(it) && !needsCheck(it));
    const d: Card[] = ready.filter(needsLabDetails).map((item) => ({ key: `d${item.id}`, kind: "lab", item }));
    const b: Card[] = ready
      .filter((it) => backupState(it, backups) === "missing")
      .map((item) => ({ key: `b${item.id}`, kind: "backup", item }));
    const p: Card[] = scoped.filter(isUnplaced).map((item) => ({ key: `p${item.id}`, kind: "place", item }));
    return [...c, ...k, ...d, ...b, ...p];
  }, [captures, items, backups, lens]);
}

