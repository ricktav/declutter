// api/test/placement.test.ts
// photos.attachToItem (a bucket photo to an existing Thing) and
// items.placement / items.placementSummary (pinned, on the plan, room photos).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { areas, captures, events, houses, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

const pos = { xM: 1, yM: 1, wM: 0.5, dM: 0.5, rotDeg: 0 };

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "Stuff" }).$returningId();
  const [{ id: keuken }] = await db
    .insert(rooms)
    .values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual", widthM: 4, depthM: 3 })
    .$returningId();
  const [{ id: zolder }] = await db
    .insert(rooms)
    .values({
      houseId: h1,
      name: "Zolder",
      floor: "top",
      source: "roomplan",
      widthM: 5,
      depthM: 5,
      walls: [{ points: [[0, 0], [5, 0]] }],
    })
    .$returningId();
  const thing = async (name: string, values: Partial<typeof items.$inferInsert> = {}) =>
    (await db.insert(items).values({ areaId, houseId: h1, name, ...values }).$returningId())[0].id;
  const photo = async (values: Partial<typeof photos.$inferInsert> = {}) =>
    (await db.insert(photos).values({ storageKey: await writeTestJpeg(), mimeType: "image/jpeg", ...values }).$returningId())[0].id;
  return { db, h1, areaId, keuken, zolder, thing, photo, api: callerFor(h1) };
}

