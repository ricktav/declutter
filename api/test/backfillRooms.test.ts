// api/test/backfillRooms.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, attachments, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { backfillRooms } from "../lib/backfillRooms";

beforeEach(async () => {
  await resetTestDb();
});

async function seedHouseAndArea() {
  const db = getTestDb();
  const [{ id: houseId }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "f", name: "Furniture" }).$returningId();
  return { db, houseId, areaId };
}

describe("backfillRooms", () => {
  it("creates one room per distinct (house, room) string, carries the floor, links items", async () => {
    const { db, houseId, areaId } = await seedHouseAndArea();
    await db.insert(items).values([
      { areaId, name: "a", houseId, floor: "ground", room: "Keuken" },
      { areaId, name: "b", houseId, floor: "ground", room: "keuken " }, // case + whitespace
      { areaId, name: "c", houseId, floor: "attic", room: "Washok" },
      { areaId, name: "d", houseId }, // in the house, no room: stays unplaced
      { areaId, name: "e" }, // nowhere
    ]);

    const r = await backfillRooms(db);
    expect(r).toMatchObject({ roomsCreated: 2, itemsLinked: 3 });

    const all = await db.select().from(rooms).orderBy(rooms.name);
    expect(all.map((x) => [x.name, x.floor, x.source])).toEqual([
      ["Keuken", "ground", "manual"],
      ["Washok", "attic", "manual"],
    ]);
    const keuken = all[0];
    const linked = await db.select({ name: items.name, roomId: items.roomId, houseId: items.houseId }).from(items).orderBy(items.name);
    expect(linked).toEqual([
      { name: "a", roomId: keuken.id, houseId },
      { name: "b", roomId: keuken.id, houseId },
      { name: "c", roomId: all[1].id, houseId },
      { name: "d", roomId: null, houseId },
      { name: "e", roomId: null, houseId: null },
    ]);
  });

  it("links to an existing scanned room by name instead of creating a twin, and fills its floor", async () => {
    const { db, houseId, areaId } = await seedHouseAndArea();
    const [{ id: scanned }] = await db
      .insert(rooms)
      .values({ houseId, name: "Woonkamer", source: "mappedin", walls: [], openings: [] })
      .$returningId();
    await db.insert(items).values({ areaId, name: "sofa", houseId, floor: "ground", room: "woonkamer" });

    const r = await backfillRooms(db);
    expect(r.roomsCreated).toBe(0);
    const [room] = await db.select().from(rooms);
    expect(room.id).toBe(scanned);
    expect(room.floor).toBe("ground");
    const [it] = await db.select().from(items);
    expect(it.roomId).toBe(scanned);
  });

  it("keeps an item's existing roomId (geometry truth) and only uses the strings to set the room's floor", async () => {
    const { db, houseId, areaId } = await seedHouseAndArea();
    const [{ id: roomId }] = await db.insert(rooms).values({ houseId, name: "Floor 2", source: "mappedin" }).$returningId();
    await db.insert(items).values({ areaId, name: "desk", houseId, roomId, floor: "attic", room: "Zolderkamer" });

    await backfillRooms(db);
    const [it] = await db.select().from(items);
    expect(it.roomId).toBe(roomId); // not re-pointed at a new "Zolderkamer" room
    const all = await db.select().from(rooms);
    expect(all).toHaveLength(1);
    expect(all[0].floor).toBe("attic");
  });

  it("maps location photos (attachments with room text) to roomId", async () => {
    const { db, houseId } = await seedHouseAndArea();
    await db.insert(attachments).values({ kind: "image", houseId, floor: "ground", room: "Eetkamer", title: "Location photo" });
    const r = await backfillRooms(db);
    expect(r.attachmentsLinked).toBe(1);
    const [room] = await db.select().from(rooms);
    const [att] = await db.select().from(attachments);
    expect(att.roomId).toBe(room.id);
  });

  it("is idempotent", async () => {
    const { db, houseId, areaId } = await seedHouseAndArea();
    await db.insert(items).values({ areaId, name: "a", houseId, floor: "ground", room: "Keuken" });
    await backfillRooms(db);
    const second = await backfillRooms(db);
    expect(second).toEqual({ roomsCreated: 0, itemsLinked: 0, attachmentsLinked: 0, floorsSet: 0 });
    expect(await db.select().from(rooms)).toHaveLength(1);
    expect((await db.select().from(items).where(eq(items.name, "a")))[0].roomId).not.toBeNull();
  });
});
