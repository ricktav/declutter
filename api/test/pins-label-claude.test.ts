// api/test/pins-label-claude.test.ts
// Focus hand-drawn frames call pins.labelWithClaude after pins.add. The
// mutation always uses claude -p (labelCropWithClaude), never the vision
// API / AI_DEV_PROVIDER. Soft-fail leaves the generic Frame N label.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { houses, items, photoPins, photos, areas } from "@db/schema";
import { getTestDb, resetTestDb } from "./db";
import { callerFor } from "./caller";
import { removeTestUploads, writeTestJpeg } from "./fixtures";

const claude = vi.hoisted(() => ({
  labelCropWithClaude: vi.fn<(imageBytes: Uint8Array) => Promise<string | null>>(async () => null),
}));
vi.mock("../lib/claudeLabel", () => ({
  labelCropWithClaude: (imageBytes: Uint8Array) => claude.labelCropWithClaude(imageBytes),
}));

beforeEach(async () => {
  await resetTestDb();
  claude.labelCropWithClaude.mockReset();
  claude.labelCropWithClaude.mockResolvedValue(null);
});
afterEach(removeTestUploads);

async function seedPin(label = "Frame 1") {
  const db = getTestDb();
  const [{ id: h1 }] = await db.insert(houses).values({ name: "A" }).$returningId();
  const key = await writeTestJpeg();
  const [{ id: photoId }] = await db.insert(photos).values({ storageKey: key, title: "Room" }).$returningId();
  const { id: pinId } = await callerFor(h1).pins.add({
    photoId,
    xPct: 40,
    yPct: 50,
    wPct: 20,
    hPct: 25,
    label,
  });
  return { db, h1, photoId, pinId };
}

describe("pins.labelWithClaude", () => {
  it("crops the pin box, names it via claude -p, and updates the pin label", async () => {
    const { db, h1, pinId } = await seedPin("Frame 2");
    claude.labelCropWithClaude.mockResolvedValue("Mac mini M4");

    const res = await callerFor(h1).pins.labelWithClaude({ id: pinId });
    expect(res).toEqual({ ok: true, label: "Mac mini M4" });
    expect(claude.labelCropWithClaude).toHaveBeenCalledTimes(1);
    const crop = claude.labelCropWithClaude.mock.calls[0]?.[0];
    expect(crop?.byteLength).toBeGreaterThan(0);

    const [pin] = await db.select().from(photoPins).where(eq(photoPins.id, pinId));
    expect(pin.label).toBe("Mac mini M4");
  });

  it("keeps Frame N when Claude returns nothing", async () => {
    const { db, h1, pinId } = await seedPin("Frame 1");
    claude.labelCropWithClaude.mockResolvedValue(null);

    const res = await callerFor(h1).pins.labelWithClaude({ id: pinId });
    expect(res).toEqual({ ok: false, error: "Could not identify this frame." });
    const [pin] = await db.select().from(photoPins).where(eq(photoPins.id, pinId));
    expect(pin.label).toBe("Frame 1");
  });

  it("does not overwrite a pin the user already renamed or admitted", async () => {
    const { db, h1, pinId } = await seedPin("Toaster");
    claude.labelCropWithClaude.mockResolvedValue("Mac mini M4");
    expect(await callerFor(h1).pins.labelWithClaude({ id: pinId })).toEqual({ ok: true, label: "Toaster" });
    expect(claude.labelCropWithClaude).not.toHaveBeenCalled();
    expect((await db.select().from(photoPins).where(eq(photoPins.id, pinId)))[0].label).toBe("Toaster");

    const { h1: h2, pinId: admittedId, db: db2 } = await seedPin("Frame 3");
    const [{ id: areaId }] = await db2.insert(areas).values({ slug: "x", name: "X" }).$returningId();
    const [{ id: itemId }] = await db2.insert(items).values({ areaId, name: "Kettle", houseId: h2 }).$returningId();
    await callerFor(h2).pins.update({ id: admittedId, itemId });
    claude.labelCropWithClaude.mockClear();
    claude.labelCropWithClaude.mockResolvedValue("Electric kettle");
    expect(await callerFor(h2).pins.labelWithClaude({ id: admittedId })).toEqual({ ok: true, label: "Frame 3" });
    expect(claude.labelCropWithClaude).not.toHaveBeenCalled();
    expect((await db2.select().from(photoPins).where(eq(photoPins.id, admittedId)))[0].label).toBe("Frame 3");
  });

  it("soft-fails for a missing pin without throwing", async () => {
    const { h1 } = await seedPin();
    await expect(callerFor(h1).pins.labelWithClaude({ id: 999_999 })).resolves.toEqual({
      ok: false,
      error: null,
    });
  });
});
