import { describe, expect, it } from "vitest";
import { itemMatchesQuery } from "../../../src/lib/itemSearch";

const laptop = {
  name: "laptop",
  description: "spare charger in the drawer",
  status: "active",
  verificationStatus: "confirmed",
  decision: "donate",
  attributes: { serial: "SN-88421", "lab.notes": "wiped yesterday", ram_gb: 16 },
  room: { name: "Keuken", floor: "ground" },
  areaName: "Computers",
};

const lamp = {
  name: "lamp",
  description: "brass",
  status: "active",
  verificationStatus: "confirmed",
  decision: null,
  attributes: { color: "brass" },
  room: null,
  areaName: "Home",
};

describe("itemMatchesQuery", () => {
  it("hits an attribute value, a workflow key, the description and the Decision", () => {
    expect(itemMatchesQuery(laptop, "SN-88421")).toBe(true);
    expect(itemMatchesQuery(laptop, "lab.notes")).toBe(true);
    expect(itemMatchesQuery(laptop, "wiped")).toBe(true);
    expect(itemMatchesQuery(laptop, "charger")).toBe(true);
    expect(itemMatchesQuery(laptop, "donate")).toBe(true);
    expect(itemMatchesQuery(laptop, "16")).toBe(true);
  });

  it("hits the Place name and keeps a non-matching Thing out", () => {
    expect(itemMatchesQuery(laptop, "keuken")).toBe(true);
    expect(itemMatchesQuery(lamp, "keuken")).toBe(false);
    expect(itemMatchesQuery(lamp, "SN-88421")).toBe(false);
    expect(itemMatchesQuery(lamp, "charger")).toBe(false);
    expect(itemMatchesQuery(laptop, "brass")).toBe(false);
  });

  it("matches status and verification only as a whole word", () => {
    const plain = {
      name: "lamp",
      description: "brass",
      status: "active" as const,
      verificationStatus: "confirmed" as const,
      attributes: { hue: "brass" },
      areaName: "Home",
    };
    expect(itemMatchesQuery(plain, "c")).toBe(false);
    expect(itemMatchesQuery(plain, "active")).toBe(true);
    expect(itemMatchesQuery(plain, "confirmed")).toBe(true);
  });

  it("treats a blank query as no filter and requires every word", () => {
    expect(itemMatchesQuery(lamp, "  ")).toBe(true);
    expect(itemMatchesQuery(laptop, "keuken charger")).toBe(true);
    expect(itemMatchesQuery(laptop, "keuken brass")).toBe(false);
  });
});
