// api/test/photos-routers.test.ts
import fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, captures, events, houses, itemLinks, items, photoPins, photos, rooms } from "@db/schema";
import mysql from "mysql2/promise";
import { getTestDb, requireTestDatabaseUrl, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { keyPath, removeTestUploads, writeTestJpeg, writeTestPng } from "./fixtures";
import { releaseStoredFiles } from "../lib/entities";
import { coverPhotos } from "../lib/photos";

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "Kitchen stuff" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId: keuken }).$returningId();
  return { db, h1, areaId, keuken, itemId };
}

const box = { xPct: 50, yPct: 50, wPct: 40, hPct: 40 };

describe("photos.add / remove", () => {
  it("add sniffs the file; remove deletes the photo, its pins and its file", async () => {
    const { db, h1, itemId, areaId } = await seed();
    const key = await writeTestJpeg();
    const { id } = await callerFor(h1).photos.add({ itemId, areaId, storageKey: key, title: "front" });
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    expect([row.mimeType, row.itemId, (row.size ?? 0) > 0]).toEqual(["image/jpeg", itemId, true]);

    await callerFor(h1).pins.add({ photoId: id, xPct: 10, yPct: 10, label: "handle" });
    await callerFor(h1).photos.remove({ id });
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(await db.select().from(photoPins)).toHaveLength(0);
    expect(fs.existsSync(keyPath(key))).toBe(false);
  });

  it("remove keeps the file while an inbox capture still uses the same key", async () => {
    const { db, h1, itemId } = await seed();
    const key = await writeTestJpeg();
    await db.insert(captures).values({ kind: "image", storageKey: key });
    const { id } = await callerFor(h1).photos.add({ itemId, storageKey: key });
    await callerFor(h1).photos.remove({ id });
    expect(fs.existsSync(keyPath(key))).toBe(true);
  });
});

describe("photos.unlink", () => {
  it("puts the photo back in the pool, in its item's room", async () => {
    const { db, h1, itemId, keuken } = await seed();
    const [{ id }] = await db.insert(photos).values({ itemId, storageKey: "local/test-fake-unlink.jpg" }).$returningId();
    await callerFor(h1).photos.unlink({ id });
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    expect([row.itemId, row.roomId]).toEqual([null, keuken]);
  });
});

