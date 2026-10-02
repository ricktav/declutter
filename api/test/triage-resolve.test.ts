import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { resolveSuggestion } from "../routers/inbox";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", source: "manual" }).$returningId();
  return { db, h1, areaId, keuken };
}

const obj = (room: string | null, matchedItemId: number | null = null) => ({
  note: "n",
  floor: null,
  room,
  items: [{ itemName: "pan", areaSlug: "x", matchedItemId, isNewItem: matchedItemId == null, attributes: {}, confidence: "high" as const }],
});

describe("resolveSuggestion roomId", () => {
  it("matches room text case-insensitively within the house", async () => {
    const { h1, keuken } = await seed();
    expect((await resolveSuggestion(obj("keuken"), h1)).roomId).toBe(keuken);
  });
  it("is null without a house", async () => {
    await seed();
    expect((await resolveSuggestion(obj("keuken"), null)).roomId).toBeNull();
  });
  it("falls back to the matched item's room when no room text", async () => {
    const { db, h1, areaId, keuken } = await seed();
    const [{ id }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId: keuken }).$returningId();
    expect((await resolveSuggestion(obj(null, id), h1)).roomId).toBe(keuken);
  });
});

describe("resolveSuggestion roomId is house-scoped", () => {
  it("does not take a room from a matched item in another house", async () => {
    const { db, h1, areaId } = await seed();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: hal }] = await db.insert(rooms).values({ houseId: h2, name: "Hal", source: "manual" }).$returningId();
    const [{ id }] = await db.insert(items).values({ areaId, name: "pan", houseId: h2, roomId: hal }).$returningId();
    expect((await resolveSuggestion(obj(null, id), h1)).roomId).toBeNull();
    expect((await resolveSuggestion(obj(null, id), null)).roomId).toBeNull();
    expect((await resolveSuggestion(obj(null, id), h2)).roomId).toBe(hal);
  });
});
