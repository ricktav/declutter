// api/test/photo-cameras.test.ts
// photos.camera: where a photo was taken in its room's frame. setCamera,
// roomPhotos, suggestCamera, and the resets when a photo changes room.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { areas, captures, events, houses, items, photoPins, photos, rooms, type PhotoCamera } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

const cam: PhotoCamera = { xM: 1, yM: 2, headingDeg: 90, fovDeg: 60, heightM: 1.5 };

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
    .values({ houseId: h1, name: "Zolder", floor: "top", source: "manual", widthM: 5, depthM: 5 })
    .$returningId();
  const thing = async (name: string, values: Partial<typeof items.$inferInsert> = {}) =>
    (await db.insert(items).values({ areaId, houseId: h1, name, ...values }).$returningId())[0].id;
  const photo = async (values: Partial<typeof photos.$inferInsert> = {}) =>
    (await db.insert(photos).values({ storageKey: await writeTestJpeg(), mimeType: "image/jpeg", ...values }).$returningId())[0].id;
  const cameraOf = async (id: number) => (await db.select().from(photos).where(eq(photos.id, id)))[0].camera ?? null;
  return { db, h1, areaId, keuken, zolder, thing, photo, cameraOf, api: callerFor(h1) };
}

describe("photos.setCamera", () => {
  it("stores a camera with defaults and a normalised heading; null takes it off; logs photo.camera on the room", async () => {
    const { db, keuken, photo, cameraOf, api } = await seed();
    const p = await photo({ roomId: keuken, title: "Overview" });

    const res = await api.photos.setCamera({ id: p, camera: { xM: 1, yM: 2, headingDeg: -90 } as PhotoCamera });
    expect(res).toEqual({ id: p, camera: { xM: 1, yM: 2, headingDeg: 270, fovDeg: 60, heightM: 1.5 } });
    expect(await cameraOf(p)).toEqual(res.camera);
    expect((await api.photos.setCamera({ id: p, camera: { ...cam, headingDeg: 720 } })).camera?.headingDeg).toBe(0);
    expect((await api.photos.get({ id: p })).photo?.camera).toEqual({ ...cam, headingDeg: 0 });

    // the walls themselves are inside
    await api.photos.setCamera({ id: p, camera: { ...cam, xM: 4, yM: 3 } });
    expect(await cameraOf(p)).toMatchObject({ xM: 4, yM: 3 });

    expect(await api.photos.setCamera({ id: p, camera: null })).toEqual({ id: p, camera: null });
    expect(await cameraOf(p)).toBeNull();

    const ev = await db.select().from(events).where(eq(events.action, "photo.camera"));
    expect(ev).toHaveLength(4);
    expect(ev.every((e) => e.entityType === "room" && e.entityId === keuken)).toBe(true);
  });

  it("logs on the photo's Thing when it has one", async () => {
    const { db, keuken, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const p = await photo({ roomId: keuken, itemId: kettle });
    await api.photos.setCamera({ id: p, camera: cam });
    const [ev] = await db.select().from(events).where(eq(events.action, "photo.camera"));
    expect(ev).toMatchObject({ entityType: "item", entityId: kettle });
  });

  it("refuses a camera outside the room and out-of-range values (Review Focus 1)", async () => {
    const { keuken, photo, cameraOf, api } = await seed();
    const p = await photo({ roomId: keuken });
    await expect(api.photos.setCamera({ id: p, camera: { ...cam, xM: 4.01 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.photos.setCamera({ id: p, camera: { ...cam, yM: 3.5 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.photos.setCamera({ id: p, camera: { ...cam, xM: -0.1 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.photos.setCamera({ id: p, camera: { ...cam, fovDeg: 150 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.photos.setCamera({ id: p, camera: { ...cam, fovDeg: 10 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.photos.setCamera({ id: p, camera: { ...cam, heightM: 6 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await cameraOf(p)).toBeNull();
  });

  it("refuses a cutout, a photo without a room and an unknown photo", async () => {
    const { keuken, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const cut = await photo({ roomId: keuken, itemId: kettle, cropBox: { xPct: 50, yPct: 50, wPct: 20, hPct: 20 } });
    await expect(api.photos.setCamera({ id: cut, camera: cam })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const roomless = await photo();
    await expect(api.photos.setCamera({ id: roomless, camera: cam })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(api.photos.setCamera({ id: 999999, camera: cam })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.photos.suggestCamera({ id: cut })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.photos.suggestCamera({ id: roomless })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("keeps the stored marker when the room loses its size (Review Focus 2)", async () => {
    const { keuken, photo, cameraOf, api } = await seed();
    const p = await photo({ roomId: keuken });
    await api.photos.setCamera({ id: p, camera: cam });
    await api.rooms.update({ id: keuken, widthM: null });
    expect(await cameraOf(p)).toEqual(cam);
    const rows = await api.photos.roomPhotos({ roomId: keuken });
    expect(rows.find((r) => r.photoId === p)?.camera).toEqual(cam);
    // no frame: no bounds to check, and no plan to suggest on
    await api.photos.setCamera({ id: p, camera: { ...cam, xM: 7 } });
    expect(await cameraOf(p)).toMatchObject({ xM: 7 });
    await expect(api.photos.suggestCamera({ id: p })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("room changes reset the camera", () => {
  it("attachToItem copying the Thing's room onto a room-less photo leaves no camera", async () => {
    const { db, keuken, thing, photo, cameraOf, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const p = await photo();
    await api.photos.attachToItem({ photoId: p, itemId: kettle });
    expect(await cameraOf(p)).toBeNull();
    // even a stray camera on a room-less row (no frame) is dropped by the move
    const q = await photo();
    await db.update(photos).set({ camera: cam }).where(eq(photos.id, q));
    await api.photos.attachToItem({ photoId: q, itemId: kettle });
    const [row] = await db.select().from(photos).where(eq(photos.id, q));
    expect(row).toMatchObject({ roomId: keuken, camera: null });
  });

  it("attachToItem keeps the camera while the room stays (Review Focus 5)", async () => {
    const { keuken, zolder, thing, photo, cameraOf, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const p = await photo({ roomId: keuken, title: "Overview" });
    await api.photos.setCamera({ id: p, camera: cam });
    await api.photos.attachToItem({ photoId: p, itemId: kettle });
    expect(await cameraOf(p)).toEqual(cam);
    // a Thing in another room: the photo keeps its own room, and its camera
    const chest = await thing("Chest", { roomId: zolder });
    const q = await photo({ roomId: keuken });
    await api.photos.setCamera({ id: q, camera: cam });
    expect(await api.photos.attachToItem({ photoId: q, itemId: chest })).toMatchObject({ roomId: keuken });
    expect(await cameraOf(q)).toEqual(cam);
  });

  it("ensureForCapture giving a later room sets the room; the camera stays null", async () => {
    const { db, keuken, cameraOf, api } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: await writeTestJpeg() }).$returningId();
    const { photoId } = await api.photos.ensureForCapture({ captureId: capId });
    expect(await cameraOf(photoId)).toBeNull();
    // a stray camera on the room-less row is dropped when the room comes
    await db.update(photos).set({ camera: cam }).where(eq(photos.id, photoId));
    await api.photos.ensureForCapture({ captureId: capId, roomId: keuken });
    const [row] = await db.select().from(photos).where(eq(photos.id, photoId));
    expect(row).toMatchObject({ roomId: keuken, camera: null });
    // a room already set is kept, and so is a camera set in it
    await api.photos.setCamera({ id: photoId, camera: cam });
    await api.photos.ensureForCapture({ captureId: capId, roomId: keuken });
    expect(await cameraOf(photoId)).toEqual(cam);
  });

  it("rooms.merge and rooms.remove drop cameras of the moved photos", async () => {
    const { keuken, zolder, photo, cameraOf, api } = await seed();
    const p = await photo({ roomId: keuken });
    await api.photos.setCamera({ id: p, camera: cam });
    await api.rooms.merge({ fromId: keuken, toId: zolder });
    expect(await cameraOf(p)).toBeNull();
    await api.photos.setCamera({ id: p, camera: cam });
    await api.rooms.remove({ id: zolder, force: true });
    expect(await cameraOf(p)).toBeNull();
  });
});

describe("photos.roomPhotos", () => {
  it("lists full photos first, newest first, with camera, own roomId, owner and confirmed pin count", async () => {
    const { db, keuken, zolder, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: await writeTestJpeg() }).$returningId();
    const older = await photo({ roomId: keuken, title: "Older", createdAt: new Date("2026-01-01T10:00:00Z") });
    const newer = await photo({ roomId: keuken, title: "Newer", createdAt: new Date("2026-02-01T10:00:00Z") });
    // a capture's location photo filed in another room still lists here, with its own roomId
    const location = await photo({
      sourceCaptureId: capId,
      roomId: zolder,
      title: "Location photo",
      createdAt: new Date("2026-01-15T10:00:00Z"),
    });
    const cut = await photo({
      itemId: kettle,
      sourceCaptureId: capId,
      title: "Kettle cut",
      cropBox: { xPct: 50, yPct: 50, wPct: 20, hPct: 20 },
      createdAt: new Date("2026-03-01T10:00:00Z"),
    });
    await photo({ roomId: zolder, title: "Attic" });
    await api.photos.setCamera({ id: older, camera: cam });
    await db.insert(photoPins).values([
      { photoId: newer, itemId: kettle, xPct: 10, yPct: 10, label: "kettle", status: "confirmed" },
      { photoId: newer, itemId: null, xPct: 30, yPct: 30, label: "cup", status: "confirmed" },
      { photoId: older, itemId: kettle, xPct: 20, yPct: 20, label: "kettle?", origin: "ai", status: "suggested" },
    ]);

    const rows = await api.photos.roomPhotos({ roomId: keuken });
    expect(rows).toEqual([
      { photoId: newer, title: "Newer", storageKey: expect.any(String), itemId: null, itemName: null, roomId: keuken, isCutout: false, camera: null, pinCount: 2 },
      { photoId: location, title: "Location photo", storageKey: expect.any(String), itemId: null, itemName: null, roomId: zolder, isCutout: false, camera: null, pinCount: 0 },
      { photoId: older, title: "Older", storageKey: expect.any(String), itemId: null, itemName: null, roomId: keuken, isCutout: false, camera: cam, pinCount: 0 },
      { photoId: cut, title: "Kettle cut", storageKey: expect.any(String), itemId: kettle, itemName: "Kettle", roomId: null, isCutout: true, camera: null, pinCount: 0 },
    ]);

    // items.placement shares the query: same rows minus the Thing's own photos, plus hasPinForItem; pins carry camera
    const pl = await api.items.placement({ itemId: kettle });
    expect(pl.roomPhotos.map((r) => [r.photoId, r.camera, r.hasPinForItem])).toEqual([
      [newer, null, true],
      [older, cam, false],
    ]);
    expect(pl.pins).toEqual([
      { pinId: expect.any(Number), photoId: newer, title: "Newer", label: "kettle", camera: null, roomId: keuken, isCutout: false },
    ]);
  });

  it("caps the list at 60", async () => {
    const { db, keuken, api } = await seed();
    const key = await writeTestJpeg();
    await db.insert(photos).values(Array.from({ length: 65 }, (_, i) => ({ storageKey: key, roomId: keuken, title: `P${i}` })));
    expect(await api.photos.roomPhotos({ roomId: keuken })).toHaveLength(60);
  });
});

describe("photos.listAll", () => {
  it("carries each photo's camera and whether it is a cutout; captures have neither", async () => {
    const { db, keuken, thing, photo, api } = await seed();
    const kettle = await thing("Kettle", { roomId: keuken });
    const placed = await photo({ roomId: keuken, title: "Placed" });
    const bare = await photo({ roomId: keuken, title: "Bare" });
    const cut = await photo({ itemId: kettle, cropBox: { xPct: 10, yPct: 10, wPct: 20, hPct: 20 } });
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: await writeTestJpeg() }).$returningId();
    await api.photos.setCamera({ id: placed, camera: cam });

    const byKey = new Map((await api.photos.listAll()).map((r) => [`${r.source}:${r.id}`, r]));
    expect(byKey.get(`photo:${placed}`)).toMatchObject({ roomId: keuken, isCutout: false, camera: cam });
    expect(byKey.get(`photo:${bare}`)).toMatchObject({ isCutout: false, camera: null });
    expect(byKey.get(`photo:${cut}`)).toMatchObject({ isCutout: true, camera: null });
    expect(byKey.get(`capture:${capId}`)).toMatchObject({ isCutout: false, camera: null });
  });
});

describe("photos.suggestCamera (Review Focus 3)", () => {
  it("without pinned placed Things: the room's centre facing +x, basis center", async () => {
    const { db, keuken, zolder, thing, photo, api } = await seed();
    const p = await photo({ roomId: keuken });
    // pinned but not placed, suggested only, and placed in another room: none count
    const loose = await thing("Loose", { roomId: keuken });
    const maybe = await thing("Maybe", { roomId: keuken, pos: { xM: 3, yM: 1, wM: 0.5, dM: 0.5, rotDeg: 0 } });
    const away = await thing("Away", { roomId: zolder, pos: { xM: 3, yM: 1, wM: 0.5, dM: 0.5, rotDeg: 0 } });
    await db.insert(photoPins).values([
      { photoId: p, itemId: loose, xPct: 10, yPct: 10, label: "loose", status: "confirmed" },
      { photoId: p, itemId: maybe, xPct: 20, yPct: 20, label: "maybe", origin: "ai", status: "suggested" },
      { photoId: p, itemId: away, xPct: 30, yPct: 30, label: "away", status: "confirmed" },
    ]);
    expect(await api.photos.suggestCamera({ id: p })).toEqual({
      camera: { xM: 2, yM: 1.5, headingDeg: 0, fovDeg: 60, heightM: 1.5 },
      basis: "center",
    });
    // it writes nothing
    expect((await db.select().from(photos).where(eq(photos.id, p)))[0].camera).toBeNull();
  });

  it("with pinned placed Things: on the wall opposite their centroid, facing it, basis pins", async () => {
    const { db, keuken, thing, photo, api } = await seed();
    const p = await photo({ roomId: keuken });
    // one Thing centred at (3.25, 1.25) in a 4 x 3 room (centre 2, 1.5): the
    // ray from it through the centre leaves the room at the -x wall, y = 1.9;
    // 0.3 m inside that is (0.3, 1.9); from there the Thing is at
    // atan2(0.65, 2.95) = 12.4° (counter-clockwise: towards smaller yM)
    const kettle = await thing("Kettle", { roomId: keuken, pos: { xM: 3, yM: 1, wM: 0.5, dM: 0.5, rotDeg: 0 } });
    await db.insert(photoPins).values({ photoId: p, itemId: kettle, xPct: 10, yPct: 10, label: "kettle", status: "confirmed" });
    expect(await api.photos.suggestCamera({ id: p })).toEqual({
      camera: { xM: 0.3, yM: 1.9, headingDeg: 12.4, fovDeg: 60, heightM: 1.5 },
      basis: "pins",
    });

    // two Things whose centroid is (2, 0.5): the camera stands at the bottom wall, facing up the plan (90°)
    const lamp = await thing("Lamp", { roomId: keuken, pos: { xM: 0.25, yM: 0.25, wM: 0.5, dM: 0.5, rotDeg: 30 } });
    await db.update(items).set({ pos: { xM: 3.25, yM: 0.25, wM: 0.5, dM: 0.5, rotDeg: 0 } }).where(eq(items.id, kettle));
    await db.insert(photoPins).values({ photoId: p, itemId: lamp, xPct: 40, yPct: 40, label: "lamp", status: "confirmed" });
    expect(await api.photos.suggestCamera({ id: p })).toEqual({
      camera: { xM: 2, yM: 2.7, headingDeg: 90, fovDeg: 60, heightM: 1.5 },
      basis: "pins",
    });
    const stored = await db.select().from(photoPins).where(and(eq(photoPins.photoId, p), eq(photoPins.status, "confirmed")));
    expect(stored).toHaveLength(2);
  });
});
