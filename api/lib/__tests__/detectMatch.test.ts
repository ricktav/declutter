import { describe, expect, it } from "vitest";
import {
  detectInventoryPrompt,
  matchDetectedItem,
  nameScore,
  normalizeDetectBox,
  pickDetectHouseId,
} from "../detectMatch";

const josies = { id: 90, name: "pink cat night light", houseId: 4, description: null };
const cardReader = {
  id: 173,
  name: "Card reader / bank authenticator with keypad",
  houseId: 2,
  description: null,
};
const table5 = { id: 133, name: "Table 5", houseId: 2, description: null };
const kinderTable = { id: 200, name: "children's table", houseId: 4, description: null };

describe("pickDetectHouseId", () => {
  it("uses the photo's room house over an explicit Focus house", () => {
    expect(pickDetectHouseId({ photoHouseId: 4, explicitHouseId: 2, captureHouseId: 2 })).toBe(4);
  });
  it("falls back to explicit then capture when the photo has no Place", () => {
    expect(pickDetectHouseId({ photoHouseId: null, explicitHouseId: 4 })).toBe(4);
    expect(pickDetectHouseId({ captureHouseId: 2 })).toBe(2);
    expect(pickDetectHouseId({})).toBeNull();
  });
});

describe("matchDetectedItem house scope", () => {
  it("does not link a Kinderkamer greeting card to a Thuis RT card reader", () => {
    // live miss: nameScore is 0.5 because both share "card"; inventory must
    // already exclude the other house so the pin stays label-only
    expect(nameScore("greeting card", cardReader.name)).toBe(0.5);
    expect(matchDetectedItem("greeting card", cardReader.id, [josies])).toEqual({
      itemId: null,
      via: null,
      score: 0,
    });
    expect(matchDetectedItem("greeting card", null, [josies])).toMatchObject({ itemId: null });
  });

  it("does not name-match a red children's table to Table 5 in another house", () => {
    expect(nameScore("red children's table", table5.name)).toBe(1);
    expect(matchDetectedItem("red children's table", null, [josies, kinderTable]).itemId).toBe(kinderTable.id);
    expect(matchDetectedItem("red children's table", table5.id, [josies, kinderTable]).itemId).toBe(kinderTable.id);
  });

  it("accepts a visual match only when that id is in the scoped inventory", () => {
    expect(matchDetectedItem("pink cat", josies.id, [josies])).toEqual({
      itemId: josies.id,
      via: "visual",
      score: 1,
    });
    expect(matchDetectedItem("pink cat", josies.id, [])).toEqual({ itemId: null, via: null, score: 0 });
  });

  it("skips inventory match when the photo has no house", () => {
    expect(matchDetectedItem("Card reader / bank authenticator with keypad", cardReader.id, [])).toEqual({
      itemId: null,
      via: null,
      score: 0,
    });
  });
});

describe("detectInventoryPrompt", () => {
  it("tells the model not to invent a match when nothing is in scope", () => {
    expect(detectInventoryPrompt([])).toMatch(/Leave matchedItemId null/);
  });
});

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
