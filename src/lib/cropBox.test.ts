import { describe, expect, it } from "vitest";
import { DEFAULT_CROP_BOX, boxesEqual, frameRect } from "./cropBox";

describe("frameRect", () => {
  it("turns a centre+size box into a top-left rect in percent", () => {
    expect(frameRect({ xPct: 50, yPct: 50, wPct: 40, hPct: 20 })).toEqual({ left: 30, top: 40, width: 40, height: 20 });
  });
  it("lets a frame reach the left edge exactly", () => {
    expect(frameRect({ xPct: 10, yPct: 10, wPct: 20, hPct: 20 }).left).toBe(0);
  });
});
describe("boxesEqual", () => {
  it("compares the four fields", () => {
    expect(boxesEqual(DEFAULT_CROP_BOX, { ...DEFAULT_CROP_BOX })).toBe(true);
    expect(boxesEqual(DEFAULT_CROP_BOX, { ...DEFAULT_CROP_BOX, wPct: 41 })).toBe(false);
  });
});
