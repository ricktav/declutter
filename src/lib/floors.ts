/** Generic Dutch floors shown only when a house has none yet. */
export const DUTCH_FLOOR_DEFAULTS = [
  "kelder",
  "begane grond",
  "1ste verdieping",
  "2de verdieping",
  "3de verdieping",
  "zolder",
];

/** Sort rank: Dutch names plus English aliases that may still exist in data. */
const FLOOR_RANK_ORDER = [
  "kelder",
  "basement",
  "begane grond",
  "ground",
  "1ste verdieping",
  "1",
  "2de verdieping",
  "2",
  "3de verdieping",
  "3",
  "zolder",
  "attic",
];

const RANK = new Map(FLOOR_RANK_ORDER.map((f, i) => [f.toLowerCase(), i]));

export function sortFloorNames(floors: string[]): string[] {
  return [...new Set(floors)].sort((a, b) => {
    const ra = RANK.get(a.toLowerCase()) ?? 1000;
    const rb = RANK.get(b.toLowerCase()) ?? 1000;
    return ra - rb || a.localeCompare(b);
  });
}

/** Suggestions for a house: its used floors, or Dutch defaults if it has none. */
export function floorDatalist(existing: string[]): string[] {
  const used = [...new Set(existing.map((s) => s.trim()).filter(Boolean))];
  if (used.length === 0) return [...DUTCH_FLOOR_DEFAULTS];
  return sortFloorNames(used);
}
