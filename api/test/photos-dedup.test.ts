// Pure plan tests for photos-dedup. No writes. Cases match the live dry-run
// holes: a Thing whose only photo is an extra, and groups that share one file.
import { describe, expect, it } from "vitest";
import { WHOLE_SCENE_BOX } from "../lib/photos";
import {
  APPLY_SNAPSHOT_FLAG,
  applyGuard,
  applyPhotosDedupPlan,
  buildPhotosDedupPlan,
  DEDUP_APPLY_ENABLED,
  DEDUP_WHOLE_SCENE_BOX,
  formatPhotosDedupReport,
  pickKeep,
  type DedupPhoto,
  type DedupPin,
} from "../lib/photosDedup";

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
    expect(DEDUP_APPLY_ENABLED).toBe(false);
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

  it("blocks --apply until the flag is enabled and a snapshot is declared", () => {
    expect(applyGuard([]).mode).toBe("dry-run");
    const blocked = applyGuard(["--apply"]);
    expect(blocked.mode).toBe("blocked");
    if (blocked.mode === "blocked") {
      expect(blocked.message).toMatch(/DEDUP_APPLY_ENABLED is false/);
      expect(blocked.message).toMatch(/snapshot/);
    }
    expect(applyGuard(["--apply", APPLY_SNAPSHOT_FLAG]).mode).toBe("blocked");
  });

  it("refuses applyPhotosDedupPlan while the flag is off", async () => {
    const plan = buildPhotosDedupPlan({
      photos: [photo({ id: 1, hash: "h" }), photo({ id: 2, itemId: 1, hash: "h" })],
      pins: [],
    });
    await expect(
      applyPhotosDedupPlan(plan, {
        createPin: async () => {},
        rePointPin: async () => {},
        removePhotoRow: async () => {},
        deleteFileIfUnused: async () => {},
      }),
    ).rejects.toThrow(/DEDUP_APPLY_ENABLED is false/);
  });
});
