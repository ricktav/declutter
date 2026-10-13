// Plan tests (no writes) plus apply on the test-DB seam. Cases match the live
// dry-run holes: a Thing whose only photo is an extra, and groups that share
// one file.
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { areas, captures, houses, itemLinks, items, photoPins, photos } from "@db/schema";
import { WHOLE_SCENE_BOX, coverPhotos, photosForItem } from "../lib/photos";
import {
  APPLY_SNAPSHOT_FLAG,
  applyGuard,
  applyPhotosDedupPlan,
  buildPhotosDedupPlan,
  formatPhotosDedupReport,
  isDedupApplyEnabled,
  DEDUP_WHOLE_SCENE_BOX,
  pickKeep,
  type DedupApplyIo,
  type DedupPhoto,
  type DedupPin,
} from "../lib/photosDedup";
import { loadPhotosDedupInput, makePhotosDedupApplyIo } from "../lib/photosDedupApply";
import { getTestDb, requireTestDatabaseUrl, resetTestDb } from "./db";
import { keyPath, removeTestUploads } from "./fixtures";

const run = promisify(execFile);

function photo(partial: Partial<DedupPhoto> & Pick<DedupPhoto, "id">): DedupPhoto {
  return {
    itemId: null,
    sourceCaptureId: null,
    storageKey: `local/${partial.id}.jpg`,
    cropBox: null,
    title: null,
    hash: "aa",
    ...partial,
  };
}

