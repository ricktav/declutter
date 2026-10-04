// api/test/pins-from-cutouts.test.ts
// A cutout means its item is in the source photo: both crop paths pin the
// item there, so the Item view's "Seen in photos" (pins.listForItem) fills.
import { execFile } from "child_process";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { areas, captures, houses, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, requireTestDatabaseUrl, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";

const run = promisify(execFile);

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "Kitchen stuff" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const capKey = await writeTestJpeg();
  const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
  return { db, h1, areaId, keuken, capId };
}

const box = { xPct: 50, yPct: 40, wPct: 30, hPct: 20 };

describe("inbox.fileObject", () => {
  it("pins the new item on the capture's location photo, once", async () => {
    const { db, h1, areaId, keuken, capId } = await seed();
    const file = { id: capId, label: "kettle", ...box, itemName: "Kettle", areaId, roomId: keuken };
    const { itemId } = await callerFor(h1).inbox.fileObject({ ...file, itemId: null });

    const [location] = await db.select().from(photos).where(and(eq(photos.sourceCaptureId, capId), isNull(photos.itemId)));
    expect(location.roomId).toBe(keuken);
    const cutouts = await db.select().from(photos).where(eq(photos.itemId, itemId));
    expect(cutouts).toHaveLength(1);
    expect(cutouts[0].cropBox).toEqual(box);

    const pins = await db.select().from(photoPins);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ photoId: location.id, itemId, ...box, label: "kettle", status: "confirmed", origin: "user" });
    const seen = await callerFor(h1).pins.listForItem({ itemId });
    expect(seen.filter((p) => p.status === "confirmed").map((p) => p.photo?.id)).toEqual([location.id]);

    // filing the same object again adds a cutout but no second pin or location photo
    await callerFor(h1).inbox.fileObject({ ...file, itemId });
    expect(await db.select().from(photoPins)).toHaveLength(1);
    expect(await db.select().from(photos).where(isNull(photos.itemId))).toHaveLength(1);
  });

  it("reuses an existing location photo and confirms an AI-suggested pin for the item, keeping its box", async () => {
    const { db, h1, areaId, capId } = await seed();
    const { photoId } = await callerFor(h1).photos.ensureForCapture({ captureId: capId });
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "Kettle", houseId: h1 }).$returningId();
    await db
      .insert(photoPins)
      .values({ photoId, itemId, xPct: 10, yPct: 10, wPct: 5, hPct: 5, label: "kettle?", origin: "ai", status: "suggested" });

    await callerFor(h1).inbox.fileObject({ id: capId, label: "kettle", ...box, itemId, itemName: "Kettle", areaId });
    const pins = await db.select().from(photoPins);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ photoId, itemId, xPct: 10, status: "confirmed" });
    expect(await db.select().from(photos).where(isNull(photos.itemId))).toHaveLength(1);
  });
});

describe("photos.createCutout", () => {
  it("pins the item on the source photo with the item's name; the dedupe path keeps one pin", async () => {
    const { db, h1, areaId, capId } = await seed();
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "Toaster", houseId: h1 }).$returningId();
    const { photoId } = await callerFor(h1).photos.ensureForCapture({ captureId: capId });

    const a = await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: photoId, box });
    expect(a.created).toBe(true);
    let pins = await db.select().from(photoPins);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ photoId, itemId, ...box, label: "Toaster", status: "confirmed" });

    // dedupe path, after the pin was removed by hand: the pin comes back, once
    await db.delete(photoPins);
    const b = await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: photoId, box });
    const c = await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: photoId, box });
    expect([b.created, c.created, b.id]).toEqual([false, false, a.id]);
    pins = await db.select().from(photoPins);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ photoId, itemId });
  });

  it("does not add a second pin when the canvas pinned the item first", async () => {
    const { db, h1, areaId, capId } = await seed();
    const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "Toaster", houseId: h1 }).$returningId();
    const { photoId } = await callerFor(h1).photos.ensureForCapture({ captureId: capId });
    const { id: pinId } = await callerFor(h1).pins.add({ photoId, ...box, label: "Toaster", itemId });
    await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: photoId, box });
    expect((await db.select().from(photoPins)).map((p) => p.id)).toEqual([pinId]);
  });
});

describe("scripts/backfill-pins-from-cutouts.mjs", () => {
  const backfill = async (...args: string[]) =>
    (await run("node", ["scripts/backfill-pins-from-cutouts.mjs", "--url", requireTestDatabaseUrl(), ...args])).stdout.trim();

  it("pins pre-existing cutouts on their location photo, dry run first, and is idempotent", async () => {
    const { db, h1, areaId, capId } = await seed();
    const [{ id: itemA }] = await db.insert(items).values({ areaId, name: "Kettle", houseId: h1 }).$returningId();
    const [{ id: itemB }] = await db.insert(items).values({ areaId, name: "Toaster", houseId: h1 }).$returningId();
    const [{ id: itemC }] = await db.insert(items).values({ areaId, name: "Mixer", houseId: h1 }).$returningId();
    const [{ id: lonelyCap }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-lonely.jpg" }).$returningId();
    const [{ id: location }] = await db
      .insert(photos)
      .values({ storageKey: "local/test-fake-location.jpg", sourceCaptureId: capId, title: "Location photo" })
      .$returningId();
    const boxB = { xPct: 20, yPct: 30, wPct: 10, hPct: 10 };
    await db.insert(photos).values([
      { itemId: itemA, storageKey: "local/test-fake-cut-a.jpg", sourceCaptureId: capId, cropBox: box },
      { itemId: itemB, storageKey: "local/test-fake-cut-b.jpg", sourceCaptureId: capId, cropBox: boxB },
      { itemId: itemC, storageKey: "local/test-fake-cut-c.jpg", sourceCaptureId: lonelyCap, cropBox: box },
    ]);
    // B already pinned: left as is
    await db.insert(photoPins).values({ photoId: location, itemId: itemB, xPct: 1, yPct: 1, label: "old" });

    expect(await backfill()).toMatch(/Dry run on \w+_test: 3 cutouts, 1 pins to create, 1 without a location photo/);
    expect(await db.select().from(photoPins)).toHaveLength(1);

    expect(await backfill("--apply")).toMatch(/Applied on \w+_test: 3 cutouts, 1 pins created, 1 without a location photo/);
    const [pinA] = await db.select().from(photoPins).where(eq(photoPins.itemId, itemA));
    expect(pinA).toMatchObject({ photoId: location, ...box, label: "Kettle", status: "confirmed", origin: "user" });
    expect((await callerFor(h1).pins.listForItem({ itemId: itemA })).map((p) => p.photo?.id)).toEqual([location]);

    expect(await backfill("--apply")).toMatch(/3 cutouts, 0 pins created, 1 without a location photo/);
    expect(await db.select().from(photoPins).where(isNotNull(photoPins.itemId))).toHaveLength(2);
  });
});
