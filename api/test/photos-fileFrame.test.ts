// api/test/photos-fileFrame.test.ts
// photos.fileFrame: one frame on a photo becomes a Thing, a confirmed pin and
// (best-effort) a cutout in one call.
import fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, captures, houses, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { keyPath, removeTestUploads, writeTestJpeg } from "./fixtures";

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

const box = { xPct: 50, yPct: 50, wPct: 40, hPct: 40 };

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "Kitchen stuff" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const api = callerFor(h1);
  const capKey = await writeTestJpeg();
  const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
  const { photoId: sourcePhotoId } = await api.photos.ensureForCapture({ captureId: capId });
  return { db, api, h1, areaId, keuken, sourcePhotoId, capKey };
}

describe("photos.fileFrame", () => {
  it("(a) makes a Thing, a confirmed pin and a cutout from one frame", async () => {
    const { db, api, h1, keuken, sourcePhotoId } = await seed();
    const r = await api.photos.fileFrame({ sourcePhotoId, box: { xPct: 50, yPct: 50, wPct: 40, hPct: 40 }, itemId: null, itemName: "Lamp", roomId: keuken });
    expect(r).toMatchObject({ createdItem: true, createdPhoto: true, cutoutError: null });
    const [item] = await db.select().from(items).where(eq(items.id, r.itemId));
    expect(item).toMatchObject({ name: "Lamp", roomId: keuken, houseId: h1, verificationStatus: "confirmed" });
    const [pin] = await db.select().from(photoPins).where(eq(photoPins.id, r.pinId));
    expect(pin).toMatchObject({ photoId: sourcePhotoId, itemId: r.itemId, status: "confirmed" });
    const [cut] = await db.select().from(photos).where(eq(photos.id, r.photoId!));
    expect(cut.cropBox).toEqual({ xPct: 50, yPct: 50, wPct: 40, hPct: 40 });
  });

  it("(b) links an existing suggested pin to the new Thing instead of adding a pin", async () => {
    const { db, api, sourcePhotoId } = await seed();
    const { id: pinId } = await api.pins.add({ photoId: sourcePhotoId, xPct: 20, yPct: 20, wPct: 10, hPct: 10, label: "?" });
    const r = await api.photos.fileFrame({ sourcePhotoId, box: { xPct: 20, yPct: 20, wPct: 10, hPct: 10 }, itemId: null, itemName: "Mug", pinId });
    expect(r.pinId).toBe(pinId);
    expect((await db.select().from(photoPins).where(eq(photoPins.photoId, sourcePhotoId))).length).toBe(1);
    const [pin] = await db.select().from(photoPins).where(eq(photoPins.id, pinId));
    expect(pin).toMatchObject({ itemId: r.itemId, label: "Mug", status: "confirmed" });
  });

  it("(c) refuses a new Thing without a name", async () => {
    const { db, api, sourcePhotoId } = await seed();
    await expect(api.photos.fileFrame({ sourcePhotoId, box, itemId: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.select().from(items)).toHaveLength(0);
  });

  it("(d) stores a decision in the same call", async () => {
    const { db, api, sourcePhotoId } = await seed();
    const r = await api.photos.fileFrame({ sourcePhotoId, box, itemId: null, itemName: "Box", decision: "sell" });
    const [item] = await db.select().from(items).where(eq(items.id, r.itemId));
    expect(item.decision).toBe("sell");
    expect(item.decidedAt).not.toBeNull();
  });

  it("(e) a second frame for the same Thing on the same capture reuses the cutout", async () => {
    const { api, sourcePhotoId } = await seed();
    const r1 = await api.photos.fileFrame({ sourcePhotoId, box, itemId: null, itemName: "Pan" });
    const r2 = await api.photos.fileFrame({ sourcePhotoId, box, itemId: r1.itemId });
    expect(r2).toMatchObject({ createdItem: false, createdPhoto: false, photoId: r1.photoId });
  });

  it("(f) a failed crop is reported in cutoutError; the Thing and pin stay", async () => {
    const { db, api, sourcePhotoId, capKey } = await seed();
    fs.rmSync(keyPath(capKey), { force: true });
    const r = await api.photos.fileFrame({ sourcePhotoId, box, itemId: null, itemName: "Vase" });
    expect(r).toMatchObject({ createdItem: true, createdPhoto: false, photoId: null });
    expect(r.cutoutError).toMatch(/no longer available/);
    expect(await db.select().from(items).where(eq(items.id, r.itemId))).toHaveLength(1);
    const [pin] = await db.select().from(photoPins).where(eq(photoPins.id, r.pinId));
    expect(pin).toMatchObject({ itemId: r.itemId, status: "confirmed" });
  });

  it("(g) a frame thinner than 1% still saves the Thing and pin; the cutout is skipped", async () => {
    const { db, api, sourcePhotoId } = await seed();
    const r = await api.photos.fileFrame({ sourcePhotoId, box: { xPct: 50, yPct: 50, wPct: 10, hPct: 0.5 }, itemId: null, itemName: "Cable" });
    expect(r).toMatchObject({ createdItem: true, createdPhoto: false, photoId: null });
    expect(r.cutoutError).not.toBeNull();
    expect(await db.select().from(items).where(eq(items.id, r.itemId))).toHaveLength(1);
    const [pin] = await db.select().from(photoPins).where(eq(photoPins.id, r.pinId));
    expect(pin).toMatchObject({ photoId: sourcePhotoId, itemId: r.itemId, status: "confirmed" });
  });
});
