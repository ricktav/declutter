import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, attachments, captures, houses, items, rooms } from "@db/schema";
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

describe("attachments.unlink / map.photosForLocation", () => {
  it("unlink copies the item's room onto the attachment", async () => {
    const { db, h1, areaId, keuken } = await seed();
    const { id } = await callerFor(h1).items.create({ areaId, name: "pan", roomId: keuken });
    const [{ id: attId }] = await db.insert(attachments).values({ itemId: id, areaId, kind: "image", storageKey: "local/x.jpg" }).$returningId();
    await callerFor(h1).attachments.unlink({ id: attId });
    const [att] = await db.select().from(attachments).where(eq(attachments.id, attId));
    expect([att.itemId, att.roomId]).toEqual([null, keuken]);
  });
  it("photosForLocation returns the source capture of a cutout whose item is in the room", async () => {
    const { db, h1, areaId, keuken } = await seed();
    const { id } = await callerFor(h1).items.create({ areaId, name: "pan", roomId: keuken });
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/src.jpg" }).$returningId();
    await db.insert(attachments).values({ itemId: id, areaId, kind: "image", storageKey: "local/cut.jpg", sourceCaptureId: capId });
    expect(await callerFor(h1).map.photosForLocation({ roomId: keuken })).toEqual([{ id: capId, storageKey: "local/src.jpg" }]);
    expect(await callerFor(h1).map.photosForLocation({ roomId: 999999 })).toEqual([]);
  });
});
