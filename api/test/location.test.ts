// api/test/location.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { ensureRoom, setItemLocation } from "../lib/location";

beforeEach(async () => {
  await resetTestDb();
});

describe("ensureRoom", () => {
  it("creates once and then finds, ignoring case and surrounding whitespace", async () => {
    const db = getTestDb();
    const [{ id: houseId }] = await db.insert(houses).values({ name: "H" }).$returningId();
    const a = await ensureRoom(db, { houseId, name: "Keuken", floor: "ground" });
    const b = await ensureRoom(db, { houseId, name: "  keuken " });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(await db.select().from(rooms)).toHaveLength(1);
  });
  it("refuses an empty name", async () => {
    const db = getTestDb();
    const [{ id: houseId }] = await db.insert(houses).values({ name: "H" }).$returningId();
    await expect(ensureRoom(db, { houseId, name: "   " })).rejects.toThrow(/name/);
  });
});

describe("setItemLocation", () => {
  it("putting an item in a room sets houseId to the room's house, even across houses", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "lamp", houseId: h1 }).$returningId();
    const room = await ensureRoom(db, { houseId: h2, name: "Hal" });

    await setItemLocation(db, itemId, { roomId: room.id });
    const [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect(it.roomId).toBe(room.id);
    expect(it.houseId).toBe(h2);
  });
  it("unplacing keeps the house; clearing the house clears both", async () => {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const room = await ensureRoom(db, { houseId: h1, name: "Hal" });
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "lamp", roomId: room.id, houseId: h1 }).$returningId();

    await setItemLocation(db, itemId, { roomId: null, houseId: h1 });
    let [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect([it.roomId, it.houseId]).toEqual([null, h1]);

    await setItemLocation(db, itemId, { roomId: null, houseId: null });
    [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect([it.roomId, it.houseId]).toEqual([null, null]);
  });
  it("rejects a room id that does not exist", async () => {
    const db = getTestDb();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "lamp" }).$returningId();
    await expect(setItemLocation(db, itemId, { roomId: 999 })).rejects.toThrow(/room/i);
  });
});
