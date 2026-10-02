// api/test/copy-attachments.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { attachments, itemLinks, photoAnnotations, photoPins, photos } from "@db/schema";
import { getTestDb, requireTestDatabaseUrl, resetTestDb } from "./db";
import { blockingIds, copyAttachmentsToPhotos, planCopy, verifyCopy } from "../lib/copyAttachmentsToPhotos";

let conn: mysql.Connection;

beforeAll(async () => {
  // dateStrings: TIMESTAMP values round-trip as strings, so the copy cannot shift them across the DST gap
  conn = await mysql.createConnection({ uri: requireTestDatabaseUrl(), dateStrings: true });
});
afterAll(async () => {
  await conn.end();
});
beforeEach(async () => {
  await resetTestDb();
});

describe("copyAttachmentsToPhotos", () => {
  it("copies images to photos and link/note/file rows to item_links under their own ids, fields intact", async () => {
    const db = getTestDb();
    const box = { xPct: 50, yPct: 50, wPct: 20, hPct: 30 };
    const when = new Date("2025-03-04T05:06:07Z");
    await db.insert(attachments).values([
      { id: 10, itemId: 1, areaId: 2, roomId: 3, kind: "image", title: "Cutout: mug", storageKey: "local/test-fake-a.jpg", mimeType: "image/jpeg", size: 100, sourceCaptureId: 9, cropBox: box, createdAt: when },
      { id: 11, itemId: 1, areaId: 2, kind: "link", title: "Manual", url: "https://example.com/m.pdf", createdAt: when },
      { id: 12, itemId: 1, kind: "file", title: "receipt.pdf", storageKey: "local/test-fake-r.pdf", mimeType: "application/pdf", size: 5, sourceCaptureId: 8 },
    ]);

    expect(await copyAttachmentsToPhotos(conn)).toEqual({ photosCreated: 1, itemLinksCreated: 2, pinsCreated: 0 });

    const [p] = await db.select().from(photos).where(eq(photos.id, 10));
    expect([p.itemId, p.areaId, p.roomId, p.title, p.storageKey, p.mimeType, p.size, p.sourceCaptureId]).toEqual([
      1, 2, 3, "Cutout: mug", "local/test-fake-a.jpg", "image/jpeg", 100, 9,
    ]);
    expect(p.cropBox).toEqual(box);
    expect(p.createdAt.getTime()).toBe(when.getTime());

    const links = await db.select().from(itemLinks).orderBy(asc(itemLinks.id));
    expect(links.map((l) => [l.id, l.kind, l.title, l.url, l.storageKey, l.sourceCaptureId])).toEqual([
      [11, "link", "Manual", "https://example.com/m.pdf", null, null],
      [12, "file", "receipt.pdf", null, "local/test-fake-r.pdf", 8],
    ]);
    expect(links[0].createdAt.getTime()).toBe(when.getTime());
    expect(await db.select().from(attachments)).toHaveLength(3); // the copy never deletes
  });

  it("keeps two identical notes and two same-titled files as separate rows", async () => {
    const db = getTestDb();
    await db.insert(attachments).values([
      { id: 20, itemId: 1, kind: "note", content: "check the fuse" },
      { id: 21, itemId: 1, kind: "note", content: "check the fuse" },
      { id: 22, itemId: 1, kind: "file", title: "scan.pdf", storageKey: "local/test-fake-s.pdf" },
      { id: 23, itemId: 1, kind: "file", title: "scan.pdf", storageKey: "local/test-fake-s.pdf" },
    ]);
    await copyAttachmentsToPhotos(conn);
    expect((await db.select().from(itemLinks).orderBy(asc(itemLinks.id))).map((l) => l.id)).toEqual([20, 21, 22, 23]);
  });

  it("reports and never copies an image without a file; reports a link that carried a room", async () => {
    const db = getTestDb();
    await db.insert(attachments).values([
      { id: 30, itemId: 1, kind: "image", title: "lost" },
      { id: 31, kind: "note", content: "hall note", roomId: 4 },
      { id: 32, itemId: 1, kind: "image", storageKey: "local/test-fake-ok.jpg" },
    ]);
    const plan = await planCopy(conn);
    expect(plan.imagesWithoutFile).toEqual([30]);
    expect(plan.nonImageWithRoom).toEqual([31]);
    expect(blockingIds(plan)).toEqual([30, 31]);
    expect([plan.images, plan.links]).toEqual([1, 1]);

    await copyAttachmentsToPhotos(conn);
    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([32]);
    expect((await verifyCopy(conn)).ok).toBe(true);
  });

  it("moves pins onto the photo with the same id and skips pins whose photo is gone", async () => {
    const db = getTestDb();
    await db.insert(attachments).values({ id: 40, kind: "image", storageKey: "local/test-fake-p.jpg" });
    await db.insert(photoAnnotations).values([
      { id: 1, attachmentId: 40, xPct: 10, yPct: 20, wPct: 5, hPct: 6, label: "mug", itemId: 7, origin: "ai", status: "suggested", flagged: true },
      { id: 2, attachmentId: 999, xPct: 1, yPct: 1, label: "orphan" },
    ]);
    const plan = await planCopy(conn);
    expect([plan.pins, plan.orphanPins]).toEqual([1, [2]]);

    expect(await copyAttachmentsToPhotos(conn)).toEqual({ photosCreated: 1, itemLinksCreated: 0, pinsCreated: 1 });
    const pins = await db.select().from(photoPins);
    expect(pins.map((p) => [p.id, p.photoId, p.label, p.itemId, p.origin, p.status, p.flagged, p.wPct])).toEqual([
      [1, 40, "mug", 7, "ai", "suggested", true, 5],
    ]);
  });

  it("is idempotent; verify reports what is missing before the copy and nothing after", async () => {
    const db = getTestDb();
    await db.insert(attachments).values([
      { id: 50, kind: "image", storageKey: "local/test-fake-c.jpg" },
      { id: 51, kind: "note", content: "n" },
    ]);
    await db.insert(photoAnnotations).values({ id: 3, attachmentId: 50, xPct: 1, yPct: 1 });

    expect(await verifyCopy(conn)).toEqual({ missingPhotos: 1, missingItemLinks: 1, missingPins: 1, mismatched: 0, ok: false });
    await copyAttachmentsToPhotos(conn);
    expect(await copyAttachmentsToPhotos(conn)).toEqual({ photosCreated: 0, itemLinksCreated: 0, pinsCreated: 0 });
    expect(await verifyCopy(conn)).toEqual({ missingPhotos: 0, missingItemLinks: 0, missingPins: 0, mismatched: 0, ok: true });
    expect(await db.select().from(photos)).toHaveLength(1);
    // the counter moved past the legacy ids: a fresh photo cannot collide with, or reuse, one
    const [{ id: fresh }] = await db.insert(photos).values({ storageKey: "local/test-fake-fresh.jpg" }).$returningId();
    expect(fresh).toBeGreaterThan(51);
  });

describe("images that carry text", () => {
  it("reports an image with content as blocking, still copies the photo (text dropped), and re-runs copy nothing", async () => {
    const db = getTestDb();
    await db.insert(attachments).values({ id: 60, itemId: 1, kind: "image", storageKey: "local/test-fake-cap.jpg", content: "caption" });
    const plan = await planCopy(conn);
    expect(plan.imagesWithText).toEqual([60]);
    expect(plan.images).toBe(1);
    expect(blockingIds(plan)).toEqual([60]); // the CLI refuses --copy on this unless --accept-losses
    expect(await copyAttachmentsToPhotos(conn)).toEqual({ photosCreated: 1, itemLinksCreated: 0, pinsCreated: 0 });
    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([60]);
    expect(await copyAttachmentsToPhotos(conn)).toEqual({ photosCreated: 0, itemLinksCreated: 0, pinsCreated: 0 });
    expect((await verifyCopy(conn)).ok).toBe(true);
  });
});
});
