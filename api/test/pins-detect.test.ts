import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { areas, captures, houses, items, photoPins, photos, rooms } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";

const model = vi.hoisted(() => ({ answer: null as unknown }));

vi.mock("../lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai")>()),
  getDetectVisionModel: async () => ({}),
  getTriageVisionModel: async () => ({}),
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
    object: schema.parse(model.answer),
  }),
}));

beforeEach(async () => {
  await resetTestDb();
  model.answer = null;
});
afterEach(removeTestUploads);

async function seedTwoHouses() {
  const db = getTestDb();
  const [{ id: thuis }] = await db.insert(houses).values({ name: "Thuis RT" }).$returningId();
  const [{ id: josies }] = await db.insert(houses).values({ name: "Josies" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();
  const [{ id: zolder }] = await db
    .insert(rooms)
    .values({ houseId: thuis, name: "Zolderkamer", floor: "attic", source: "manual" })
    .$returningId();
  const [{ id: eetkamer }] = await db
    .insert(rooms)
    .values({ houseId: thuis, name: "Eetkamer", floor: "ground", source: "manual" })
    .$returningId();
  const [{ id: kinder }] = await db
    .insert(rooms)
    .values({ houseId: josies, name: "Kinderkamer", floor: "1", source: "manual" })
    .$returningId();
  const [{ id: cardReader }] = await db
    .insert(items)
    .values({ areaId, name: "Card reader / bank authenticator with keypad", houseId: thuis, roomId: zolder })
    .$returningId();
  const [{ id: table5 }] = await db
    .insert(items)
    .values({ areaId, name: "Table 5", houseId: thuis, roomId: eetkamer })
    .$returningId();
  const [{ id: cat }] = await db
    .insert(items)
    .values({ areaId, name: "pink cat night light", houseId: josies, roomId: kinder })
    .$returningId();
  const key = await writeTestJpeg();
  const [{ id: photoId }] = await db
    .insert(photos)
    .values({ storageKey: key, roomId: kinder, title: "Kinderkamer" })
    .$returningId();
  return { db, thuis, josies, kinder, photoId, cardReader, table5, cat, key, areaId };
}

describe("pins.detect house scope", () => {
  it("does not pin a Thuis RT card reader or table onto a Josies Kinderkamer photo", async () => {
    const { db, josies, photoId, cardReader, table5, cat } = await seedTwoHouses();
    model.answer = {
      objects: [
        { label: "greeting card", xPct: 20, yPct: 30, wPct: 10, hPct: 12, matchedItemId: cardReader },
        { label: "red children's table", xPct: 70, yPct: 60, wPct: 20, hPct: 18, matchedItemId: null },
        { label: "pink cat night light", xPct: 48, yPct: 63, wPct: 6, hPct: 6, matchedItemId: cat },
      ],
    };
    const res = await callerFor(josies).pins.detect({ photoId });
    expect(res).toEqual({ ok: true, created: 3, matched: 1 });
    const pins = await db.select().from(photoPins).where(eq(photoPins.photoId, photoId));
    expect(pins.map((p) => [p.label, p.itemId, p.status])).toEqual([
      ["greeting card", null, "suggested"],
      ["red children's table", null, "suggested"],
      ["pink cat night light", cat, "suggested"],
    ]);
    expect(pins.some((p) => p.itemId === cardReader || p.itemId === table5)).toBe(false);
  });

  it("stays label-only when the photo has no Place and no house was passed", async () => {
    const { db, josies, cardReader, cat } = await seedTwoHouses();
    const key = await writeTestJpeg();
    const [{ id: loose }] = await db.insert(photos).values({ storageKey: key, title: "unplaced" }).$returningId();
    model.answer = {
      objects: [
        { label: "greeting card", xPct: 40, yPct: 40, wPct: 10, hPct: 10, matchedItemId: cardReader },
        { label: "pink cat night light", xPct: 48, yPct: 63, wPct: 6, hPct: 6, matchedItemId: cat },
      ],
    };
    const res = await callerFor(josies).pins.detect({ photoId: loose });
    expect(res).toMatchObject({ ok: true, created: 2, matched: 0 });
    const pins = await db.select().from(photoPins).where(eq(photoPins.photoId, loose));
    expect(pins.map((p) => p.itemId)).toEqual([null, null]);
  });

  it("clamps a hanging-off-edge box into the image before storing", async () => {
    const { db, josies, photoId } = await seedTwoHouses();
    model.answer = {
      objects: [{ label: "lamp", xPct: 90, yPct: 90, wPct: 40, hPct: 40, matchedItemId: null }],
    };
    await callerFor(josies).pins.detect({ photoId });
    const [pin] = await db.select().from(photoPins).where(eq(photoPins.photoId, photoId));
    expect([pin.xPct, pin.yPct, pin.wPct, pin.hPct]).toEqual([80, 80, 40, 40]);
  });
});

describe("inbox.detectObjects house scope", () => {
  it("does not match a capture in Josies to a Thuis RT card reader", async () => {
    const { db, josies, kinder, cardReader, cat, key } = await seedTwoHouses();
    const [{ id: capId }] = await db
      .insert(captures)
      .values({ kind: "image", storageKey: key, houseId: josies })
      .$returningId();
    await db.insert(photos).values({ storageKey: key, sourceCaptureId: capId, roomId: kinder, title: "Location photo" });
    model.answer = {
      objects: [
        {
          label: "greeting card",
          description: null,
          xPct: 20,
          yPct: 30,
          wPct: 10,
          hPct: 12,
          matchedItemId: cardReader,
        },
        {
          label: "pink cat night light",
          description: null,
          xPct: 48,
          yPct: 63,
          wPct: 6,
          hPct: 6,
          matchedItemId: cat,
        },
      ],
    };
    const res = await callerFor(josies).inbox.detectObjects({ id: capId });
    if (!res.ok) throw new Error(res.error);
    expect(res.suggestions.map((s) => [s.label, s.matchedItemId])).toEqual([
      ["greeting card", null],
      ["pink cat night light", cat],
    ]);
  });
});
