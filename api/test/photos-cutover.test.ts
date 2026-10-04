// api/test/photos-cutover.test.ts
import fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { areas, captures, houses, itemLinks, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { keyPath, removeTestUploads, trackedUploads, writeTestJpeg } from "./fixtures";
import { addPhoto } from "../lib/photos";

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: itemId }] = await db.insert(items).values({ areaId, name: "pan", houseId: h1, roomId: keuken }).$returningId();
  return { db, h1, areaId, keuken, itemId };
}

describe("after the cutover, a filed object is visible everywhere", () => {
  it("inbox.fileObject writes a photo that items.listAll, items.get, photos.listAll and attachments.listForItem all show", async () => {
    const { db, h1, areaId, keuken } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();

    const { itemId } = await callerFor(h1).inbox.fileObject({
      id: capId, label: "mug", xPct: 50, yPct: 50, wPct: 20, hPct: 20,
      itemId: null, itemName: "Mug", areaId, roomId: keuken,
    });

    const [photo] = await db.select().from(photos).where(eq(photos.itemId, itemId));
    expect([photo.sourceCaptureId, photo.cropBox]).toEqual([capId, { xPct: 50, yPct: 50, wPct: 20, hPct: 20 }]);
    const listed = await callerFor(h1).items.listAll({});
    expect(listed.find((i) => i.id === itemId)?.imageKey).toBe(photo.storageKey);
    const detail = await callerFor(h1).items.get({ id: itemId });
    expect(detail?.photos.map((p) => p.id)).toEqual([photo.id]);
    expect(detail?.links).toEqual([]);
    expect(detail?.attachments.map((a) => [a.id, a.kind])).toEqual([[photo.id, "image"]]);
    const catalog = await callerFor(h1).photos.listAll();
    // the cutout, plus the capture's location photo the item is pinned on
    const [location] = await db.select().from(photos).where(and(eq(photos.sourceCaptureId, capId), isNull(photos.itemId)));
    expect(
      catalog
        .filter((r) => r.source === "photo")
        .map((r) => r.id)
        .sort((a, b) => a - b),
    ).toEqual([location.id, photo.id].sort((a, b) => a - b));
    expect(catalog.some((r) => r.source === "capture" && r.id === capId)).toBe(false);
    expect((await callerFor(h1).attachments.listForItem({ itemId })).map((a) => [a.id, a.kind])).toEqual([[photo.id, "image"]]);
  });
});

describe("inbox.acceptMany after the cutover", () => {
  it("an image capture gives the new item its own photo copy; a note capture an item_link; both remember the capture", async () => {
    const { db, h1, areaId } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: imgCap }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
    const [{ id: noteCap }] = await db.insert(captures).values({ kind: "note", rawText: "a lamp with a broken switch" }).$returningId();

    await callerFor(h1).inbox.acceptMany({ id: imgCap, items: [{ areaId, itemId: null, itemName: "Lamp" }] });
    await callerFor(h1).inbox.acceptMany({ id: noteCap, items: [{ areaId, itemId: null, itemName: "Idea" }] });

    const [lamp] = await db.select().from(items).where(eq(items.name, "Lamp"));
    const [idea] = await db.select().from(items).where(eq(items.name, "Idea"));
    const [photo] = await db.select().from(photos).where(eq(photos.itemId, lamp.id));
    expect(photo.storageKey).not.toBe(capKey);
    expect(photo.sourceCaptureId).toBe(imgCap);
    const [note] = await db.select().from(itemLinks).where(eq(itemLinks.itemId, idea.id));
    expect([note.kind, note.content, note.sourceCaptureId]).toEqual(["note", "a lamp with a broken switch", noteCap]);
    expect(await db.select().from(photos).where(eq(photos.itemId, idea.id))).toHaveLength(0);
  });

  it("stays all-or-nothing: a capture whose file is gone files no item at all", async () => {
    const { db, h1, areaId } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/test-fake-gone.jpg" }).$returningId();
    await expect(
      callerFor(h1).inbox.acceptMany({
        id: capId,
        items: [
          { areaId, itemId: null, itemName: "One" },
          { areaId, itemId: null, itemName: "Two" },
        ],
      }),
    ).rejects.toThrow();
    expect(await db.select().from(items)).toHaveLength(1); // only the seeded "pan"
    expect(await db.select().from(photos)).toHaveLength(0);
  });

  it("a failed filing deletes the file copies it made for rolled-back items", async () => {
    const { db, h1, areaId } = await seed();
    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
    await expect(
      callerFor(h1).inbox.acceptMany({
        id: capId,
        items: [
          { areaId, itemId: null, itemName: "One" },
          // longer than items.name (varchar 255): the second insert fails, the transaction rolls back
          { areaId, itemId: null, itemName: "x".repeat(300) },
        ],
      }),
    ).rejects.toThrow();
    const copies = trackedUploads().filter((k) => k.includes("-items_"));
    expect(copies).toHaveLength(1);
    expect(copies.filter((k) => fs.existsSync(keyPath(k)))).toEqual([]);
    expect(fs.existsSync(keyPath(capKey))).toBe(true);
    expect(await db.select().from(items)).toHaveLength(1); // only the seeded "pan"
  });
});

