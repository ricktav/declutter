import type { ItemDecision } from "@db/schema";

export const DECISIONS: { key: ItemDecision; label: string; color: string }[] = [
  { key: "keep", label: "Keep", color: "#2F7A45" },
  { key: "sell", label: "Sell", color: "#9E6A08" },
  { key: "donate", label: "Donate", color: "#2D689B" },
  { key: "toss", label: "Toss", color: "#AD432B" },
  { key: "later", label: "Later", color: "#6E7563" },
];
