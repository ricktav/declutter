import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, attachments, captures, houses, items, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: capId }] = await db.insert(captures).values({ kind: "note", rawText: "a pan and a pot" }).$returningId();
  return { db, h1, areaId, keuken, capId };
}

describe("inbox.acceptMany", () => {
  it("files new items into the given room with the room's house", async () => {
    const { db, h1, areaId, keuken, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({
      id: capId,
      roomId: keuken,
      items: [
        { areaId, itemId: null, itemName: "pan" },
        { areaId, itemId: null, itemName: "pot" },
      ],
    });
    const rows = await db.select().from(items);
    expect(rows.map((r) => [r.roomId, r.houseId])).toEqual([[keuken, h1], [keuken, h1]]);
  });
  it("without a room, new items are unplaced in the context house", async () => {
    const { db, h1, areaId, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: null, itemName: "pan" }] });
    const [row] = await db.select().from(items);
    expect([row.roomId, row.houseId]).toEqual([null, h1]);
  });
});

describe("map.ensureAttachmentForCapture", () => {
  it("creates a location photo linked by roomId", async () => {
    const { db, h1, keuken } = await seed();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: "local/does-not-matter.jpg" }).$returningId();
    // the copy step needs a real file; stub it by writing one into uploads/
    const fs = await import("fs");
    fs.mkdirSync("uploads", { recursive: true });
    fs.writeFileSync("uploads/does-not-matter.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const r = await callerFor(h1).map.ensureAttachmentForCapture({ captureId: capId, roomId: keuken });
    const [att] = await db.select().from(attachments).where(eq(attachments.id, r.attachmentId));
    expect(att.roomId).toBe(keuken);
    expect(att.itemId).toBeNull();
    fs.rmSync(att.storageKey!.replace(/^local\//, "uploads/"), { force: true });
    fs.rmSync("uploads/does-not-matter.jpg", { force: true });
  });
});
