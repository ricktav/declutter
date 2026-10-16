// api/test/inbox-triage-boxes.test.ts
// inbox.triage asks for a frame per spotted object and stores it in the
// suggestion; inbox.acceptMany can pin that frame on the capture's photo and
// give a new Thing the crop as its photo. The model is mocked: generateObject
// parses a canned answer with the real triage schema, so the box cleaning the
// provider's answer goes through is the one under test.
import fs from "fs";
import mysql from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { areas, captures, houses, items, photoPins, photos, rooms, type TriageSuggestion } from "@db/schema";
import { getTestDb, requireTestDatabaseUrl, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { keyPath, removeTestUploads, trackedUploads, writeTestJpeg } from "./fixtures";

const model = vi.hoisted(() => ({ answer: null as unknown }));

vi.mock("../lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai")>()),
  getModel: async () => ({}),
  getTriageModel: async () => ({}),
  getTriageVisionModel: async () => ({}),
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({ object: schema.parse(model.answer) }),
}));

beforeEach(async () => {
  await resetTestDb();
  model.answer = null;
});
afterEach(removeTestUploads);

async function seed(kind: "image" | "note" = "image") {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: keuken }] = await db.insert(rooms).values({ houseId: h1, name: "Keuken", floor: "ground", source: "manual" }).$returningId();
  const storageKey = kind === "image" ? await writeTestJpeg() : null;
  const [{ id: capId }] = await db.insert(captures).values({ kind, storageKey, rawText: kind === "note" ? "a pan" : null }).$returningId();
  return { db, h1, areaId, keuken, capId };
}

const spotted = (itemName: string, box?: unknown) => ({
  itemName,
  areaSlug: "x",
  matchedItemId: null,
  isNewItem: true,
  attributes: {},
  confidence: "high",
  ...(box === undefined ? {} : { box }),
});

const pan = { xPct: 30, yPct: 40, wPct: 20, hPct: 25 };
const pot = { xPct: 70, yPct: 60, wPct: 30, hPct: 30 };

async function triage(h1: number, capId: number, answerItems: unknown[]) {
  model.answer = { note: "kitchen counter", floor: null, room: null, items: answerItems };
  const res = await callerFor(h1).inbox.triage({ id: capId });
  if (!res.ok) throw new Error(res.error);
  const [cap] = await getTestDb().select().from(captures).where(eq(captures.id, capId));
  return { returned: res.suggestion, stored: cap.suggestion as TriageSuggestion };
}

describe("inbox.triage boxes", () => {
  it("stores and returns a box per spotted object", async () => {
    const { h1, capId } = await seed();
    const { returned, stored } = await triage(h1, capId, [spotted("pan", pan), spotted("pot", pot)]);
    expect(returned.items.map((i) => i.box)).toEqual([pan, pot]);
    expect(stored.items.map((i) => i.box)).toEqual([pan, pot]);
  });

  it("an answer without boxes is still a suggestion, box null (older model, or omitted)", async () => {
    const { h1, capId } = await seed();
    const { returned, stored } = await triage(h1, capId, [spotted("pan"), spotted("pot", null)]);
    expect(returned.items.map((i) => [i.itemName, i.box])).toEqual([["pan", null], ["pot", null]]);
    expect(stored.items.map((i) => i.box)).toEqual([null, null]);
  });

  it("drops an invalid box from its item only, not the whole triage", async () => {
    const { h1, capId } = await seed();
    const { returned } = await triage(h1, capId, [
      spotted("outside", { xPct: 120, yPct: 40, wPct: 10, hPct: 10 }),
      spotted("zero", { xPct: 50, yPct: 50, wPct: 0, hPct: 10 }),
      spotted("negative", { xPct: 50, yPct: 50, wPct: 10, hPct: -5 }),
      spotted("garbage", { xPct: "left" }),
      spotted("pan", pan),
    ]);
    expect(returned.items.map((i) => [i.itemName, i.box])).toEqual([
      ["outside", null],
      ["zero", null],
      ["negative", null],
      ["garbage", null],
      ["pan", pan],
    ]);
  });
});