describe("photos-dedup plan", () => {
  it("uses the same whole-scene box as acceptMany", () => {
    expect(DEDUP_WHOLE_SCENE_BOX).toEqual(WHOLE_SCENE_BOX);
    expect(isDedupApplyEnabled()).toBe(false);
    expect(isDedupApplyEnabled({ DEDUP_APPLY_ENABLED: "true" })).toBe(true);
    expect(isDedupApplyEnabled({ DEDUP_APPLY_ENABLED: "TRUE" })).toBe(false);
    expect(isDedupApplyEnabled({ DEDUP_APPLY_ENABLED: "1" })).toBe(false);
  });

  it("keeps the item-less location photo, else the oldest id", () => {
    const olderOwned = photo({ id: 72, itemId: 51, hash: "x" });
    const location = photo({ id: 73, hash: "x" });
    expect(pickKeep([olderOwned, location]).id).toBe(73);
    expect(pickKeep([olderOwned, photo({ id: 80, itemId: 12, hash: "x" })]).id).toBe(72);
  });

  it("pins a Thing on the kept scene when its only photo row would be removed", () => {
    // Live-shaped: [72, 73] share a file; #73 is the location photo; #72 is
    // item #51's only photo and has no pin on #73.
    const photos = [
      photo({ id: 72, itemId: 51, storageKey: "local/scene.jpg", hash: "same" }),
      photo({ id: 73, storageKey: "local/scene.jpg", hash: "same", title: "Kantoor" }),
    ];
    const plan = buildPhotosDedupPlan({ photos, pins: [] });

    expect(plan.totals).toMatchObject({
      photos: 2,
      hashGroups: 1,
      uncroppedGroups: 1,
      extras: 1,
      createPins: 1,
      orphanPins: 1,
      rePointPins: 0,
      removePhotos: 1,
      deleteFiles: 0,
      sharedFiles: 1,
    });
    expect(plan.groups[0].keep.id).toBe(73);
    expect(plan.removePhotoIds).toEqual([72]);
    expect(plan.createPins).toEqual([
      {
        photoId: 73,
        itemId: 51,
        box: WHOLE_SCENE_BOX,
        onlyPhotoRemoved: true,
        extraPhotoId: 72,
      },
    ]);
    expect(plan.sharedFiles).toEqual([
      { storageKey: "local/scene.jpg", remainingPhotoIds: [73], extraPhotoIds: [72] },
    ]);
    expect(plan.deleteFiles).toEqual([]);

    const report = formatPhotosDedupReport(plan);
    expect(report).toContain("would create 1 whole-scene pin(s) on kept photos (1 Thing(s) would otherwise have no photo and no pin)");
    expect(report).toContain("keep 1 shared file(s) still referenced by a remaining photo");
    expect(report).toContain("pin item #51 on #73 (WHOLE_SCENE_BOX)  only photo #72 would be removed");
    expect(report).toContain("same file as a remaining photo — will not delete file");
  });

  it("does not delete a file while any remaining photo row still uses it", () => {
    // Live-shaped groups: keep + extras share one storageKey.
    const photos = [
      photo({ id: 61, itemId: 12, storageKey: "local/a.jpg", hash: "a" }),
      photo({ id: 63, storageKey: "local/a.jpg", hash: "a" }),
      photo({ id: 83, storageKey: "local/b.jpg", hash: "b" }),
      photo({ id: 86, itemId: 165, storageKey: "local/b.jpg", hash: "b" }),
      photo({ id: 87, itemId: 166, storageKey: "local/b.jpg", hash: "b" }),
      photo({ id: 88, itemId: 167, storageKey: "local/b.jpg", hash: "b" }),
      photo({ id: 89, itemId: 168, storageKey: "local/b.jpg", hash: "b" }),
      photo({ id: 84, itemId: 58, storageKey: "local/c.jpg", hash: "c" }),
      photo({ id: 85, storageKey: "local/c.jpg", hash: "c" }),
    ];
    const plan = buildPhotosDedupPlan({ photos, pins: [] });

    expect(plan.totals.uncroppedGroups).toBe(3);
    expect(plan.totals.extras).toBe(6);
    expect(plan.totals.orphanPins).toBe(6);
    expect(plan.totals.deleteFiles).toBe(0);
    expect(plan.totals.sharedFiles).toBe(3);
    expect(plan.createPins.map((p) => p.itemId).sort((a, b) => a - b)).toEqual([12, 58, 165, 166, 167, 168]);
    expect(plan.createPins.every((p) => p.onlyPhotoRemoved && p.box.wPct === 0 && p.box.hPct === 0)).toBe(true);
    expect(plan.sharedFiles.map((f) => [f.storageKey, f.remainingPhotoIds, f.extraPhotoIds])).toEqual([
      ["local/a.jpg", [63], [61]],
      ["local/b.jpg", [83], [86, 87, 88, 89]],
      ["local/c.jpg", [85], [84]],
    ]);
  });

  it("deletes a true copy only when no remaining photo, capture or link uses that key", () => {
    const photos = [
      photo({ id: 1, storageKey: "local/keep.jpg", hash: "copy" }),
      photo({ id: 2, itemId: 9, storageKey: "local/copy.jpg", hash: "copy" }),
      photo({ id: 3, itemId: 10, storageKey: "local/other.jpg", hash: "other" }),
    ];
    const pins: DedupPin[] = [{ id: 4, photoId: 2, itemId: 9 }];
    const plan = buildPhotosDedupPlan({ photos, pins, otherFileRefs: ["local/other.jpg"] });

    expect(plan.groups[0].keep.id).toBe(1);
    expect(plan.createPins).toEqual([]);
    expect(plan.rePointPins).toEqual([{ pinId: 4, fromPhotoId: 2, toPhotoId: 1, itemId: 9 }]);
    expect(plan.deleteFiles).toEqual(["local/copy.jpg"]);
    expect(plan.sharedFiles).toEqual([]);
  });

  it("keeps a unique extra file when a capture or link still references it", () => {
    const photos = [
      photo({ id: 1, storageKey: "local/keep.jpg", hash: "z" }),
      photo({ id: 2, itemId: 9, storageKey: "local/copy.jpg", hash: "z" }),
    ];
    const plan = buildPhotosDedupPlan({ photos, pins: [], otherFileRefs: ["local/copy.jpg"] });
    expect(plan.deleteFiles).toEqual([]);
    expect(plan.otherRefFiles).toEqual(["local/copy.jpg"]);
    expect(formatPhotosDedupReport(plan)).toContain("file still referenced by a capture or link — will not delete file");
  });

  it("does not create a pin when the keep already has one, or the Thing keeps another photo", () => {
    const photos = [
      photo({ id: 1, storageKey: "local/keep.jpg", hash: "s" }),
      photo({ id: 2, itemId: 9, storageKey: "local/copy.jpg", hash: "s" }),
      photo({ id: 3, itemId: 9, storageKey: "local/cut.jpg", hash: "cut", cropBox: { xPct: 1, yPct: 1, wPct: 10, hPct: 10 } }),
      photo({ id: 4, itemId: 11, storageKey: "local/copy2.jpg", hash: "s" }),
    ];
    const pins: DedupPin[] = [{ id: 8, photoId: 1, itemId: 11 }];
    const plan = buildPhotosDedupPlan({ photos, pins });

    expect(plan.removePhotoIds).toEqual([2, 4]);
    expect(plan.createPins).toEqual([
      { photoId: 1, itemId: 9, box: WHOLE_SCENE_BOX, onlyPhotoRemoved: false, extraPhotoId: 2 },
    ]);
    expect(plan.createPins[0].onlyPhotoRemoved).toBe(false);
    expect(formatPhotosDedupReport(plan)).toContain("link item #9 to the kept scene");
    expect(plan.createPins.some((p) => p.itemId === 11)).toBe(false);
  });

  it("leaves cropped-only hash groups alone", () => {
    const photos = [
      photo({ id: 1, hash: "c", cropBox: { xPct: 1, yPct: 1, wPct: 10, hPct: 10 } }),
      photo({ id: 2, hash: "c", cropBox: { xPct: 2, yPct: 2, wPct: 10, hPct: 10 } }),
    ];
    const plan = buildPhotosDedupPlan({ photos, pins: [] });
    expect(plan.totals.hashGroups).toBe(1);
    expect(plan.totals.uncroppedGroups).toBe(0);
    expect(plan.removePhotoIds).toEqual([]);
  });

  it("blocks --apply until the env is true and a snapshot is declared", () => {
    expect(applyGuard([]).mode).toBe("dry-run");
    const blocked = applyGuard(["--apply"]);
    expect(blocked.mode).toBe("blocked");
    if (blocked.mode === "blocked") {
      expect(blocked.message).toMatch(/DEDUP_APPLY_ENABLED is not 'true'/);
      expect(blocked.message).toMatch(/snapshot/);
    }
    expect(applyGuard(["--apply", APPLY_SNAPSHOT_FLAG]).mode).toBe("blocked");

    const prev = process.env.DEDUP_APPLY_ENABLED;
    process.env.DEDUP_APPLY_ENABLED = "true";
    try {
      expect(applyGuard(["--apply"]).mode).toBe("blocked");
      expect(applyGuard(["--apply", APPLY_SNAPSHOT_FLAG]).mode).toBe("apply");
    } finally {
      if (prev === undefined) delete process.env.DEDUP_APPLY_ENABLED;
      else process.env.DEDUP_APPLY_ENABLED = prev;
    }
  });

  it("refuses applyPhotosDedupPlan while the env is not true", async () => {
    const plan = buildPhotosDedupPlan({
      photos: [photo({ id: 1, hash: "h" }), photo({ id: 2, itemId: 1, hash: "h" })],
      pins: [],
    });
    await expect(applyPhotosDedupPlan(plan, silentIo())).rejects.toThrow(/DEDUP_APPLY_ENABLED is not 'true'/);
  });

  it("runs pins and row deletes inside withTransaction, files after commit", async () => {
    const prev = process.env.DEDUP_APPLY_ENABLED;
    process.env.DEDUP_APPLY_ENABLED = "true";
    const order: string[] = [];
    const plan = buildPhotosDedupPlan({
      photos: [
        photo({ id: 1, storageKey: "local/keep.jpg", hash: "h" }),
        photo({ id: 2, itemId: 9, storageKey: "local/copy.jpg", hash: "h" }),
      ],
      pins: [{ id: 4, photoId: 2, itemId: 9 }],
    });
    expect(plan.createPins).toHaveLength(0);
    expect(plan.rePointPins).toHaveLength(1);
    expect(plan.removePhotoIds).toEqual([2]);
    expect(plan.deleteFiles).toEqual(["local/copy.jpg"]);
    await applyPhotosDedupPlan(plan, {
      withTransaction: async (work) => {
        order.push("tx-start");
        const result = await work();
        order.push("tx-end");
        return result;
      },
      createPin: async () => {
        order.push("createPin");
      },
      rePointPin: async () => {
        order.push("rePointPin");
      },
      removePhotoRow: async () => {
        order.push("removePhotoRow");
      },
      deleteFileIfUnused: async () => {
        order.push("deleteFile");
      },
    });
    expect(order).toEqual(["tx-start", "rePointPin", "removePhotoRow", "tx-end", "deleteFile"]);
    if (prev === undefined) delete process.env.DEDUP_APPLY_ENABLED;
    else process.env.DEDUP_APPLY_ENABLED = prev;
  });
});