describe("inbox.mergeDuplicates after the cutover", () => {
  it("keeps (dismisses) a duplicate capture that a photo or an item_link was made from, and deletes the rest", async () => {
    const { db, h1 } = await seed();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [{ id }] = await db
        .insert(captures)
        .values({ kind: "image", storageKey: await writeTestJpeg(), contentHash: "same", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) })
        .$returningId();
      ids.push(id);
    }
    await db.insert(photos).values({ storageKey: "local/test-fake-merge-photo.jpg", sourceCaptureId: ids[1] });
    await db.insert(itemLinks).values({ kind: "file", storageKey: "local/test-fake-merge-file.pdf", sourceCaptureId: ids[2] });

    expect(await callerFor(h1).inbox.mergeDuplicates()).toEqual({ merged: 1, skipped: 2 });
    const left = await db.select().from(captures);
    expect(new Map(left.map((c) => [c.id, c.status]))).toEqual(
      new Map([
        [ids[0], "pending"],
        [ids[1], "dismissed"],
        [ids[2], "dismissed"],
      ]),
    );
  });
});

describe("items.remove after the cutover (deleteItemTx)", () => {
  it("items.remove removes photos, pins on them, links and their files; unlinks pins elsewhere; keeps a file a capture uses", async () => {
    const { db, h1, itemId } = await seed();
    const photoKey = await writeTestJpeg();
    const fileKey = await writeTestJpeg();
    const sharedKey = await writeTestJpeg();
    const [{ id: own }] = await db.insert(photos).values({ itemId, storageKey: photoKey }).$returningId();
    await db.insert(photos).values({ itemId, storageKey: sharedKey });
    await db.insert(captures).values({ kind: "image", storageKey: sharedKey });
    const [{ id: other }] = await db.insert(photos).values({ storageKey: "local/test-fake-wall.jpg" }).$returningId();
    await db.insert(photoPins).values([
      { photoId: own, xPct: 1, yPct: 1, label: "drawn on the pan's own photo" },
      { photoId: other, xPct: 2, yPct: 2, label: "pan", itemId },
    ]);
    await db.insert(itemLinks).values([
      { itemId, kind: "note", content: "n" },
      { itemId, kind: "file", storageKey: fileKey },
    ]);

    expect(await callerFor(h1).items.remove({ id: itemId })).toEqual({ ok: true });

    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([other]);
    expect(await db.select().from(itemLinks)).toHaveLength(0);
    expect((await db.select().from(photoPins)).map((p) => [p.photoId, p.itemId])).toEqual([[other, null]]);
    expect([photoKey, fileKey, sharedKey].map((k) => fs.existsSync(keyPath(k)))).toEqual([false, false, true]);
  });
});

