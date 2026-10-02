import { beforeEach, describe, expect, it } from "vitest";
import { areas, attachments, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

describe("houses.impact / reassign count photos by room or item", () => {
  it("counts a cutout and a location photo, and follows them to the new house", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const [{ id: roomId }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", source: "manual" }).$returningId();
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId }).$returningId();
    await db.insert(attachments).values({ itemId, areaId, kind: "image", storageKey: "local/a.jpg" });
    await db.insert(attachments).values({ roomId, kind: "image", storageKey: "local/b.jpg" });

    const c = callerFor(h1);
    expect(await c.houses.impact({ id: h1 })).toEqual({ itemCount: 1, photoCount: 2 });
    expect(await c.houses.reassign({ fromId: h1, toId: h2 })).toEqual({ itemCount: 1, photoCount: 2 });
    expect(await c.houses.impact({ id: h1 })).toEqual({ itemCount: 0, photoCount: 0 });
    expect(await c.houses.impact({ id: h2 })).toEqual({ itemCount: 1, photoCount: 2 });
  });
});
