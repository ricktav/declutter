import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items, photos, rooms } from "@db/schema";
import { eq } from "drizzle-orm";
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
    await db.insert(photos).values({ itemId, areaId, storageKey: "local/test-fake-a.jpg" });
    await db.insert(photos).values({ roomId, storageKey: "local/test-fake-b.jpg" });

    const c = callerFor(h1);
    expect(await c.houses.impact({ id: h1 })).toEqual({ itemCount: 1, photoCount: 2 });
    expect(await c.houses.reassign({ fromId: h1, toId: h2 })).toEqual({ itemCount: 1, photoCount: 2 });
    expect(await c.houses.impact({ id: h1 })).toEqual({ itemCount: 0, photoCount: 0 });
    expect(await c.houses.impact({ id: h2 })).toEqual({ itemCount: 1, photoCount: 2 });
  });
});

describe("houses.reassign with same-named rooms", () => {
  async function two() {
    const db = getTestDb();
    const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const [{ id: k1 }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", source: "manual" }).$returningId();
    const [{ id: k2 }] = await db.insert(rooms).values({ houseId: h2, name: "keuken", source: "manual" }).$returningId();
    await db.insert(items).values([
      { areaId, name: "pan", houseId: h1, roomId: k1 },
      { areaId, name: "pot", houseId: h2, roomId: k2 },
    ]);
    return { db, h1, h2, k1, k2 };
  }
  it("merges a geometry-less source room into the target's same-named room", async () => {
    const { db, h1, h2, k2 } = await two();
    await callerFor(h1).houses.reassign({ fromId: h1, toId: h2 });
    const rs = await db.select().from(rooms);
    expect(rs).toHaveLength(1);
    expect(rs[0].id).toBe(k2);
    const its = await db.select().from(items);
    expect(its.every((i) => i.roomId === k2 && i.houseId === h2)).toBe(true);
    expect(its).toHaveLength(2);
  });
  it("rejects when both same-named rooms have a plan, writing nothing", async () => {
    const { db, h1, h2, k1, k2 } = await two();
    await db.update(rooms).set({ walls: [] }).where(eq(rooms.id, k1));
    await db.update(rooms).set({ walls: [] }).where(eq(rooms.id, k2));
    await expect(callerFor(h1).houses.reassign({ fromId: h1, toId: h2 })).rejects.toThrow(/with a plan/);
    expect(await db.select().from(rooms)).toHaveLength(2);
  });
  it("moves the plan over when only the source room has one", async () => {
    const { db, h1, h2, k1, k2 } = await two();
    await db.update(rooms).set({ walls: [{ points: [[0, 0], [1, 0]] }], widthM: 2 }).where(eq(rooms.id, k1));
    await callerFor(h1).houses.reassign({ fromId: h1, toId: h2 });
    const [r] = await db.select().from(rooms).where(eq(rooms.id, k2));
    expect(r.walls).toHaveLength(1);
    expect(r.widthM).toBe(2);
  });
});
