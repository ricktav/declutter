import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { itemLinks, photoPins, photos } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";

beforeEach(async () => {
  await resetTestDb();
});

describe("photos schema", () => {
  it("stores a photo under an explicit id with its crop box as JSON, and a pin pointing at it", async () => {
    const db = getTestDb();
    await db.insert(photos).values({
      id: 41,
      storageKey: "local/test-fake-schema.jpg",
      sourceCaptureId: 7,
      cropBox: { xPct: 50, yPct: 40, wPct: 20, hPct: 10 },
    });
    await db.insert(photoPins).values({ id: 5, photoId: 41, xPct: 10, yPct: 20, label: "mug" });

    const [p] = await db.select().from(photos).where(eq(photos.id, 41));
    expect(p.cropBox).toEqual({ xPct: 50, yPct: 40, wPct: 20, hPct: 10 });
    expect([p.itemId, p.roomId, p.sourceCaptureId]).toEqual([null, null, 7]);
    const [pin] = await db.select().from(photoPins).where(eq(photoPins.photoId, 41));
    expect([pin.id, pin.status, pin.origin, pin.flagged]).toEqual([5, "confirmed", "user", false]);

    // an explicit id moves the counter past it, which the id-preserving copy relies on
    const [{ id: next }] = await db.insert(photos).values({ storageKey: "local/test-fake-schema-2.jpg" }).$returningId();
    expect(next).toBe(42);
  });

  it("refuses a photo without a storage key", async () => {
    const db = getTestDb();
    await expect(db.insert(photos).values({ storageKey: null as unknown as string })).rejects.toThrow();
  });

  it("keeps two identical notes on one item as two rows, each remembering its capture", async () => {
    const db = getTestDb();
    await db.insert(itemLinks).values([
      { itemId: 1, kind: "note", content: "same", sourceCaptureId: 3 },
      { itemId: 1, kind: "note", content: "same", sourceCaptureId: 3 },
    ]);
    const rows = await db.select().from(itemLinks).where(eq(itemLinks.itemId, 1));
    expect(rows.map((r) => [r.kind, r.content, r.url, r.sourceCaptureId])).toEqual([
      ["note", "same", null, 3],
      ["note", "same", null, 3],
    ]);
  });

  it("has no attachments or photo_annotations table any more", async () => {
    const db = getTestDb();
    const [rows] = await db.execute(
      sql`select table_name as t from information_schema.tables where table_schema = database() and table_name in ('attachments', 'photo_annotations')`,
    );
    expect(rows).toEqual([]);
  });
});