function silentIo(): DedupApplyIo {
  return {
    withTransaction: async (work) => work(),
    createPin: async () => {},
    rePointPin: async () => {},
    removePhotoRow: async () => {},
    deleteFileIfUnused: async () => {},
  };
}

async function writeColoredJpeg(r: number, g: number, b: number): Promise<string> {
  const key = `local/test-${crypto.randomBytes(6).toString("hex")}.jpg`;
  const abs = keyPath(key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
  fs.writeFileSync(abs, bytes);
  return key;
}

function copyJpeg(fromKey: string): string {
  const key = `local/test-${crypto.randomBytes(6).toString("hex")}.jpg`;
  fs.copyFileSync(keyPath(fromKey), keyPath(key));
  return key;
}

async function applyEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DEDUP_APPLY_ENABLED;
  process.env.DEDUP_APPLY_ENABLED = "true";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DEDUP_APPLY_ENABLED;
    else process.env.DEDUP_APPLY_ENABLED = prev;
  }
}

async function seedApplyFixture() {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const [{ id: areaId }] = await db.insert(areas).values({ slug: "x", name: "X" }).$returningId();

  const sharedKey = await writeColoredJpeg(200, 40, 40);
  const [{ id: sharedItem }] = await db.insert(items).values({ areaId, name: "Mac mini", houseId: h1 }).$returningId();
  const [{ id: sharedExtra }] = await db
    .insert(photos)
    .values({ itemId: sharedItem, storageKey: sharedKey, title: "copy of scene" })
    .$returningId();
  const [{ id: sharedKeep }] = await db.insert(photos).values({ storageKey: sharedKey, title: "Kantoor" }).$returningId();

  const copyKeepKey = await writeColoredJpeg(40, 200, 40);
  const copyExtraKey = copyJpeg(copyKeepKey);
  const [{ id: copyItem }] = await db.insert(items).values({ areaId, name: "Lamp", houseId: h1 }).$returningId();
  const [{ id: copyKeep }] = await db.insert(photos).values({ storageKey: copyKeepKey, title: "scene" }).$returningId();
  const [{ id: copyExtra }] = await db
    .insert(photos)
    .values({ itemId: copyItem, storageKey: copyExtraKey, title: "lamp copy" })
    .$returningId();
  const [{ id: copyPin }] = await db
    .insert(photoPins)
    .values({ photoId: copyExtra, itemId: copyItem, xPct: 50, yPct: 50, wPct: 0, hPct: 0, label: "lamp" })
    .$returningId();

  const capKeepKey = await writeColoredJpeg(40, 40, 200);
  const capExtraKey = copyJpeg(capKeepKey);
  const [{ id: capItem }] = await db.insert(items).values({ areaId, name: "Chair", houseId: h1 }).$returningId();
  const [{ id: capKeep }] = await db.insert(photos).values({ storageKey: capKeepKey }).$returningId();
  const [{ id: capExtra }] = await db.insert(photos).values({ itemId: capItem, storageKey: capExtraKey }).$returningId();
  await db.insert(captures).values({ kind: "image", storageKey: capExtraKey });

  const linkKeepKey = await writeColoredJpeg(200, 200, 40);
  const linkExtraKey = copyJpeg(linkKeepKey);
  const [{ id: linkItem }] = await db.insert(items).values({ areaId, name: "Desk", houseId: h1 }).$returningId();
  const [{ id: linkKeep }] = await db.insert(photos).values({ storageKey: linkKeepKey }).$returningId();
  const [{ id: linkExtra }] = await db.insert(photos).values({ itemId: linkItem, storageKey: linkExtraKey }).$returningId();
  await db.insert(itemLinks).values({ itemId: linkItem, kind: "file", storageKey: linkExtraKey });

  return {
    db,
    h1,
    sharedItem,
    sharedKeep,
    sharedExtra,
    sharedKey,
    copyItem,
    copyKeep,
    copyExtra,
    copyKeepKey,
    copyExtraKey,
    copyPin,
    capItem,
    capKeep,
    capExtra,
    capKeepKey,
    capExtraKey,
    linkItem,
    linkKeep,
    linkExtra,
    linkKeepKey,
    linkExtraKey,
  };
}

