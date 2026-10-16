import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

let h1: number;
let h2: number;

beforeEach(async () => {
  await resetTestDb();
  const db = getTestDb();
  [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  await db.insert(items).values([
    { areaId, houseId: h1, name: "Electric kettle" },
    { areaId, houseId: h1, name: "Kettle descaler" },
    { areaId, houseId: h1, name: "Old kettle", status: "archived" },
    { areaId, houseId: h1, name: "Mini PC", attributes: { brand: "Beelink", hostname: "pve" } },
    { areaId, houseId: h1, name: "100% wool blanket" },
    { areaId, houseId: h2, name: "Kettle B" },
  ]);
});

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("items.search", () => {
  it("matches names case-insensitively in the session house, prefix matches first", async () => {
    expect(names(await callerFor(h1).items.search({ q: "KETTLE" }))).toEqual(["Kettle descaler", "Electric kettle"]);
    expect(names(await callerFor(h2).items.search({ q: "kettle" }))).toEqual(["Kettle B"]);
    expect(await callerFor(null).items.search({ q: "kettle" })).toHaveLength(3);
  });

  it("searches attribute values only when asked, never keys", async () => {
    expect(await callerFor(h1).items.search({ q: "beelink" })).toEqual([]);
    expect(names(await callerFor(h1).items.search({ q: "beelink", fields: true }))).toEqual(["Mini PC"]);
    expect(await callerFor(h1).items.search({ q: "hostname", fields: true })).toEqual([]);
  });

  it("treats % and _ as text, honours the limit and ignores blank input", async () => {
    expect(names(await callerFor(h1).items.search({ q: "100%" }))).toEqual(["100% wool blanket"]);
    expect(await callerFor(h1).items.search({ q: "_" })).toEqual([]);
    expect(await callerFor(h1).items.search({ q: "e", limit: 2 })).toHaveLength(2);
    expect(await callerFor(h1).items.search({ q: "  " })).toEqual([]);
  });
});
