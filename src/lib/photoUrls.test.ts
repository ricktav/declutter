import { describe, expect, it } from "vitest";
import { chunkKeys } from "./photoUrls";

describe("chunkKeys", () => {
  it("drops empties, dedupes and keeps order", () => {
    expect(chunkKeys(["a", null, "", "b", "a", undefined])).toEqual([["a", "b"]]);
  });
  it("splits at the server limit of 200", () => {
    const keys = Array.from({ length: 401 }, (_, i) => `k${i}`);
    const chunks = chunkKeys(keys);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 1]);
  });
  it("returns no chunks for no keys", () => {
    expect(chunkKeys([])).toEqual([]);
  });
});
