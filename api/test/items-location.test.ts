import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, houses, items, rooms } from "@db/schema";
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
  const [{ id: hal }] = await db.insert(rooms).values({ houseId: h2, name: "Hal", source: "manual" }).$returningId();
  return { db, h1, h2, areaId, keuken, hal };
}

describe("items.create / update location", () => {
  it("create with roomId derives houseId; update to another house's room follows it", async () => {
    const { db, h1, h2, areaId, keuken, hal } = await seed();
    const { id } = await callerFor(h1).items.create({ areaId, name: "pan", roomId: keuken });
    let [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId]).toEqual([keuken, h1]);

    await callerFor(h1).items.update({ id, roomId: hal });
    [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId]).toEqual([hal, h2]);
  });
  it("create without a room lands unplaced in the context house", async () => {
    const { db, h1, areaId } = await seed();
    const { id } = await callerFor(h1).items.create({ areaId, name: "lamp" });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId]).toEqual([null, h1]);
  });
});

describe("items.listAll / get", () => {
  it("lists the context house by default, joins the room, and filters by roomId", async () => {
    const { h1, areaId, keuken, hal } = await seed();
    await callerFor(h1).items.create({ areaId, name: "pan", roomId: keuken });
    await callerFor(h1).items.create({ areaId, name: "coat", roomId: hal });
    await callerFor(h1).items.create({ areaId, name: "lamp" });

    const mine = await callerFor(h1).items.listAll({});
    expect(mine.map((r) => [r.name, r.room?.name ?? null, r.room?.floor ?? null]).sort()).toEqual([
      ["lamp", null, null],
      ["pan", "Keuken", "ground"],
    ]);
    expect((await callerFor(h1).items.listAll({ roomId: keuken })).map((r) => r.name)).toEqual(["pan"]);
    expect(await callerFor(h1).items.listAll({ houseId: null })).toHaveLength(3);

    const one = await callerFor(h1).items.get({ id: mine.find((r) => r.name === "pan")!.id });
    expect(one?.room).toMatchObject({ id: keuken, name: "Keuken", floor: "ground", hasGeometry: false });
  });
});

describe("items.create atomicity", () => {
  it("a bad roomId leaves no orphan item", async () => {
    const { db, h1, areaId } = await seed();
    await expect(callerFor(h1).items.create({ areaId, name: "ghost", roomId: 999999 })).rejects.toThrow(/does not exist/);
    expect(await db.select().from(items)).toHaveLength(0);
  });
});

describe("items.update topic", () => {
  it("optional areaId moves the Thing to another topic", async () => {
    const { db, h1, areaId } = await seed();
    const [{ id: other }] = await db.insert(areas).values({ slug: "y", name: "Y" }).$returningId();
    const { id } = await callerFor(h1).items.create({ areaId, name: "pan" });
    await callerFor(h1).items.update({ id, areaId: other });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect(it.areaId).toBe(other);
  });
});

describe("items.update location", () => {
  it("roomId null keeps the house and clears the room; houseId alone unplaces into that house", async () => {
    const { db, h1, h2, areaId, keuken } = await seed();
    const { id } = await callerFor(h1).items.create({ areaId, name: "pan", roomId: keuken });
    await callerFor(h1).items.update({ id, roomId: null });
    let [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId]).toEqual([null, h1]);

    await callerFor(h1).items.update({ id, roomId: keuken });
    await callerFor(h1).items.update({ id, houseId: h2 });
    [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId]).toEqual([null, h2]);
  });
});

describe("items.update pos on room change", () => {
  const pos = { xM: 1, yM: 1, wM: 1, dM: 1, rotDeg: 0 };
  async function placed() {
    const s = await seed();
    const [{ id: zolder }] = await s.db.insert(rooms).values({ houseId: s.h1, name: "Zolder", source: "manual" }).$returningId();
    const [{ id }] = await s.db.insert(items).values({ areaId: s.areaId, name: "pan", houseId: s.h1, roomId: s.keuken, pos }).$returningId();
    return { ...s, zolder, id };
  }
  it("clears pos when the room changes", async () => {
    const { db, h1, zolder, id } = await placed();
    await callerFor(h1).items.update({ id, roomId: zolder });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect(it.roomId).toBe(zolder);
    expect(it.pos).toBeNull();
  });
  it("keeps an explicit pos given with the room change", async () => {
    const { db, h1, zolder, id } = await placed();
    await callerFor(h1).items.update({ id, roomId: zolder, pos: { ...pos, xM: 2 } });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect((it.pos as { xM: number }).xM).toBe(2);
  });
  it("keeps pos when the room is unchanged", async () => {
    const { db, h1, keuken, id } = await placed();
    await callerFor(h1).items.update({ id, roomId: keuken });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect(it.pos).not.toBeNull();
  });
});

describe("items.update with houseId only", () => {
  const pos = { xM: 1, yM: 1, wM: 1, dM: 1, rotDeg: 0 };

  it("another house unplaces the item and clears its pos", async () => {
    const { db, h1, h2, areaId, keuken } = await seed();
    const [{ id }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId: keuken, pos }).$returningId();
    await callerFor(h1).items.update({ id, houseId: h2 });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId, it.pos]).toEqual([null, h2, null]);
  });

  it("its own house changes nothing: room and pos stay", async () => {
    const { db, h1, areaId, keuken } = await seed();
    const [{ id }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId: keuken, pos }).$returningId();
    await callerFor(h1).items.update({ id, houseId: h1 });
    const [it] = await db.select().from(items).where(eq(items.id, id));
    expect([it.roomId, it.houseId, it.pos]).toEqual([keuken, h1, pos]);
  });
});
