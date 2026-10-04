// api/test/rooms.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, events, houses, items, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: zolder }] = await db.insert(rooms).values({ houseId: h1, name: "Zolder", floor: "attic", source: "manual" }).$returningId();
  const [{ id: hal }] = await db.insert(rooms).values({ houseId: h2, name: "Hal", source: "manual" }).$returningId();
  await db.insert(items).values([
    { areaId, name: "pan", houseId: h1, roomId: keuken },
    { areaId, name: "pot", houseId: h1, roomId: keuken },
    { areaId, name: "box", houseId: h1, roomId: zolder },
    { areaId, name: "coat", houseId: h2, roomId: hal },
  ]);
  return { db, h1, h2, areaId, keuken, zolder, hal };
}

describe("rooms.list", () => {
  it("defaults to the context house, sorted by floor then name, with counts and geometry flag", async () => {
    const { h1 } = await seed();
    const rows = await callerFor(h1).rooms.list();
    expect(rows.map((r) => [r.name, r.floor, r.itemCount, r.hasGeometry])).toEqual([
      ["Zolder", "attic", 1, false],
      ["Keuken", "ground", 2, false],
    ]);
  });
  it("returns every house's rooms with no context and no input", async () => {
    await seed();
    expect(await callerFor(null).rooms.list()).toHaveLength(3);
  });
  it("explicit houseId beats the context", async () => {
    const { h1, h2 } = await seed();
    expect((await callerFor(h1).rooms.list({ houseId: h2 })).map((r) => r.name)).toEqual(["Hal"]);
  });
});

describe("rooms.ensure / create", () => {
  it("ensure returns the existing room for a case-variant name", async () => {
    const { h1, keuken } = await seed();
    const r = await callerFor(h1).rooms.ensure({ name: "keuken" });
    expect(r).toEqual({ id: keuken, created: false });
  });
  it("create refuses a duplicate with a readable message", async () => {
    const { h1 } = await seed();
    await expect(callerFor(h1).rooms.create({ name: "Keuken" })).rejects.toThrow(/already exists/);
  });
  it("ensure without a house anywhere is an error", async () => {
    await seed();
    await expect(callerFor(null).rooms.ensure({ name: "Nieuw" })).rejects.toThrow(/house/i);
  });
});

describe("rooms.update", () => {
  it("renaming a room moves nothing and logs an event; floor can be cleared", async () => {
    const { db, h1, keuken } = await seed();
    await callerFor(h1).rooms.update({ id: keuken, name: "Kitchen", floor: null });
    const [room] = await db.select().from(rooms).where(eq(rooms.id, keuken));
    expect([room.name, room.floor]).toEqual(["Kitchen", null]);
    const inRoom = await db.select().from(items).where(eq(items.roomId, keuken));
    expect(inRoom).toHaveLength(2);
  });
});

