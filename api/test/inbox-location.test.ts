import { beforeEach, describe, expect, it } from "vitest";
import { areas, captures, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: capId }] = await db.insert(captures).values({ kind: "note", rawText: "a pan and a pot" }).$returningId();
  return { db, h1, areaId, keuken, capId };
}

describe("inbox.acceptMany", () => {
  it("files new items into the given room with the room's house", async () => {
    const { db, h1, areaId, keuken, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({
      id: capId,
      roomId: keuken,
      items: [
        { areaId, itemId: null, itemName: "pan" },
        { areaId, itemId: null, itemName: "pot" },
      ],
    });
    const rows = await db.select().from(items);
    expect(rows.map((r) => [r.roomId, r.houseId])).toEqual([[keuken, h1], [keuken, h1]]);
  });
  it("without a room, new items are unplaced in the context house", async () => {
    const { db, h1, areaId, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: null, itemName: "pan" }] });
    const [row] = await db.select().from(items);
    expect([row.roomId, row.houseId]).toEqual([null, h1]);
  });
});

describe("inbox.importGeojson input handling", () => {
  it("needs a room id or name", async () => {
    const { h1, capId } = await seed();
    await expect(callerFor(h1).inbox.importGeojson({ captureId: capId })).rejects.toThrow();
  });
  it("unknown roomId", async () => {
    const { h1, capId } = await seed();
    await expect(callerFor(h1).inbox.importGeojson({ captureId: capId, roomId: 999999 })).rejects.toThrow(/Room not found/);
  });
  it("roomName without any house", async () => {
    const { capId } = await seed();
    await expect(callerFor(null).inbox.importGeojson({ captureId: capId, roomName: "Nieuw" })).rejects.toThrow(/Pick a house first/);
  });
});