describe("inbox.acceptMany with a box", () => {
  it("pins a new Thing on the capture's location photo and gives it the crop as its photo", async () => {
    const { db, h1, areaId, keuken, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({
      id: capId,
      roomId: keuken,
      items: [
        { areaId, itemId: null, itemName: "pan", box: pan },
        { areaId, itemId: null, itemName: "pot", box: pot },
      ],
    });
    const things = await db.select().from(items).orderBy(items.id);
    expect(things.map((t) => t.name)).toEqual(["pan", "pot"]);

    // one location photo for the capture, in the room, holding both pins
    const locations = await db.select().from(photos).where(and(eq(photos.sourceCaptureId, capId), isNull(photos.itemId)));
    expect(locations).toHaveLength(1);
    expect(locations[0].roomId).toBe(keuken);
    const pins = await db.select().from(photoPins).orderBy(photoPins.id);
    expect(pins.map((p) => [p.photoId, p.itemId, p.status, p.xPct, p.yPct, p.wPct, p.hPct])).toEqual([
      [locations[0].id, things[0].id, "confirmed", 30, 40, 20, 25],
      [locations[0].id, things[1].id, "confirmed", 70, 60, 30, 30],
    ]);

    // each Thing's photo is its cutout (with the box), not a copy of the scene
    for (const [i, box] of [pan, pot].entries()) {
      const own = await db.select().from(photos).where(eq(photos.itemId, things[i].id));
      expect(own).toHaveLength(1);
      expect(own[0].cropBox).toEqual(box);
      expect(own[0].mimeType).toBe("image/jpeg");
      expect(own[0].storageKey).not.toBe(locations[0].storageKey);
    }
  });

  it("a later box upgrades a whole-scene pin instead of adding a second pin", async () => {
    const { db, h1, areaId, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: null, itemName: "pan", box: null }] });
    const [thing] = await db.select().from(items);
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: thing.id, itemName: "pan", box: pot }] });
    const pins = await db.select().from(photoPins);
    expect(pins).toHaveLength(1);
    expect([pins[0].wPct, pins[0].hPct]).toEqual([pot.wPct, pot.hPct]);
  });

  it("an existing match without a box is linked to the location photo, not copied", async () => {
    const { db, h1, areaId, capId } = await seed();
    const [{ id: kettle }] = await db.insert(items).values({ areaId, name: "kettle", houseId: h1 }).$returningId();
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: kettle, itemName: "kettle", box: null }] });
    expect(await db.select().from(photos).where(eq(photos.itemId, kettle))).toHaveLength(0);
    const [loc] = await db.select().from(photos).where(isNull(photos.itemId));
    const pins = await db.select().from(photoPins);
    expect(pins.map((p) => [p.photoId, p.itemId, p.wPct, p.hPct])).toEqual([[loc.id, kettle, 0, 0]]);
  });

  it("pins an existing match without re-photographing it", async () => {
    const { db, h1, areaId, capId } = await seed();
    const [{ id: kettle }] = await db.insert(items).values({ areaId, name: "kettle", houseId: h1 }).$returningId();
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: kettle, itemName: "kettle", box: pot }] });
    expect(await db.select().from(photos).where(eq(photos.itemId, kettle))).toHaveLength(0);
    const pins = await db.select().from(photoPins);
    expect(pins.map((p) => [p.itemId, p.status])).toEqual([[kettle, "confirmed"]]);
  });

  it("without a box links the Thing to the location photo; no per-Thing copy", async () => {
    const { db, h1, areaId, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({
      id: capId,
      items: [
        { areaId, itemId: null, itemName: "pan", box: null },
        { areaId, itemId: null, itemName: "pot", box: null },
      ],
    });
    const things = await db.select().from(items).orderBy(items.id);
    expect(things.map((t) => t.name)).toEqual(["pan", "pot"]);
    expect(await db.select().from(photos).where(eq(photos.itemId, things[0].id))).toHaveLength(0);
    expect(await db.select().from(photos).where(eq(photos.itemId, things[1].id))).toHaveLength(0);
    const locations = await db.select().from(photos).where(and(eq(photos.sourceCaptureId, capId), isNull(photos.itemId)));
    expect(locations).toHaveLength(1);
    const pins = await db.select().from(photoPins).orderBy(photoPins.id);
    expect(pins.map((p) => [p.photoId, p.itemId, p.wPct, p.hPct])).toEqual([
      [locations[0].id, things[0].id, 0, 0],
      [locations[0].id, things[1].id, 0, 0],
    ]);
    const detail = await callerFor(h1).items.get({ id: things[0].id });
    expect(detail?.photos.map((p) => [p.id, "shared" in p && p.shared])).toEqual([[locations[0].id, true]]);
    await callerFor(h1).items.remove({ id: things[0].id });
    expect((await db.select().from(photos)).map((p) => p.id)).toEqual([locations[0].id]);
    expect(fs.existsSync(keyPath(locations[0].storageKey))).toBe(true);
    expect((await db.select().from(photoPins)).map((p) => p.itemId)).toEqual([things[1].id]);
  });

  it("roomPhotos shows the shared scene once with the linked Things as chips", async () => {
    const { h1, areaId, keuken, capId } = await seed();
    await callerFor(h1).inbox.acceptMany({
      id: capId,
      roomId: keuken,
      items: [
        { areaId, itemId: null, itemName: "wardrobe", box: null },
        { areaId, itemId: null, itemName: "desk", box: null },
      ],
    });
    const rows = await callerFor(h1).photos.roomPhotos({ roomId: keuken });
    const full = rows.filter((r) => !r.isCrop);
    expect(full).toHaveLength(1);
    expect(full[0].linkedItems.map((i) => i.name).sort()).toEqual(["desk", "wardrobe"]);
  });

  it("hides existing uncropped copies of the same capture behind one canvas", async () => {
    const { db, h1, areaId, keuken } = await seed();
    const key = await writeTestJpeg();
    const [{ id: capId }] = await db.insert(captures).values({ kind: "image", storageKey: key }).$returningId();
    const [{ id: loc }] = await db
      .insert(photos)
      .values({ storageKey: key, sourceCaptureId: capId, roomId: keuken, title: "Location photo" })
      .$returningId();
    const [{ id: a }] = await db.insert(items).values({ areaId, name: "Wardrobe", houseId: h1, roomId: keuken }).$returningId();
    const [{ id: b }] = await db.insert(items).values({ areaId, name: "Chest", houseId: h1, roomId: keuken }).$returningId();
    await db.insert(photos).values([
      { itemId: a, storageKey: key, sourceCaptureId: capId, title: "copy a" },
      { itemId: b, storageKey: key, sourceCaptureId: capId, title: "copy b" },
    ]);
    const rows = await callerFor(h1).photos.roomPhotos({ roomId: keuken });
    const full = rows.filter((r) => !r.isCrop);
    expect(full.map((r) => r.photoId)).toEqual([loc]);
    expect(full[0].linkedItems.map((i) => i.name).sort()).toEqual(["Chest", "Wardrobe"]);
  });

  it("ignores a box on a capture without an image", async () => {
    const { db, h1, areaId, capId } = await seed("note");
    await callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: null, itemName: "pan", box: pan }] });
    expect(await db.select().from(items)).toHaveLength(1);
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(await db.select().from(photoPins)).toHaveLength(0);
  });

  it("rejects an invalid box on input", async () => {
    const { h1, areaId, capId } = await seed();
    await expect(
      callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: null, itemName: "pan", box: { ...pan, wPct: 0 } }] }),
    ).rejects.toThrow();
  });

  it("a failing item rolls the whole accept back and removes the files it wrote", async () => {
    const { db, h1, areaId, capId } = await seed();
    const before = trackedUploads().length;
    await expect(
      callerFor(h1).inbox.acceptMany({
        id: capId,
        items: [
          { areaId, itemId: null, itemName: "pan", box: pan },
          // an unsigned column: the insert fails after the first item's files exist
          { areaId: -1, itemId: null, itemName: "pot", box: pot },
        ],
      }),
    ).rejects.toThrow();
    const written = trackedUploads().slice(before);
    expect(written).toHaveLength(2); // the location photo and the pan's cutout
    for (const k of written) expect(fs.existsSync(keyPath(k)), k).toBe(false);
    expect(await db.select().from(items)).toHaveLength(0);
    expect(await db.select().from(photos)).toHaveLength(0);
    expect(await db.select().from(photoPins)).toHaveLength(0);
  });

  it("a missing capture file is PRECONDITION_FAILED, nothing written", async () => {
    const { db, h1, areaId, capId } = await seed();
    const [cap] = await db.select().from(captures).where(eq(captures.id, capId));
    fs.rmSync(keyPath(cap.storageKey!), { force: true });
    await expect(
      callerFor(h1).inbox.acceptMany({ id: capId, items: [{ areaId, itemId: null, itemName: "pan", box: pan }] }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Source photo is no longer available." });
    expect(await db.select().from(items)).toHaveLength(0);
  });

  // acceptMany's first read fixes its snapshot before it waits on the capture
  // lock. A location photo committed meanwhile by another connection must be
  // found (a locking read), not duplicated.
  it("waits on the capture row lock, then pins on the location photo made meanwhile", async () => {
    const { db, h1, areaId, keuken, capId } = await seed();
    const [cap] = await db.select().from(captures).where(eq(captures.id, capId));
    const conn = await mysql.createConnection(requireTestDatabaseUrl());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("lock test timed out")), 15_000);
    });
    try {
      const run = async () => {
        await conn.beginTransaction();
        await conn.query("SELECT id FROM captures WHERE id = ? FOR UPDATE", [capId]);
        const call = callerFor(h1).inbox.acceptMany({
          id: capId,
          roomId: keuken,
          items: [{ areaId, itemId: null, itemName: "pan", box: pan }],
        });
        let settled = false;
        call.then(
          () => (settled = true),
          () => (settled = true),
        );
        await new Promise((r) => setTimeout(r, 500));
        expect(settled, "acceptMany resolved while another transaction held the capture lock").toBe(false);
        const [res] = await conn.query<mysql.ResultSetHeader>(
          "INSERT INTO photos (storageKey, mimeType, sourceCaptureId, roomId, title) VALUES (?, ?, ?, ?, ?)",
          [cap.storageKey, "image/jpeg", capId, keuken, "Location photo"],
        );
        await conn.commit();
        await call;
        const locations = await db.select().from(photos).where(and(eq(photos.sourceCaptureId, capId), isNull(photos.itemId)));
        expect(locations.map((p) => p.id)).toEqual([res.insertId]);
        const pins = await db.select().from(photoPins);
        expect(pins.map((p) => p.photoId)).toEqual([res.insertId]);
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
