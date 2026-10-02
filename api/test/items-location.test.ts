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
    // items.create tries a best-effort LLM link suggestion for same-area siblings, which is slow without a provider
  }, 30_000);
});
