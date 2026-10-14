import { describe, expect, it } from "vitest";
import {
  discardDetection,
  framesOnPhoto,
  hiddenExistingCount,
  isExistingSuggestedPin,
  isMatchedOpenSuggestion,
  toggleSelection,
  visibleDetections,
} from "../../../src/lib/detectFrames";

type Row = { key: string; matchedItemId: number | null; state: "open" | "filed" | "dismissed"; itemId?: number | null };

const rows: Row[] = [
  { key: "new", matchedItemId: null, state: "open" },
  { key: "known", matchedItemId: 12, state: "open" },
  { key: "filed", matchedItemId: 3, state: "filed" },
];

describe("detect frame selection", () => {
  it("selects a key and clears it when clicked again", () => {
    expect(toggleSelection(null, "known")).toBe("known");
    expect(toggleSelection("known", "known")).toBeNull();
    expect(toggleSelection("known", "new")).toBe("new");
  });

  it("hides every other frame while one detection is selected", () => {
    const visible = visibleDetections(rows, false, isMatchedOpenSuggestion);
    expect(visible.map((r) => r.key)).toEqual(["new", "filed"]);
    expect(framesOnPhoto(visible, "new", (r) => r.key).map((r) => r.key)).toEqual(["new"]);
    expect(framesOnPhoto(visible, null, (r) => r.key).map((r) => r.key)).toEqual(["new", "filed"]);
  });

  it("counts existing detections hidden until Show all", () => {
    expect(hiddenExistingCount(rows, isMatchedOpenSuggestion)).toBe(1);
    expect(visibleDetections(rows, true, isMatchedOpenSuggestion).map((r) => r.key)).toEqual(["new", "known", "filed"]);
  });

  it("discards a detection without touching the others, and clears selection when it was selected", () => {
    expect(discardDetection(rows, "known", "known", (r) => r.key)).toEqual({
      rows: [
        { key: "new", matchedItemId: null, state: "open" },
        { key: "filed", matchedItemId: 3, state: "filed" },
      ],
      selectedKey: null,
    });
    expect(discardDetection(rows, "new", "known", (r) => r.key).selectedKey).toBe("known");
  });

  it("treats a linked pin or a duplicate-of-existing-pin as already existing", () => {
    expect(isExistingSuggestedPin({ itemId: 9 }, false)).toBe(true);
    expect(isExistingSuggestedPin({ itemId: null }, true)).toBe(true);
    expect(isExistingSuggestedPin({ itemId: null }, false)).toBe(false);
  });
});
