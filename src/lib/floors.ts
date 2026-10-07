import { DEFAULT_FLOORS } from "@/components/RoomPicker";

/** Common floor names (Dutch + the RoomPicker defaults) for Map/edit datalists. */
export const FLOOR_SUGGESTIONS = [
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

const RANK = new Map(
  [...FLOOR_SUGGESTIONS, ...DEFAULT_FLOORS.filter((f) => !FLOOR_SUGGESTIONS.includes(f))].map((f, i) => [
    f.toLowerCase(),
    i,
  ]),
);

export function sortFloorNames(floors: string[]): string[] {
  return [...new Set(floors)].sort((a, b) => {
    const ra = RANK.get(a.toLowerCase()) ?? 1000;
    const rb = RANK.get(b.toLowerCase()) ?? 1000;
    return ra - rb || a.localeCompare(b);
  });
}

export function floorDatalist(existing: string[]): string[] {
  return sortFloorNames([...FLOOR_SUGGESTIONS, ...existing.filter(Boolean)]);
}