describe("photos.ensureForCapture / createCutout / recrop", () => {
  it("ensureForCapture makes one bare photo per capture with its own copy of the file, and saves a room given later", async () => {
    const { db, h1, keuken } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();

    const first = await callerFor(h1).photos.ensureForCapture({ captureId: capId });
    const again = await callerFor(h1).photos.ensureForCapture({ captureId: capId, roomId: keuken });
    expect(again.photoId).toBe(first.photoId);

    const [row] = await db.select().from(photos).where(eq(photos.id, first.photoId));
    expect(row.storageKey).not.toBe(capKey);
    expect([row.itemId, row.roomId, row.sourceCaptureId]).toEqual([null, keuken, capId]);
    expect((await callerFor(h1).photos.get({ id: first.photoId })).url).toMatch(/^\/uploads\//);
  });

  it("createCutout crops from the source capture once per item and capture; recrop replaces the file", async () => {
    const { db, h1, itemId } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
    const { photoId } = await callerFor(h1).photos.ensureForCapture({ captureId: capId });

    const a = await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: photoId, box });
    const b = await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: photoId, box });
    expect([a.created, b.created, b.id]).toEqual([true, false, a.id]);
    const [cut] = await db.select().from(photos).where(eq(photos.id, a.id));
    expect([cut.itemId, cut.sourceCaptureId, cut.cropBox]).toEqual([itemId, capId, box]);
    expect(await callerFor(h1).photos.sourcePhoto({ photoId: a.id })).toMatchObject({ available: true, cropBox: box });

    const narrower = { ...box, wPct: 20 };
    const re = await callerFor(h1).photos.recrop({ photoId: a.id, box: narrower });
    const [after] = await db.select().from(photos).where(eq(photos.id, a.id));
    expect([after.storageKey, after.cropBox]).toEqual([re.storageKey, narrower]);
    expect(fs.existsSync(keyPath(a.storageKey))).toBe(false);
  });

  it("createCutout on a whole Photo from a capture makes a new cutout and leaves the whole Photo alone", async () => {
    const { db, h1, itemId } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
    const [{ id: whole }] = await db
      .insert(photos)
      .values({ itemId, sourceCaptureId: capId, storageKey: capKey, mimeType: "image/jpeg" })
      .$returningId();
    const cut = await callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: whole, box });
    expect(cut.created).toBe(true);
    expect(cut.id).not.toBe(whole);
    const [w] = await db.select().from(photos).where(eq(photos.id, whole));
    expect([w.storageKey, w.cropBox]).toEqual([capKey, null]);
    const [c] = await db.select().from(photos).where(eq(photos.id, cut.id));
    expect(c.cropBox).toEqual(box);
  });

  it("a source photo that is gone from disk gives a readable error and writes nothing", async () => {
    const { db, h1, itemId } = await seed();
    const [{ id: capId }] = await db
      .insert(captures)
      .values({ kind: "image", storageKey: "local/test-fake-missing-capture.jpg" })
      .$returningId();
    await expect(callerFor(h1).photos.ensureForCapture({ captureId: capId })).rejects.toThrow(/no longer available/);
    expect(await db.select().from(photos)).toHaveLength(0);

    const [{ id: bare }] = await db
      .insert(photos)
      .values({ storageKey: "local/test-fake-missing-photo.jpg", sourceCaptureId: capId })
      .$returningId();
    await expect(callerFor(h1).photos.createCutout({ itemId, sourcePhotoId: bare, box })).rejects.toThrow(/no longer available/);
    await expect(callerFor(h1).photos.recrop({ photoId: bare, box })).rejects.toThrow(/no longer available/);
    expect(await db.select().from(photos)).toHaveLength(1);
  });
});

