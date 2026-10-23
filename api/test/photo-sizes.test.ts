// api/test/photo-sizes.test.ts
// Cover metadata on items.listAll, photos.urls, and the size backfill.
import { execFile } from "child_process";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { areas, captures, houses, items, photos, rooms } from "@db/schema";
import { getTestDb, requireTestDatabaseUrl, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";
import { imageSize } from "../lib/imageSize";
import { readFileBytes } from "../lib/filestore";

const run = promisify(execFile);

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
  const [{ id: bare }] = await db.insert(items).values({ areaId, name: "lid", houseId: h1, roomId: keuken }).$returningId();
  return { db, h1, areaId, keuken, itemId, bare };
}

describe("imageSize", () => {
  it("reads a 64x48 JPEG as those pixels", async () => {
    const key = await writeTestJpeg();
    expect(await imageSize(await readFileBytes(key))).toEqual({ width: 64, height: 48 });
  });
});

describe("items.listAll cover metadata", () => {
  it("stamps size on add, reports a whole Photo as not a cutout, and a cutout as a cutout", async () => {
    const { db, h1, itemId, bare } = await seed();
    const api = callerFor(h1);
    const key = await writeTestJpeg();
    const { id: photoId } = await api.photos.add({ itemId, storageKey: key, title: "front" });
    const [row] = await db.select().from(photos).where(eq(photos.id, photoId));
    expect([row.width, row.height]).toEqual([64, 48]);

    const listed = await api.items.listAll({});
    const pan = listed.find((i) => i.id === itemId);
    const lid = listed.find((i) => i.id === bare);
    expect(pan).toMatchObject({
      imageKey: key,
      imageIsCutout: false,
      imageWidth: 64,
      imageHeight: 48,
    });
    expect(lid).toMatchObject({ imageKey: null, imageIsCutout: false, imageWidth: null, imageHeight: null });

    const capKey = await writeTestJpeg();
    const [{ id: capId }] = await getTestDb().insert(captures).values({ kind: "image", storageKey: capKey }).$returningId();
    const { photoId: loc } = await api.photos.ensureForCapture({ captureId: capId });
    const cut = await api.photos.createCutout({
      itemId,
      sourcePhotoId: loc,
      box: { xPct: 50, yPct: 50, wPct: 40, hPct: 40 },
    });
    expect(cut.created).toBe(true);
    const after = (await api.items.listAll({})).find((i) => i.id === itemId);
    expect(after?.imageIsCutout).toBe(true);
    expect(after?.imageKey).toBe(cut.storageKey);
    expect(after?.imageWidth).toBeGreaterThan(0);
    expect(after?.imageHeight).toBeGreaterThan(0);
  });
});

describe("photos.urls", () => {
  it("resolves photo ids and storage keys in one call, with dimensions when known", async () => {
    const { h1, itemId } = await seed();
    const api = callerFor(h1);
    const key = await writeTestJpeg();
    const { id } = await api.photos.add({ itemId, storageKey: key, title: "front" });
    const byId = await api.photos.urls({ ids: [id, 999999] });
    expect(byId).toEqual([{ id, key, url: expect.stringMatching(/^\/uploads\//), width: 64, height: 48 }]);
    const byKey = await api.photos.urls({ keys: [key, "local/does-not-exist.jpg"] });
    expect(byKey).toEqual([
      { id, key, url: expect.stringMatching(/^\/uploads\//), width: 64, height: 48 },
      { id: null, key: "local/does-not-exist.jpg", url: null, width: null, height: null },
    ]);
    await expect(api.photos.urls({})).rejects.toThrow(/ids or keys/);
  });
});

describe("scripts/backfill-photo-sizes.mjs", () => {
  const backfill = async (...args: string[]) =>
    (await run("node", ["scripts/backfill-photo-sizes.mjs", "--url", requireTestDatabaseUrl(), ...args])).stdout.trim();

  it("is dry by default, writes only with --apply, and is idempotent", async () => {
    const { db, itemId } = await seed();
    const key = await writeTestJpeg();
    const [{ id }] = await db.insert(photos).values({ itemId, storageKey: key, title: "old" }).$returningId();
    expect((await db.select().from(photos).where(eq(photos.id, id)))[0].width).toBeNull();

    expect(await backfill()).toMatch(/Dry run on \w+_test: 1 photos without a size, 1 to update, 0 missing file, 0 unreadable/);
    expect((await db.select().from(photos).where(eq(photos.id, id)))[0].width).toBeNull();

    expect(await backfill("--apply")).toMatch(/Applied on \w+_test: 1 photos without a size, 1 updated/);
    expect((await db.select().from(photos).where(eq(photos.id, id)))[0]).toMatchObject({ width: 64, height: 48 });

    expect(await backfill("--apply")).toMatch(/0 photos without a size, 0 updated/);
  });
});
