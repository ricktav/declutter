import path from "path";
import { describe, expect, it } from "vitest";
import { formatPlace, knownItemsForPlace, parseBatchDetectCli, resolveCapturePlace } from "../batchDetect";
import { uploadsRoot } from "../filestore";

describe("resolveCapturePlace", () => {
  it("lets a location photo's room house win over captures.houseId", () => {
    expect(
      resolveCapturePlace({ captureHouseId: 1, locationRoomId: 9, locationHouseId: 2 }),
    ).toEqual({ roomId: 9, houseId: 2 });
  });

  it("does not invent a room when the location photo has none, and keeps the capture house", () => {
    expect(
      resolveCapturePlace({ captureHouseId: 1, locationRoomId: null, locationHouseId: null }),
    ).toEqual({ roomId: null, houseId: 1 });
  });

  it("treats a missing room row as unplaced in the capture house rather than inventing a place", () => {
    expect(
      resolveCapturePlace({ captureHouseId: 1, locationRoomId: 9, locationHouseId: null }),
    ).toEqual({ roomId: null, houseId: 1 });
  });

  it("is empty when the capture has no house and no room", () => {
    expect(
      resolveCapturePlace({ captureHouseId: null, locationRoomId: null, locationHouseId: null }),
    ).toEqual({ roomId: null, houseId: null });
  });
});

describe("knownItemsForPlace", () => {
  const desk = { name: "monitor", houseId: 1, roomId: 10 };
  const kitchen = { name: "kettle", houseId: 1, roomId: 11 };
  const otherHouse = { name: "monitor", houseId: 2, roomId: 20 };
  const unplaced = { name: "loose cable", houseId: 1, roomId: null };
  const items = [desk, kitchen, otherHouse, unplaced];

  it("room-scopes so a desk capture cannot match the kitchen kettle or the other house", () => {
    expect(knownItemsForPlace(items, { houseId: 1, roomId: 10 }).map((i) => i.name)).toEqual(["monitor"]);
  });

  it("house-scopes when there is a house but no room", () => {
    expect(knownItemsForPlace(items, { houseId: 1, roomId: null }).map((i) => i.name)).toEqual([
      "monitor",
      "kettle",
      "loose cable",
    ]);
  });

  it("matches no known names when the capture has no place", () => {
    expect(knownItemsForPlace(items, { houseId: null, roomId: null })).toEqual([]);
  });
});

describe("parseBatchDetectCli", () => {
  it("defaults to dry-run with naming off, and keeps the old model flags", () => {
    expect(parseBatchDetectCli([])).toMatchObject({ apply: false, label: false, maxResults: 10 });
    expect(parseBatchDetectCli(["--model", "owlvit", "--no-florence", "--threshold", "0.12"])).toMatchObject({
      apply: false,
      model: "owlvit",
      florence: false,
      threshold: 0.12,
    });
  });

  it("requires --apply to write, and --no-label skips claude even then", () => {
    expect(parseBatchDetectCli(["--apply"]).label).toBe(true);
    expect(parseBatchDetectCli(["--apply", "--no-label"]).label).toBe(false);
    expect(parseBatchDetectCli(["--apply", "--no-claude"]).label).toBe(false);
    expect(parseBatchDetectCli(["--apply", "--dry-run"]).apply).toBe(false);
    expect(parseBatchDetectCli(["--limit", "15", "-n", "2"]).limit).toBe(15);
  });
});

describe("formatPlace", () => {
  it("says when known names will be skipped", () => {
    expect(formatPlace({ houseId: null, roomId: null })).toMatch(/no place/i);
  });
});

describe("uploadsRoot", () => {
  it("is this process's ./uploads, not a fixed production path", () => {
    expect(uploadsRoot()).toBe(path.resolve(process.cwd(), "uploads"));
  });
});
