// api/test/pins-forItemPhotos.test.ts
// pins.forItemPhotos: every pin on every Photo that pins this Thing, for the
// Thing page's schematics. Photos without a room are left out.
import { beforeEach, describe, expect, it } from "vitest";
import { areas, houses, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

describe("pins.forItemPhotos", () => {
  it("returns all pins of the Photos that pin the Thing, with roomId, skipping room-less Photos", async () => {
    const db = getTestDb();
    const [{ id: h }] = await db.insert(houses).values({ name: "A" }).$returningId();
    const [{ id: areaId }] = await db.insert(areas).values({ slug: "lab", name: "Lab", color: "#123456" }).$returningId();
    const [{ id: room }] = await db.insert(rooms).values({ houseId: h, name: "Zolder", floor: "ground", source: "manual" }).$returningId();
    const photo = async (roomId: number | null, t: string) =>
      (await db.insert(photos).values({ roomId, title: t, storageKey: `local/pins-fip-${t}.jpg` }).$returningId())[0].id;
    const thing = async (name: string, extra: Partial<typeof items.$inferInsert> = {}) =>
      (await db.insert(items).values({ areaId, houseId: h, roomId: room, name, ...extra }).$returningId())[0].id;
    const pin = async (photoId: number, itemId: number) =>
      (await db.insert(photoPins).values({ photoId, itemId, xPct: 50, yPct: 50, wPct: 10, hPct: 10, label: "" }).$returningId())[0].id;
    const p1 = await photo(room, "one");
    const p2 = await photo(room, "two");
    const pNo = await photo(null, "none");
    const A = await thing("A");
    const B = await thing("B");
    const gone = await thing("Gone", { status: "archived", decision: "toss" });
    await pin(p1, A);
    await pin(pNo, A);
    await pin(p1, B);
    await pin(p2, B);
    await pin(p1, gone);

    const api = callerFor(h);
    const a = await api.pins.forItemPhotos({ itemId: A });
    expect(a.map((p) => p.photoId)).toEqual([p1, p1]);
    expect(a.every((p) => p.roomId === room)).toBe(true);
    expect(a[0]).toMatchObject({ photoTitle: "one", photoStorageKey: "local/pins-fip-one.jpg" });
    const b = await api.pins.forItemPhotos({ itemId: B });
    expect(b.map((p) => p.photoId)).toEqual([p1, p1, p2]);
  });
});
