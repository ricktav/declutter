import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { captures, houses, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";

beforeEach(async () => {
  await resetTestDb();
});
afterEach(removeTestUploads);

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "Thuis" }).$returningId();
  const [{ id: h2 }] = await db.insert(houses).values({ name: "Boot" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const [{ id: roomInHouse2 }] = await db.insert(rooms).values({ houseId: h2, name: "Kajuit", floor: "deck", source: "manual" }).$returningId();
  return { db, h1, h2, keuken, roomInHouse2, api: callerFor(h1) };
}

describe("inbox.create with a roomId", () => {
  it("(a) a snap with a roomId lists with that photoRoomId", async () => {
    const { api, keuken } = await seed();
    const { id } = await api.inbox.create({ kind: "image", storageKey: await writeTestJpeg(), roomId: keuken });
    const row = (await api.inbox.list()).find((c) => c.id === id)!;
    expect(row.photoRoomId).toBe(keuken);
  });

  it("(b) an unknown room is refused", async () => {
    const { api } = await seed();
    await expect(api.inbox.create({ kind: "image", storageKey: await writeTestJpeg(), roomId: 999999 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Place not found.",
    });
  });

  it("(c) a room in another house places the snap there and sets the capture's house", async () => {
    const { db, api, h2, roomInHouse2 } = await seed();
    const { id } = await api.inbox.create({ kind: "image", storageKey: await writeTestJpeg(), roomId: roomInHouse2 });
    const [cap] = await db.select().from(captures).where(eq(captures.id, id));
    expect(cap.houseId).toBe(h2);
    expect((await callerFor(h2).inbox.list()).find((c) => c.id === id)!.photoRoomId).toBe(roomInHouse2);
  });

  it("(d) without roomId nothing changes", async () => {
    const { api } = await seed();
    const { id } = await api.inbox.create({ kind: "image", storageKey: await writeTestJpeg() });
    expect((await api.inbox.list()).find((c) => c.id === id)!.photoRoomId ?? null).toBeNull();
  });

  it("(e) a note ignores roomId", async () => {
    const { db, api, h1, keuken } = await seed();
    const { id } = await api.inbox.create({ kind: "note", rawText: "buy bulbs", roomId: keuken });
    const [cap] = await db.select().from(captures).where(eq(captures.id, id));
    expect(cap.houseId).toBe(h1);
    expect((await db.select().from(photos).where(eq(photos.sourceCaptureId, id))).length).toBe(0);
  });
});
