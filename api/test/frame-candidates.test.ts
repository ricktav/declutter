// One frame per Thing on a Photo. Every source keeps its own candidate.
// A confirmed user or Focus frame beats a higher model score. Dismissing
// hides that candidate and leaves the row. Old pins.add callers still insert.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, houses, items, photoPins, photos, rooms } from "@db/schema";
import { batchQuality, registerFrameCandidate } from "../lib/frameCandidates";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";

beforeEach(async () => {
  await resetTestDb();
});

async function seed() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "lab", name: "Lab" }).$returningId();
  const [{ id: roomId }] = await db
    .insert(rooms)
    .values({ houseId: h1, name: "Zolder", floor: "ground", source: "manual" })
    .$returningId();
  const [{ id: photoId }] = await db
    .insert(photos)
    .values({ roomId, title: "shelf", storageKey: "local/frame-candidates.jpg" })
    .$returningId();
  const [{ id: itemId }] = await db.insert(items).values({ areaId, houseId: h1, roomId, name: "Kettle" }).$returningId();
  return { db, h1, photoId, itemId, roomId };
}

describe("frame candidates", () => {
  it("keeps an inbox candidate when a user frame is placed on the same Thing", async () => {
    const { db, h1, photoId, itemId } = await seed();
    const [{ id: inboxId }] = await db
      .insert(photoPins)
      .values({
        photoId,
        itemId,
        xPct: 10,
        yPct: 12,
        wPct: 8,
        hPct: 9,
        label: "model",
        origin: "ai",
        status: "suggested",
        source: "inbox",
        quality: 99,
      })
      .$returningId();

    const placed = await callerFor(h1).pins.add({
      photoId,
      xPct: 40,
      yPct: 50,
      wPct: 20,
      hPct: 18,
      itemId,
      label: "Kettle",
      onePerThing: true,
    });
    expect(placed.existing).toBe(false);
    expect(placed.id).not.toBe(inboxId);

    const rows = await db.select().from(photoPins).where(eq(photoPins.photoId, photoId));
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.id === inboxId)).toMatchObject({ xPct: 10, yPct: 12, wPct: 8, hPct: 9, source: "inbox", status: "suggested" });
    expect(rows.find((p) => p.id === placed.id)).toMatchObject({ xPct: 40, yPct: 50, source: "user", status: "confirmed" });
  });

  it("shows the confirmed user frame even when the model score looks higher", async () => {
    const { db, h1, photoId, itemId, roomId } = await seed();
    const [{ id: batchId }] = await db
      .insert(photoPins)
      .values({
        photoId,
        itemId,
        xPct: 70,
        yPct: 70,
        wPct: 15,
        hPct: 15,
        label: "batch",
        origin: "ai",
        status: "suggested",
        source: "batch",
        quality: 99,
      })
      .$returningId();
    const user = await callerFor(h1).pins.add({
      photoId,
      xPct: 30,
      yPct: 30,
      wPct: 12,
      hPct: 12,
      itemId,
      label: "Kettle",
      source: "user",
    });

    const caller = callerFor(h1);
    expect((await caller.pins.listForPhoto({ photoId })).map((p) => p.id)).toEqual([user.id]);
    expect((await caller.pins.listForItem({ itemId })).map((p) => p.id)).toEqual([user.id]);
    expect((await caller.pins.listForRoom({ roomId })).map((p) => p.id)).toEqual([user.id]);
    expect((await db.select().from(photoPins)).map((p) => p.id).sort()).toEqual([batchId, user.id].sort());
  });

  it("uses the highest quality, then the newest, when no person has confirmed a frame", async () => {
    const { db, h1, photoId, itemId } = await seed();
    await db.insert(photoPins).values({
      photoId,
      itemId,
      xPct: 10,
      yPct: 10,
      wPct: 5,
      hPct: 5,
      label: "older",
      origin: "ai",
      status: "suggested",
      source: "batch",
      quality: 70,
    });
    const [{ id: newer }] = await db
      .insert(photoPins)
      .values({
        photoId,
        itemId,
        xPct: 20,
        yPct: 20,
        wPct: 6,
        hPct: 6,
        label: "newer",
        origin: "ai",
        status: "suggested",
        source: "inbox",
        quality: 70,
      })
      .$returningId();
    expect((await callerFor(h1).pins.listForPhoto({ photoId })).map((p) => p.id)).toEqual([newer]);

    const [{ id: sharper }] = await db
      .insert(photoPins)
      .values({
        photoId,
        itemId,
        xPct: 80,
        yPct: 80,
        wPct: 7,
        hPct: 7,
        label: "sharper",
        origin: "ai",
        status: "suggested",
        source: "batch",
        quality: 95,
      })
      .$returningId();
    // two batch rows: the helper's same-source update is what --apply uses;
    // a higher quality still wins the read either way
    expect((await callerFor(h1).pins.listForPhoto({ photoId })).map((p) => p.id)).toEqual([sharper]);
  });

  it("dismissing hides the frame and keeps every candidate", async () => {
    const { db, h1, photoId, itemId } = await seed();
    const [{ id: inboxId }] = await db
      .insert(photoPins)
      .values({
        photoId,
        itemId,
        xPct: 10,
        yPct: 10,
        wPct: 8,
        hPct: 8,
        label: "model",
        origin: "ai",
        status: "suggested",
        source: "inbox",
        quality: 99,
      })
      .$returningId();
    const user = await callerFor(h1).pins.add({
      photoId,
      xPct: 40,
      yPct: 40,
      wPct: 10,
      hPct: 10,
      itemId,
      label: "Kettle",
    });
    await callerFor(h1).pins.resolve({ id: user.id, confirm: false });

    const rows = await db.select().from(photoPins);
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.id === user.id)).toMatchObject({ status: "dismissed", xPct: 40 });
    expect(rows.find((p) => p.id === inboxId)).toMatchObject({ status: "suggested", xPct: 10 });
    expect((await callerFor(h1).pins.listForPhoto({ photoId })).map((p) => p.id)).toEqual([inboxId]);
    const withHistory = await callerFor(h1).pins.listForPhoto({ photoId, includeDismissed: true });
    expect(withHistory.map((p) => p.id).sort()).toEqual([inboxId, user.id].sort());
  });

  it("still inserts for a pins.add caller that does not pass onePerThing, and still moves a legacy pin", async () => {
    const { db, h1, photoId, itemId } = await seed();
    const [{ id: legacyId }] = await db
      .insert(photoPins)
      .values({ photoId, itemId, xPct: 5, yPct: 5, wPct: 4, hPct: 4, label: "old", origin: "user", status: "dismissed" })
      .$returningId();

    const moved = await callerFor(h1).pins.add({
      photoId,
      xPct: 60,
      yPct: 61,
      itemId,
      label: "moved",
      onePerThing: true,
    });
    expect(moved).toEqual({ id: legacyId, existing: true });
    const legacy = (await db.select().from(photoPins).where(eq(photoPins.id, legacyId)))[0];
    expect(legacy).toMatchObject({ xPct: 60, yPct: 61, wPct: 4, hPct: 4, status: "confirmed", source: "user" });

    const added = await callerFor(h1).pins.add({ photoId, xPct: 15, yPct: 15, itemId, label: "again" });
    expect(added).toMatchObject({ existing: false });
    expect(added.id).not.toBe(legacyId);
    expect(await db.select().from(photoPins)).toHaveLength(2);
  });

  it("a batch candidate does not replace a user frame, and its score stays below a confirm", async () => {
    const { db, h1, photoId, itemId } = await seed();
    const user = await callerFor(h1).pins.add({
      photoId,
      xPct: 25,
      yPct: 25,
      wPct: 10,
      hPct: 10,
      itemId,
      label: "Kettle",
      source: "focus",
    });
    await db.transaction((tx) =>
      registerFrameCandidate(tx, {
        photoId,
        itemId,
        source: "batch",
        quality: batchQuality(0.97),
        xPct: 80,
        yPct: 80,
        wPct: 20,
        hPct: 20,
        label: "kettle",
        origin: "ai",
        status: "suggested",
        replaceBox: true,
        adoptUnsourced: true,
      }),
    );
    expect(batchQuality(0)).toBe(40);
    expect(batchQuality(0.97)).toBe(97);
    const rows = await db.select().from(photoPins);
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.id === user.id)).toMatchObject({ xPct: 25, source: "focus" });
    expect((await callerFor(h1).pins.listForItem({ itemId })).map((p) => p.id)).toEqual([user.id]);
  });
});