describe("rooms.update size", () => {
  it("sets width and depth; rooms.list and rooms.get show them; the event says the size", async () => {
    const { db, h1, keuken } = await seed();
    const api = callerFor(h1);
    await api.rooms.update({ id: keuken, widthM: 3.5, depthM: 4 });
    expect((await api.rooms.list()).find((r) => r.id === keuken)).toMatchObject({ widthM: 3.5, depthM: 4 });
    expect(await api.rooms.get({ id: keuken })).toMatchObject({ widthM: 3.5, depthM: 4 });
    const ev = await db.select().from(events).where(eq(events.entityType, "room"));
    expect(ev.at(-1)?.summary).toBe('Room "Keuken" size set to 3.5×4 m');

    // clearing one side is allowed; zero and absurd sizes are not
    await api.rooms.update({ id: keuken, depthM: null });
    expect(await api.rooms.get({ id: keuken })).toMatchObject({ widthM: 3.5, depthM: null });
    await expect(api.rooms.update({ id: keuken, widthM: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.rooms.update({ id: keuken, depthM: 101 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("rooms.update duplicate", () => {
  it("renaming to another room's name (case-variant) is a readable conflict", async () => {
    const { h1, zolder } = await seed();
    await expect(callerFor(h1).rooms.update({ id: zolder, name: "KEUKEN" })).rejects.toThrow(/already exists/);
  });
});

describe("rooms.merge", () => {
  it("moves items and location photos, then deletes the source", async () => {
    const { db, h1, keuken, zolder } = await seed();
    await db.insert(photos).values({ roomId: zolder, title: "photo", storageKey: "local/test-fake-merge.jpg" });
    const r = await callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken });
    expect(r).toEqual({ ok: true, itemsMoved: 1, photosMoved: 1 });
    expect(await db.select().from(rooms)).toHaveLength(2);
    expect(await db.select().from(items).where(eq(items.roomId, keuken))).toHaveLength(3);
  });
  it("refuses when both rooms carry geometry", async () => {
    const { db, h1, keuken, zolder } = await seed();
    await db.update(rooms).set({ walls: [] }).where(eq(rooms.id, keuken));
    await db.update(rooms).set({ walls: [] }).where(eq(rooms.id, zolder));
    await expect(callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken })).rejects.toThrow(/geometry/);
  });
  it("carries geometry over when only the source has it", async () => {
    const { db, h1, keuken, zolder } = await seed();
    await db.update(rooms).set({ walls: [{ points: [[0, 0], [1, 0]] }], widthM: 1, depthM: 1 }).where(eq(rooms.id, zolder));
    await callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken });
    const [room] = await db.select().from(rooms).where(eq(rooms.id, keuken));
    expect(room.walls).toHaveLength(1);
    expect(room.widthM).toBe(1);
  });
  it("refuses to merge across houses", async () => {
    const { h1, keuken, hal } = await seed();
    await expect(callerFor(h1).rooms.merge({ fromId: hal, toId: keuken })).rejects.toThrow(/same house/);
  });
});

describe("rooms.remove", () => {
  it("refuses a room with items unless forced, and forced items stay in the house unplaced", async () => {
    const { db, h1, keuken } = await seed();
    await expect(callerFor(h1).rooms.remove({ id: keuken })).rejects.toThrow(/2 item/);
    await callerFor(h1).rooms.remove({ id: keuken, force: true });
    const rows = await db.select().from(items).where(eq(items.houseId, h1));
    expect(rows.filter((r) => r.roomId == null)).toHaveLength(2);
  });
});

describe("rooms.merge pos and self-parent guards", () => {
  const pos = { xM: 1, yM: 1, wM: 1, dM: 1, rotDeg: 0 };
  it("rebases pos when a cut child is merged into its parent", async () => {
    const { db, h1, zolder, keuken, areaId } = await seed();
    await db.update(rooms).set({ parentRoomId: keuken, offsetXM: 2, offsetYM: 3 }).where(eq(rooms.id, zolder));
    const [{ id }] = await db.insert(items).values({ areaId, name: "kist", houseId: h1, roomId: zolder, pos }).$returningId();
    await callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect(it.roomId).toBe(keuken);
    expect(it.pos).toMatchObject({ xM: 3, yM: 4 });
  });
  it("clears pos when an unrelated room is merged", async () => {
    const { db, h1, zolder, keuken, areaId } = await seed();
    const [{ id }] = await db.insert(items).values({ areaId, name: "kist", houseId: h1, roomId: zolder, pos }).$returningId();
    await callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect(it.pos).toBeNull();
  });
  it("forced remove clears pos on the unplaced items", async () => {
    const { db, h1, zolder, areaId } = await seed();
    const [{ id }] = await db.insert(items).values({ areaId, name: "kist", houseId: h1, roomId: zolder, pos }).$returningId();
    await callerFor(h1).rooms.remove({ id: zolder, force: true });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect(it.roomId).toBeNull();
    expect(it.pos).toBeNull();
  });
  it("refuses merging a room into one of its own cuts, and re-parents other children only", async () => {
    const { db, h1, zolder, keuken } = await seed();
    await db.update(rooms).set({ parentRoomId: zolder }).where(eq(rooms.id, keuken));
    await expect(callerFor(h1).rooms.merge({ fromId: zolder, toId: keuken })).rejects.toThrow(/own cut/);
    expect(await db.select().from(rooms)).toHaveLength(3);
  });
});

describe("rooms.cutFromRoom", () => {
  async function seedSource() {
    const s = await seed();
    const { db, h1, areaId } = s;
    const [{ id: src }] = await db
      .insert(rooms)
      .values({
        houseId: h1, name: "Begane grond", floor: "ground", source: "manual", widthM: 4, depthM: 3,
        walls: [
          { points: [[0, 0], [4, 0]] }, { points: [[4, 0], [4, 3]] },
          { points: [[4, 3], [0, 3]] }, { points: [[0, 3], [0, 0]] },
        ],
      })
      .$returningId();
    const [{ id: itemId }] = await db
      .insert(items)
      .values({ areaId, name: "kast", houseId: h1, roomId: src, pos: { xM: 0.5, yM: 0.5, wM: 0.5, dM: 0.5 } as never })
      .$returningId();
    return { ...s, src, itemId };
  }
  const bounds = { xM: 0, yM: 0, wM: 2, dM: 2 };

  it("adopts an existing geometry-less room of the same name", async () => {
    const { db, h1, src, itemId, keuken } = await seedSource();
    const r = await callerFor(h1).rooms.cutFromRoom({ sourceRoomId: src, name: " keuken ", bounds });
    expect(r.id).toBe(keuken);
    const [room] = await db.select().from(rooms).where(eq(rooms.id, keuken));
    expect(room.parentRoomId).toBe(src);
    expect(room.walls).not.toBeNull();
    const [it] = await db.select().from(items).where(eq(items.id, itemId));
    expect(it.roomId).toBe(keuken);
  });
  it("refuses cutting a room under its own name", async () => {
    const { h1, src } = await seedSource();
    await expect(callerFor(h1).rooms.cutFromRoom({ sourceRoomId: src, name: "begane GROND", bounds })).rejects.toThrow(/different name/);
  });
  it("refuses a name whose room already has a plan", async () => {
    const { db, h1, src, keuken } = await seedSource();
    await db.update(rooms).set({ walls: [] }).where(eq(rooms.id, keuken));
    await expect(callerFor(h1).rooms.cutFromRoom({ sourceRoomId: src, name: "Keuken", bounds })).rejects.toThrow(/already has a plan/);
  });
});

describe("rooms.list dimensions", () => {
  it("carries each room's width and depth for the Rooms page", async () => {
    const db = getTestDb();
    const [{ id: h }] = await db.insert(houses).values({ name: "Dims" }).$returningId();
    await db.insert(rooms).values([
      { houseId: h, name: "Keuken", source: "manual", widthM: 3.2, depthM: 4.1 },
      { houseId: h, name: "Hal", source: "manual" },
    ]);
    const rows = await callerFor(h).rooms.list();
    expect(rows.map((r) => [r.name, r.widthM, r.depthM])).toEqual([
      ["Hal", null, null],
      ["Keuken", 3.2, 4.1],
    ]);
  });
});
