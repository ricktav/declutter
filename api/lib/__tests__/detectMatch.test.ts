import { describe, expect, it } from "vitest";
import { normalizeDetectBox } from "../detectMatch";

describe("normalizeDetectBox vs FramedRoomPhoto centre+size overlay", () => {
  it("keeps a valid centre box unchanged (pink cat 48/63/6/6)", () => {
    expect(normalizeDetectBox({ xPct: 48, yPct: 63, wPct: 6, hPct: 6 })).toEqual({
      xPct: 48,
      yPct: 63,
      wPct: 6,
      hPct: 6,
    });
  });

  it("treats 0–1 fractions as percents", () => {
    expect(normalizeDetectBox({ xPct: 0.48, yPct: 0.63, wPct: 0.12, hPct: 0.1 })).toEqual({
      xPct: 48,
      yPct: 63,
      wPct: 12,
      hPct: 10,
    });
  });

  it("converts top-left (x,y) to centre when that is the only reading that fits", () => {
    // top-left at 10,20 size 40×30 fits; as centre the box would go off the left/top
    expect(normalizeDetectBox({ xPct: 10, yPct: 20, wPct: 40, hPct: 30 })).toEqual({
      xPct: 30,
      yPct: 35,
      wPct: 40,
      hPct: 30,
    });
  });

  it("shifts a hanging-off-edge centre box fully onto the image", () => {
    // overflows as both centre and top-left, so this is clamp not conversion
    expect(normalizeDetectBox({ xPct: 90, yPct: 90, wPct: 40, hPct: 40 })).toEqual({
      xPct: 80,
      yPct: 80,
      wPct: 40,
      hPct: 40,
    });
  });

  it("drops missing or zero-size boxes", () => {
    expect(normalizeDetectBox({ xPct: 50, yPct: 50 })).toBeNull();
    expect(normalizeDetectBox({ xPct: 50, yPct: 50, wPct: 0, hPct: 10 })).toBeNull();
  });
});