describe("photos.listAll / forRoom", () => {
  it("lists filed photos with room, topic and cover flag, plus inbox photos that have no photo yet", async () => {
    const { db, h1, itemId, keuken } = await seed();
    const [{ id: filedCap }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-list-a.jpg" }).$returningId();
    const [{ id: looseCap }] = await db
      .insert(captures)
      .values({ kind: "image", storageKey: "local/test-fake-list-b.jpg", status: "triaged" })
      .$returningId();
    await db.insert(captures).values({ kind: "note", rawText: "not a photo" });
    const [{ id: cover }] = await db
      .insert(photos)
      .values({ itemId, storageKey: "local/test-fake-list-c.jpg", sourceCaptureId: filedCap })
      .$returningId();
    const [{ id: second }] = await db.insert(photos).values({ itemId, storageKey: "local/test-fake-list-d.jpg" }).$returningId();
    const [{ id: location }] = await db.insert(photos).values({ roomId: keuken, storageKey: "local/test-fake-list-e.jpg" }).$returningId();

    const rows = await callerFor(h1).photos.listAll();
    const byKey = new Map(rows.map((r) => [`${r.source}:${r.id}`, r]));
    expect(rows).toHaveLength(4);
    expect(byKey.get(`photo:${cover}`)).toMatchObject({
      itemName: "pan",
      roomName: "Keuken",
      floor: "ground",
      houseId: h1,
      areaName: "Kitchen stuff",
      isItemCover: true,
    });
    expect(byKey.get(`photo:${second}`)?.isItemCover).toBe(false);
    expect(byKey.get(`photo:${location}`)).toMatchObject({ itemId: null, roomId: keuken, roomName: "Keuken", isItemCover: false });
    expect(byKey.get(`capture:${looseCap}`)).toMatchObject({ captureId: looseCap, captureStatus: "triaged", isItemCover: false });
    expect(byKey.has(`capture:${filedCap}`)).toBe(false);
  });

  it("forRoom returns the source captures behind cutouts of items in the room", async () => {
    const { db, h1, itemId, keuken } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-forroom-src.jpg" }).$returningId();
    await db.insert(photos).values({ itemId, storageKey: "local/test-fake-forroom-cut.jpg", sourceCaptureId: capId });
    expect(await callerFor(h1).photos.forRoom({ roomId: keuken })).toEqual([
      { id: capId, storageKey: "local/test-fake-forroom-src.jpg", camera: null },
    ]);
    expect(await callerFor(h1).photos.forRoom({ roomId: 999999 })).toEqual([]);
  });

  it("forRoom carries the camera of the capture's location photo in this room", async () => {
    const { db, h1, itemId, keuken } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-forroom-cam.jpg" }).$returningId();
    await db.insert(photos).values({ itemId, storageKey: "local/test-fake-forroom-cam-cut.jpg", sourceCaptureId: capId });
    const camera = { xM: 1, yM: 1, headingDeg: 90, fovDeg: 60, heightM: 1.5 };
    await db.insert(photos).values({ roomId: keuken, storageKey: "local/test-fake-forroom-cam-loc.jpg", sourceCaptureId: capId, camera });
    expect(await callerFor(h1).photos.forRoom({ roomId: keuken })).toEqual([
      { id: capId, storageKey: "local/test-fake-forroom-cam.jpg", camera },
    ]);
  });
});

describe("pins", () => {
  it("lists a photo's pins with item names and an item's pins with their photo", async () => {
    const { db, h1, itemId } = await seed();
    const [{ id: photoId }] = await db.insert(photos).values({ storageKey: "local/test-fake-pins.jpg", title: "Kitchen wall" }).$returningId();
    const { id: pinId } = await callerFor(h1).pins.add({ photoId, xPct: 30, yPct: 40, label: "pan", itemId });
    expect((await callerFor(h1).pins.listForPhoto({ photoId })).map((p) => [p.id, p.itemName])).toEqual([[pinId, "pan"]]);
    const forItem = await callerFor(h1).pins.listForItem({ itemId });
    expect([forItem[0].photoId, forItem[0].photo?.title]).toEqual([photoId, "Kitchen wall"]);
    await callerFor(h1).pins.resolve({ id: pinId, confirm: false });
    expect(await db.select().from(photoPins)).toHaveLength(0);
  });

  it("detect on a photo that does not exist says so instead of throwing", async () => {
    const { h1 } = await seed();
    expect(await callerFor(h1).pins.detect({ photoId: 424242 })).toEqual({ ok: false, error: "No stored image for this photo." });
  });
});

describe("itemLinks", () => {
  it("keeps two identical notes, lists newest first, and remove releases a file link's file", async () => {
    const { db, h1, itemId, areaId } = await seed();
    await callerFor(h1).itemLinks.add({ itemId, areaId, kind: "note", content: "same" });
    await callerFor(h1).itemLinks.add({ itemId, areaId, kind: "note", content: "same" });
    const key = await writeTestJpeg();
    const file = await callerFor(h1).itemLinks.add({ itemId, kind: "file", title: "scan", storageKey: key, fileName: "scan.jpg" });

    expect((await callerFor(h1).itemLinks.listForItem({ itemId })).map((l) => l.kind).sort()).toEqual(["file", "note", "note"]);
    const [row] = await db.select().from(itemLinks).where(eq(itemLinks.id, file.id));
    expect(row.mimeType).toBe("image/jpeg");
    await callerFor(h1).itemLinks.remove({ id: file.id });
    expect(fs.existsSync(keyPath(key))).toBe(false);
  });
});

describe("releaseStoredFiles", () => {
  it("keeps a file a photo or a link still uses and deletes one nothing uses", async () => {
    const db = getTestDb();
    const byPhoto = await writeTestJpeg();
    const byLink = await writeTestJpeg();
    const loose = await writeTestJpeg();
    await db.insert(photos).values({ storageKey: byPhoto });
    await db.insert(itemLinks).values({ kind: "file", storageKey: byLink });
    expect(await releaseStoredFiles(db, [byPhoto, byLink, loose])).toBe(1);
    expect([byPhoto, byLink, loose].map((k) => fs.existsSync(keyPath(k)))).toEqual([true, true, false]);
  });
});

describe("photos.ensureForCapture (find-or-create)", () => {
  it("records the capture's real file type", async () => {
    const { db, h1 } = await seed();
    const key = await writeTestPng();
    const [{ id: captureId }] = await db.insert(captures).values({ kind: "image", storageKey: key }).$returningId();
    const { photoId } = await callerFor(h1).photos.ensureForCapture({ captureId });
    const [row] = await db.select().from(photos).where(eq(photos.id, photoId));
    expect(row.mimeType).toBe("image/png");
    expect(fs.existsSync(keyPath(row.storageKey))).toBe(true);
  });

  it("two calls at once make one photo", async () => {
    const { db, h1 } = await seed();
    const key = await writeTestJpeg();
    const [{ id: captureId }] = await db.insert(captures).values({ kind: "image", storageKey: key }).$returningId();
    const [a, b] = await Promise.all([
      callerFor(h1).photos.ensureForCapture({ captureId }),
      callerFor(h1).photos.ensureForCapture({ captureId }),
    ]);
    expect(a.photoId).toBe(b.photoId);
    expect(await db.select().from(photos)).toHaveLength(1);
  });

  // The Promise.all test above also passed before the lock existed (the two
  // calls rarely interleave), so it guards nothing. This one forces the race:
  // a second connection holds the capture row lock and makes the photo while
  // the call waits. With the lock the call reads after that commit and returns
  // the same photo; without it the call finds nothing, makes its own, and
  // resolves while the lock is still held.
  it("waits on the capture row lock, then returns the photo made meanwhile", async () => {
    const { db, h1, keuken } = await seed();
    const key = await writeTestJpeg();
    const [{ id: captureId }] = await db.insert(captures).values({ kind: "image", storageKey: key }).$returningId();
    const conn = await mysql.createConnection(requireTestDatabaseUrl());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("lock test timed out")), 15_000);
    });
    try {
      const run = async () => {
        await conn.beginTransaction();
        await conn.query("SELECT id FROM captures WHERE id = ? FOR UPDATE", [captureId]);
        const call = callerFor(h1).photos.ensureForCapture({ captureId, roomId: keuken });
        // settle-or-not probe: never let the pending call reject unobserved
        let settled = false;
        call.then(
          () => (settled = true),
          () => (settled = true),
        );
        await new Promise((r) => setTimeout(r, 300));
        expect(settled, "ensureForCapture resolved while another transaction held the capture lock").toBe(false);
        const [res] = await conn.query<mysql.ResultSetHeader>(
          "INSERT INTO photos (storageKey, mimeType, sourceCaptureId, roomId, title) VALUES (?, ?, ?, ?, ?)",
          [key, "image/jpeg", captureId, keuken, "Location photo"],
        );
        await conn.commit();
        const { photoId } = await call;
        expect(photoId).toBe(res.insertId);
        expect(await db.select().from(photos).where(eq(photos.sourceCaptureId, captureId))).toHaveLength(1);
      };
      await Promise.race([run(), timeout]);
    } finally {
      clearTimeout(timer);
      try {
        await conn.rollback();
      } finally {
        await conn.end();
      }
    }
  });
});