describe("rooms after the cutover", () => {
  it("rooms.remove clears roomId on that room's location photos", async () => {
    const { db, h1, keuken } = await seed();
    const [{ id: photoId }] = await db.insert(photos).values({ roomId: keuken, storageKey: "local/test-fake-room.jpg" }).$returningId();
    await callerFor(h1).rooms.remove({ id: keuken, force: true });
    const [row] = await db.select().from(photos).where(eq(photos.id, photoId));
    expect(row.roomId).toBeNull();
  });
});

describe("deprecated attachments.* aliases", () => {
  it("never confuse a photo and a link that share a numeric id", async () => {
    const { db, h1, itemId } = await seed();
    await db.insert(photos).values({ id: 7, itemId, storageKey: "local/test-fake-seven.jpg" });
    await db.insert(itemLinks).values({ id: 7, itemId, kind: "note", content: "seven" });

    const listed = await callerFor(h1).attachments.listForItem({ itemId });
    expect(listed.map((a) => [a.id, a.kind]).sort()).toEqual([[-7, "note"], [7, "image"]]);
    await callerFor(h1).attachments.remove({ id: -7 });
    expect(await db.select().from(itemLinks)).toHaveLength(0);
    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([7]);
  });

  it("attachments.unlink puts a photo back in the pool and refuses a negative id", async () => {
    const { db, h1, itemId, areaId, keuken } = await seed();
    const photo = await addPhoto(db, { itemId, areaId, storageKey: await writeTestJpeg() });

    expect(await callerFor(h1).attachments.unlink({ id: photo.id })).toEqual({ ok: true });
    const [row] = await db.select().from(photos).where(eq(photos.id, photo.id));
    expect(row.itemId).toBeNull();
    expect(row.roomId).toBe(keuken);
    await expect(callerFor(h1).attachments.unlink({ id: -1 })).rejects.toThrow(/Only a photo/);
  });

  it("add routes images to photos and the rest to item_links; url, listAllImages and remove keep their shapes", async () => {
    const { db, h1, itemId, areaId } = await seed();
    const key = await writeTestJpeg();
    const img = await callerFor(h1).attachments.add({ itemId, areaId, kind: "image", storageKey: key, fileName: "a.jpg" });
    const link = await callerFor(h1).attachments.add({ itemId, areaId, kind: "link", url: "https://example.com", title: "Manual" });
    expect(img).toEqual({ id: expect.any(Number), storageKey: key });
    expect(img.id).toBeGreaterThan(0);
    expect(link.id).toBeLessThan(0);
    expect((await db.select().from(itemLinks)).map((l) => [-l.id, l.url])).toEqual([[link.id, "https://example.com"]]);
    await expect(callerFor(h1).attachments.add({ itemId, kind: "image" })).rejects.toThrow(/storageKey/);

    expect((await callerFor(h1).attachments.listAllImages()).map((r) => [r.source, r.id])).toEqual([["attachment", img.id]]);
    expect(await callerFor(h1).attachments.url({ key })).toEqual({ url: expect.stringMatching(/^\/uploads\/test-/) });
    await callerFor(h1).attachments.remove({ id: img.id });
    expect(fs.existsSync(keyPath(key))).toBe(false);
  });
});

describe("items.get deprecated attachments field", () => {
  it("lists photos with their id and links with a negated id, newest first, and the ids round-trip", async () => {
    const { db, h1, itemId } = await seed();
    await db.insert(photos).values({ id: 5, itemId, storageKey: "local/test-fake-five.jpg", createdAt: new Date("2026-01-01T00:00:00Z") });
    await db.insert(itemLinks).values({ id: 5, itemId, kind: "link", url: "https://example.org", createdAt: new Date("2026-01-02T00:00:00Z") });
    const got = await callerFor(h1).items.get({ id: itemId });
    expect(got!.attachments.map((a) => [a.id, a.kind])).toEqual([[-5, "link"], [5, "image"]]);
    await callerFor(h1).attachments.remove({ id: got!.attachments[0].id });
    expect(await db.select().from(itemLinks)).toHaveLength(0);
    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([5]);
  });
});
