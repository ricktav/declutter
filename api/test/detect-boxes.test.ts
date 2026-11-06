// pins.detect and inbox.detectObjects store a centre+size box that fits the
// upright photo. House matching stays on photoScope / captureScope.
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
  const [{ id: kinder }] = await db
    .insert(rooms)
    .values({ houseId: josies, name: "Kinderkamer", floor: "1", source: "manual" })
    .$returningId();
  const [{ id: cardReader }] = await db
    .insert(items)
    .values({ areaId, name: "Card reader / bank authenticator with keypad", houseId: thuis, roomId: zolder })
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
  return { db, josies, kinder, photoId, cardReader, cat, key };
}

describe("pins.detect boxes", () => {
  it("clamps a hanging box, scales a 0–1 fraction, and drops a zero-size box", async () => {
    const { db, josies, photoId } = await seedTwoHouses();
    model.answer = {
      objects: [
        { label: "lamp", xPct: 90, yPct: 90, wPct: 40, hPct: 40, matchedItemId: null },
        { label: "mug", xPct: 0.48, yPct: 0.63, wPct: 0.12, hPct: 0.1, matchedItemId: null },
        { label: "speck", xPct: 50, yPct: 50, wPct: 0, hPct: 10, matchedItemId: null },
      ],
    };
    const res = await callerFor(josies).pins.detect({ photoId });
    expect(res).toEqual({ ok: true, created: 2, matched: 0 });
    const pins = await db.select().from(photoPins).where(eq(photoPins.photoId, photoId));
    expect(pins.map((p) => [p.label, p.xPct, p.yPct, p.wPct, p.hPct])).toEqual([
      ["lamp", 80, 80, 40, 40],
      ["mug", 48, 63, 12, 10],
    ]);
  });

  it("still matches only the photo's house", async () => {
    const { db, josies, photoId, cardReader, cat } = await seedTwoHouses();
    model.answer = {
      objects: [
        { label: "greeting card", xPct: 20, yPct: 30, wPct: 10, hPct: 12, matchedItemId: cardReader },
        { label: "pink cat night light", xPct: 48, yPct: 63, wPct: 6, hPct: 6, matchedItemId: cat },
      ],
    };
    const res = await callerFor(josies).pins.detect({ photoId });
    expect(res).toEqual({ ok: true, created: 2, matched: 1 });
    const pins = await db.select().from(photoPins).where(eq(photoPins.photoId, photoId));
    expect(pins.map((p) => [p.label, p.itemId])).toEqual([
      ["greeting card", null],
      ["pink cat night light", cat],
    ]);
  });
});

describe("inbox.detectObjects boxes", () => {
  it("returns a clamped box and does not match a Thing from another house", async () => {
    const { db, josies, kinder, cardReader, cat, key } = await seedTwoHouses();
    const [{ id: capId }] = await db
      .insert(captures)
      .values({ kind: "image", storageKey: key, houseId: josies })
      .$returningId();
    await db.insert(photos).values({ storageKey: key, sourceCaptureId: capId, roomId: kinder, title: "Location photo" });
    model.answer = {
      objects: [
        { label: "lamp", description: null, xPct: 90, yPct: 90, wPct: 40, hPct: 40, matchedItemId: cardReader },
        { label: "pink cat night light", description: null, xPct: 0.48, yPct: 0.63, wPct: 0.12, hPct: 0.1, matchedItemId: cat },
        { label: "speck", description: null, xPct: 50, yPct: 50, wPct: 0, hPct: 4, matchedItemId: null },
      ],
    };
    const res = await callerFor(josies).inbox.detectObjects({ id: capId });
    if (!res.ok) throw new Error(res.error);
    expect(res.suggestions.map((s) => [s.label, s.matchedItemId, s.xPct, s.yPct, s.wPct, s.hPct])).toEqual([
      ["lamp", null, 80, 80, 40, 40],
      ["pink cat night light", cat, 48, 63, 12, 10],
    ]);
  });
});