describe("photos.listAll titles", () => {
  it("listAll and the deprecated listAllImages carry each photo's title (the lab shows it as a caption)", async () => {
    const { db, h1, itemId } = await seed();
    await db.insert(photos).values({ itemId, storageKey: "local/test-fake-title.jpg", title: "front view" });
    expect((await callerFor(h1).photos.listAll()).map((r) => r.title)).toEqual(["front view"]);
    expect((await callerFor(h1).attachments.listAllImages()).map((r) => r.title)).toEqual(["front view"]);
  });
});

describe("coverPhotos", () => {
  async function add(itemId: number, name: string, cropBox: typeof box | null) {
    const [{ id }] = await getTestDb().insert(photos).values({ itemId, storageKey: `local/cover-${name}.jpg`, cropBox }).$returningId();
    return id;
  }

  it("prefers a cutout over an older whole Photo", async () => {
    const { db, itemId } = await seed();
    await add(itemId, "whole", null);
    const cut = await add(itemId, "cut", box);
    expect((await coverPhotos(db, [itemId])).get(itemId)?.id).toBe(cut);
    expect((await coverPhotos(db)).get(itemId)?.id).toBe(cut);
  });

  it("takes the newest of two cutouts", async () => {
    const { db, itemId } = await seed();
    await add(itemId, "cut1", box);
    const newer = await add(itemId, "cut2", box);
    await add(itemId, "whole", null);
    expect((await coverPhotos(db, [itemId])).get(itemId)?.id).toBe(newer);
  });

  it("takes the oldest whole Photo when there is no cutout", async () => {
    const { db, itemId } = await seed();
    const first = await add(itemId, "a", null);
    await add(itemId, "b", null);
    expect((await coverPhotos(db, [itemId])).get(itemId)?.id).toBe(first);
describe("photos.setRoom", () => {
  const cam = { xM: 1, yM: 1, headingDeg: 0, fovDeg: 60, heightM: 1.5 };

  it("sets the room, clears the camera when the room changes, and logs photo.moved", async () => {
    const { db, h1, keuken } = await seed();
    const [{ id: zolder }] = await db.insert(rooms).values({ houseId: h1, name: "Zolder", floor: "attic", source: "manual" }).$returningId();
    const [{ id }] = await db.insert(photos).values({ storageKey: "local/test-fake-setroom.jpg", roomId: keuken, camera: cam }).$returningId();
    const res = await callerFor(h1).photos.setRoom({ id, roomId: zolder });
    expect(res).toEqual({ id, roomId: zolder, cameraCleared: true });
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    expect([row.roomId, row.camera]).toEqual([zolder, null]);
    const [ev] = await db.select().from(events).where(eq(events.action, "photo.moved"));
    expect([ev.entityType, ev.entityId, ev.summary]).toEqual(["photo", id, "Photo moved to Zolder"]);
  });

  it("keeps the camera when the same room is set again", async () => {
    const { db, h1, keuken } = await seed();
    const [{ id }] = await db.insert(photos).values({ storageKey: "local/test-fake-setroom2.jpg", roomId: keuken, camera: cam }).$returningId();
    const res = await callerFor(h1).photos.setRoom({ id, roomId: keuken });
    expect(res.cameraCleared).toBe(false);
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    expect([row.roomId, row.camera]).toEqual([keuken, cam]);
  });

  it("null clears the Place and the camera", async () => {
    const { db, h1, keuken } = await seed();
    const [{ id }] = await db.insert(photos).values({ storageKey: "local/test-fake-setroom3.jpg", roomId: keuken, camera: cam }).$returningId();
    expect(await callerFor(h1).photos.setRoom({ id, roomId: null })).toEqual({ id, roomId: null, cameraCleared: true });
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    expect([row.roomId, row.camera]).toEqual([null, null]);
    const [ev] = await db.select().from(events).where(eq(events.action, "photo.moved"));
    expect(ev.summary).toBe("Photo's Place cleared");
  });

  it("refuses a room in another house than the photo's Thing, but lets a Thing-less photo go anywhere", async () => {
    const { db, h1, itemId, keuken } = await seed();
    const [{ id: h2 }] = await db.insert(houses).values({ name: "B" }).$returningId();
    const [{ id: elders }] = await db.insert(rooms).values({ houseId: h2, name: "Elders", floor: "ground", source: "manual" }).$returningId();
    const [{ id }] = await db.insert(photos).values({ itemId, storageKey: "local/test-fake-setroom4.jpg", roomId: keuken }).$returningId();
    await expect(callerFor(h1).photos.setRoom({ id, roomId: elders })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [row] = await db.select().from(photos).where(eq(photos.id, id));
    expect(row.roomId).toBe(keuken);
    const [{ id: free }] = await db.insert(photos).values({ storageKey: "local/test-fake-setroom5.jpg", roomId: keuken }).$returningId();
    expect((await callerFor(h1).photos.setRoom({ id: free, roomId: elders })).roomId).toBe(elders);
  });
});