describe("photos.attachToItem", () => {
  it("attaches a room-less photo and copies the Thing's room; logs photo.attached", async () => {
    const { db, keuken, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const p = await photo();
    expect(await api.photos.attachToItem({ photoId: p, itemId: kettle })).toEqual({ photoId: p, itemId: kettle, roomId: keuken });
    const [row] = await db.select().from(photos).where(eq(photos.id, p));
    expect(row).toMatchObject({ itemId: kettle, roomId: keuken });
    const ev = await db.select().from(events).where(and(eq(events.entityType, "item"), eq(events.action, "photo.attached")));
    expect(ev).toHaveLength(1);
    expect(ev[0].entityId).toBe(kettle);

    // attaching again to the same Thing is a no-op: same answer, no second event
    expect(await api.photos.attachToItem({ photoId: p, itemId: kettle })).toEqual({ photoId: p, itemId: kettle, roomId: keuken });
    expect(await db.select().from(events).where(eq(events.action, "photo.attached"))).toHaveLength(1);
  });

  it("keeps the photo's own room; the Thing's room is not changed", async () => {
    const { db, keuken, zolder, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken, pos });
    const p = await photo({ roomId: zolder });
    expect(await api.photos.attachToItem({ photoId: p, itemId: kettle })).toEqual({ photoId: p, itemId: kettle, roomId: zolder });
    const [row] = await db.select().from(photos).where(eq(photos.id, p));
    expect(row.roomId).toBe(zolder);
    const [it] = await db.select().from(items).where(eq(items.id, kettle));
    expect(it.roomId).toBe(keuken);
    expect(it.pos).toEqual(pos);
  });

  it("refuses an id that is only a capture, and an archived Thing", async () => {
    const { db, thing, photo, api } = await seed();
    const kettle = await thing("Kettle");
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: await writeTestJpeg() }).$returningId();
    await expect(api.photos.attachToItem({ photoId: capId, itemId: kettle })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const old = await thing("Old kettle", { status: "archived" });
    const p = await photo();
    await expect(api.photos.attachToItem({ photoId: p, itemId: old })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [row] = await db.select().from(photos).where(eq(photos.id, p));
    expect(row.itemId).toBeNull();
  });

  it("refuses a photo of another Thing without force (CONFLICT) and moves it with force", async () => {
    const { db, keuken, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const toaster = await thing("Toaster", { roomId: keuken });
    const p = await photo({ itemId: toaster, roomId: keuken });
    await expect(api.photos.attachToItem({ photoId: p, itemId: kettle })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Photo belongs to Toaster",
    });
    expect((await db.select().from(photos).where(eq(photos.id, p)))[0].itemId).toBe(toaster);

    await api.photos.attachToItem({ photoId: p, itemId: kettle, force: true });
    expect((await db.select().from(photos).where(eq(photos.id, p)))[0].itemId).toBe(kettle);
  });

  it("refuses a photo with pins on other Things, even with force; a pin of the target itself is fine", async () => {
    const { db, keuken, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const toaster = await thing("Toaster", { roomId: keuken });
    const mixer = await thing("Mixer", { roomId: keuken });
    const scene = await photo({ roomId: keuken });
    await db.insert(photoPins).values([
      { photoId: scene, itemId: toaster, xPct: 1, yPct: 1 },
      { photoId: scene, itemId: toaster, xPct: 5, yPct: 5 },
      { photoId: scene, itemId: mixer, xPct: 2, yPct: 2, origin: "ai", status: "suggested" },
      { photoId: scene, itemId: kettle, xPct: 3, yPct: 3 },
    ]);
    for (const force of [false, true]) {
      await expect(api.photos.attachToItem({ photoId: scene, itemId: kettle, force })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "This photo shows 2 other Things; pin Kettle in it instead.",
      });
    }
    expect((await db.select().from(photos).where(eq(photos.id, scene)))[0].itemId).toBeNull();

    const own = await photo({ roomId: keuken });
    await db.insert(photoPins).values({ photoId: own, itemId: kettle, xPct: 3, yPct: 3 });
    await api.photos.attachToItem({ photoId: own, itemId: kettle });
    expect((await db.select().from(photos).where(eq(photos.id, own)))[0].itemId).toBe(kettle);
  });

  it("CONFLICT carries the owner id; force with fromItemId moves only from that owner", async () => {
    const { db, keuken, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const toaster = await thing("Toaster", { roomId: keuken });
    const mixer = await thing("Mixer", { roomId: keuken });
    const p = await photo({ itemId: toaster, roomId: keuken });
    const err = await api.photos.attachToItem({ photoId: p, itemId: kettle }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONFLICT", cause: { ownerId: toaster } });

    // the owner changed since the question: no move
    await expect(api.photos.attachToItem({ photoId: p, itemId: kettle, force: true, fromItemId: mixer })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await db.select().from(photos).where(eq(photos.id, p)))[0].itemId).toBe(toaster);

    await api.photos.attachToItem({ photoId: p, itemId: kettle, force: true, fromItemId: toaster });
    expect((await db.select().from(photos).where(eq(photos.id, p)))[0].itemId).toBe(kettle);
  });
});

describe("items.placement", () => {
  it("reports confirmed pins, photo count and roomPhotos with hasPinForItem", async () => {
    const { db, keuken, zolder, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const toaster = await thing("Toaster", { roomId: keuken });
    await thing("Old pan", { roomId: keuken, status: "archived" });
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: await writeTestJpeg() }).$returningId();

    const kitchenShot = await photo({ roomId: keuken, title: "Kitchen" }); // item-less, in the room
    const locationShot = await photo({ sourceCaptureId: capId, title: "Location photo" }); // item-less, no room, behind a cutout
    const toasterCut = await photo({ itemId: toaster, sourceCaptureId: capId, title: "Toaster cut" });
    await photo({ itemId: toaster, title: "Toaster upload" }); // no source capture: not a room photo
    await photo({ roomId: zolder, title: "Attic" }); // another room
    await photo({ itemId: kettle, title: "Kettle own" });

    await db.insert(photoPins).values([
      { photoId: kitchenShot, itemId: kettle, xPct: 10, yPct: 10, label: "kettle", status: "confirmed" },
      { photoId: locationShot, itemId: kettle, xPct: 20, yPct: 20, label: "kettle?", origin: "ai", status: "suggested" },
    ]);

    const pl = await api.items.placement({ itemId: kettle });
    expect(pl).toMatchObject({
      itemId: kettle,
      roomId: keuken,
      roomName: "Keuken",
      roomHasGeometry: false,
      roomHasDimensions: true,
      onPlan: false,
      photos: 1,
    });
    expect(pl.pins).toEqual([{ pinId: expect.any(Number), photoId: kitchenShot, title: "Kitchen", label: "kettle" }]);
    expect(new Set(pl.roomPhotos.map((p) => p.photoId))).toEqual(new Set([kitchenShot, locationShot, toasterCut]));
    // full images first (newest first), cutouts last
    expect(pl.roomPhotos.map((p) => [p.photoId, p.isCutout])).toEqual([
      [locationShot, false],
      [kitchenShot, false],
      [toasterCut, true],
    ]);
    expect(pl.roomPhotos.find((p) => p.photoId === kitchenShot)?.hasPinForItem).toBe(true);
    expect(pl.roomPhotos.find((p) => p.photoId === locationShot)?.hasPinForItem).toBe(false);
  });

  it("onPlan follows roomId + pos, with and without room geometry", async () => {
    const { db, keuken, zolder, thing, api } = await seed();
    const flat = await thing("Chair", { roomId: keuken, pos });
    const scanned = await thing("Desk", { roomId: zolder, pos });
    const unplaced = await thing("Box");

    expect(await api.items.placement({ itemId: flat })).toMatchObject({ onPlan: true, roomHasGeometry: false, roomHasDimensions: true });
    expect(await api.items.placement({ itemId: scanned })).toMatchObject({ onPlan: true, roomHasGeometry: true, roomHasDimensions: true });
    expect(await api.items.placement({ itemId: unplaced })).toMatchObject({
      roomId: null,
      roomName: null,
      onPlan: false,
      roomHasGeometry: false,
      roomHasDimensions: false,
      roomPhotos: [],
    });

    expect(await api.items.placement({ itemId: flat })).toMatchObject({ roomHasPlan: true, parentId: null, parentName: null });
    // walls but no size: geometry for 3D, yet no 2D plan
    await db.update(rooms).set({ widthM: null, depthM: null }).where(eq(rooms.id, zolder));
    expect(await api.items.placement({ itemId: scanned })).toMatchObject({ roomHasGeometry: true, roomHasPlan: false });

    // a room with neither walls nor dimensions: still on the plan when pos is set
    const [{ id: bare }] = await db.insert(rooms).values({ houseId: (await db.select().from(houses))[0].id, name: "Hal", source: "manual" }).$returningId();
    const coat = await thing("Coat", { roomId: bare, pos });
    expect(await api.items.placement({ itemId: coat })).toMatchObject({ onPlan: true, roomHasGeometry: false, roomHasDimensions: false });
  });
});

