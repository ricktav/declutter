import { describe, expect, it } from "vitest";
import { parseHouseId } from "../houseContext";

describe("parseHouseId", () => {
  it("returns null without the header", () => {
    expect(parseHouseId(new Headers())).toBeNull();
  });
  it("parses a positive integer", () => {
    expect(parseHouseId(new Headers({ "x-house-id": "2" }))).toBe(2);
  });
  it("rejects garbage, zero and negatives", () => {
    expect(parseHouseId(new Headers({ "x-house-id": "abc" }))).toBeNull();
    expect(parseHouseId(new Headers({ "x-house-id": "0" }))).toBeNull();
    expect(parseHouseId(new Headers({ "x-house-id": "-3" }))).toBeNull();
  });
});