async function withDedupConn<T>(fn: (c: mysql.Connection, pathOf: (key: string) => string) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({ uri: requireTestDatabaseUrl() });
  try {
    return await fn(c, keyPath);
  } finally {
    await c.end();
  }
}

describe("photos-dedup apply on a fixture DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(removeTestUploads);

  it("pins Things onto the kept scene, keeps shared and still-referenced files, and a rerun is a no-op", async () => {
    const fx = await seedApplyFixture();
    const thingIds = [fx.sharedItem, fx.copyItem, fx.capItem, fx.linkItem];

    const first = await withDedupConn(async (c, pathOf) => {
      const loaded = await loadPhotosDedupInput(c, pathOf);
      const plan = buildPhotosDedupPlan(loaded);
      expect(plan.totals.uncroppedGroups).toBe(4);
      expect(plan.totals.extras).toBe(4);
      expect(plan.createPins.map((p) => p.itemId).sort((a, b) => a - b)).toEqual(
        [fx.sharedItem, fx.capItem, fx.linkItem].sort((a, b) => a - b),
      );
      expect(plan.createPins.every((p) => p.box.wPct === 0 && p.box.hPct === 0 && p.onlyPhotoRemoved)).toBe(true);
      expect(plan.rePointPins).toEqual([
        { pinId: fx.copyPin, fromPhotoId: fx.copyExtra, toPhotoId: fx.copyKeep, itemId: fx.copyItem },
      ]);
      expect(plan.sharedFiles.map((f) => f.storageKey)).toEqual([fx.sharedKey]);
      expect(plan.deleteFiles).toEqual([fx.copyExtraKey]);
      expect(plan.otherRefFiles.sort()).toEqual([fx.capExtraKey, fx.linkExtraKey].sort());

      await applyEnv(() => applyPhotosDedupPlan(plan, makePhotosDedupApplyIo(c, { pathOf })));
      return plan;
    });

    const remaining = await fx.db.select().from(photos);
    expect(remaining.map((p) => p.id).sort((a, b) => a - b)).toEqual(
      [fx.sharedKeep, fx.copyKeep, fx.capKeep, fx.linkKeep].sort((a, b) => a - b),
    );
    expect(remaining.some((p) => first.removePhotoIds.includes(p.id))).toBe(false);

    const [moved] = await fx.db.select().from(photoPins).where(eq(photoPins.id, fx.copyPin));
    expect(moved).toMatchObject({
      photoId: fx.copyKeep,
      itemId: fx.copyItem,
      xPct: 50,
      yPct: 50,
      wPct: 0,
      hPct: 0,
    });

    const scenePins = await fx.db.select().from(photoPins);
    const created = scenePins.filter((p) => p.id !== fx.copyPin);
    expect(created).toHaveLength(3);
    expect(created.every((p) => p.wPct === 0 && p.hPct === 0 && p.status === "confirmed" && p.origin === "user")).toBe(
      true,
    );
    expect(created.map((p) => [p.itemId, p.photoId]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual(
      [
        [fx.sharedItem, fx.sharedKeep],
        [fx.capItem, fx.capKeep],
        [fx.linkItem, fx.linkKeep],
      ].sort((a, b) => a[0] - b[0]),
    );

    for (const id of thingIds) {
      const listed = await photosForItem(fx.db, id);
      expect(listed.length, `Thing #${id} lost its photo`).toBeGreaterThan(0);
    }
    const covers = await coverPhotos(fx.db, thingIds);
    expect([...covers.keys()].sort((a, b) => a - b)).toEqual([...thingIds].sort((a, b) => a - b));

    expect(fs.existsSync(keyPath(fx.sharedKey))).toBe(true);
    expect(fs.existsSync(keyPath(fx.copyKeepKey))).toBe(true);
    expect(fs.existsSync(keyPath(fx.copyExtraKey))).toBe(false);
    expect(fs.existsSync(keyPath(fx.capExtraKey))).toBe(true);
    expect(fs.existsSync(keyPath(fx.linkExtraKey))).toBe(true);

    const rerun = await withDedupConn(async (c, pathOf) => {
      const loaded = await loadPhotosDedupInput(c, pathOf);
      const plan = buildPhotosDedupPlan(loaded);
      expect(plan.totals).toMatchObject({
        uncroppedGroups: 0,
        extras: 0,
        createPins: 0,
        rePointPins: 0,
        removePhotos: 0,
        deleteFiles: 0,
      });
      expect(plan.groups).toHaveLength(0);
      await applyEnv(() => applyPhotosDedupPlan(plan, makePhotosDedupApplyIo(c, { pathOf })));
      return plan;
    });
    expect(rerun.removePhotoIds).toEqual([]);
    expect((await fx.db.select().from(photos)).map((p) => p.id).sort((a, b) => a - b)).toEqual(
      [fx.sharedKeep, fx.copyKeep, fx.capKeep, fx.linkKeep].sort((a, b) => a - b),
    );
    expect(fs.existsSync(keyPath(fx.sharedKey))).toBe(true);
    expect(fs.existsSync(keyPath(fx.copyExtraKey))).toBe(false);
  });

  it("does not delete files or drop extra rows when the transaction rolls back", async () => {
    const fx = await seedApplyFixture();
    await applyEnv(async () => {
      await withDedupConn(async (c, pathOf) => {
        const loaded = await loadPhotosDedupInput(c, pathOf);
        const plan = buildPhotosDedupPlan(loaded);
        const inner = makePhotosDedupApplyIo(c, { pathOf });
        await expect(
          applyPhotosDedupPlan(plan, {
            ...inner,
            removePhotoRow: async () => {
              throw new Error("boom");
            },
          }),
        ).rejects.toThrow("boom");
      });
    });

    expect((await fx.db.select().from(photos)).map((p) => p.id).sort((a, b) => a - b)).toEqual(
      [fx.sharedExtra, fx.sharedKeep, fx.copyKeep, fx.copyExtra, fx.capKeep, fx.capExtra, fx.linkKeep, fx.linkExtra].sort(
        (a, b) => a - b,
      ),
    );
    expect(fs.existsSync(keyPath(fx.copyExtraKey))).toBe(true);
    expect(fs.existsSync(keyPath(fx.sharedKey))).toBe(true);
  });

  it("the script apply path writes the fixture and a rerun finds 0 groups", async () => {
    const fx = await seedApplyFixture();
    const url = requireTestDatabaseUrl();
    expect(url).toMatch(/_test(?:\?|$)/);
    const env: NodeJS.ProcessEnv = { ...process.env, DEDUP_APPLY_ENABLED: "true" };
    delete env.DATABASE_URL;
    const script = async () =>
      (
        await run(
          "node",
          ["--experimental-strip-types", "scripts/photos-dedup.ts", "--url", url, "--apply", APPLY_SNAPSHOT_FLAG],
          { env, timeout: 30_000 },
        )
      ).stdout;

    const first = await script();
    expect(first).toMatch(/4 uncropped duplicate groups, 4 extra copies/);
    expect((await photosForItem(fx.db, fx.sharedItem)).map((p) => p.id)).toEqual([fx.sharedKeep]);
    expect(fs.existsSync(keyPath(fx.sharedKey))).toBe(true);
    expect(fs.existsSync(keyPath(fx.copyExtraKey))).toBe(false);

    const second = await script();
    expect(second).toMatch(/0 uncropped duplicate groups, 0 extra copies/);
    expect(second).toMatch(/would create 0 whole-scene pin\(s\)/);
    expect(second).toMatch(/would re-point 0 pin\(s\) and remove 0 uncropped copy row\(s\)/);
  });
});