describe("items.placementSummary", () => {
  it("returns pin count and onPlan for three Things in one call", async () => {
    const { db, keuken, thing, photo, api } = await seed();
    const a = await thing("A", { roomId: keuken, pos });
    const b = await thing("B", { roomId: keuken });
    const c = await thing("C");
    const p1 = await photo({ roomId: keuken });
    const p2 = await photo({ roomId: keuken });
    await db.insert(photoPins).values([
      { photoId: p1, itemId: a, xPct: 1, yPct: 1, status: "confirmed" },
      { photoId: p2, itemId: a, xPct: 1, yPct: 1, status: "confirmed" },
      { photoId: p1, itemId: b, xPct: 1, yPct: 1, status: "confirmed" },
      { photoId: p2, itemId: b, xPct: 1, yPct: 1, origin: "ai", status: "suggested" },
    ]);
    expect(await api.items.placementSummary({ itemIds: [c, a, b] })).toEqual([
      { itemId: c, pinCount: 0, onPlan: false },
      { itemId: a, pinCount: 2, onPlan: true },
      { itemId: b, pinCount: 1, onPlan: false },
    ]);
  });

  it("a hosted Thing is on the plan when its host is; placement names the host", async () => {
    const { keuken, thing, api } = await seed();
    const pc = await thing("PC", { roomId: keuken, pos });
    const ssd = await thing("SSD", { roomId: keuken, parentId: pc });
    const box = await thing("Box", { roomId: keuken });
    const cable = await thing("Cable", { roomId: keuken, parentId: box });
    expect(await api.items.placementSummary({ itemIds: [ssd, cable] })).toEqual([
      { itemId: ssd, pinCount: 0, onPlan: true },
      { itemId: cable, pinCount: 0, onPlan: false },
    ]);
    expect(await api.items.placement({ itemId: ssd })).toMatchObject({ parentId: pc, parentName: "PC", onPlan: false });
  });
});
