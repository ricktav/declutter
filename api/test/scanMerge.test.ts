import { describe, expect, it } from "vitest";
import { matchScanItems, MATCH_TOLERANCE_M, type ScanCandidate, type ScanPoly } from "../lib/scanMerge";

const poly = (kind: string, label: string, xM: number, yM: number, wM = 0.5, dM = 0.5): ScanPoly => ({ kind, label, xM, yM, wM, dM });
const thing = (id: number, name: string, scanKind: string | null, xM: number, yM: number, wM = 0.5, dM = 0.5): ScanCandidate => ({
  id, name, scanKind, pos: { xM, yM, wM, dM },
});

describe("matchScanItems", () => {
  it("identical sets match one to one with movedM 0", () => {
    const r = matchScanItems(
      [thing(1, "Stove", "stove", 1, 1, 0.6, 0.6), thing(2, "Sink", "sink", 3, 1)],
      [poly("stove", "Stove", 1, 1, 0.6, 0.6), poly("sink", "Sink", 3, 1)],
    );
    expect(r.matched.map((m) => [m.itemId, m.poly.kind, m.movedM])).toEqual([[1, "stove", 0], [2, "sink", 0]]);
    expect(r.unmatchedPolys).toEqual([]);
    expect(r.missingItemIds).toEqual([]);
  });

  it("a poly shifted within tolerance matches and reports the distance", () => {
    const r = matchScanItems([thing(1, "Smeg fornuis", "stove", 1, 1)], [poly("stove", "Stove", 1.3, 1.4)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].itemId).toBe(1);
    expect(r.matched[0].movedM).toBeCloseTo(0.5, 3);
    expect(r.missingItemIds).toEqual([]);
  });

  it("a poly shifted beyond tolerance is new and the Thing is missing", () => {
    const r = matchScanItems([thing(1, "Stove", "stove", 1, 1)], [poly("stove", "Stove", 1 + MATCH_TOLERANCE_M + 0.1, 1)]);
    expect(r.matched).toEqual([]);
    expect(r.unmatchedPolys).toHaveLength(1);
    expect(r.missingItemIds).toEqual([1]);
  });

  it("a big Thing gets half its diagonal as tolerance", () => {
    // 3 x 2 m table: diagonal 3.6 m, so a 1.5 m shift still matches
    const r = matchScanItems([thing(1, "Table", "table", 0, 0, 3, 2)], [poly("table", "Table", 1.5, 0, 3, 2)]);
    expect(r.matched.map((m) => m.itemId)).toEqual([1]);
  });

  it("a different kind never matches, even on the same spot", () => {
    const r = matchScanItems([thing(1, "Stove", "stove", 1, 1)], [poly("oven", "Oven", 1, 1)]);
    expect(r.matched).toEqual([]);
    expect(r.missingItemIds).toEqual([1]);
  });

  it("two chairs 0.6 m apart each match their own poly, never both to one", () => {
    const things = [thing(1, "Chair", "chair", 0, 0), thing(2, "Chair 2", "chair", 0.6, 0)];
    const same = matchScanItems(things, [poly("chair", "Chair", 0.6, 0), poly("chair", "Chair", 0, 0)]);
    expect(same.matched.map((m) => [m.itemId, m.poly.xM, m.movedM]).sort()).toEqual([[1, 0, 0], [2, 0.6, 0]]);
    // both shifted 0.3 m to the right: the tie must still give two distinct matches
    const shifted = matchScanItems(things, [poly("chair", "Chair", 0.3, 0), poly("chair", "Chair", 0.9, 0)]);
    expect(new Set(shifted.matched.map((m) => m.itemId)).size).toBe(2);
    expect(new Set(shifted.matched.map((m) => m.poly.xM)).size).toBe(2);
    expect(shifted.unmatchedPolys).toEqual([]);
    expect(shifted.missingItemIds).toEqual([]);
  });

  it("greedy's nearest pair does not strand the other chair", () => {
    // right chair's nearest new poly is the left chair's only option
    const r = matchScanItems(
      [thing(1, "Chair", "chair", 0, 0), thing(2, "Chair 2", "chair", 0.6, 0)],
      [poly("chair", "Chair", 0.32, 0), poly("chair", "Chair", 0.95, 0)],
    );
    expect(r.matched.map((m) => [m.itemId, m.poly.xM])).toEqual([[1, 0.32], [2, 0.95]]);
    expect(r.matched.map((m) => m.movedM)).toEqual([0.32, 0.35]);
    expect(r.missingItemIds).toEqual([]);
  });

  it("one chair poly for two chair Things: the nearer matches, the other is missing", () => {
    const r = matchScanItems([thing(1, "Chair", "chair", 0, 0), thing(2, "Chair 2", "chair", 0.6, 0)], [poly("chair", "Chair", 0.5, 0)]);
    expect(r.matched.map((m) => m.itemId)).toEqual([2]);
    expect(r.missingItemIds).toEqual([1]);
  });

  it("a legacy Thing without scan_kind matches by its name without the counter", () => {
    const r = matchScanItems([thing(7, "Chair 2", null, 2, 2)], [poly("chair", "Chair", 2.1, 2)]);
    expect(r.matched.map((m) => m.itemId)).toEqual([7]);
  });

  it("an unmatched legacy scan Thing is missing", () => {
    const r = matchScanItems([thing(7, "chair 3", null, 2, 2)], []);
    expect(r.missingItemIds).toEqual([7]);
  });

  it("a hand-placed Thing (no scan_kind, unrelated name) is never matched or missing", () => {
    const r = matchScanItems([thing(9, "Grandma's vase", null, 1, 1)], [poly("chair", "Chair", 1, 1)]);
    expect(r.matched).toEqual([]);
    expect(r.unmatchedPolys).toHaveLength(1);
    expect(r.missingItemIds).toEqual([]);
  });

  it("a Thing without a position is ignored", () => {
    const r = matchScanItems([{ id: 3, name: "Stove", scanKind: "stove", pos: null }], [poly("stove", "Stove", 1, 1)]);
    expect(r.matched).toEqual([]);
    expect(r.unmatchedPolys).toHaveLength(1);
    expect(r.missingItemIds).toEqual([]);
  });
});
